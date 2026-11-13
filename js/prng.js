// 确定性伪随机数生成器（mulberry32）与稳定字符串哈希（FNV-1a）。
// 同一种子 + 同一盐值永远产生同一序列，这是方案可复现的基础。

export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seedU32) {
  let a = seedU32 >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 盐值用于区分不同抽样环节（简单随机 / 某个层 / 时间桶选择 / 段内起点），
// 使各环节的随机流相互独立且只依赖 (seed, salt)，与处理顺序无关。
export function makeRng(seed, salt) {
  const base = typeof seed === 'number' ? seed >>> 0 : fnv1a32(String(seed));
  const mixed = salt ? (base ^ fnv1a32(String(salt))) >>> 0 : base;
  return mulberry32(mixed);
}

// Fisher–Yates 部分洗牌：从 [0, n) 中无放回取出 k 个互不相同的下标。
// 绝不复制记录——每个下标最多出现一次。
export function pickIndices(n, k, rng) {
  const arr = new Array(n);
  for (let i = 0; i < n; i++) arr[i] = i;
  const limit = Math.min(Math.max(0, Math.floor(k)), n);
  for (let i = 0; i < limit; i++) {
    const j = i + Math.floor(rng() * (n - i));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr.slice(0, limit);
}
