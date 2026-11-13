// 零依赖内联 SVG 图表。配色取 dataviz 参考调色板：
// 总体 = 蓝 #2a78d6 / 暗色 #3987e5；样本 = 橙 #eb6834 / 暗色 #d95926。
// 所有图表同时提供 <table> 数据视图，颜色不承担唯一信息通道。

const CSS_VARS = `
.sv-chart { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
.sv-chart text { fill: var(--text-muted, #898781); font-size: 11px; }
.sv-chart .sv-grid { stroke: var(--gridline, #e1e0d9); stroke-width: 1; }
.sv-chart .sv-axis { stroke: var(--axis, #c3c2b7); stroke-width: 1; }
.sv-chart .sv-pop { fill: var(--series-1, #2a78d6); }
.sv-chart .sv-sample { fill: var(--series-2, #eb6834); }
.sv-chart .sv-line-pop { stroke: var(--series-1, #2a78d6); stroke-width: 2; fill: none; stroke-linejoin: round; stroke-linecap: round; }
.sv-chart .sv-line-sample { stroke: var(--series-2, #eb6834); stroke-width: 2; fill: none; stroke-linejoin: round; stroke-linecap: round; }
.sv-chart .sv-dot { stroke: var(--surface-1, #fcfcfb); stroke-width: 2; }
.sv-chart .sv-hit { fill: transparent; cursor: default; }
.sv-chart .sv-label { fill: var(--text-secondary, #52514e); }
.sv-tooltip {
  position: fixed; z-index: 50; pointer-events: none; display: none;
  background: var(--surface-1, #fcfcfb); border: 1px solid var(--border, rgba(11,11,11,.1));
  border-radius: 8px; padding: 6px 10px; font-size: 12px; line-height: 1.5;
  color: var(--text-primary, #0b0b0b); box-shadow: 0 4px 16px rgba(0,0,0,.12); max-width: 320px;
}
.sv-table { border-collapse: collapse; width: 100%; font-size: 12px; margin-top: 8px; }
.sv-table th, .sv-table td { border: 1px solid var(--gridline, #e1e0d9); padding: 4px 8px; text-align: right; font-variant-numeric: tabular-nums; }
.sv-table th:first-child, .sv-table td:first-child { text-align: left; }
.sv-table caption { text-align: left; color: var(--text-muted, #898781); padding: 4px 0; }
.sv-legend { display: flex; gap: 16px; align-items: center; font-size: 12px; color: var(--text-secondary, #52514e); margin: 4px 0; }
.sv-legend .sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; margin-right: 5px; }
`;

let styleInjected = false;
function injectStyle() {
  if (styleInjected || typeof document === 'undefined') return;
  const el = document.createElement('style');
  el.id = 'sv-chart-style';
  el.textContent = CSS_VARS;
  document.head.appendChild(el);
  styleInjected = true;
}

let tooltipEl = null;
function tooltip() {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'sv-tooltip';
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

function bindTip(el, html) {
  el.addEventListener('mousemove', (e) => {
    const tip = tooltip();
    tip.innerHTML = html;
    tip.style.display = 'block';
    const pad = 14;
    const w = tip.offsetWidth;
    const x = Math.min(e.clientX + pad, window.innerWidth - w - 8);
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${e.clientY + pad}px`;
  });
  el.addEventListener('mouseleave', () => { tooltip().style.display = 'none'; });
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function fmtPct(v) {
  return `${(v * 100).toFixed(1)}%`;
}
function fmtNum(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (Math.abs(v) >= 1000) return v.toLocaleString('zh-CN', { maximumFractionDigits: digits });
  return Number(v.toFixed(digits)).toString();
}

// ---------- 分组水平条形图：类别比例 总体 vs 样本 ----------

export function groupedBarChart(container, title, items, opts = {}) {
  injectStyle();
  container.innerHTML = '';
  const width = opts.width || 640;
  const labelW = 110;
  const rowH = 34;
  const barH = 10;
  const height = Math.max(120, items.length * rowH + 28);
  const plotW = width - labelW - 70;
  const maxV = Math.max(0.0001, ...items.map((d) => Math.max(d.popRate ?? 0, d.sampleRate ?? 0)));
  const svg = svgEl('svg', { class: 'sv-chart', width: '100%', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': title });

  const legend = document.createElement('div');
  legend.className = 'sv-legend';
  legend.innerHTML = `<span><i class="sw" style="background:var(--series-1,#2a78d6)"></i>总体比例</span>
    <span><i class="sw" style="background:var(--series-2,#eb6834)"></i>样本比例</span>`;
  container.appendChild(legend);

  items.forEach((d, i) => {
    const y = 14 + i * rowH;
    const label = d.label ?? d.key ?? '(空值)';
    const text = svgEl('text', { x: labelW - 8, y: y + barH + 2, 'text-anchor': 'end', class: 'sv-label' });
    text.textContent = String(label).length > 8 ? `${String(label).slice(0, 7)}…` : String(label);
    svg.appendChild(text);

    const draw = (rate, cls, dy) => {
      const w = Math.max(rate > 0 ? 2 : 0, (rate / maxV) * plotW);
      const rect = svgEl('rect', {
        x: labelW, y: y + dy, width: w, height: barH, rx: 4, class: cls,
      });
      if (dy === barH + 4) rect.setAttribute('rx', 4); // 两条均为数据端圆角
      svg.appendChild(rect);
      const val = svgEl('text', { x: labelW + w + 5, y: y + dy + barH - 1 });
      val.textContent = fmtPct(rate ?? 0);
      svg.appendChild(val);
      return rect;
    };
    const r1 = draw(d.popRate ?? 0, 'sv-pop', 0);
    const r2 = draw(d.sampleRate ?? 0, 'sv-sample', barH + 4);
    bindTip(r1, `<b>${label}</b><br>总体：${(d.popCount ?? 0).toLocaleString('zh-CN')} 行 · ${fmtPct(d.popRate ?? 0)}`);
    bindTip(r2, `<b>${label}</b><br>样本：${(d.sampleCount ?? 0).toLocaleString('zh-CN')} 行 · ${fmtPct(d.sampleRate ?? 0)}<br>偏差：${(d.deviationPctPoints ?? 0).toFixed(2)} 个百分点`);
  });
  const axis = svgEl('line', { x1: labelW, y1: height - 14, x2: width - 60, y2: height - 14, class: 'sv-axis' });
  svg.appendChild(axis);
  container.appendChild(svg);

  const table = document.createElement('table');
  table.className = 'sv-table';
  table.innerHTML = `<caption>${title}（数据表）</caption><thead><tr>
    <th>类别</th><th>总体行数</th><th>总体比例</th><th>样本行数</th><th>样本比例</th><th>偏差(百分点)</th></tr></thead>
    <tbody>${items.map((d) => {
      const label = d.label ?? d.key ?? '(空值)';
      return `<tr><td>${label}</td><td>${d.popCount ?? '—'}</td><td>${fmtPct(d.popRate ?? 0)}</td>
      <td>${d.sampleCount ?? '—'}</td><td>${fmtPct(d.sampleRate ?? 0)}</td>
      <td>${(d.deviationPctPoints ?? 0).toFixed(2)}</td></tr>`;
    }).join('')}</tbody>`;
  table.hidden = true;
  container.appendChild(table);
  return table;
}

// ---------- 直方图：数值列 总体 vs 样本（共用箱边界） ----------

export function histogramChart(container, title, data) {
  injectStyle();
  container.innerHTML = '';
  const { edges, popCounts, sampleCounts, singleValue } = data;
  if (!edges || edges.length < 2) {
    container.textContent = '该列数值不足，无法绘制分布。';
    return;
  }
  const width = 640;
  const height = 240;
  const m = { top: 16, right: 16, bottom: 44, left: 48 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const svg = svgEl('svg', { class: 'sv-chart', width: '100%', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': title });

  const legend = document.createElement('div');
  legend.className = 'sv-legend';
  legend.innerHTML = `<span><i class="sw" style="background:var(--series-1,#2a78d6)"></i>总体频数</span>
    <span><i class="sw" style="background:var(--series-2,#eb6834)"></i>样本频数</span>`;
  container.appendChild(legend);

  const maxCount = Math.max(1, ...popCounts, ...sampleCounts);
  const bins = popCounts.length;
  const groupW = plotW / bins;
  const barW = Math.min(24, (groupW - 4) / 2);

  for (let g = 0; g <= 4; g++) {
    const y = m.top + (plotH / 4) * g;
    svg.appendChild(svgEl('line', { x1: m.left, y1: y, x2: m.left + plotW, y2: y, class: 'sv-grid' }));
    const tick = svgEl('text', { x: m.left - 6, y: y + 4, 'text-anchor': 'end' });
    tick.textContent = Math.round(maxCount - (maxCount / 4) * g).toString();
    svg.appendChild(tick);
  }

  edges.slice(0, bins).forEach((lo, b) => {
    const x0 = m.left + b * groupW + groupW / 2 - barW - 1;
    const x1 = x0 + barW + 2;
    const h1 = (popCounts[b] / maxCount) * plotH;
    const h2 = (sampleCounts[b] / maxCount) * plotH;
    const r1 = svgEl('rect', { x: x0, y: m.top + plotH - h1, width: barW, height: h1, rx: 4, class: 'sv-pop' });
    const r2 = svgEl('rect', { x: x1, y: m.top + plotH - h2, width: barW, height: h2, rx: 4, class: 'sv-sample' });
    svg.appendChild(r1);
    svg.appendChild(r2);
    const tip = `<b>${fmtNum(lo)} ~ ${fmtNum(edges[b + 1])}</b><br>总体：${popCounts[b]} 行<br>样本：${sampleCounts[b]} 行`;
    bindTip(r1, tip);
    bindTip(r2, tip);
    if (b % Math.ceil(bins / 6) === 0) {
      const t = svgEl('text', { x: m.left + b * groupW + 2, y: height - 24 });
      t.textContent = fmtNum(lo, 1);
      svg.appendChild(t);
    }
  });
  svg.appendChild(svgEl('line', { x1: m.left, y1: m.top + plotH, x2: m.left + plotW, y2: m.top + plotH, class: 'sv-axis' }));
  const cap = singleValue !== undefined
    ? `所有值均为 ${fmtNum(singleValue)}`
    : `区间 ${fmtNum(edges[0], 1)} ~ ${fmtNum(edges[edges.length - 1], 1)}，共 ${bins} 箱`;
  const note = svgEl('text', { x: m.left, y: height - 6 });
  note.textContent = cap;
  svg.appendChild(note);
  container.appendChild(svg);

  const table = document.createElement('table');
  table.className = 'sv-table';
  table.innerHTML = `<caption>${title}（数据表）</caption><thead><tr>
    <th>区间下界</th><th>区间上界</th><th>总体频数</th><th>样本频数</th></tr></thead>
    <tbody>${popCounts.map((c, b) => `<tr><td>${fmtNum(edges[b], 2)}</td><td>${fmtNum(edges[b + 1], 2)}</td>
    <td>${c}</td><td>${sampleCounts[b]}</td></tr>`).join('')}</tbody>`;
  table.hidden = true;
  container.appendChild(table);
  return table;
}

// ---------- 折线图：样本量扫描 ----------

export function lineChart(container, title, points, seriesDefs) {
  injectStyle();
  container.innerHTML = '';
  const width = 640;
  const height = 260;
  const m = { top: 20, right: 20, bottom: 40, left: 56 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const svg = svgEl('svg', { class: 'sv-chart', width: '100%', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': title });

  const legend = document.createElement('div');
  legend.className = 'sv-legend';
  legend.innerHTML = seriesDefs
    .map((s, i) => `<span><i class="sw" style="background:var(--series-${i + 1},${i === 0 ? '#2a78d6' : '#eb6834'})"></i>${s.label}</span>`)
    .join('');
  container.appendChild(legend);

  const xs = points.map((p) => p.x);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMaxRaw = Math.max(0.0001, ...points.flatMap((p) => seriesDefs.map((s) => p[s.key] ?? 0)));
  const yMax = yMaxRaw * 1.1;
  const sx = (x) => m.left + ((x - xMin) / Math.max(1, xMax - xMin)) * plotW;
  const sy = (y) => m.top + plotH - (y / yMax) * plotH;

  for (let g = 0; g <= 4; g++) {
    const y = m.top + (plotH / 4) * g;
    svg.appendChild(svgEl('line', { x1: m.left, y1: y, x2: m.left + plotW, y2: y, class: 'sv-grid' }));
    const tick = svgEl('text', { x: m.left - 6, y: y + 4, 'text-anchor': 'end' });
    tick.textContent = (yMax - (yMax / 4) * g).toFixed(1);
    svg.appendChild(tick);
  }

  seriesDefs.forEach((s, si) => {
    const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p[s.key] ?? 0).toFixed(1)}`).join(' ');
    svg.appendChild(svgEl('path', { d, class: si === 0 ? 'sv-line-pop' : 'sv-line-sample' }));
    points.forEach((p) => {
      const dot = svgEl('circle', { cx: sx(p.x), cy: sy(p[s.key] ?? 0), r: 4, class: si === 0 ? 'sv-pop sv-dot' : 'sv-sample sv-dot' });
      svg.appendChild(dot);
      bindTip(dot, `<b>样本量 ${p.x}${p.actual !== p.x ? `（实际 ${p.actual}）` : ''}</b><br>${s.label}：${(p[s.key] ?? 0).toFixed(2)}`);
    });
  });

  // 横轴刻度
  const tickEvery = Math.max(1, Math.ceil(points.length / 8));
  points.forEach((p, i) => {
    if (i % tickEvery !== 0 && i !== points.length - 1) return;
    const t = svgEl('text', { x: sx(p.x), y: height - 18, 'text-anchor': 'middle' });
    t.textContent = String(p.x);
    svg.appendChild(t);
  });
  svg.appendChild(svgEl('line', { x1: m.left, y1: m.top + plotH, x2: m.left + plotW, y2: m.top + plotH, class: 'sv-axis' }));
  const axisLabel = svgEl('text', { x: m.left + plotW / 2, y: height - 4, 'text-anchor': 'middle' });
  axisLabel.textContent = '目标样本量（行）';
  svg.appendChild(axisLabel);
  container.appendChild(svg);

  const table = document.createElement('table');
  table.className = 'sv-table';
  table.innerHTML = `<caption>${title}（数据表）</caption><thead><tr>
    <th>目标样本量</th><th>实际行数</th>${seriesDefs.map((s) => `<th>${s.label}</th>`).join('')}</tr></thead>
    <tbody>${points.map((p) => `<tr><td>${p.x}</td><td>${p.actual}</td>${seriesDefs
      .map((s) => `<td>${(p[s.key] ?? 0).toFixed(3)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  table.hidden = true;
  container.appendChild(table);
  return table;
}

// 图表/表格切换按钮
export function attachTableToggle(btn, table) {
  if (!btn || !table) return;
  btn.addEventListener('click', () => {
    table.hidden = !table.hidden;
    btn.textContent = table.hidden ? '查看数据表' : '查看图表';
  });
}
