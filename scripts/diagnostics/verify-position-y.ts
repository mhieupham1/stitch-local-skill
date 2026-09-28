/**
 * Kiểm chứng công thức `position.y` trong plan sửa chữ mục 1.3 bằng mẫu thật.
 *
 *   fontLineHeight = (ascender + |descender|) / unitsPerEm
 *   lineHeightPx   = PIXELS ? value : value/100 × fontLineHeight × fontSize
 *   lineAscent     = ascender / unitsPerEm × fontSize
 *   baseline.y     = lineIndex × lineHeightPx
 *                  + (lineHeightPx − fontLineHeight × fontSize) / 2
 *                  + lineAscent
 */
import { readFileSync } from 'node:fs';
import opentype from 'opentype.js';
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { unpackArchive } from '../../packages/server/src/figma/archive.ts';
import { parseFigmaClipboardHtml } from '../../packages/server/src/figma/clipboard.ts';

const [samplePath, fontPath] = process.argv.slice(2);
const parsed = parseFigmaClipboardHtml(readFileSync(samplePath, 'utf8'))!;
const unpacked = unpackArchive(new Uint8Array(parsed.archive));
const msg = compileSchema(decodeBinarySchema(unpacked.schema)).decodeMessage(unpacked.message) as Record<string, any>;

const buffer = readFileSync(fontPath);
const font = opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
const upm = font.unitsPerEm;
const ascender = (font as unknown as { ascender: number }).ascender;
const descender = (font as unknown as { descender: number }).descender;
const fontLineHeight = (ascender + Math.abs(descender)) / upm;

console.log('font:', fontPath.split('/').pop(), '| upm', upm, '| ascender', ascender, '| descender', descender);
console.log('fontLineHeight =', fontLineHeight);
console.log();
console.log('  fontSize  lh(value,units)  baseline.y thật   công thức    lệch');
const seen = new Set<string>();
for (const node of (msg.nodeChanges as Array<Record<string, any>>)) {
  if (node.type !== 'TEXT') continue;
  const baseline = node.derivedTextData?.baselines?.[0];
  if (!baseline) continue;
  const key = `${node.fontSize}|${node.lineHeight?.value}|${node.lineHeight?.units}|${baseline.position.y}`;
  if (seen.has(key)) continue;
  seen.add(key);

  const fontSize = node.fontSize;
  const lh = node.lineHeight ?? { value: fontSize, units: 'PIXELS' };
  const lineHeightPx = lh.units === 'PIXELS' ? lh.value : (lh.value / 100) * fontLineHeight * fontSize;
  const lineAscent = (ascender / upm) * fontSize;
  const predicted = (lineHeightPx - fontLineHeight * fontSize) / 2 + lineAscent;
  const gap = Math.abs(predicted - baseline.position.y);
  console.log(
    '  ' + String(fontSize).padStart(8),
    `  ${String(lh.value).padStart(6)} ${lh.units}`.padEnd(20),
    baseline.position.y.toFixed(4).padStart(14),
    predicted.toFixed(4).padStart(12),
    gap.toFixed(4).padStart(9),
    gap < 0.001 ? '  ĐẠT' : '  SAI',
  );
}
console.log();
console.log('So sánh: lineAscent thật của mẫu có bằng ascender/upm × fontSize không?');
let ok = 0, total = 0;
for (const node of (msg.nodeChanges as Array<Record<string, any>>)) {
  if (node.type !== 'TEXT') continue;
  const baseline = node.derivedTextData?.baselines?.[0];
  if (!baseline?.lineAscent) continue;
  total++;
  if (Math.abs(baseline.lineAscent - (ascender / upm) * node.fontSize) < 0.001) ok++;
}
console.log(`  khớp: ${ok}/${total}`);
