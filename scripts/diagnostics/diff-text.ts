/**
 * So từng field giữa node TEXT của payload thật và node do encoder sinh.
 *
 * Dùng khi text không render: chỉ ra chính xác field nào còn thiếu, thay vì đoán.
 *
 *   npx tsx scripts/diagnostics/diff-text.ts <mẫu-thật.html> <của-tôi.html>
 */
import { readFileSync } from 'node:fs';
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { unpackArchive } from '../../packages/server/src/figma/archive.ts';
import { parseFigmaClipboardHtml } from '../../packages/server/src/figma/clipboard.ts';

function loadMessage(path: string) {
  const parsed = parseFigmaClipboardHtml(readFileSync(path, 'utf8'));
  if (!parsed) throw new Error(`Không bóc được clipboard từ ${path}`);
  const unpacked = unpackArchive(new Uint8Array(parsed.archive));
  return { unpacked, message: compileSchema(decodeBinarySchema(unpacked.schema)) };
}

const [realPath, minePath] = process.argv.slice(2);
if (!realPath || !minePath) {
  console.error('Dùng: npx tsx scripts/diagnostics/diff-text.ts <mẫu-thật.html> <của-tôi.html>');
  process.exit(1);
}

const real = loadMessage(realPath);
const mine = loadMessage(minePath);
const realMessage = real.message.decodeMessage(real.unpacked.message) as Record<string, unknown>;
const mineMessage = mine.message.decodeMessage(mine.unpacked.message) as Record<string, unknown>;

const pick = (message: Record<string, unknown>) =>
  ((message.nodeChanges ?? []) as Array<Record<string, unknown>>).find((node) => node.type === 'TEXT');

const realText = pick(realMessage);
const mineText = pick(mineMessage);
if (!realText || !mineText) {
  console.error('Không tìm thấy node TEXT trong một trong hai file.');
  process.exit(1);
}

const format = (value: unknown) => (value instanceof Uint8Array ? `<${value.length}B>` : JSON.stringify(value));

const realKeys = new Set(Object.keys(realText));
const mineKeys = new Set(Object.keys(mineText));

console.log('=== THIẾU (có ở Stitch, không có ở bản của tôi) ===');
for (const key of [...realKeys].filter((k) => !mineKeys.has(k)).sort()) {
  console.log('  ' + key.padEnd(32), (format(realText[key]) ?? '').slice(0, 90));
}

console.log();
console.log('=== THỪA (có ở bản của tôi, Stitch không có) ===');
for (const key of [...mineKeys].filter((k) => !realKeys.has(k)).sort()) console.log('  ' + key);

console.log();
console.log('=== KHÁC GIÁ TRỊ ===');
for (const key of [...realKeys].filter((k) => mineKeys.has(k)).sort()) {
  const a = JSON.stringify(realText[key]);
  const b = JSON.stringify(mineText[key]);
  if (a !== b) {
    console.log('  ' + key);
    console.log('    Stitch:', (a ?? '').slice(0, 110));
    console.log('    Tôi   :', (b ?? '').slice(0, 110));
  }
}

console.log();
console.log('=== blobs ===');
console.log('  Stitch:', ((realMessage.blobs ?? []) as unknown[]).length, '| Tôi:', ((mineMessage.blobs ?? []) as unknown[]).length);

console.log();
console.log('=== derivedTextData: glyphs[0] của Stitch ===');
const derived = realText.derivedTextData as Record<string, unknown> | undefined;
const glyphs = (derived?.glyphs ?? []) as unknown[];
if (glyphs[0]) console.log(' ', JSON.stringify(glyphs[0]));

console.log();
console.log('=== textData: lines ===');
console.log('  Stitch:', JSON.stringify((realText.textData as Record<string, unknown>)?.lines));
console.log('  Tôi   :', JSON.stringify((mineText.textData as Record<string, unknown>)?.lines));
