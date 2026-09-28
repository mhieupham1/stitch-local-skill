/**
 * Khảo sát mảng `blobs`: kích thước, loại dữ liệu, và node nào tham chiếu tới.
 *
 * Nghi vấn: blob có thể chứa dữ liệu mà Figma cần để render (đường vẽ glyph),
 * nên bỏ trống có thể làm chữ không hiện.
 */
import { readFileSync } from 'node:fs';
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { unpackArchive } from '../../packages/server/src/figma/archive.ts';
import { parseFigmaClipboardHtml } from '../../packages/server/src/figma/clipboard.ts';

const parsed = parseFigmaClipboardHtml(readFileSync(process.argv[2], 'utf8'))!;
const unpacked = unpackArchive(new Uint8Array(parsed.archive));
const message = compileSchema(decodeBinarySchema(unpacked.schema)).decodeMessage(unpacked.message) as Record<string, any>;
const blobs = (message.blobs ?? []) as Array<Record<string, unknown>>;
const changes = (message.nodeChanges ?? []) as Array<Record<string, any>>;

console.log('tổng blob:', blobs.length);
const sizes = blobs.map((blob) => (blob.bytes ? (blob.bytes as Uint8Array).length : 0));
console.log('tổng byte :', sizes.reduce((a, b) => a + b, 0));
console.log('nhỏ nhất  :', Math.min(...sizes), '| lớn nhất:', Math.max(...sizes));
console.log();

console.log('=== blob[0..4] ===');
for (const blob of blobs.slice(0, 5)) {
  const bytes = blob.bytes as Uint8Array;
  const head = Buffer.from(bytes.slice(0, 16)).toString('hex');
  console.log('  ' + bytes.length + 'B  ' + head);
}

console.log();
console.log('=== field của blob ===');
console.log(' ', JSON.stringify(Object.keys(blobs[0] ?? {})));

// Ai tham chiếu blob? `commandsBlob` là chỉ số 1-based.
const users = new Map<number, Array<{ type: string; name: string }>>();
for (const node of changes) {
  const glyphs = (node.derivedTextData?.glyphs ?? []) as Array<Record<string, unknown>>;
  for (const glyph of glyphs) {
    const index = glyph.commandsBlob as number | undefined;
    if (typeof index === 'number' && index > 0) {
      if (!users.has(index)) users.set(index, []);
      users.get(index)!.push({ type: node.type, name: node.name });
    }
  }
}
console.log();
console.log('=== blob được tham chiếu bởi ===');
console.log('số blob được dùng:', users.size, '/', blobs.length);
const first = [...users.entries()][0];
if (first) console.log('  blob', first[0], '->', JSON.stringify(first[1].slice(0, 2)));

// Có loại node nào khác dùng blob không (vectorData, image fill)?
console.log();
console.log('=== field tên chứa "blob" trên node ===');
const blobFields = new Set<string>();
for (const node of changes) {
  for (const key of Object.keys(node)) if (key.toLowerCase().includes('blob')) blobFields.add(`${node.type}.${key}`);
}
console.log(' ', [...blobFields].join('\n  '));
