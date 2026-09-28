/**
 * Giải mã blob đường vẽ theo định dạng đã biết của Figma:
 *
 *   [u8 tag][f32 LE args]*  — KHÔNG có header, KHÔNG có tiền tố độ dài.
 *
 *   tag 0 = ClosePath    (0 arg)
 *   tag 1 = MoveTo       (2 arg: x y)
 *   tag 2 = LineTo       (2 arg: x y)
 *   tag 3 = QuadraticTo  (4 arg: x1 y1 x y)
 *   tag 4 = CubicTo      (6 arg: x1 y1 x2 y2 x y)
 *
 * Toạ độ nằm trong hệ em (em unit), gốc ở baseline, trục y hướng LÊN — nên khi
 * vẽ cần đảo dấu y và nhân với cỡ chữ.
 */
import { readFileSync } from 'node:fs';
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { unpackArchive } from '../../packages/server/src/figma/archive.ts';
import { parseFigmaClipboardHtml } from '../../packages/server/src/figma/clipboard.ts';

const ARITY: Record<number, number> = { 0: 0, 1: 2, 2: 2, 3: 4, 4: 6 };
const LETTER: Record<number, string> = { 0: 'Z', 1: 'M', 2: 'L', 3: 'Q', 4: 'C' };

interface Command { op: string; coords: number[] }

/** Giải mã luồng lệnh; ném lỗi nếu gặp tag lạ để không hiểu sai dữ liệu. */
function decodePathBlob(bytes: Uint8Array): Command[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const commands: Command[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = bytes[offset++];
    const arity = ARITY[tag];
    if (arity === undefined) throw new Error(`tag lạ ${tag} tại byte ${offset - 1}`);
    if (offset + arity * 4 > bytes.length) throw new Error(`lệnh ${tag} bị cắt tại byte ${offset - 1}`);
    const coords: number[] = [];
    for (let i = 0; i < arity; i++) { coords.push(view.getFloat32(offset, true)); offset += 4; }
    commands.push({ op: LETTER[tag], coords });
  }
  return commands;
}

const parsed = parseFigmaClipboardHtml(readFileSync(process.argv[2], 'utf8'))!;
const unpacked = unpackArchive(new Uint8Array(parsed.archive));
const message = compileSchema(decodeBinarySchema(unpacked.schema)).decodeMessage(unpacked.message) as Record<string, any>;
const blobs = (message.blobs ?? []) as Array<Record<string, any>>;

const text = (message.nodeChanges as Array<Record<string, any>>).find(
  (node) => node.type === 'TEXT' && String(node.textData?.characters ?? '').startsWith('SMEMBER'),
)!;
const characters = String(text.textData.characters);
const glyphs = text.derivedTextData.glyphs as Array<Record<string, any>>;

let ok = 0, failed: string[] = [];
for (const glyph of glyphs) {
  const bytes = blobs[glyph.commandsBlob - 1].bytes as Uint8Array;
  try {
    const commands = decodePathBlob(bytes);
    ok++;
    if (glyph.firstCharacter < 3 || characters[glyph.firstCharacter] === 'D') {
      const summary = commands.map((c) => c.op + (c.coords.length ? '(' + c.coords.map((n) => n.toFixed(2)).join(' ') + ')' : '')).join(' ');
      console.log(`  ${JSON.stringify(characters[glyph.firstCharacter])} (glyph #${glyph.firstCharacter}, ${bytes.length}B, ${commands.length} lệnh):`);
      console.log('    ' + summary.slice(0, 190));
    }
  } catch (error) {
    failed.push(`${JSON.stringify(characters[glyph.firstCharacter])}: ${(error as Error).message}`);
  }
}

console.log();
console.log(`giải mã được: ${ok}/${glyphs.length} glyph`);
if (failed.length) { console.log('thất bại:'); for (const f of failed) console.log('  ' + f); }
console.log();
console.log('=== toạ độ glyph "S" — kiểm tra hệ trục ===');
const firstBytes = blobs[glyphs[0].commandsBlob - 1].bytes as Uint8Array;
const cmds = decodePathBlob(firstBytes);
const allY = cmds.flatMap((c) => c.coords.filter((_, i) => i % 2 === 1));
console.log('  số lệnh:', cmds.length);
console.log('  y nhỏ nhất:', Math.min(...allY).toFixed(4), '| y lớn nhất:', Math.max(...allY).toFixed(4));
console.log('  font-size glyph:', glyphs[0].fontSize, '| position:', JSON.stringify(glyphs[0].position));
console.log('  advance:', glyphs[0].advance);
