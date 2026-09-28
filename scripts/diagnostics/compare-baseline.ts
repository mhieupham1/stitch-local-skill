/**
 * Xác định cách Figma đặt gốc toạ độ khi vẽ glyph.
 *
 * Giả thuyết cần kiểm: `glyph.position.y` là đường cơ sở; đường vẽ trong blob có
 * thể đã ở hệ "y hướng xuống" sẵn (Figma tự đảo), nên KHÔNG được cộng thêm offset.
 */
import { readFileSync } from 'node:fs';
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { unpackArchive } from '../../packages/server/src/figma/archive.ts';
import { parseFigmaClipboardHtml } from '../../packages/server/src/figma/clipboard.ts';

const parsed = parseFigmaClipboardHtml(readFileSync(process.argv[2], 'utf8'))!;
const unpacked = unpackArchive(new Uint8Array(parsed.archive));
const message = compileSchema(decodeBinarySchema(unpacked.schema)).decodeMessage(unpacked.message) as Record<string, any>;
const blobs = (message.blobs ?? []) as Array<Record<string, any>>;

const ARITY: Record<number, number> = { 0: 0, 1: 2, 2: 2, 3: 4, 4: 6 };
function decode(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Array<{ op: number; coords: number[] }> = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = bytes[offset++];
    const arity = ARITY[tag];
    if (arity === undefined) return out;
    const coords: number[] = [];
    for (let i = 0; i < arity; i++) { coords.push(view.getFloat32(offset, true)); offset += 4; }
    out.push({ op: tag, coords });
  }
  return out;
}

// Chỉ xét glyph có blob giải mã được (bỏ blob container 3168B).
const text = (message.nodeChanges as Array<Record<string, any>>).find(
  (node) => node.type === 'TEXT' && String(node.textData?.characters ?? '').startsWith('SMEMBER'),
)!;
const characters = String(text.textData.characters);

console.log('fontSize node:', text.fontSize, '| lineHeight:', JSON.stringify(text.lineHeight), '| textAlignVertical:', text.textAlignVertical);
console.log();
console.log('  ký tự  pos.y   fontSize  y nhỏ nhất  y lớn nhất  bề rộng  advance');
for (const glyph of (text.derivedTextData.glyphs as Array<Record<string, any>>).slice(0, 8)) {
  const bytes = blobs[glyph.commandsBlob - 1].bytes as Uint8Array;
  const commands = decode(bytes);
  if (!commands.length) { console.log(`  ${JSON.stringify(characters[glyph.firstCharacter])}  -> blob container, bỏ qua`); continue; }
  const ys = commands.flatMap((c) => c.coords.filter((_, i) => i % 2 === 1));
  const xs = commands.flatMap((c) => c.coords.filter((_, i) => i % 2 === 0));
  console.log(
    `  ${JSON.stringify(characters[glyph.firstCharacter]).padEnd(6)} ${glyph.position.y.toFixed(3).padStart(7)}` +
    `  ${String(glyph.fontSize).padStart(8)}  ${Math.min(...ys).toFixed(3).padStart(10)}  ${Math.max(...ys).toFixed(3).padStart(10)}` +
    `  ${(Math.max(...xs) - Math.min(...xs)).toFixed(3).padStart(7)}  ${glyph.advance.toFixed(4)}`,
  );
}
console.log();
console.log('KẾT LUẬN cần rút ra: pos.y', text.derivedTextData.glyphs[1].position.y.toFixed(3),
  'so với y của đường vẽ', decode(blobs[text.derivedTextData.glyphs[1].commandsBlob - 1].bytes as Uint8Array).flatMap((c) => c.coords.filter((_, i) => i % 2 === 1)).slice(0, 3));
