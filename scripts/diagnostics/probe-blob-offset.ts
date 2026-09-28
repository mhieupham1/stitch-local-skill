/**
 * Xác định `commandsBlob` trỏ vào đâu, bằng cách khớp HÌNH VẼ với KÝ TỰ.
 *
 *   npx tsx scripts/diagnostics/probe-blob-offset.ts <mẫu.html> <font.ttf> [chuỗi]
 *
 * Vì sao không dùng bbox: bbox không khớp `advance` của ký tự (chữ "M" có advance
 * 0.922 nhưng bbox chỉ 0.776), nên không thể kết luận chỉ số từ bbox. Cách chắc
 * hơn là so bbox blob của Stitch với bbox mà chính bộ parse font sinh ra cho ký
 * tự đó — blob nào khớp thì blob đó là của ký tự này.
 */
import { readFileSync } from 'node:fs';
import opentype from 'opentype.js';
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { unpackArchive } from '../../packages/server/src/figma/archive.ts';
import { parseFigmaClipboardHtml } from '../../packages/server/src/figma/clipboard.ts';
import { decodePathCommands, outlineFromFont } from '../../packages/server/src/figma/font/outline.ts';

const [samplePath, fontPath, wanted = 'SMEMBER REWARDS'] = process.argv.slice(2);
const parsed = parseFigmaClipboardHtml(readFileSync(samplePath, 'utf8'))!;
const unpacked = unpackArchive(new Uint8Array(parsed.archive));
const msg = compileSchema(decodeBinarySchema(unpacked.schema)).decodeMessage(unpacked.message) as Record<string, any>;
const blobs = (msg.blobs ?? []) as Array<{ bytes: Uint8Array }>;
const text = (msg.nodeChanges as Array<Record<string, any>>).find(
  (node) => node.type === 'TEXT' && String(node.textData?.characters) === wanted,
)!;
const characters = String(text.textData.characters);
const glyphs = text.derivedTextData.glyphs as Array<Record<string, any>>;

const buffer = readFileSync(fontPath);
const font = opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);

interface Box { w: number; h: number; commands: number }

/** Bbox của blob. Trả `null` nếu blob không phải đường vẽ đơn (container). */
function boxOfBytes(bytes?: Uint8Array): Box | null {
  if (!bytes) return null;
  try {
    const commands = decodePathCommands(bytes);
    if (!commands.length) return null;
    const xs = commands.flatMap((c) => c.coords.filter((_, i) => i % 2 === 0));
    const ys = commands.flatMap((c) => c.coords.filter((_, i) => i % 2 === 1));
    return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), commands: commands.length };
  } catch {
    return null;
  }
}

/** Bbox outline mà chính ta sinh từ font, đã nhân fontSize để so cùng hệ. */
function boxFromFont(character: string): Box | null {
  const outline = outlineFromFont(font as never, character);
  if (!outline || !outline.commands.length) return null;
  const xs = outline.commands.flatMap((c) => c.coords.filter((_, i) => i % 2 === 0));
  const ys = outline.commands.flatMap((c) => c.coords.filter((_, i) => i % 2 === 1));
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), commands: outline.commands.length };
}

console.log('mẫu:', samplePath.split('/').pop());
console.log('font:', fontPath.split('/').pop(), '| blobs:', blobs.length);
console.log();
console.log('Câu hỏi: blob nào là hình của ký tự nào?');
console.log('So bbox của blobs[idx] và blobs[idx-1] với bbox outline sinh từ font cho chính ký tự đó.');
console.log();
console.log('  ký tự  idx   blobs[idx] w/h/lệnh     blobs[idx-1] w/h/lệnh    font w/h/lệnh    khớp');
for (const glyph of glyphs.slice(0, 12)) {
  const character = characters[glyph.firstCharacter];
  const index = glyph.commandsBlob as number;
  const self = boxOfBytes(blobs[index]?.bytes);
  const prev = boxOfBytes(blobs[index - 1]?.bytes);
  const mine = boxFromFont(character);
  const fmt = (b: Box | null) => (b ? `${b.w.toFixed(2)} ${b.h.toFixed(2)} ${String(b.commands).padStart(2)}` : '   —      ');
  let verdict = '—';
  if (self && mine) {
    const selfGap = Math.abs(self.w - mine.w);
    const prevGap = prev ? Math.abs(prev.w - mine.w) : Infinity;
    verdict = selfGap < prevGap ? 'idx ✓' : 'idx-1 ←';
    if (Math.min(selfGap, prevGap) > 0.02) verdict = 'lệch weight';
  } else if (self) verdict = 'container';
  console.log('  ' + JSON.stringify(character).padEnd(6), String(index).padStart(3),
    '  ', fmt(self), '  ', fmt(prev), '  ', fmt(mine), '   ' + verdict);
}

console.log();
console.log('=== Tổng hợp: blob của dấu cách ===');
for (const glyph of glyphs.filter((g) => characters[g.firstCharacter] === ' ')) {
  const index = glyph.commandsBlob as number;
  console.log(`  dấu cách #${glyph.firstCharacter} -> idx ${index} | ${blobs[index]?.bytes.length ?? 0} byte | bytes [${[...(blobs[index]?.bytes ?? [])]}]`);
}
