// Pixel size from an image's header, so the pane can fit it without scaling small images up. null when unknown.
const be16 = (b, i) => (b[i] << 8) | b[i + 1];
const le16 = (b, i) => b[i] | (b[i + 1] << 8);
const be32 = (b, i) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const le32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24));
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

function jpeg(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: be16(b, i + 7), height: be16(b, i + 5) };
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    i += 2 + be16(b, i + 2);
  }
  return null;
}

function webp(b) {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  if (chunk === "VP8L") return { width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
  if (chunk === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  return null;
}

function svgSize(b) {
  const head = ascii(b, 0, Math.min(b.length, 4096)), tag = head.match(/<svg\b[^>]*>/i)?.[0] ?? "";
  const num = (name) => { const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, "i")); return m ? Number(m[1]) : 0; };
  const width = num("width"), height = num("height");
  if (width && height) return { width, height };
  const box = tag.match(/\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  return box ? { width: Number(box[1]), height: Number(box[2]) } : null;
}

export function imageSize(b) {
  if (b.length < 30) return null;
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return { width: be32(b, 16), height: be32(b, 20) };
  if (ascii(b, 0, 4) === "GIF8") return { width: le16(b, 6), height: le16(b, 8) };
  if (b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return webp(b);
  if (ascii(b, 0, 2) === "BM") return { width: Math.abs(le32(b, 18)), height: Math.abs(le32(b, 22)) };
  return svgSize(b);
}

export function formatBytes(n) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
