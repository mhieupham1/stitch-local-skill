/**
 * Kiểm chứng độc lập các khẳng định trong plan sửa chữ, đọc thẳng từ mẫu thật.
 *
 *   npx tsx scripts/diagnostics/verify-claims.ts <mẫu.html> [chuỗi text]
 *
 * Ba câu hỏi cần trả lời bằng dữ liệu, không suy đoán:
 *   1. `commandsBlob` là chỉ số 0-based hay 1-based vào mảng `blobs`?
 *   2. `logicalIndexToCharacterOffsetMap` chứa chỉ số hay toạ độ?
 *   3. Blob của dấu cách chứa gì?
 */
import { readFileSync } from 'node:fs';
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { unpackArchive } from '../../packages/server/src/figma/archive.ts';
import { parseFigmaClipboardHtml } from '../../packages/server/src/figma/clipboard.ts';
import { decodePathCommands } from '../../packages/server/src/figma/font/outline.ts';

const [samplePath, wanted = 'SMEMBER REWARDS'] = process.argv.slice(2);
const parsed = parseFigmaClipboardHtml(readFileSync(samplePath, 'utf8'))!;
const unpacked = unpackArchive(new Uint8Array(parsed.archive));
const msg = compileSchema(decodeBinarySchema(unpacked.schema)).decodeMessage(unpacked.message) as Record<string, any>;
const blobs = (msg.blobs ?? []) as Array<{ bytes: Uint8Array }>;

const text = (msg.nodeChanges as Array<Record<string, any>>).find(
  (node) => node.type === 'TEXT' && String(node.textData?.characters) === wanted,
)!;
if (!text) {
  console.error('Không tìm thấy node TEXT khớp ' + JSON.stringify(wanted));
  process.exit(1);
}
const characters = String(text.textData.characters);
const glyphs = text.derivedTextData.glyphs as Array<Record<string, any>>;

/** Bề rộng hình vẽ của blob. Dùng để đối chiếu blob với ký tự nó phục vụ. */
const bboxWidth = (blob?: { bytes: Uint8Array }): string => {
  if (!blob) return '—';
  try {
    const commands = decodePathCommands(blob.bytes);
    if (!commands.length) return '(container)';
    const xs = commands.flatMap((c) => c.coords.filter((_, i) => i % 2 === 0));
    return (Math.max(...xs) - Math.min(...xs)).toFixed(3);
  } catch {
    return '(lỗi)';
  }
};

console.log('mẫu:', samplePath.split('/').pop());
console.log('node:', JSON.stringify(wanted), '| fontSize', text.fontSize, '| blobs', blobs.length);
console.log();
console.log('=== 1. commandsBlob: 0-based hay 1-based? ===');
console.log('  Ký tự  cmdBlob  advance   bbox blobs[idx]   bbox blobs[idx-1]');
for (const glyph of glyphs) {
  const index = glyph.commandsBlob as number;
  console.log(
    '  ' + JSON.stringify(characters[glyph.firstCharacter]).padEnd(6),
    String(index).padStart(7),
    glyph.advance.toFixed(3).padStart(9),
    bboxWidth(blobs[index]).padStart(15),
    bboxWidth(blobs[index - 1]).padStart(18),
  );
}

console.log();
console.log('=== 2. logicalIndexToCharacterOffsetMap ===');
const map = (text.derivedTextData.logicalIndexToCharacterOffsetMap ?? []) as number[];
console.log('  độ dài:', map.length, '| ký tự:', characters.length, map.length === characters.length ? '(khớp)' : '(LỆCH)');
console.log('  10 đầu       :', map.slice(0, 10).map((n) => n.toFixed(3)).join(', '));
console.log('  glyph.pos.x  :', glyphs.slice(0, 10).map((g) => g.position.x.toFixed(3)).join(', '));
const identical = map.length === glyphs.length && map.every((n, i) => Math.abs(n - glyphs[i].position.x) < 1e-4);
console.log('  giống hệt glyph.position.x?', identical ? 'CÓ' : 'KHÔNG');

console.log();
console.log('=== 3. Blob của dấu cách ===');
const spaceGlyphs = glyphs.filter((g) => characters[g.firstCharacter] === ' ');
for (const glyph of spaceGlyphs.slice(0, 3)) {
  const index = glyph.commandsBlob as number;
  console.log(`  dấu cách #${glyph.firstCharacter} -> commandsBlob ${index} | ${blobs[index].bytes.length} byte | bytes: [${[...blobs[index].bytes]}]`);
}
const oneByte = blobs.map((b, i) => [i, b?.bytes] as const).filter(([, b]) => b?.length === 1);
console.log('  mọi blob 1 byte trong payload:', oneByte.length ? oneByte.map(([i, b]) => `blobs[${i}]=[${[...b.bytes]}]`).join(', ') : '(không có)');

console.log();
console.log('=== 4. Đối chiếu advance: blob[idx] hay blob[idx-1] khớp ký tự? ===');
let correct = 0, shifted = 0;
for (const glyph of glyphs) {
  const index = glyph.commandsBlob as number;
  const self = bboxWidth(blobs[index]);
  const prev = bboxWidth(blobs[index - 1]);
  if (self === '(container)' || prev === '(container)') continue;
  const selfGap = Math.abs(Number(self) - glyph.advance);
  const prevGap = prev === '—' ? Infinity : Math.abs(Number(prev) - glyph.advance);
  if (selfGap < prevGap) correct++;
  else if (prevGap < selfGap) shifted++;
}
console.log(`  bbox khớp advance tốt hơn khi đọc blobs[idx]    : ${correct} ký tự`);
console.log(`  bbox khớp advance tốt hơn khi đọc blobs[idx-1]  : ${shifted} ký tự`);
console.log('  =>', correct > shifted ? 'blobs[idx] đúng (0-based)' : 'LỆCH MỘT: chỉ số đang sai');
