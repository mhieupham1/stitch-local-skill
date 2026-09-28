/**
 * Giải mã một blob đường vẽ glyph để hiểu định dạng nhị phân của Figma.
 *
 * Blob bắt đầu bằng `00 01` rồi tới một dãy số float 4 byte. Mục đích là dịch
 * ngược cấu trúc này để tự sinh lại được từ outline chữ.
 */
import { readFileSync } from 'node:fs';
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { unpackArchive } from '../../packages/server/src/figma/archive.ts';
import { parseFigmaClipboardHtml } from '../../packages/server/src/figma/clipboard.ts';

const parsed = parseFigmaClipboardHtml(readFileSync(process.argv[2], 'utf8'))!;
const unpacked = unpackArchive(new Uint8Array(parsed.archive));
const message = compileSchema(decodeBinarySchema(unpacked.schema)).decodeMessage(unpacked.message) as Record<string, any>;
const blobs = (message.blobs ?? []) as Array<Record<string, any>>;

// Lấy blob của chữ "D" trong "SMEMBER REWARDS" (glyph #13 -> blob 9).
const text = (message.nodeChanges as Array<Record<string, any>>).find(
  (node) => node.type === 'TEXT' && String(node.textData?.characters ?? '').startsWith('SMEMBER'),
);
const glyphs = text.derivedTextData.glyphs as Array<Record<string, any>>;

for (const label of ['S', 'B', 'D']) {
  const index = 'SMEMBER REWARDS'.indexOf(label, label === 'D' ? 10 : 0);
  const glyph = glyphs.find((g) => g.firstCharacter === index);
  if (!glyph) continue;
  const bytes = blobs[glyph.commandsBlob - 1].bytes as Uint8Array;
  console.log(`### chữ ${JSON.stringify(label)} -> glyph #${index}, blob ${glyph.commandsBlob}, ${bytes.length} byte`);
  console.log('  hex 16 đầu:', Buffer.from(bytes.slice(0, 16)).toString('hex'));
  console.log('  byte 0..7 :', [...bytes.slice(0, 8)].join(' '));

  // Byte 0..1 là header. Kiểm tra giả thuyết: 00 01.
  console.log('  byte[0]:', bytes[0], '| byte[1]:', bytes[1]);

  // Thử đọc phần còn lại như dãy float 4 byte (little-endian).
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const floats: number[] = [];
  for (let offset = 2; offset + 4 <= bytes.length; offset += 4) {
    floats.push(Number(view.getFloat32(offset, true).toFixed(4)));
  }
  console.log('  float (từ byte 2):', floats.slice(0, 14).join(', '), floats.length > 14 ? `... (${floats.length} số)` : `(${floats.length} số)`);

  // Độ dài có chia hết cho 4 (kể từ byte 2) không?
  console.log('  (độ dài - 2) % 4 =', (bytes.length - 2) % 4, '| (độ dài - 2) / 4 =', (bytes.length - 2) / 4);
  console.log();
}

// So sánh blob của cùng một chữ xuất hiện ở nhiều chỗ: có giống hệt không?
console.log('### cùng chữ cái -> cùng blob?');
const usage = new Map<number, number[]>();
for (const node of message.nodeChanges as Array<Record<string, any>>) {
  if (node.type !== 'TEXT') continue;
  for (const glyph of (node.derivedTextData?.glyphs ?? []) as Array<Record<string, any>>) {
    const i = glyph.commandsBlob as number;
    if (!usage.has(i)) usage.set(i, []);
    usage.get(i)!.push(glyph.firstCharacter);
  }
}
console.log('  tổng blob dùng:', usage.size);
const sizes = [...usage.keys()].map((i) => (blobs[i - 1].bytes as Uint8Array).length);
console.log('  kích thước blob:', [...new Set(sizes)].sort((a, b) => a - b).join(', '));
