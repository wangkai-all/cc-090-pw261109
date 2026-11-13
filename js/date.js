// 宽容但确定的时间解析：支持常见明确格式；无法判定的一律返回 null（不猜测）。
// 统一返回 UTC 毫秒时间戳，避免本地时区差异影响可复现性。

const RE_ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|([+-]\d{2}):?(\d{2}))?$/;
const RE_DATE_DASH = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const RE_DATE_SLASH_A = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/; // MM/DD/YYYY
const RE_DATE_SLASH_B = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/; // YYYY/MM/DD
const RE_DATE_DOT = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/; // DD.MM.YYYY
const RE_COMPACT = /^(\d{4})(\d{2})(\d{2})$/; // YYYYMMDD

function validDate(y, m, d) {
  return m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function utc(y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) {
  return Date.UTC(y, m - 1, d, hh, mm, ss, ms);
}

export function parseTimestamp(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '') return null;

  let mt = s.match(RE_ISO);
  if (mt) {
    const [, y, mo, d, hh, mm, ss, ms, tzH, tzM] = mt;
    if (!validDate(+y, +mo, +d)) return null;
    let t = utc(+y, +mo, +d, +hh, +mm, ss ? +ss : 0, ms ? +ms.padEnd(3, '0') : 0);
    if (tzH !== undefined) {
      const sign = tzH.startsWith('-') ? 1 : -1;
      t += sign * (Math.abs(+tzH) * 3600 + (tzM ? +tzM * 60 : 0)) * 1000;
    }
    return t;
  }

  mt = s.match(RE_DATE_DASH);
  if (mt) {
    const [, y, mo, d] = mt;
    return validDate(+y, +mo, +d) ? utc(+y, +mo, +d) : null;
  }

  mt = s.match(RE_DATE_SLASH_B);
  if (mt) {
    const [, y, mo, d] = mt;
    return validDate(+y, +mo, +d) ? utc(+y, +mo, +d) : null;
  }

  mt = s.match(RE_DATE_SLASH_A);
  if (mt) {
    const [, mo, d, y] = mt;
    return validDate(+y, +mo, +d) ? utc(+y, +mo, +d) : null;
  }

  mt = s.match(RE_DATE_DOT);
  if (mt) {
    const [, d, mo, y] = mt;
    return validDate(+y, +mo, +d) ? utc(+y, +mo, +d) : null;
  }

  mt = s.match(RE_COMPACT);
  if (mt) {
    const [, y, mo, d] = mt;
    return validDate(+y, +mo, +d) ? utc(+y, +mo, +d) : null;
  }

  // 数字 Excel 序列日期（1900 起）
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n >= 1 && n < 80000) {
      // Excel 1900 闰年 bug 补偿：序列 60（虚构的 1900-02-29）之后整体减 1
      const adjusted = n >= 60 ? n - 1 : n;
      return Date.UTC(1899, 11, 31) + Math.round(adjusted * 86400000);
    }
    // 纯数字时间戳（秒或毫秒）
    if (n > 1e11) return n; // 毫秒
    if (n > 1e9) return n * 1000; // 秒
  }

  return null;
}

export const BUCKET_MS = {
  hour: 3600000,
  day: 86400000,
  week: 7 * 86400000,
  month: 'month',
};

export function bucketKey(ts, granularity) {
  const dt = new Date(ts);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  const h = dt.getUTCHours();
  if (granularity === 'hour') return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} ${String(h).padStart(2, '0')}:00`;
  if (granularity === 'month') return `${y}-${String(m).padStart(2, '0')}`;
  if (granularity === 'week') {
    const monday = new Date(ts - ((dt.getUTCDay() + 6) % 7) * 86400000);
    return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, '0')}-${String(monday.getUTCDate()).padStart(2, '0')}`;
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
