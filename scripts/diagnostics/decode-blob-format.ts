/**
 * Dịch ngược định dạng nhị phân của blob đường vẽ glyph.
 *
 * Quan sát ban đầu: hầu hết blob bắt đầu `00 01`; nhưng blob 3168B bắt đầu
 * `4a 00 00 00 46 00 00 00` — giống một bảng đếm/độ dài. Cần xác định mỗi loại.
 */
import { readFileSync } from 'node:fs';
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { unpackArchive } from '../../packages/server/src/figma/archive.ts';
import { parseFigmaClipboardHtml } from '../../packages/server/src/figma/clipboard.ts';

const parsed = parseFigmaClipboardHtml(readFileSync(process.argv[2], 'utf8'))!;
const unpacked = unpackArchive(new Uint8Array(parsed.archive));
const message = compileSchema(decodeBinarySchema(unpacked.schema)).decodeMessage(unpacked.message) as Record<string, any>;
const blobs = (message.blobs ?? []) as Array<Record<string, any>>;

const bytesOf = (index: number) => blobs[index - 1].bytes as Uint8Array;
const u32 = (bytes: Uint8Array, offset: number) =>
  bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
const f32 = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(offset, true);

console.log('=== blob 1 (3168B) — nghi là bảng nhiều glyph ===');
const big = bytesOf(1);
console.log('  byte 0..15:', [...big.slice(0, 16)].map((b) => String(b).padStart(3)).join(' '));
console.log('  u32 tại 0 :', u32(big, 0));
console.log('  u32 tại 4 :', u32(big, 4));
console.log('  u32 tại 8 :', u32(big, 8));
console.log('  u32 tại 12:', u32(big, 12));
console.log('  u32 tại 16:', u32(big, 16));
console.log();
// Nếu u32(0)=74 là số phần tử, và u32(4)=70 là độ lệch bảng, thử kiểm chứng.
const count = u32(big, 0);
const offset2 = u32(big, 4);
console.log('  giả thuyết: u32(0) =', count, 'phần tử, u32(4) =', offset2, 'là byte offset của bảng thứ hai');
console.log('  đọc thử 8 số float từ byte', offset2, ':', [...Array(8)].map((_, i) => f32(big, offset2 + i * 4).toFixed(4)).join(', '));
console.log();
// Tổng quát: liệt kê các u32 đầu của nhiều blob để tìm quy luật.
console.log('=== u32 đầu tiên của 12 blob đầu ===');
for (let i = 1; i <= 12; i++) {
  const bytes = bytesOf(i);
  const head = bytes.length >= 8 ? `${u32(bytes, 0)}, ${u32(bytes, 4)}` : '(quá ngắn)';
  const tail = bytes.length >= 16 ? `${u32(bytes, 8)}, ${u32(bytes, 12)}` : '';
  console.log(`  blob ${String(i).padStart(3)} (${String(bytes.length).padStart(4)}B): u32 = ${head} ${tail}`);
}
console.log();
console.log('=== blob 1 byte duy nhất ===');
const one = [...Array(blobs.length)].map((_, i) => i + 1).filter((i) => (bytesOf(i)).length === 1);
console.log('  các blob 1 byte:', one.join(', '), '| nội dung:', one.map((i) => bytesOf(i)[0]).join(', '));
