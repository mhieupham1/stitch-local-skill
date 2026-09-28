#!/usr/bin/env node
/**
 * Đọc một mẫu clipboard từ Figma và in ra nội dung message dễ đọc.
 *
 * Dùng khi debug encoder: mẫu nhỏ (màn hình đăng nhập, vài trăm node) thì đọc
 * trực tiếp được; mẫu lớn (cả trang web, >1000 node) chỉ nên xem phần tổng hợp.
 *
 *   node scripts/figma-inspect-sample.mjs <file.html> [--tree] [--texts] [--full]
 *
 * Cần `kiwi-schema` và `fzstd`.
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error('Dùng: node scripts/figma-inspect-sample.mjs <file.html> [--tree] [--texts] [--full]');
  process.exit(1);
}
const showTree = flags.includes('--tree');
const showTexts = flags.includes('--texts');
const showFull = flags.includes('--full');

// Nạp động để báo lỗi rõ ràng khi thiếu dependency.
let decodeBinarySchema, compileSchema, zstdDecompress;
try {
  ({ decodeBinarySchema, compileSchema } = await import('kiwi-schema'));
  ({ decompress: zstdDecompress } = await import('fzstd'));
} catch (error) {
  console.error('Thiếu dependency:', error.message.split('\n')[0]);
  console.error('Chạy: npm install kiwi-schema fzstd');
  process.exit(1);
}

const html = readFileSync(file, 'utf8');
const unescape = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&');

const bufferMatch = html.match(/\(figma\)([\s\S]*?)\(\/figma\)/);
if (!bufferMatch) {
  console.error('Không tìm thấy (figma) — file này không phải payload Figma.');
  process.exit(1);
}
const archive = Buffer.from(unescape(bufferMatch[1]).replace(/\s/g, ''), 'base64');

/** Dò thuật toán: zstd có frame magic `28 b5 2f fd`, còn lại là deflate thô. */
function decompressAuto(buffer) {
  if (buffer.length > 4 && buffer[0] === 0x28 && buffer[1] === 0xb5 && buffer[2] === 0x2f && buffer[3] === 0xfd) {
    return { algorithm: 'zstd', data: zstdDecompress(buffer) };
  }
  return { algorithm: 'deflate', data: inflateRawSync(buffer) };
}

console.log('=== FILE ===');
console.log('tên       :', file.split('/').pop());
console.log('kích thước:', (html.length / 1024).toFixed(0) + 'KB');
console.log('magic     :', JSON.stringify(archive.slice(0, 8).toString('latin1')), '| version:', archive.readUInt32LE(8));

const metaMatch = html.match(/\(figmeta\)([\s\S]*?)\(\/figmeta\)/);
if (metaMatch) {
  const meta = JSON.parse(Buffer.from(unescape(metaMatch[1]).replace(/\s/g, ''), 'base64').toString('utf8'));
  console.log('figmeta   :', JSON.stringify(meta));
}

// Chunk có dạng [u32 LE độ dài][dữ liệu nén], dừng khi độ dài 0 hoặc hết buffer.
const chunks = [];
let offset = 12;
while (offset + 4 <= archive.length) {
  const length = archive.readUInt32LE(offset);
  if (length === 0) break;
  const start = offset + 4;
  if (start + length > archive.length) {
    console.error(`chunk vượt biên ở offset ${offset} (cần ${start + length}, có ${archive.length})`);
    break;
  }
  chunks.push(archive.slice(start, start + length));
  offset = start + length;
}
if (chunks.length < 2) {
  console.error(`chỉ đọc được ${chunks.length} chunk, cần ít nhất 2 (schema + message).`);
  process.exit(1);
}

const schemaChunk = decompressAuto(chunks[0]);
const messageChunk = decompressAuto(chunks[1]);
console.log();
console.log('=== CHUNK ===');
console.log(`0 (schema) : ${chunks[0].length} B nén -> ${schemaChunk.data.length} B (${schemaChunk.algorithm})`);
console.log(`1 (message): ${chunks[1].length} B nén -> ${messageChunk.data.length} B (${messageChunk.algorithm})`);

const schema = decodeBinarySchema(schemaChunk.data);
const message = compileSchema(schema).decodeMessage(messageChunk.data);
const changes = message.nodeChanges ?? [];

console.log();
console.log('=== MESSAGE ===');
console.log('type       :', message.type);
console.log('nodeChanges:', changes.length);
console.log('blobs      :', (message.blobs ?? []).length);
if (message.pasteID !== undefined) console.log('pasteID    :', message.pasteID);

const counts = {};
for (const change of changes) counts[change.type ?? '(none)'] = (counts[change.type ?? '(none)'] ?? 0) + 1;
console.log('loại node  :', JSON.stringify(counts));

const keyOf = (guid) => (guid ? `${guid.sessionID}:${guid.localID}` : '(none)');
const byGuid = new Map();
for (const change of changes) byGuid.set(keyOf(change.guid), change);

/** In gọn một node: tên, kích thước, style chính. */
function summarize(change) {
  const parts = [change.name ? JSON.stringify(change.name) : '(không tên)'];
  if (change.size) parts.push(`${Math.round(change.size.x)}x${Math.round(change.size.y)}`);
  if (change.type === 'TEXT' && change.textData?.characters) {
    parts.push('text=' + JSON.stringify(change.textData.characters.slice(0, 40)));
  }
  if (change.fontName) parts.push(`${change.fontName.family}/${change.fontName.style}`);
  if (change.fontSize) parts.push(`${change.fontSize}px`);
  if (change.textAutoResize) parts.push(`autoResize=${change.textAutoResize}`);
  if (change.stackMode) parts.push(change.stackMode + (change.stackSpacing !== undefined ? ` gap=${change.stackSpacing}` : ''));
  if (change.cornerRadius) parts.push('r=' + change.cornerRadius);
  const fills = (change.fillPaints ?? []).map((paint) => paint.type).join('+');
  if (fills) parts.push('fill=' + fills);
  if (change.derivedTextData) {
    const derived = change.derivedTextData;
    parts.push(`derived{base=${derived.baselines?.length ?? 0},glyph=${derived.glyphs?.length ?? 0}}`);
  }
  return parts.filter(Boolean).join(' | ');
}

if (showTree) {
  console.log();
  console.log('=== CÂY NODE ===');
  const childrenOf = new Map();
  for (const change of changes) {
    const parent = keyOf(change.parentIndex?.guid);
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(change);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => String(a.parentIndex?.position ?? '').localeCompare(String(b.parentIndex?.position ?? '')));
  }
  const printed = new Set();
  const walk = (key, depth) => {
    if (printed.has(key) || depth > 16) return;
    printed.add(key);
    for (const change of childrenOf.get(key) ?? []) {
      console.log('  '.repeat(depth) + '- ' + change.type + ': ' + summarize(change));
      walk(keyOf(change.guid), depth + 1);
    }
  };
  for (const change of changes) {
    const parent = keyOf(change.parentIndex?.guid);
    if (!change.parentIndex || !byGuid.has(parent)) {
      console.log('- ' + change.type + ': ' + summarize(change));
      walk(keyOf(change.guid), 1);
    }
  }
} else {
  console.log();
  console.log('=== NODE (12 đầu) ===');
  for (const change of changes.slice(0, 12)) console.log(`  ${change.type}: ${summarize(change)}`);
  console.log('(dùng --tree để xem toàn bộ cây)');
}

if (showTexts) {
  const texts = changes.filter((change) => change.type === 'TEXT');
  console.log();
  console.log('=== TEXT ===');
  console.log('tổng:', texts.length);
  console.log('có derivedTextData:', texts.filter((t) => t.derivedTextData).length, '(không bắt buộc — xem mục 7 của kế hoạch)');
  console.log('có glyphs         :', texts.filter((t) => t.derivedTextData?.glyphs?.length).length);
  console.log();
  console.log('Tỉ lệ glyph/ký tự (chứng minh glyphs là cache bố cục từng ký tự):');
  for (const text of texts.slice(0, 8)) {
    const characters = text.textData?.characters ?? '';
    const glyphs = text.derivedTextData?.glyphs?.length ?? 0;
    const baselines = text.derivedTextData?.baselines?.length ?? 0;
    console.log(`  ${String(characters.length).padStart(3)} ký tự -> ${String(glyphs).padStart(3)} glyph, ${baselines} baseline | ${JSON.stringify(characters.slice(0, 32))}`);
  }
  const sample = texts.find((t) => t.derivedTextData);
  if (sample) {
    console.log();
    console.log('Cấu trúc derivedTextData đầy đủ:');
    console.log(JSON.stringify(sample.derivedTextData, (k, v) => (v instanceof Uint8Array ? `<${v.length}B>` : v), 1).slice(0, 900));
  }
}

if (showFull) {
  console.log();
  console.log('=== JSON ĐẦY ĐỦ (5 node đầu) ===');
  for (const change of changes.slice(0, 5)) {
    console.log(JSON.stringify(change, (k, v) => (v instanceof Uint8Array ? `<${v.length} byte>` : v), 1));
  }
}

const blobs = message.blobs ?? [];
if (blobs.length) {
  const sizes = blobs.map((blob) => (blob.bytes ? blob.bytes.length : 0));
  console.log();
  console.log('=== BLOB ===');
  console.log(`số blob: ${blobs.length} | tổng ${(sizes.reduce((a, b) => a + b, 0) / 1024).toFixed(0)}KB | lớn nhất ${Math.max(...sizes)}B`);
  const first = blobs[0];
  if (first?.bytes) {
    const head = Buffer.from(first.bytes.slice(0, 8)).toString('hex');
    const kind = head.startsWith('89504e47') ? 'PNG' : head.startsWith('ffd8ff') ? 'JPEG' : 'khác';
    console.log('blob[0] 8 byte đầu:', head, `(${kind})`);
  }
}
