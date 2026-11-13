// 总体 vs 样本的统计对照：类别比例、空值率、数值分布（分位数 + 直方图），
// 以及样本量扫描用的差异指标。

import { isEmptyValue } from './sampling.js';

function numericValues(rows, ci) {
  const out = [];
  for (const row of rows) {
    const raw = row[ci];
    if (isEmptyValue(raw)) continue;
    const n = Number(String(raw).trim());
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
}

function summary(values) {
  if (values.length === 0) {
    return { count: 0, mean: null, sd: null, min: null, p25: null, median: null, p75: null, max: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1)
    : 0;
  return {
    count: values.length,
    mean,
    sd: Math.sqrt(variance),
    min: sorted[0],
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    max: sorted[sorted.length - 1],
  };
}

// 总体与样本共用同一组分箱边界，保证两张直方图可直接对照
function sharedHistogram(popValues, sampleValues, bins = 12) {
  const all = [...popValues, ...sampleValues];
  if (all.length === 0) return { edges: [], popCounts: [], sampleCounts: [] };
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  if (lo === hi) {
    return {
      edges: [lo, hi],
      popCounts: [popValues.length],
      sampleCounts: [sampleValues.length],
      singleValue: lo,
    };
  }
  const width = (hi - lo) / bins;
  const edges = Array.from({ length: bins + 1 }, (_, i) => lo + i * width);
  const popCounts = new Array(bins).fill(0);
  const sampleCounts = new Array(bins).fill(0);
  const assign = (v, counts) => {
    let b = Math.floor((v - lo) / width);
    if (b >= bins) b = bins - 1; // 最大值归入末箱
    counts[b]++;
  };
  for (const v of popValues) assign(v, popCounts);
  for (const v of sampleValues) assign(v, sampleCounts);
  return { edges, popCounts, sampleCounts, width };
}

export function nullRateTable(headers, popRows, sampleRows) {
  return headers.map((name, ci) => {
    const popNulls = popRows.filter((r) => isEmptyValue(r[ci])).length;
    const sampleNulls = sampleRows.filter((r) => isEmptyValue(r[ci])).length;
    return {
      column: name,
      popNulls,
      popRate: popRows.length ? popNulls / popRows.length : 0,
      sampleNulls,
      sampleRate: sampleRows.length ? sampleNulls / sampleRows.length : 0,
      deviationPctPoints:
        (sampleRows.length ? sampleNulls / sampleRows.length : 0) -
        (popRows.length ? popNulls / popRows.length : 0),
    };
  });
}

export function categoryTable(headers, columnTypes, stratifyColumn, popRows, sampleRows) {
  const ci = headers.indexOf(stratifyColumn);
  if (ci < 0) return null;
  const popCounts = new Map();
  const sampleCounts = new Map();
  let popNulls = 0;
  let sampleNulls = 0;
  for (const r of popRows) {
    if (isEmptyValue(r[ci])) { popNulls++; continue; }
    const k = String(r[ci]).trim();
    popCounts.set(k, (popCounts.get(k) || 0) + 1);
  }
  for (const r of sampleRows) {
    if (isEmptyValue(r[ci])) { sampleNulls++; continue; }
    const k = String(r[ci]).trim();
    sampleCounts.set(k, (sampleCounts.get(k) || 0) + 1);
  }
  const keys = [...new Set([...popCounts.keys(), ...sampleCounts.keys()])].sort((a, b) =>
    a.localeCompare(b, 'zh-Hans-CN'));
  const rows = keys.map((k) => {
    const pCount = popCounts.get(k) || 0;
    const sCount = sampleCounts.get(k) || 0;
    const pRate = popRows.length ? pCount / popRows.length : 0;
    const sRate = sampleRows.length ? sCount / sampleRows.length : 0;
    return {
      key: k,
      popCount: pCount,
      sampleCount: sCount,
      popRate: pRate,
      sampleRate: sRate,
      deviationPctPoints: (sRate - pRate) * 100,
      popExpectedInSample: pRate * sampleRows.length,
    };
  });
  if (popNulls > 0 || sampleNulls > 0) {
    rows.push({
      key: null,
      label: '(空值)',
      popCount: popNulls,
      sampleCount: sampleNulls,
      popRate: popRows.length ? popNulls / popRows.length : 0,
      sampleRate: sampleRows.length ? sampleNulls / sampleRows.length : 0,
      deviationPctPoints:
        ((sampleRows.length ? sampleNulls / sampleRows.length : 0) -
          (popRows.length ? popNulls / popRows.length : 0)) * 100,
    });
  }
  return {
    column: stratifyColumn,
    rows,
    rareFlag: rows
      .filter((r) => r.popRate > 0 && r.popRate < 0.05)
      .map((r) => r.key ?? '(空值)'),
  };
}

export function numericCompare(headers, columnTypes, popRows, sampleRows) {
  return columnTypes
    .filter((c) => c.type === 'numeric')
    .map((c) => {
      const ci = headers.indexOf(c.name);
      const popValues = numericValues(popRows, ci);
      const sampleValues = numericValues(sampleRows, ci);
      return {
        column: c.name,
        pop: summary(popValues),
        sample: summary(sampleValues),
        histogram: sharedHistogram(popValues, sampleValues),
      };
    });
}

export function compareAll(dataset, result) {
  const sampleRows = result.indices.map((i) => dataset.rows[i]);
  return {
    sampleRows,
    nullRates: nullRateTable(dataset.headers, dataset.rows, sampleRows),
    categories: result.config.method === 'stratified'
      ? categoryTable(dataset.headers, dataset.columnTypes, result.config.stratifyColumn, dataset.rows, sampleRows)
      : null,
    numerics: numericCompare(dataset.headers, dataset.columnTypes, dataset.rows, sampleRows),
  };
}

// 样本量扫描：对不同样本量重跑同一配置，汇总差异指标
export function sweepSizes(dataset, baseConfig, sizes, runFn) {
  return sizes.map((n) => {
    const result = runFn(dataset, { ...baseConfig, sampleSize: n });
    const sampleRows = result.indices.map((i) => dataset.rows[i]);
    const nullDev = nullRateTable(dataset.headers, dataset.rows, sampleRows).reduce(
      (acc, r) => Math.max(acc, Math.abs(r.deviationPctPoints)), 0);
    let catDev = 0;
    if (result.config.method === 'stratified') {
      const cat = categoryTable(
        dataset.headers, dataset.columnTypes, result.config.stratifyColumn, dataset.rows, sampleRows);
      catDev = Math.max(...cat.rows.map((r) => Math.abs(r.deviationPctPoints)));
    }
    const numDevs = numericCompare(dataset.headers, dataset.columnTypes, dataset.rows, sampleRows).map((nc) => ({
      column: nc.column,
      meanRelDev: nc.pop.mean ? Math.abs((nc.sample.mean - nc.pop.mean) / nc.pop.mean) : 0,
    }));
    return {
      requested: n,
      actual: result.actualSize,
      nullDevPctPoints: nullDev * 100,
      catDevPctPoints: catDev,
      meanRelDev: numDevs.length ? numDevs.reduce((a, x) => a + x.meanRelDev, 0) / numDevs.length : 0,
      warnings: result.warnings.filter((w) => w.level !== 'info').length,
    };
  });
}
