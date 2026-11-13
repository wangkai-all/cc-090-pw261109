import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toCsv } from '../js/csv.js';
import { makeRng, pickIndices } from '../js/prng.js';
import { parseTimestamp, bucketKey } from '../js/date.js';
import {
  runSampling, buildPlan, verifyPlan, replayPlan, inferColumnTypes,
  SamplingConfigError, ALGORITHM_VERSION,
} from '../js/sampling.js';
import { compareAll, sweepSizes } from '../js/stats.js';
import { buildDemoDataset } from '../js/demo.js';
import { fingerprintDataset } from '../js/fingerprint.js';

function makeRows(n, mapper) {
  return Array.from({ length: n }, (_, i) => mapper(i));
}

const HEADERS = ['id', 'region', 'amount', 'ts'];
const ROWS = makeRows(100, (i) => {
  const region = i < 80 ? 'A' : i < 95 ? 'B' : 'C'; // 80 / 15 / 5
  const amount = String(100 + i);
  const day = String((i % 20) + 1).padStart(2, '0');
  const ts = `2026-01-${day}`;
  return [String(i + 1), region, amount, ts];
});

async function demo() {
  const d = buildDemoDataset();
  const fingerprint = await fingerprintDataset(d.name, d.rawText);
  return { name: d.name, rawText: d.rawText, headers: d.headers, rows: d.rows, fingerprint, columnTypes: inferColumnTypes(d.headers, d.rows) };
}

test('同种子同输入：简单随机抽样完全一致', () => {
  const cfg = { method: 'simple', sampleSize: 20, seed: 42 };
  const r1 = runSampling(ROWS, HEADERS, cfg);
  const r2 = runSampling(ROWS, HEADERS, cfg);
  assert.deepEqual(r1.indices, r2.indices);
  assert.equal(r1.indices.length, 20);
  assert.equal(new Set(r1.indices).size, 20, '无放回：下标互不相同');
});

test('不同种子产生不同结果，但各自可复现', () => {
  const a = runSampling(ROWS, HEADERS, { method: 'simple', sampleSize: 20, seed: 1 }).indices;
  const b = runSampling(ROWS, HEADERS, { method: 'simple', sampleSize: 20, seed: 2 }).indices;
  assert.notDeepEqual(a, b);
  assert.deepEqual(runSampling(ROWS, HEADERS, { method: 'simple', sampleSize: 20, seed: 1 }).indices, a);
});

test('样本量超过总体：返回全部且不复制记录', () => {
  const r = runSampling(ROWS, HEADERS, { method: 'simple', sampleSize: 500, seed: 7 });
  assert.equal(r.actualSize, 100);
  assert.equal(new Set(r.indices).size, 100);
  assert.ok(r.warnings.some((w) => w.code === 'SAMPLE_LARGER_THAN_POPULATION'));
});

test('分层按比例分配：总数精确、占比接近总体', () => {
  const r = runSampling(ROWS, HEADERS, {
    method: 'stratified', sampleSize: 40, seed: 42, stratifyColumn: 'region', allocation: 'proportional',
  });
  assert.equal(r.actualSize, 40);
  const byKey = Object.fromEntries(r.strata.map((s) => [s.label, s]));
  assert.equal(byKey.A.actual, 32);
  assert.equal(byKey.B.actual, 6);
  assert.equal(byKey.C.actual, 2);
  for (const s of r.strata) assert.ok(s.actual <= s.population, '绝不超过层容量');
});

test('分层每层保底：稀有层至少保底，其余层补足且不复制', () => {
  const r = runSampling(ROWS, HEADERS, {
    method: 'stratified', sampleSize: 30, seed: 42, stratifyColumn: 'region',
    allocation: 'floor', floorPerStratum: 4,
  });
  const byKey = Object.fromEntries(r.strata.map((s) => [s.label, s]));
  assert.ok(byKey.C.actual >= 4);
  assert.equal(r.actualSize, 30);
  assert.ok(r.strata.every((s) => s.actual <= s.population));
});

test('稀有层容量不足：报告实际数量，禁止复制凑数', () => {
  // C 层只有 5 行，保底要 10
  const r = runSampling(ROWS, HEADERS, {
    method: 'stratified', sampleSize: 50, seed: 42, stratifyColumn: 'region',
    allocation: 'floor', floorPerStratum: 10,
  });
  const c = r.strata.find((s) => s.label === 'C');
  assert.equal(c.actual, 5, 'C 层实际只有 5 行');
  assert.equal(c.shortfall > 0 || c.belowFloor, true);
  assert.ok(r.warnings.some((w) => w.code === 'STRATUM_SHORTFALL'));
  assert.equal(new Set(r.indices).size, r.indices.length, '无重复行');
});

test('保底总和超过目标样本量：明确报错而非静默截断', () => {
  assert.throws(
    () => runSampling(ROWS, HEADERS, {
      method: 'stratified', sampleSize: 2, seed: 42, stratifyColumn: 'region',
      allocation: 'floor', floorPerStratum: 5,
    }),
    (e) => e instanceof SamplingConfigError && e.code === 'FLOOR_EXCEEDS_TARGET',
  );
});

test('空值归入独立空值层，不与其他类别混合', () => {
  const rows = ROWS.slice(0, 10).map((r, i) => (i < 3 ? [r[0], '', r[2], r[3]] : r));
  const r = runSampling(rows, HEADERS, {
    method: 'stratified', sampleSize: 8, seed: 42, stratifyColumn: 'region',
    allocation: 'floor', floorPerStratum: 2,
  });
  const nullStratum = r.strata.find((s) => s.isNullStratum);
  assert.ok(nullStratum);
  assert.equal(nullStratum.population, 3);
  assert.ok(r.warnings.some((w) => w.code === 'NULL_STRATUM'));
});

test('时间段抽样：保留连续区间，不打散成随机样本', () => {
  const r = runSampling(ROWS, HEADERS, {
    method: 'time', sampleSize: 3, seed: 42, timeColumn: 'ts',
    timeGranularity: 'day', blockLength: 2, timeMode: 'blocks',
  });
  assert.ok(r.blocks.length >= 3);
  const selected = r.blocks.filter((b) => b.selected);
  assert.equal(selected.length, 3);
  // 每个选中区间包含 blockLength 个连续日桶；同一区间内的行全部出现或全部不出现
  const selectedIndexSet = new Set(r.indices);
  for (const block of r.blocks.filter((b) => b.selected)) {
    const inBlock = ROWS
      .map((row, idx) => ({ idx, key: bucketKey(parseTimestamp(row[3]), 'day') }))
      .filter((x) => x.key >= block.startKey && x.key <= block.endKey);
    for (const x of inBlock) assert.ok(selectedIndexSet.has(x.idx), '区间内行必须整体保留');
  }
});

test('时间段抽样可复现，且目标行数模式实际行数被如实报告', () => {
  const cfg = {
    method: 'time', sampleSize: 25, seed: 99, timeColumn: 'ts',
    timeGranularity: 'day', blockLength: 1, timeMode: 'targetRows',
  };
  const r1 = runSampling(ROWS, HEADERS, cfg);
  const r2 = runSampling(ROWS, HEADERS, cfg);
  assert.deepEqual(r1.indices, r2.indices);
  assert.ok(r1.warnings.some((w) => w.code === 'TIME_TARGET_APPROX'));
  assert.equal(r1.actualSize, r1.indices.length);
});

test('混乱时间格式：可解析多格式，不可解析行被排除并给出行号', async () => {
  const d = await demo();
  const r = runSampling(d.rows, d.headers, {
    method: 'time', sampleSize: 5, seed: 1, timeColumn: 'order_time',
    timeGranularity: 'day', blockLength: 1, timeMode: 'blocks',
  });
  assert.ok(r.timeCoverage.invalidRows > 0, '演示数据包含“时间未知”');
  assert.ok(r.timeCoverage.invalidRowSample.length > 0);
  assert.ok(r.warnings.some((w) => w.code === 'UNPARSEABLE_TIME'));
  // 不可解析行不会进入样本
  const invalidSet = new Set(r.timeCoverage.invalidRowSample.map((n) => n - 2));
  assert.ok(r.indices.every((i) => !invalidSet.has(i)));
});

test('时间字段全部不可解析：抛出明确错误', () => {
  const rows = [['1', 'bad'], ['2', 'nope']];
  assert.throws(
    () => runSampling(rows, ['id', 't'], {
      method: 'time', sampleSize: 1, seed: 1, timeColumn: 't',
      timeGranularity: 'day', blockLength: 1, timeMode: 'blocks',
    }),
    (e) => e.code === 'NO_VALID_TIMESTAMP',
  );
});

test('方案：输入指纹变化后明确失效', async () => {
  const d = await demo();
  const plan = buildPlan({ method: 'simple', sampleSize: 30, seed: 42 }, d);
  assert.equal(plan.algorithm, `local-sampling-lab@${ALGORITHM_VERSION}`);
  const okCheck = verifyPlan(plan, d);
  assert.equal(okCheck.ok, true);

  const changed = { ...d, fingerprint: 'deadbeef' };
  const badCheck = verifyPlan(plan, changed);
  assert.equal(badCheck.ok, false);
  assert.ok(badCheck.errors.some((e) => e.code === 'FINGERPRINT_MISMATCH'));
  assert.throws(() => replayPlan(plan, changed), (e) => e.code === 'PLAN_INVALID');
});

test('方案复现：同输入重放结果指纹一致', async () => {
  const d = await demo();
  const plan = buildPlan({
    method: 'stratified', sampleSize: 50, seed: 2026,
    stratifyColumn: 'region', allocation: 'proportional',
  }, d);
  const r1 = replayPlan(plan, d);
  const r2 = replayPlan(plan, d);
  assert.deepEqual(r1.indices, r2.indices);
});

test('依赖字段被删除：方案失效', async () => {
  const d = await demo();
  const plan = buildPlan({
    method: 'stratified', sampleSize: 20, seed: 42,
    stratifyColumn: 'region', allocation: 'proportional',
  }, d);
  const headers = d.headers.filter((h) => h !== 'region');
  const rows = d.rows.map((r) => r.filter((_, i) => d.headers[i] !== 'region'));
  const broken = { ...d, headers, rows };
  const check = verifyPlan(plan, broken);
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => e.code === 'COLUMN_MISSING'));
});

test('行数或列数变化：即使指纹被绕过也能识别结构变化', async () => {
  const d = await demo();
  const plan = buildPlan({ method: 'simple', sampleSize: 10, seed: 42 }, d);
  const rowChanged = { ...d, fingerprint: plan.dataset.fingerprint, rows: d.rows.slice(0, -1) };
  assert.ok(verifyPlan(plan, rowChanged).errors.some((e) => e.code === 'ROW_COUNT_MISMATCH'));
  const colChanged = {
    ...d, fingerprint: plan.dataset.fingerprint,
    headers: d.headers.slice(0, -1),
    rows: d.rows.map((r) => r.slice(0, -1)),
  };
  assert.ok(verifyPlan(plan, colChanged).errors.some((e) => e.code === 'COLUMN_COUNT_MISMATCH'));
});

test('导出样本：首列为来源行号且与选中下标严格对应', async () => {
  const d = await demo();
  const result = runSampling(d.rows, d.headers, { method: 'simple', sampleSize: 15, seed: 7 });
  const { toCsv } = await import('../js/csv.js');
  const headers = ['source_row', ...d.headers];
  const rows = result.indices.map((idx) => [String(idx + 2), ...d.rows[idx]]);
  const csv = toCsv(headers, rows);
  const parsed = parseCsv(csv);
  assert.equal(parsed.headers[0], 'source_row');
  assert.equal(parsed.rows.length, 15);
  parsed.rows.forEach((r, i) => assert.equal(Number(r[0]), result.indices[i] + 2));
  // 原表未被修改：演示数据重建后行数一致
  assert.equal(d.rows.length, buildDemoDataset().rows.length);
});

test('统计对照：空值率、类别比例与数值分布均可计算', async () => {
  const d = await demo();
  const result = runSampling(d.rows, d.headers, {
    method: 'stratified', sampleSize: 40, seed: 42,
    stratifyColumn: 'region', allocation: 'proportional',
  });
  const cmp = compareAll(d, result);
  assert.equal(cmp.nullRates.length, d.headers.length);
  assert.ok(cmp.categories.rows.length >= 3);
  const amount = cmp.numerics.find((n) => n.column === 'amount');
  assert.ok(amount.pop.mean > 0 && amount.sample.count > 0);
  assert.equal(amount.histogram.popCounts.reduce((a, b) => a + b, 0), amount.pop.count);
  // 总体与样本共用箱边界
  assert.equal(amount.histogram.edges.length, amount.histogram.popCounts.length + 1);
});

test('样本量扫描：同种子下统计指标随样本量变化', async () => {
  const d = await demo();
  const base = { method: 'stratified', seed: 42, stratifyColumn: 'region', allocation: 'proportional' };
  const sweep = sweepSizes(d, base, [20, 60, 120], (ds, cfg) => runSampling(ds.rows, ds.headers, cfg));
  assert.equal(sweep.length, 3);
  assert.deepEqual(sweep.map((s) => s.actual), [20, 60, 120]);
  assert.ok(sweep.every((s) => Number.isFinite(s.nullDevPctPoints)));
});

test('CSV：引号、字段内逗号与 BOM 往返一致', () => {
  const text = '﻿id,note\n1,"包含,逗号"\n2,"含""引号"""\n3,普通\n';
  const parsed = parseCsv(text);
  assert.equal(parsed.headers[0], 'id');
  assert.deepEqual(parsed.rows[0], ['1', '包含,逗号']);
  assert.deepEqual(parsed.rows[1], ['2', '含"引号"']);
  const out = parseCsv(toCsv(parsed.headers, parsed.rows));
  assert.deepEqual(out.rows, parsed.rows);
});

test('TSV 自动探测分隔符', () => {
  const parsed = parseCsv('a\tb\n1\t2\n');
  assert.equal(parsed.delimiter, '\t');
  assert.deepEqual(parsed.rows, [['1', '2']]);
});

test('日期解析：支持多格式，拒绝模糊/非法日期', () => {
  assert.equal(parseTimestamp('2026-03-04'), Date.UTC(2026, 2, 4));
  assert.equal(parseTimestamp('03/04/2026'), Date.UTC(2026, 2, 4)); // MM/DD/YYYY
  assert.equal(parseTimestamp('2026/03/04'), Date.UTC(2026, 2, 4));
  assert.equal(parseTimestamp('04.03.2026'), Date.UTC(2026, 2, 4)); // DD.MM.YYYY
  assert.equal(parseTimestamp('20260304'), Date.UTC(2026, 2, 4));
  assert.equal(parseTimestamp('2026-02-30'), null, '非法日期');
  assert.equal(parseTimestamp('时间未知'), null);
  assert.equal(parseTimestamp(''), null);
  assert.ok(parseTimestamp('2026-03-04T10:20:00Z') > 0);
});

test('RNG 盐值隔离：不同盐值独立序列，同盐值可复现', () => {
  const a = makeRng(42, 'salt-a');
  const b = makeRng(42, 'salt-b');
  const aAgain = makeRng(42, 'salt-a');
  assert.notEqual(a(), b());
  assert.equal(makeRng(42, 'salt-a')(), aAgain());
  const picked = pickIndices(10, 10, makeRng(1, 'x'));
  assert.equal(picked.length, 10);
  assert.equal(new Set(picked).size, 10);
});
