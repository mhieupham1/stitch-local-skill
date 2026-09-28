/**
 * In từng ký tự kèm glyph và blob tương ứng, để đối chiếu trực tiếp với ảnh render.
 *
 * Dùng khi phát hiện ký tự nào đó không hiện: xem ký tự đó có glyph hay không, và
 * blob nó trỏ tới có tồn tại thật không.
 */
import { readFileSync } from 'node:fs';
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { unpackArchive } from '../../packages/server/src/figma/archive.ts';
import { parseFigmaClipboardHtml } from '../../packages/server/src/figma/clipboard.ts';

const [path, wanted] = process.argv.slice(2);
const parsed = parseFigmaClipboardHtml(readFileSync(path, 'utf8'))!;
const unpacked = unpackArchive(new Uint8Array(parsed.archive));
const message = compileSchema(decodeBinarySchema(unpacked.schema)).decodeMessage(unpacked.message) as Record<string, any>;
const blobs = (message.blobs ?? []) as Array<Record<string, any>>;

const text = (message.nodeChanges as Array<Record<string, any>>).find(
  (node) => node.type === 'TEXT' && (!wanted || String(node.textData?.characters ?? '').includes(wanted)),
);
if (!text) { console.error('Không tìm thấy TEXT khớp.'); process.exit(1); }

const characters = String(text.textData.characters);
const glyphs = (text.derivedTextData?.glyphs ?? []) as Array<Record<string, any>>;
console.log('chữ   :', JSON.stringify(characters));
console.log('glyph :', glyphs.length, '| ký tự:', characters.length);
console.log();
console.log('  #  ký tự  blob  kích thước  firstChar  advance');
for (let i = 0; i < characters.length; i++) {
  const glyph = glyphs.find((g) => g.firstCharacter === i);
  if (!glyph) { console.log(`  ${String(i).padStart(3)}  ${JSON.stringify(characters[i]).padEnd(7)} (KHÔNG CÓ GLYPH)`); continue; }
  const index = glyph.commandsBlob as number;
  const blob = blobs[index - 1];
  const size = blob?.bytes ? (blob.bytes as Uint8Array).length : 0;
  const flag = index > blobs.length ? '  <-- VƯỢT MẢNG' : '';
  console.log(`  ${String(i).padStart(3)}  ${JSON.stringify(characters[i]).padEnd(7)} ${String(index).padStart(4)}  ${String(size).padStart(9)}  ${String(glyph.firstCharacter).padStart(9)}  ${String(glyph.advance).slice(0, 8).padStart(8)}${flag}`);
}
