// 轻量 CSV/TSV 解析与序列化：支持引号转义、字段内逗号/换行、BOM、分隔符自动探测。

export function detectDelimiter(text) {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] || '';
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = 0;
  for (const d of candidates) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM
  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      pushField();
    } else if (c === '\n') {
      pushRow();
    } else if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      pushRow();
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();

  if (rows.length === 0) {
    return { headers: [], rows: [], delimiter, warnings: [{ level: 'error', code: 'EMPTY_FILE', message: '文件内容为空，未找到任何数据。' }] };
  }

  const headers = rows[0].map((h, i) => {
    const name = h.trim();
    return name === '' ? `未命名列_${i + 1}` : name;
  });
  const seen = new Map();
  for (let i = 0; i < headers.length; i++) {
    const name = headers[i];
    const count = seen.get(name) ?? 0;
    if (count > 0) headers[i] = `${name}_${count + 1}`;
    seen.set(name, count + 1);
  }

  const warnings = [];
  const dataRows = [];
  for (const r of rows.slice(1)) {
    const isBlank = r.length === 1 && r[0].trim() === '';
    if (isBlank) continue;
    if (r.length !== headers.length) {
      warnings.push({
        level: 'warning',
        code: 'ROW_WIDTH_MISMATCH',
        message: `第 ${dataRows.length + 2} 行有 ${r.length} 个字段，表头为 ${headers.length} 列，已按表头宽度补齐或截断。`,
      });
    }
    const normalized = r.slice(0, headers.length);
    while (normalized.length < headers.length) normalized.push('');
    dataRows.push(normalized);
  }

  return { headers, rows: dataRows, delimiter, warnings };
}

function needsQuote(value, delimiter) {
  return /["\n\r]/.test(value) || value.includes(delimiter);
}

export function toCsv(headers, rows, delimiter = ',') {
  const escape = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return needsQuote(s, delimiter) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(escape).join(delimiter)];
  for (const row of rows) lines.push(row.map(escape).join(delimiter));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
