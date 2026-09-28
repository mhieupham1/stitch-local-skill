/**
 * Kiểm tra tính toàn vẹn giữa `glyphs[].commandsBlob` và mảng `blobs`.
 *
 * Blob là con trỏ 1-based. Nếu số glyph trỏ tới blob vượt quá số blob thực có thì
 * ký tự đó không có đường vẽ -> Figma bỏ qua và chữ mất nét.
 */
import { readFileSync } from 'node:fs';
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { unpackArchive } from '../../packages/server/src/figma/archive.ts';
import { parseFigmaClipboardHtml } from '../../packages/server/src/figma/clipboard.ts';

for (const path of process.argv.slice(2)) {
  const parsed = parseFigmaClipboardHtml(readFileSync(path, 'utf8'))!;
  const unpacked = unpackArchive(new Uint8Array(parsed.archive));
  const message = compileSchema(decodeBinarySchema(unpacked.schema)).decodeMessage(unpacked.message) as Record<string, any>;
  const blobs = (message.blobs ?? []) as unknown[];
  const changes = (message.nodeChanges ?? []) as Array<Record<string, any>>;

  console.log('### ' + path.split('/').pop());
  console.log('  blob có:', blobs.length);

  let maxIndex = 0, dangling: string[] = [], total = 0;
  for (const node of changes) {
    if (node.type !== 'TEXT') continue;
    const glyphs = (node.derivedTextData?.glyphs ?? []) as Array<Record<string, any>>;
    const characters = String(node.textData?.characters ?? '');
    const used: number[] = [];
    for (const glyph of glyphs) {
      const index = glyph.commandsBlob as number | undefined;
      if (typeof index !== 'number' || index <= 0) continue;
      total++;
      maxIndex = Math.max(maxIndex, index);
      used.push(index);
      if (index > blobs.length) dangling.push(`${JSON.stringify(characters.slice(0, 20))} ký tự ${glyph.firstCharacter} -> blob ${index}`);
    }
    if (characters.length !== glyphs.length) {
      console.log(`  ! ${JSON.stringify(characters.slice(0, 24))}: ${characters.length} ký tự nhưng ${glyphs.length} glyph`);
      // Chỉ ra ký tự nào thiếu glyph.
      const covered = new Set(glyphs.map((g) => g.firstCharacter));
      const missing = [...characters].map((c, i) => (covered.has(i) ? null : `${i}:${JSON.stringify(c)}`)).filter(Boolean);
      if (missing.length) console.log('    ký tự không có glyph:', missing.join(' '));
    }
    if (used.length) {
      const unique = [...new Set(used)].length;
      console.log(`  ${JSON.stringify(characters.slice(0, 22))} | glyph ${glyphs.length} | blob dùng ${used.length} (duy nhất ${unique}) | chỉ số ${Math.min(...used)}..${Math.max(...used)} | đầu ${used.slice(0, 6).join(',')}`);
    }
  }

  console.log('  tổng tham chiếu:', total, '| chỉ số lớn nhất:', maxIndex, '| blob thực có:', blobs.length);
  if (maxIndex > blobs.length) console.log('  *** LỖI: con trỏ vượt quá mảng blob ***');
  if (dangling.length) for (const d of dangling) console.log('    ->', d);
  console.log();
}
