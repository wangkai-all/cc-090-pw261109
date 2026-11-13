// 输入指纹：基于原始文件文本 + 表名的 SHA-256。
// 浏览器走 Web Crypto，Node 测试环境走 node:crypto。

export async function sha256Hex(text) {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.subtle === 'object') {
    const bytes = new TextEncoder().encode(text);
    const digest = await cryptoObj.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function fingerprintDataset(name, rawText) {
  return sha256Hex(`${name}\n${rawText}`);
}

// 抽样结果指纹：对来源行号（1 起，含表头行）排序后哈希，
// 用于复现时逐行核对两次抽样是否完全一致。
export async function fingerprintIndices(indices) {
  const sourceRows = indices.map((i) => i + 2).sort((a, b) => a - b);
  return sha256Hex(sourceRows.join(','));
}
