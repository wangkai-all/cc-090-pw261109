// 抽样核心：列类型推断、简单随机 / 分层 / 时间段抽样、方案构建与校验。
// 纯函数、零 DOM 依赖，浏览器与 Node 测试共用，保证同输入同输出。

import { makeRng, pickIndices } from './prng.js';
import { parseTimestamp, bucketKey } from './date.js';

export const ALGORITHM_VERSION = '1.0.0';

export class SamplingConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SamplingConfigError';
    this.code = code;
  }
}

export function isEmptyValue(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

// ---------- 列类型推断 ----------

export function inferColumnTypes(headers, rows) {
  return headers.map((name, ci) => {
    let nullCount = 0;
    let numericCount = 0;
    let dateCount = 0;
    const valueCounts = new Map();
    for (const row of rows) {
      const raw = row[ci];
      if (isEmptyValue(raw)) {
        nullCount++;
        continue;
      }
      const s = String(raw).trim();
      const n = Number(s);
      if (s !== '' && Number.isFinite(n)) numericCount++;
      if (parseTimestamp(s) !== null) dateCount++;
      valueCounts.set(s, (valueCounts.get(s) || 0) + 1);
    }
    const nonNull = rows.length - nullCount;
    let type = 'categorical';
    if (nonNull === 0) type = 'empty';
    else if (numericCount / nonNull >= 0.9) type = 'numeric';
    else if (dateCount / nonNull >= 0.9) type = 'datetime';
    return {
      name,
      type,
      nullCount,
      nonNull,
      distinct: valueCounts.size,
      numericRate: nonNull ? numericCount / nonNull : 0,
      dateRate: nonNull ? dateCount / nonNull : 0,
    };
  });
}

// ---------- 参数归一化与校验 ----------

export function resolveConfig(input, headers) {
  const method = input.method;
  if (!['simple', 'stratified', 'time'].includes(method)) {
    throw new SamplingConfigError('BAD_METHOD', `未知抽样方式：${String(method)}`);
  }
  const seed = input.seed === '' || input.seed === undefined || input.seed === null ? 42 : input.seed;
  const seedNum = typeof seed === 'number' ? Math.trunc(seed) : Number(seed);
  if (!Number.isFinite(seedNum)) {
    throw new SamplingConfigError('BAD_SEED', '随机种子必须是整数（或可转为整数的值）。');
  }
  const sampleSize = Math.floor(Number(input.sampleSize));
  if (!Number.isFinite(sampleSize) || sampleSize <= 0) {
    throw new SamplingConfigError('BAD_SAMPLE_SIZE', '样本量必须是正整数。');
  }

  const cfg = { method, seed: seedNum, sampleSize };

  if (method === 'stratified') {
    if (!headers.includes(input.stratifyColumn)) {
      throw new SamplingConfigError('BAD_COLUMN', `分层字段“${input.stratifyColumn}”不存在，可能输入表结构已变化。`);
    }
    cfg.stratifyColumn = input.stratifyColumn;
    cfg.allocation = input.allocation === 'floor' ? 'floor' : 'proportional';
    const floor = Math.floor(Number(input.floorPerStratum));
    if (cfg.allocation === 'floor' && (!Number.isFinite(floor) || floor < 1)) {
      throw new SamplingConfigError('BAD_FLOOR', '每层保底数量必须是不小于 1 的整数。');
    }
    cfg.floorPerStratum = Number.isFinite(floor) ? floor : 1;
  }

  if (method === 'time') {
    if (!headers.includes(input.timeColumn)) {
      throw new SamplingConfigError('BAD_COLUMN', `时间字段“${input.timeColumn}”不存在，可能输入表结构已变化。`);
    }
    cfg.timeColumn = input.timeColumn;
    cfg.timeGranularity = ['hour', 'day', 'week', 'month'].includes(input.timeGranularity)
      ? input.timeGranularity : 'day';
    const blockLength = Math.floor(Number(input.blockLength));
    cfg.blockLength = Number.isFinite(blockLength) && blockLength >= 1 ? blockLength : 1;
    cfg.timeMode = input.timeMode === 'targetRows' ? 'targetRows' : 'blocks';
  }

  return cfg;
}

// ---------- 分层分配 ----------

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

// 在仍有容量的层之间，按剩余容量比例用最大余数法分配 remaining 个名额
function distributeByCapacity(alloc, sizes, remaining) {
  while (remaining > 0) {
    const capacity = sizes.map((h, j) => h - alloc[j]);
    const totalCap = sum(capacity);
    if (totalCap === 0) break;
    const quotas = capacity.map((c) => (remaining * c) / totalCap);
    const add = quotas.map(Math.floor);
    let rem = remaining - sum(add);
    const order = alloc
      .map((_, j) => j)
      .sort((a, b) => quotas[b] - Math.floor(quotas[b]) - (quotas[a] - Math.floor(quotas[a])) || a - b);
    let addedThisRound = 0;
    for (const j of order) {
      if (rem === 0) break;
      if (alloc[j] + add[j] + 1 <= sizes[j]) {
        add[j]++;
        rem--;
        addedThisRound++;
      }
    }
    for (let j = 0; j < alloc.length; j++) alloc[j] += add[j];
    remaining -= sum(add);
    if (addedThisRound === 0) break;
  }
}

// 按比例分配：名额 = n × 层占比；超过层容量的名额收回后再分配给有容量的层
function proportionalAllocation(sizes, n) {
  const N = sum(sizes);
  const target = Math.min(n, N);
  const quotas = sizes.map((h) => (target * h) / N);
  const alloc = quotas.map(Math.floor);
  let remaining = target - sum(alloc);
  const order = alloc
    .map((_, j) => j)
    .sort((a, b) => quotas[b] - Math.floor(quotas[b]) - (quotas[a] - Math.floor(quotas[a])) || a - b);
  for (const j of order) {
    if (remaining === 0) break;
    alloc[j]++;
    remaining--;
  }
  // 容量回收：稀有层拿不下的名额让给其他层，绝不复制记录凑数
  let guard = 0;
  while (guard++ < 1000) {
    const over = alloc.filter((a, j) => a > sizes[j]);
    if (over.length === 0) break;
    let freed = 0;
    for (let j = 0; j < alloc.length; j++) {
      if (alloc[j] > sizes[j]) {
        freed += alloc[j] - sizes[j];
        alloc[j] = sizes[j];
      }
    }
    distributeByCapacity(alloc, sizes, freed);
  }
  return alloc;
}

// 每层保底分配：先满足 min(保底, 层容量)，剩余名额按剩余容量比例分配
function floorAllocation(sizes, n, floor) {
  const alloc = sizes.map((h) => Math.min(floor, h));
  const minimum = sum(alloc);
  if (minimum > n) {
    throw new SamplingConfigError(
      'FLOOR_EXCEEDS_TARGET',
      `每层保底 ${floor} 条，所有层至少需要 ${minimum} 条，超过目标样本量 ${n}。请调大样本量或调小保底数量。`,
    );
  }
  distributeByCapacity(alloc, sizes, n - minimum);
  return alloc;
}

// ---------- 三种抽样 ----------

export function simpleRandomSample(rows, cfg) {
  const warnings = [];
  const n = cfg.sampleSize;
  const N = rows.length;
  if (n >= N) {
    warnings.push({
      level: 'warning',
      code: 'SAMPLE_LARGER_THAN_POPULATION',
      message: `目标样本量 ${n} 不小于总体行数 ${N}，实际返回全部 ${N} 行（未复制任何记录）。`,
    });
  }
  const rng = makeRng(cfg.seed, 'simple');
  const indices = pickIndices(N, Math.min(n, N), rng).sort((a, b) => a - b);
  return {
    indices,
    totalRequested: n,
    actualSize: indices.length,
    population: N,
    warnings,
    strata: null,
    blocks: null,
    timeCoverage: null,
  };
}

export function stratifiedSample(rows, headers, cfg) {
  const warnings = [];
  const ci = headers.indexOf(cfg.stratifyColumn);
  const groupsMap = new Map();
  let nullRows = 0;
  rows.forEach((row, idx) => {
    const raw = row[ci];
    if (isEmptyValue(raw)) {
      nullRows++;
      if (!groupsMap.has(null)) groupsMap.set(null, []);
      groupsMap.get(null).push(idx);
      return;
    }
    const key = String(raw).trim();
    if (!groupsMap.has(key)) groupsMap.set(key, []);
    groupsMap.get(key).push(idx);
  });

  // 稳定排序：类别按名称、空值层放最后
  const keys = [...groupsMap.keys()].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a.localeCompare(b, 'zh-Hans-CN');
  });
  const sizes = keys.map((k) => groupsMap.get(k).length);
  const N = rows.length;

  let alloc;
  if (cfg.allocation === 'floor') {
    alloc = floorAllocation(sizes, cfg.sampleSize, cfg.floorPerStratum);
  } else {
    alloc = proportionalAllocation(sizes, cfg.sampleSize);
  }

  const indices = [];
  const strata = keys.map((key, j) => {
    const members = groupsMap.get(key);
    const requested = alloc[j];
    const rng = makeRng(cfg.seed, `strat:${key === null ? '__NULL__' : key}`);
    const picked = pickIndices(members.length, requested, rng);
    const actualIndices = picked.map((p) => members[p]);
    indices.push(...actualIndices);
    const shortfall = requested > sizes[j] ? requested - sizes[j] : 0;
    if (requested > sizes[j] || (cfg.allocation === 'floor' && sizes[j] < cfg.floorPerStratum)) {
      warnings.push({
        level: 'warning',
        code: 'STRATUM_SHORTFALL',
        message: `层“${key === null ? '(空值)' : key}”总体仅 ${sizes[j]} 行${
          cfg.allocation === 'floor' ? `，低于每层保底 ${cfg.floorPerStratum} 条` : ''
        }，实际抽取 ${Math.min(requested, sizes[j])} 条，不复制记录凑数。`,
      });
    }
    return {
      key: key === null ? null : key,
      label: key === null ? '(空值)' : key,
      population: sizes[j],
      requested,
      actual: actualIndices.length,
      shortfall,
      populationProportion: sizes[j] / N,
      sampleProportion: 0, // 总量确定后回填
      deviationPctPoints: 0,
      isNullStratum: key === null,
      belowFloor: cfg.allocation === 'floor' && sizes[j] < cfg.floorPerStratum,
    };
  });

  indices.sort((a, b) => a - b);
  const actualTotal = indices.length;
  for (const s of strata) {
    s.sampleProportion = actualTotal ? s.actual / actualTotal : 0;
    s.deviationPctPoints = (s.sampleProportion - s.populationProportion) * 100;
  }
  if (nullRows > 0) {
    warnings.push({
      level: 'warning',
      code: 'NULL_STRATUM',
      message: `分层字段“${cfg.stratifyColumn}”有 ${nullRows} 行为空，已归入“(空值)”层单独抽样，未与其他类别混合。`,
    });
  }
  if (actualTotal < cfg.sampleSize) {
    warnings.push({
      level: 'warning',
      code: 'UNDERFULL_SAMPLE',
      message: `目标样本量 ${cfg.sampleSize}，受各层容量限制实际仅 ${actualTotal} 行；差额 ${
        cfg.sampleSize - actualTotal
      } 条未通过复制记录补齐。`,
    });
  }
  return {
    indices,
    totalRequested: cfg.sampleSize,
    actualSize: actualTotal,
    population: N,
    warnings,
    strata,
    blocks: null,
    timeCoverage: null,
  };
}

export function timeSegmentSample(rows, headers, cfg) {
  const warnings = [];
  const ci = headers.indexOf(cfg.timeColumn);
  const valid = [];
  const invalidRows = [];
  for (let idx = 0; idx < rows.length; idx++) {
    const ts = parseTimestamp(rows[idx][ci]);
    if (ts === null) {
      if (invalidRows.length < 20) invalidRows.push(idx + 2); // 1 起含表头
      continue;
    }
    valid.push({ idx, ts });
  }

  if (valid.length === 0) {
    throw new SamplingConfigError(
      'NO_VALID_TIMESTAMP',
      `时间字段“${cfg.timeColumn}”没有可解析的时间值，请检查格式或更换字段。`,
    );
  }

  const bucketMap = new Map();
  for (const item of valid) {
    const key = bucketKey(item.ts, cfg.timeGranularity);
    if (!bucketMap.has(key)) bucketMap.set(key, []);
    bucketMap.get(key).push(item);
  }
  const bucketKeys = [...bucketMap.keys()].sort();
  const buckets = bucketKeys.map((key) => ({
    key,
    rows: bucketMap.get(key).map((v) => v.idx),
  }));

  // 连续块：按时间顺序把相邻桶切成每块 blockLength 个桶
  const blocks = [];
  for (let i = 0; i < buckets.length; i += cfg.blockLength) {
    const slice = buckets.slice(i, i + cfg.blockLength);
    blocks.push({
      startKey: slice[0].key,
      endKey: slice[slice.length - 1].key,
      indices: slice.flatMap((b) => b.rows),
      rowCount: slice.reduce((acc, b) => acc + b.rows.length, 0),
    });
  }

  let blockCountWanted;
  if (cfg.timeMode === 'targetRows') {
    const avgRowsPerBlock = valid.length / blocks.length;
    blockCountWanted = Math.max(1, Math.ceil(cfg.sampleSize / avgRowsPerBlock));
  } else {
    blockCountWanted = cfg.sampleSize;
  }
  if (blockCountWanted >= blocks.length) {
    warnings.push({
      level: 'warning',
      code: 'BLOCKS_LARGER_THAN_RANGE',
      message: `需要 ${blockCountWanted} 个连续区间，全表只有 ${blocks.length} 个，实际返回全部区间（未打散、未复制）。`,
    });
  }
  const rng = makeRng(cfg.seed, `time:${cfg.timeGranularity}:${cfg.blockLength}:${cfg.timeMode}`);
  const chosenBlockPos = pickIndices(blocks.length, Math.min(blockCountWanted, blocks.length), rng).sort(
    (a, b) => a - b,
  );

  const indices = [];
  const blockReport = blocks.map((b, pos) => ({
    startKey: b.startKey,
    endKey: b.endKey,
    rowCount: b.rowCount,
    selected: chosenBlockPos.includes(pos),
  }));
  for (const pos of chosenBlockPos) indices.push(...blocks[pos].indices);
  indices.sort((a, b) => a - b);

  const tsValues = valid.map((v) => v.ts);
  const timeCoverage = {
    validRows: valid.length,
    invalidRows: rows.length - valid.length,
    invalidRowSample: invalidRows,
    earliest: new Date(Math.min(...tsValues)).toISOString(),
    latest: new Date(Math.max(...tsValues)).toISOString(),
    granularity: cfg.timeGranularity,
    blockCount: blocks.length,
    selectedBlockCount: chosenBlockPos.length,
  };

  if (timeCoverage.invalidRows > 0) {
    warnings.push({
      level: 'warning',
      code: 'UNPARSEABLE_TIME',
      message: `时间字段有 ${timeCoverage.invalidRows} 行无法解析（如第 ${invalidRows.slice(0, 5).join('、')}${
        invalidRows.length > 5 ? ' 等' : ''
      } 行），未纳入时间抽样。可解析范围：${timeCoverage.earliest} 至 ${timeCoverage.latest}（UTC）。`,
    });
  }
  if (cfg.timeMode === 'targetRows') {
    warnings.push({
      level: 'info',
      code: 'TIME_TARGET_APPROX',
      message: `按目标行数 ${cfg.sampleSize} 估算需 ${blockCountWanted} 个连续区间，区间整体选取、不打散，实际得到 ${indices.length} 行。`,
    });
  }
  const emptyBlocks = blocks.filter((b) => b.rowCount === 0).length;
  if (emptyBlocks > 0) {
    warnings.push({
      level: 'info',
      code: 'EMPTY_BLOCKS',
      message: `有 ${emptyBlocks} 个区间在所选粒度内无记录（时间空档），选中时贡献 0 行，属正常现象。`,
    });
  }

  return {
    indices,
    totalRequested: cfg.sampleSize,
    actualSize: indices.length,
    population: rows.length,
    warnings,
    strata: null,
    blocks: blockReport,
    timeCoverage,
  };
}

// ---------- 统一入口 ----------

export function runSampling(rows, headers, rawConfig) {
  const cfg = resolveConfig(rawConfig, headers);
  let result;
  if (cfg.method === 'simple') result = simpleRandomSample(rows, cfg);
  else if (cfg.method === 'stratified') result = stratifiedSample(rows, headers, cfg);
  else result = timeSegmentSample(rows, headers, cfg);
  result.config = cfg;
  return result;
}

// ---------- 方案：构建、校验、复现 ----------

export function buildPlan(params, dataset) {
  const cfg = resolveConfig(params, dataset.headers);
  return {
    schemaVersion: 1,
    algorithm: `local-sampling-lab@${ALGORITHM_VERSION}`,
    createdAt: new Date().toISOString(),
    dataset: {
      name: dataset.name,
      fingerprint: dataset.fingerprint,
      rowCount: dataset.rows.length,
      columnCount: dataset.headers.length,
    },
    seed: cfg.seed,
    params: cfg,
  };
}

export function verifyPlan(plan, dataset) {
  const errors = [];
  const warnings = [];
  if (!plan || typeof plan !== 'object') {
    return { ok: false, errors: [{ code: 'BAD_PLAN', message: '方案文件结构无效。' }], warnings };
  }
  if (plan.algorithm !== `local-sampling-lab@${ALGORITHM_VERSION}`) {
    warnings.push({
      code: 'ALGORITHM_VERSION_MISMATCH',
      message: `方案由 ${plan.algorithm || '未知版本'} 生成，当前算法版本为 ${ALGORITHM_VERSION}，结果可能不同。`,
    });
  }
  const fp = plan.dataset && plan.dataset.fingerprint;
  if (!fp) {
    errors.push({ code: 'NO_FINGERPRINT', message: '方案缺少输入指纹，无法确认输入一致性。' });
  } else if (fp !== dataset.fingerprint) {
    errors.push({
      code: 'FINGERPRINT_MISMATCH',
      message: '输入指纹不一致：当前表与生成方案时的表内容不同，旧样本已失效，不能声称仍可复现。请基于当前表重新生成方案。',
    });
  }
  if (plan.dataset && plan.dataset.rowCount !== undefined && plan.dataset.rowCount !== dataset.rows.length) {
    errors.push({ code: 'ROW_COUNT_MISMATCH', message: `行数不一致：方案记录 ${plan.dataset.rowCount} 行，当前表 ${dataset.rows.length} 行。` });
  }
  if (plan.dataset && plan.dataset.columnCount !== undefined && plan.dataset.columnCount !== dataset.headers.length) {
    errors.push({ code: 'COLUMN_COUNT_MISMATCH', message: `列数不一致：方案记录 ${plan.dataset.columnCount} 列，当前表 ${dataset.headers.length} 列。` });
  }
  const neededCols = [];
  if (plan.params && plan.params.method === 'stratified') neededCols.push(plan.params.stratifyColumn);
  if (plan.params && plan.params.method === 'time') neededCols.push(plan.params.timeColumn);
  for (const col of neededCols) {
    if (!dataset.headers.includes(col)) {
      errors.push({ code: 'COLUMN_MISSING', message: `方案依赖的字段“${col}”在当前表中不存在。` });
    }
  }
  try {
    resolveConfig(plan.params || {}, dataset.headers);
  } catch (e) {
    if (e instanceof SamplingConfigError) errors.push({ code: e.code, message: e.message });
    else errors.push({ code: 'BAD_PARAMS', message: String(e.message || e) });
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function replayPlan(plan, dataset) {
  const verification = verifyPlan(plan, dataset);
  if (!verification.ok) {
    const err = new SamplingConfigError('PLAN_INVALID', '方案已失效，无法复现。');
    err.verification = verification;
    throw err;
  }
  const result = runSampling(dataset.rows, dataset.headers, plan.params);
  result.planVerification = verification;
  return result;
}
