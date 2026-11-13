// 内置演示数据：确定性生成，覆盖稀有类别、空值、混乱时间格式与多数值列。
import { mulberry32 } from './prng.js';

const CATEGORIES = ['华北', '华东', '华南', '西南', '西北', '东北'];
const WEIGHTS = [0.34, 0.30, 0.20, 0.10, 0.04, 0.02];
const CHANNELS = ['线上直营', '经销商', '门店', '大客户'];
const PRODUCTS = ['A型', 'B型', 'C型'];

function pickWeighted(rng) {
  const r = rng();
  let acc = 0;
  for (let i = 0; i < WEIGHTS.length; i++) {
    acc += WEIGHTS[i];
    if (r < acc) return CATEGORIES[i];
  }
  return CATEGORIES[CATEGORIES.length - 1];
}

// 同一基准时间戳按不同格式输出，模拟真实导出里时间格式混乱的情况
function messyDate(ts, rng) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const style = Math.floor(rng() * 5);
  switch (style) {
    case 0: return `${y}-${mo}-${da} ${hh}:${mm}`;
    case 1: return `${y}/${mo}/${da}`;
    case 2: return `${da}.${mo}.${y}`;
    case 3: return `${y}${mo}${da}`;
    default: return `${y}-${mo}-${da}T${hh}:${mm}:00Z`;
  }
}

export function buildDemoDataset() {
  const rng = mulberry32(20261113);
  const headers = ['order_id', 'region', 'channel', 'product', 'amount', 'discount_rate', 'units', 'order_time', 'remark'];
  const rows = [];
  const start = Date.UTC(2026, 0, 1);
  for (let i = 1; i <= 240; i++) {
    const region = pickWeighted(rng);
    const channel = CHANNELS[Math.floor(rng() * CHANNELS.length)];
    const product = PRODUCTS[Math.floor(rng() * PRODUCTS.length)];
    const base = 800 + Math.floor(rng() * 4200);
    const amount = rng() < 0.06 ? '' : String(base); // 约 6% 空值
    const discount = rng() < 0.1 ? '' : (rng() * 0.35).toFixed(3); // 约 10% 空值
    const units = String(1 + Math.floor(rng() * 40));
    const day = Math.floor(rng() * 300);
    const hour = Math.floor(rng() * 24);
    const ts = start + day * 86400000 + hour * 3600000;
    const orderTime = rng() < 0.05 ? '时间未知' : messyDate(ts, rng); // 约 5% 不可解析
    const remark = rng() < 0.85 ? '' : '退货,需复核'; // 含逗号，测试 CSV 转义
    rows.push([String(100000 + i), region, channel, product, amount, discount, units, orderTime, remark]);
  }
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(r.map((v) => (v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v)).join(','));
  }
  return { name: '演示数据-订单抽样.csv', rawText: lines.join('\n'), headers, rows };
}
