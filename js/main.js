import { parseCsv, toCsv } from './csv.js';
import { fingerprintDataset, fingerprintIndices } from './fingerprint.js';
import { buildPlan, verifyPlan, replayPlan, runSampling, inferColumnTypes, ALGORITHM_VERSION, SamplingConfigError } from './sampling.js';
import { compareAll, sweepSizes } from './stats.js';
import { groupedBarChart, histogramChart, lineChart, attachTableToggle } from './charts.js';
import { buildDemoDataset } from './demo.js';

// ---------- 全局状态 ----------

const state = {
  dataset: null, // { name, rawText, fingerprint, headers, rows, columnTypes }
  plan: null,
  result: null,
  comparison: null,
  resultFingerprint: null,
};

const $ = (id) => document.getElementById(id);
const els = {};
[
  'file-input', 'demo-btn', 'dataset-meta', 'ingest-warnings', 'config-form', 'sample-size', 'seed',
  'stratified-options', 'time-options', 'stratify-column', 'time-column', 'floor-row', 'floor-per-stratum',
  'time-granularity', 'block-length', 'run-btn', 'replay-btn', 'config-error', 'plan-status',
  'export-plan-btn', 'import-plan-input', 'sweep-sizes', 'sweep-btn', 'empty-state', 'results',
  'summary-tiles', 'result-warnings', 'coverage-panel', 'strata-panel', 'blocks-panel',
  'cat-chart', 'cat-table-toggle', 'null-table', 'numeric-panels', 'sample-preview',
  'sweep-result', 'sweep-chart', 'sweep-table-toggle', 'export-sample-btn', 'export-stats-btn',
  'theme-toggle',
].forEach((id) => { els[id] = $(id); });

// ---------- 通用工具 ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pct(v, digits = 1) { return `${(v * 100).toFixed(digits)}%`; }
function pp(v, digits = 2) { return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`; }
function fmt(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return Number(v).toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

function renderWarnings(container, warnings) {
  container.innerHTML = '';
  if (!warnings || warnings.length === 0) {
    container.innerHTML = '<div class="warn-item info"><span>✓</span><span>本次抽样无告警。</span></div>';
    return;
  }
  for (const w of warnings) {
    const div = document.createElement('div');
    div.className = `warn-item ${w.level || 'warning'}`;
    div.innerHTML = `<span class="code">${esc(w.code)}</span><span>${esc(w.message)}</span>`;
    container.appendChild(div);
  }
}

function download(filename, content, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- 主题 ----------

function initTheme() {
  const saved = localStorage.getItem('sampling-lab-theme');
  const dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  els['theme-toggle'].textContent = dark ? '☀️ 亮色' : '🌙 暗色';
}
els['theme-toggle'].addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  localStorage.setItem('sampling-lab-theme', dark ? 'dark' : 'light');
  els['theme-toggle'].textContent = dark ? '☀️ 亮色' : '🌙 暗色';
  if (state.result) renderResults(); // 重绘图表以换色
});
initTheme();

// ---------- 数据载入 ----------

async function loadDataset(name, rawText, ingestWarnings = []) {
  const parsed = parseCsv(rawText);
  if (parsed.warnings.some((w) => w.code === 'EMPTY_FILE')) {
    showConfigError(parsed.warnings[0].message);
    return;
  }
  const fingerprint = await fingerprintDataset(name, rawText);
  const columnTypes = inferColumnTypes(parsed.headers, parsed.rows);
  const stalePlan = state.plan
    ? { ...state.plan, _stale: true, _invalidReason: `输入已替换为“${name}”，旧方案指纹不再匹配` }
    : null;
  state.dataset = {
    name, rawText, fingerprint,
    headers: parsed.headers,
    rows: parsed.rows,
    columnTypes,
  };
  state.plan = stalePlan;
  state.result = null;
  state.comparison = null;
  state.resultFingerprint = null;

  els['dataset-meta'].innerHTML = `
    <strong>${esc(name)}</strong><br>
    行数 <strong>${parsed.rows.length}</strong> · 列数 <strong>${parsed.headers.length}</strong> ·
    分隔符 <strong>${parsed.delimiter === '\t' ? 'Tab' : esc(parsed.delimiter)}</strong><br>
    输入指纹 <code>${fingerprint.slice(0, 16)}…</code><br>
    <span class="muted small">完整指纹：${fingerprint}</span>`;
  renderWarnings(els['ingest-warnings'], [...ingestWarnings, ...parsed.warnings]);

  fillColumnSelects();
  els['run-btn'].disabled = false;
  els['sweep-btn'].disabled = false;
  els['replay-btn'].disabled = true;
  els['export-plan-btn'].disabled = true;
  els['empty-state'].classList.remove('hidden');
  els['results'].classList.add('hidden');
  els['sweep-result'].classList.add('hidden');
  renderPlanStatus();
}

function fillColumnSelects() {
  const { headers, columnTypes } = state.dataset;
  els['stratify-column'].innerHTML = headers
    .map((h, i) => `<option value="${esc(h)}" ${columnTypes[i].type === 'categorical' ? '' : ''}>${esc(h)}（${typeLabel(columnTypes[i].type)}）</option>`).join('');
  // 分层字段默认选第一个类别列
  const firstCat = columnTypes.find((c) => c.type === 'categorical');
  if (firstCat) els['stratify-column'].value = firstCat.name;
  els['time-column'].innerHTML = headers
    .map((h) => `<option value="${esc(h)}">${esc(h)}${columnTypes.find((c) => c.name === h).type === 'datetime' ? '（时间）' : ''}</option>`).join('');
  const firstDate = columnTypes.find((c) => c.type === 'datetime');
  if (firstDate) els['time-column'].value = firstDate.name;
}

function typeLabel(t) {
  return { numeric: '数值', categorical: '类别', datetime: '时间', empty: '空列' }[t] || t;
}

els['file-input'].addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  await loadDataset(file.name, text);
  e.target.value = '';
});

els['demo-btn'].addEventListener('click', async () => {
  const demo = buildDemoDataset();
  await loadDataset(demo.name, demo.rawText, [
    { level: 'info', code: 'DEMO_DATA', message: '演示数据为确定性生成，包含稀有类别（东北/西北）、空字段与多种混乱时间格式，可直接试验各种告警分支。' },
  ]);
});

// ---------- 表单联动 ----------

document.querySelectorAll('input[name="method"]').forEach((radio) => {
  radio.addEventListener('change', syncConditionalFields);
});
document.querySelectorAll('input[name="allocation"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    els['floor-row'].classList.toggle('hidden', getAllocation() !== 'floor');
  });
});

function getMethod() {
  return document.querySelector('input[name="method"]:checked').value;
}
function getAllocation() {
  return document.querySelector('input[name="allocation"]:checked').value;
}
function getTimeMode() {
  return document.querySelector('input[name="time-mode"]:checked').value;
}

function syncConditionalFields() {
  const method = getMethod();
  const isStrat = method === 'stratified';
  const isTime = method === 'time';
  els['stratified-options'].classList.toggle('hidden', !isStrat);
  els['stratified-options'].disabled = !isStrat;
  els['time-options'].classList.toggle('hidden', !isTime);
  els['time-options'].disabled = !isTime;
  els['floor-row'].classList.toggle('hidden', getAllocation() !== 'floor' || !isStrat);
  // 时间模式下“样本量”含义随口径变化
  const sizeLabel = document.querySelector('label[for="sample-size"]');
  sizeLabel.textContent = isTime && getTimeMode() === 'blocks' ? '样本量（区间个数）' : '样本量（行）';
}
document.querySelectorAll('input[name="time-mode"]').forEach((radio) => {
  radio.addEventListener('change', syncConditionalFields);
});
syncConditionalFields();

function readFormConfig() {
  const cfg = {
    method: getMethod(),
    sampleSize: Number($('sample-size').value),
    seed: $('seed').value === '' ? 42 : Number($('seed').value),
  };
  if (cfg.method === 'stratified') {
    cfg.stratifyColumn = $('stratify-column').value;
    cfg.allocation = getAllocation();
    cfg.floorPerStratum = Number($('floor-per-stratum').value);
  }
  if (cfg.method === 'time') {
    cfg.timeColumn = $('time-column').value;
    cfg.timeGranularity = $('time-granularity').value;
    cfg.blockLength = Number($('block-length').value);
    cfg.timeMode = getTimeMode();
  }
  return cfg;
}

function showConfigError(message) {
  els['config-error'].textContent = message;
  els['config-error'].classList.remove('hidden');
}
function clearConfigError() {
  els['config-error'].classList.add('hidden');
}

// ---------- 方案生命周期 ----------

async function generatePlan() {
  clearConfigError();
  if (!state.dataset) return;
  const params = readFormConfig();
  let plan;
  try {
    plan = buildPlan(params, state.dataset);
    // 完整跑一遍以触发仅在执行期出现的配置错误（如保底总和超过样本量）
    runSampling(state.dataset.rows, state.dataset.headers, params);
  } catch (e) {
    if (e instanceof SamplingConfigError) return showConfigError(e.message);
    throw e;
  }
  state.plan = plan;
  await executeAndRender(plan);
}

async function executeAndRender(plan) {
  const result = runSampling(state.dataset.rows, state.dataset.headers, plan.params);
  state.result = result;
  state.comparison = compareAll(state.dataset, result);
  state.resultFingerprint = await fingerprintIndices(result.indices);
  els['replay-btn'].disabled = false;
  els['export-plan-btn'].disabled = false;
  renderPlanStatus();
  renderResults();
}

function renderPlanStatus() {
  const el = els['plan-status'];
  if (!state.plan) {
    el.className = 'plan-status muted';
    el.textContent = '尚未生成方案。';
    return;
  }
  const plan = state.plan;
  const verification = verifyPlan(plan, state.dataset);
  if (!verification.ok) {
    el.className = 'plan-status invalid';
    el.innerHTML = `⛔ <b>方案已失效</b>（${esc(plan._invalidReason || '输入已变化')}）<br>` +
      verification.errors.map((e) => `· <span class="code">${esc(e.code)}</span> ${esc(e.message)}`).join('<br>') +
      '<br><span class="muted small">旧样本不能声称仍可复现，请重新生成方案。</span>';
    return;
  }
  el.className = 'plan-status valid';
  const p = plan.params;
  const methodLabel = { simple: '简单随机', stratified: '分层', time: '时间段' }[p.method];
  el.innerHTML = `✓ <b>方案有效</b> · ${methodLabel}抽样 · 算法 ${esc(plan.algorithm)}<br>
    种子 <code>${esc(p.seed)}</code> · 目标样本量 <code>${esc(p.sampleSize)}</code>${
    p.method === 'stratified'
      ? ` · 分层字段 <code>${esc(p.stratifyColumn)}</code> · 分配 <code>${p.allocation === 'floor' ? `每层保底 ${p.floorPerStratum}` : '按比例'}</code>`
      : ''
  }${
    p.method === 'time'
      ? ` · 时间字段 <code>${esc(p.timeColumn)}</code> · 粒度 <code>${esc(p.timeGranularity)}</code> · 区间 ${esc(p.blockLength)} 桶 · 口径 <code>${p.timeMode === 'blocks' ? '区间数' : '目标行数'}</code>`
      : ''
  }<br>
    输入指纹 <code>${esc(plan.dataset.fingerprint.slice(0, 24))}…</code><br>
    结果指纹 <code>${esc(state.resultFingerprint ? state.resultFingerprint.slice(0, 24) + '…' : '—')}</code><br>
    <span class="muted small">生成时间 ${esc(plan.createdAt)}；输入一旦变化，指纹校验将立即判定失效。</span>`;
}

els['config-form'].addEventListener('submit', (e) => {
  e.preventDefault();
  generatePlan();
});

els['replay-btn'].addEventListener('click', async () => {
  if (!state.plan || !state.dataset) return;
  clearConfigError();
  try {
    const result = replayPlan(state.plan, state.dataset);
    const fp = await fingerprintIndices(result.indices);
    const same = fp === state.resultFingerprint;
    const replayed = await fingerprintIndices(result.indices);
    state.result = result;
    state.comparison = compareAll(state.dataset, result);
    state.resultFingerprint = replayed;
    renderPlanStatus();
    renderResults();
    const note = same
      ? { level: 'info', code: 'REPLAY_MATCH', message: '复现成功：来源行号集合与上次结果完全一致（结果指纹匹配）。' }
      : { level: 'error', code: 'REPLAY_MISMATCH', message: '复现结果与上次不一致，请检查算法版本或输入是否被替换。' };
    renderWarnings(els['result-warnings'], [note, ...result.warnings, ...(result.planVerification?.warnings || [])]);
  } catch (e) {
    if (e instanceof SamplingConfigError && e.verification) {
      renderPlanStatus();
      showConfigError('方案已失效，无法复现：' + e.verification.errors.map((x) => x.message).join('；'));
    } else if (e instanceof SamplingConfigError) {
      showConfigError(e.message);
    } else throw e;
  }
});

// 方案导入/导出
els['export-plan-btn'].addEventListener('click', () => {
  if (!state.plan) return;
  const clean = { ...state.plan };
  delete clean._invalidReason;
  download(`sampling-plan-${Date.now()}.json`, JSON.stringify(clean, null, 2), 'application/json;charset=utf-8');
});

els['import-plan-input'].addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !state.dataset) {
    showConfigError('请先载入数据表，再导入方案进行复现。');
    return;
  }
  try {
    const plan = JSON.parse(await file.text());
    const verification = verifyPlan(plan, state.dataset);
    if (!verification.ok) {
      state.plan = { ...plan, _invalidReason: '导入方案与当前输入不匹配' };
      renderPlanStatus();
      showConfigError('方案校验失败：' + verification.errors.map((x) => x.message).join('；'));
      return;
    }
    state.plan = plan;
    await executeAndRender(plan);
    if (verification.warnings.length) {
      renderWarnings(els['result-warnings'], [...verification.warnings, ...state.result.warnings]);
    }
  } catch (err) {
    showConfigError('方案文件解析失败：' + err.message);
  }
});

// ---------- 结果渲染 ----------

function renderResults() {
  const { dataset, result, comparison } = state;
  els['empty-state'].classList.add('hidden');
  els['results'].classList.remove('hidden');

  // 指标瓦片
  const fillRate = result.actualSize / result.population;
  els['summary-tiles'].innerHTML = [
    tile('总体行数', result.population),
    tile('目标样本量', result.totalRequested),
    tile('实际样本量', result.actualSize, `实际抽样比 ${pct(fillRate)}`),
    tile('来源行号范围', result.indices.length ? `${result.indices[0] + 2}–${result.indices[result.indices.length - 1] + 2}` : '—', '含表头行的 1 起行号'),
    tile('结果指纹', (state.resultFingerprint || '').slice(0, 10) + '…', '来源行号集合哈希'),
  ].join('');

  renderWarnings(els['result-warnings'], result.warnings);
  renderCoverage();
  renderStrata();
  renderBlocks();
  renderCategoryChart();
  renderNullTable();
  renderNumerics();
  renderPreview();
  renderPlanStatus();
}

function tile(label, value, note) {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div>
    <div class="tile-value" style="font-size:${String(value).length > 12 ? 15 : 22}px">${esc(value)}</div>
    ${note ? `<div class="tile-note">${esc(note)}</div>` : ''}</div>`;
}

function renderCoverage() {
  const { result, dataset } = state;
  const parts = [];
  if (result.timeCoverage) {
    const tc = result.timeCoverage;
    parts.push(`<div class="coverage-box"><b>时间覆盖范围</b>
      <dl>
        <dt>可解析行</dt><dd>${tc.validRows} / ${dataset.rows.length}</dd>
        <dt>无法解析</dt><dd>${tc.invalidRows} 行（不纳入抽样，见告警中的行号）</dd>
        <dt>可解析时间范围 (UTC)</dt><dd>${esc(tc.earliest)} ~ ${esc(tc.latest)}</dd>
        <dt>粒度 / 区间数</dt><dd>${esc(tc.granularity)} · 共 ${tc.blockCount} 个连续区间，选中 ${tc.selectedBlockCount} 个</dd>
      </dl></div>`);
  }
  // 空列 / 高空值率列提示
  const empties = dataset.columnTypes.filter((c) => c.type === 'empty');
  const highNull = dataset.columnTypes.filter((c) => c.type !== 'empty' && c.nullCount / dataset.rows.length >= 0.5);
  if (empties.length || highNull.length) {
    parts.push(`<div class="coverage-box"><b>空字段覆盖范围</b>
      <dl>
        ${empties.map((c) => `<dt>${esc(c.name)}</dt><dd>整列为空（${c.nullCount}/${dataset.rows.length}），数值/类别统计不可用</dd>`).join('')}
        ${highNull.map((c) => `<dt>${esc(c.name)}</dt><dd>空值率 ${pct(c.nullCount / dataset.rows.length)}（${c.nullCount}/${dataset.rows.length}），统计仅基于非空行</dd>`).join('')}
      </dl></div>`);
  }
  els['coverage-panel'].innerHTML = parts.join('');
}

function renderStrata() {
  const { result } = state;
  if (!result.strata) {
    els['strata-panel'].classList.add('hidden');
    return;
  }
  els['strata-panel'].classList.remove('hidden');
  const total = result.actualSize;
  els['strata-panel'].innerHTML = `
    <div class="table-scroll"><table class="data">
      <thead><tr><th>层</th><th>总体行数</th><th>总体占比</th><th>计划抽取</th><th>实际抽取</th>
      <th>样本占比</th><th>偏差(百分点)</th><th>状态</th></tr></thead>
      <tbody>${result.strata.map((s) => {
        const status = s.belowFloor
          ? '<span class="badge bad">低于保底</span>'
          : s.shortfall > 0
            ? '<span class="badge bad">容量不足</span>'
            : Math.abs(s.deviationPctPoints) < 0.5
              ? '<span class="badge good">偏差 &lt;0.5pp</span>'
              : '<span class="badge muted-badge">正常</span>';
        return `<tr${s.isNullStratum ? ' style="font-style:italic"' : ''}>
          <td>${esc(s.label)}</td><td>${s.population}</td><td>${pct(s.populationProportion)}</td>
          <td>${s.requested}</td><td><b>${s.actual}</b></td>
          <td>${total ? pct(s.sampleProportion) : '—'}</td>
          <td>${pp(s.deviationPctPoints)}</td><td>${status}${s.isNullStratum ? ' <span class="badge muted-badge">空值层</span>' : ''}</td></tr>`;
      }).join('')}</tbody></table></div>
    <p class="muted small">稀有类别（总体占比 &lt;5%）若容量不足，实际抽取行数低于计划值且不会复制补齐；偏差列展示样本占比相对总体占比的真实偏离。</p>`;
}

function renderBlocks() {
  const { result } = state;
  if (!result.blocks) {
    els['blocks-panel'].classList.add('hidden');
    return;
  }
  els['blocks-panel'].classList.remove('hidden');
  els['blocks-panel'].innerHTML = `
    <p class="muted small">区间按时间连续整体选取并保留，未打散为随机样本。</p>
    <div class="table-scroll"><table class="data">
      <thead><tr><th>区间起点</th><th>区间终点</th><th>行数</th><th>是否选中</th></tr></thead>
      <tbody>${result.blocks.map((b) => `<tr>
        <td>${esc(b.startKey)}</td><td>${esc(b.endKey)}</td><td>${b.rowCount}</td>
        <td>${b.selected ? '<span class="badge good">选中</span>' : '<span class="badge muted-badge">未选中</span>'}</td></tr>`).join('')}
      </tbody></table></div>`;
}

function renderCategoryChart() {
  const { comparison, result } = state;
  const host = els['cat-chart'];
  if (result.config.method !== 'stratified' || !comparison.categories) {
    host.innerHTML = '<p class="muted small">类别比例对照仅在分层抽样时展示（简单随机/时间抽样可参考空值率与数值分布对照）。</p>';
    return;
  }
  const items = comparison.categories.rows.map((r) => ({
    key: r.key,
    label: r.label ?? r.key,
    popCount: r.popCount,
    sampleCount: r.sampleCount,
    popRate: r.popRate,
    sampleRate: r.sampleRate,
    deviationPctPoints: r.deviationPctPoints,
  }));
  const table = groupedBarChart(host, `类别比例对照：${result.config.stratifyColumn}`, items);
  attachTableToggle(els['cat-table-toggle'], table);
  const rare = comparison.categories.rareFlag;
  if (rare.length) {
    const note = document.createElement('p');
    note.className = 'muted small';
    note.textContent = `稀有类别（总体占比 <5%）：${rare.join('、')}。若某类样本不足，其偏差为真实抽样结果，未做复制补齐。`;
    host.appendChild(note);
  }
}

function renderNullTable() {
  const rows = state.comparison.nullRates;
  els['null-table'].innerHTML = `<div class="table-scroll"><table class="data">
    <thead><tr><th>字段</th><th>总体空值</th><th>总体空值率</th><th>样本空值</th><th>样本空值率</th><th>偏差(百分点)</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${esc(r.column)}</td><td>${r.popNulls}</td><td>${pct(r.popRate)}</td>
      <td>${r.sampleNulls}</td><td>${pct(r.sampleRate)}</td>
      <td style="color:${Math.abs(r.deviationPctPoints) >= 0.1 ? 'var(--series-2)' : 'inherit'}">${pp(r.deviationPctPoints * 100)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function renderNumerics() {
  const numerics = state.comparison.numerics;
  const host = els['numeric-panels'];
  if (!numerics.length) {
    host.innerHTML = '<p class="muted small">未检测到数值列（数值列需 ≥90% 非空值可解析为数字）。</p>';
    return;
  }
  host.innerHTML = '';
  numerics.forEach((nc) => {
    const card = document.createElement('div');
    card.className = 'numeric-card';
    card.innerHTML = `<h4>${esc(nc.column)}</h4>
      <div class="summary-grid">
        <span><b>均值 总体/样本</b>${fmt(nc.pop.mean)} / ${fmt(nc.sample.mean)}</span>
        <span><b>中位数</b>${fmt(nc.pop.median)} / ${fmt(nc.sample.median)}</span>
        <span><b>标准差</b>${fmt(nc.pop.sd)} / ${fmt(nc.sample.sd)}</span>
        <span><b>最小</b>${fmt(nc.pop.min)} / ${fmt(nc.sample.min)}</span>
        <span><b>最大</b>${fmt(nc.pop.max)} / ${fmt(nc.sample.max)}</span>
        <span><b>非空样本数</b>${nc.pop.count} / ${nc.sample.count}</span>
      </div>`;
    const chartHost = document.createElement('div');
    card.appendChild(chartHost);
    const toggleWrap = document.createElement('div');
    toggleWrap.className = 'chart-toolbar';
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn btn-ghost btn-small';
    toggleBtn.textContent = '查看数据表';
    toggleWrap.appendChild(toggleBtn);
    card.appendChild(toggleWrap);
    host.appendChild(card);
    const table = histogramChart(chartHost, `数值分布对照：${nc.column}`, nc.histogram);
    attachTableToggle(toggleBtn, table);
  });
}

function renderPreview() {
  const { dataset, result } = state;
  const sampleRows = state.comparison.sampleRows;
  const preview = result.indices.slice(0, 20);
  const headers = ['来源行号', ...dataset.headers];
  els['sample-preview'].innerHTML = `<table class="data">
    <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${preview.map((idx) => {
      const sourceRow = idx + 2;
      return `<tr><td><b>${sourceRow}</b></td>${dataset.rows[idx].map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`;
    }).join('')}</tbody></table>
    ${sampleRows.length > 20 ? `<p class="muted small">仅预览前 20 行，完整 ${sampleRows.length} 行请导出 CSV。</p>` : ''}`;
}

// ---------- 导出 ----------

els['export-sample-btn'].addEventListener('click', () => {
  if (!state.result) return;
  const { dataset, result, plan } = state;
  const headers = ['source_row', ...dataset.headers];
  const rows = result.indices.map((idx) => [String(idx + 2), ...dataset.rows[idx]]);
  // 方案元信息作为注释头，机器解析时可跳过 # 开头行；数据区保持标准 CSV
  const meta = [
    `# 抽样导出 - 不修改原表`,
    `# dataset=${dataset.name}`,
    `# fingerprint=${dataset.fingerprint}`,
    `# plan_algorithm=${plan?.algorithm || ALGORITHM_VERSION}`,
    `# seed=${result.config.seed}`,
    `# method=${result.config.method}`,
    `# result_fingerprint=${state.resultFingerprint}`,
    `# exported_at=${new Date().toISOString()}`,
  ].join('\r\n');
  download(`sample-${Date.now()}.csv`, meta + '\r\n' + toCsv(headers, rows));
});

els['export-stats-btn'].addEventListener('click', () => {
  if (!state.result) return;
  const { comparison, result } = state;
  const lines = ['section,column,metric,population,sample,deviation'];
  for (const r of comparison.nullRates) {
    lines.push(['null_rate', r.column, 'rate', r.popRate.toFixed(6), r.sampleRate.toFixed(6), r.deviationPctPoints.toFixed(6)].map(csvCell).join(','));
  }
  if (comparison.categories) {
    for (const r of comparison.categories.rows) {
      lines.push(['category', comparison.categories.column, r.label ?? r.key ?? '(空值)', r.popRate.toFixed(6), r.sampleRate.toFixed(6), (r.deviationPctPoints / 100).toFixed(6)].map(csvCell).join(','));
    }
  }
  for (const nc of comparison.numerics) {
    for (const metric of ['mean', 'median', 'sd', 'min', 'max']) {
      lines.push(['numeric', nc.column, metric, num(nc.pop[metric]), num(nc.sample[metric]), ''].join(','));
    }
  }
  download(`stats-comparison-${Date.now()}.csv`, '﻿' + lines.join('\r\n') + '\r\n');
});

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function num(v) { return v === null || v === undefined ? '' : Number(v).toFixed(6); }

// ---------- 样本量扫描 ----------

els['sweep-btn'].addEventListener('click', () => {
  if (!state.dataset) return;
  clearConfigError();
  const base = readFormConfig();
  const sizes = $('sweep-sizes').value.split(/[,，]/).map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
  if (sizes.length < 2) {
    showConfigError('请至少输入两个正整数样本量，用逗号分隔。');
    return;
  }
  let sweep;
  try {
    sweep = sweepSizes(state.dataset, base, sizes, (ds, cfg) => runSampling(ds.rows, ds.headers, cfg));
  } catch (e) {
    if (e instanceof SamplingConfigError) return showConfigError(e.message);
    throw e;
  }
  els['sweep-result'].classList.remove('hidden');
  const points = sweep.map((s) => ({
    x: s.requested, actual: s.actual,
    nullDev: s.nullDevPctPoints, catDev: s.catDevPctPoints,
  }));
  const seriesDefs = [
    { key: 'nullDev', label: '最大空值率偏差 (pp)' },
    { key: 'catDev', label: '最大类别比例偏差 (pp)' },
  ];
  const table = lineChart(els['sweep-chart'], '样本量扫描：统计偏差随样本量变化', points, seriesDefs);
  attachTableToggle(els['sweep-table-toggle'], table);
  els['sweep-result'].scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
});
