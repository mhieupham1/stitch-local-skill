/**
 * Blob "S" (3168B) không theo định dạng đường vẽ đơn. Xem nó là bảng nhiều glyph.
 *
 * Quan sát: `4a 00 00 00` = 74, `46 00 00 00` = 70. Nghi là số phần tử + độ lệch.
 * Giả thuyết khác: các blob lớn là "nhiều glyph gộp" để tiết kiệm chỗ.
 */
import { readFileSync } from 'node:fs';
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { unpackArchive } from '../../packages/server/src/figma/archive.ts';
import { parseFigmaClipboardHtml } from '../../packages/server/src/figma/clipboard.ts';

const parsed = parseFigmaClipboardHtml(readFileSync(process.argv[2], 'utf8'))!;
const unpacked = unpackArchive(new Uint8Array(parsed.archive));
const message = compileSchema(decodeBinarySchema(unpacked.schema)).decodeMessage(unpacked.message) as Record<string, any>;
const blobs = (message.blobs ?? []) as Array<Record<string, any>>;

const big = blobs[0].bytes as Uint8Array;
const u32 = (o: number) => big[o] | (big[o+1] << 8) | (big[o+2] << 16) | (big[o+3] << 24);

console.log('blob 1:', big.length, 'byte');
console.log('u32 liên tiếp 8 đầu:', [...Array(8)].map((_, i) => u32(i * 4)).join(', '));
console.log();

// Ai dùng blob 1?
const users: Array<{ char: string; node: string; offset: number }> = [];
for (const node of message.nodeChanges as Array<Record<string, any>>) {
  if (node.type !== 'TEXT') continue;
  const characters = String(node.textData?.characters ?? '');
  for (const glyph of (node.derivedTextData?.glyphs ?? []) as Array<Record<string, any>>) {
    if (glyph.commandsBlob === 1) users.push({ char: characters[glyph.firstCharacter], node: node.name, offset: glyph.firstCharacter });
  }
}
console.log('glyph dùng blob 1:', users.length, '| ví dụ:', JSON.stringify(users.slice(0, 6)));

// Nếu u32(0)=74 là số phần tử, thử tìm bảng chỉ mục ngay sau 8 byte đầu.
const count = u32(0);
console.log();
console.log('giả thuyết: u32(0) =', count, 'phần tử');
console.log('nếu mỗi phần tử là [u32 offset, u32 length], bảng cần', count * 8, 'byte =', count * 8, '| có', big.length - 8, 'byte sau header');
console.log();
console.log('đọc thử 12 u32 tiếp theo (từ byte 8):');
for (let i = 0; i < 12; i++) {
  const value = u32(8 + i * 4);
  console.log(`  [${8 + i * 4}] ${String(value).padStart(10)}`);
}
