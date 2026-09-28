/**
 * Rút một cây node từ payload thật rồi đóng gói lại thành clipboard.
 *
 * Dùng để tách bạch khi text không render: nếu dán lại chính node của Stitch mà
 * vẫn trống thì lỗi nằm ngoài payload (font chưa nạp trong file Figma đích);
 * nếu hiện được thì lỗi nằm ở encoder tự sinh.
 *
 *   npx tsx scripts/diagnostics/extract-subtree.ts <nguồn.html> <ra.html> [--only-text]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { unpackArchive, packArchive } from '../../packages/server/src/figma/archive.ts';
import { buildFigmaClipboardHtml, parseFigmaClipboardHtml } from '../../packages/server/src/figma/clipboard.ts';
import { createNodeChangesMessage } from '../../packages/server/src/figma/codec.ts';

const [sourcePath, outPath] = process.argv.slice(2);
const onlyText = process.argv.includes('--only-text');
if (!sourcePath || !outPath) {
  console.error('Dùng: npx tsx scripts/diagnostics/extract-subtree.ts <nguồn.html> <ra.html> [--only-text]');
  process.exit(1);
}

const parsed = parseFigmaClipboardHtml(readFileSync(sourcePath, 'utf8'));
if (!parsed) throw new Error('Không bóc được clipboard.');

const unpacked = unpackArchive(new Uint8Array(parsed.archive));
const codec = compileSchema(decodeBinarySchema(unpacked.schema));
const message = codec.decodeMessage(unpacked.message) as Record<string, unknown>;
const changes = (message.nodeChanges ?? []) as Array<Record<string, any>>;

const keyOf = (guid: { sessionID: number; localID: number } | undefined) =>
  guid ? `${guid.sessionID}:${guid.localID}` : '';

/** Thu thập node cùng toàn bộ con cháu. */
function collect(rootKey: string): Array<Record<string, any>> {
  const byGuid = new Map(changes.map((node) => [keyOf(node.guid), node]));
  const result: Array<Record<string, any>> = [];
  const visit = (key: string) => {
    const node = byGuid.get(key);
    if (!node) return;
    result.push(node);
    for (const child of changes) {
      if (keyOf(child.parentIndex?.guid) === key) visit(keyOf(child.guid));
    }
  };
  visit(rootKey);
  return result;
}

let kept: Array<Record<string, any>>;

if (onlyText) {
  // Chỉ giữ DOCUMENT + CANVAS + một TEXT, để cô lập vấn đề render chữ.
  const document = changes.find((node) => node.type === 'DOCUMENT')!;
  const canvas = changes.find((node) => node.type === 'CANVAS')!;
  const text = changes.find((node) => node.type === 'TEXT')!;
  // Đặt text trực tiếp dưới canvas để không phụ thuộc frame cha.
  text.parentIndex = { guid: canvas.guid, position: '!' };
  kept = [document, canvas, text];
  // Dịch về gốc toạ độ để dễ thấy khi dán.
  text.transform = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
} else {
  const root = changes[0];
  kept = collect(keyOf(root.guid));
  if (kept.length <= 1) {
    // Gốc là DOCUMENT: lấy luôn cây con của CANVAS.
    const canvas = changes.find((node) => node.type === 'CANVAS')!;
    kept = [changes[0], ...collect(keyOf(canvas.guid))];
  }
}

// Gom blob được tham chiếu: `commandsBlob` là chỉ số 1-based vào mảng blobs.
const allBlobs = (message.blobs ?? []) as Array<Record<string, unknown>>;
const referenced = new Set<number>();
const remap = new Map<number, number>();
for (const node of kept) {
  const glyphs = (node.derivedTextData?.glyphs ?? []) as Array<Record<string, unknown>>;
  for (const glyph of glyphs) {
    const index = glyph.commandsBlob as number | undefined;
    if (typeof index === 'number' && index > 0) referenced.add(index);
  }
}
const blobs: Array<Record<string, unknown>> = [];
if (referenced.size) {
  for (const index of [...referenced].sort((a, b) => a - b)) {
    remap.set(index, blobs.length + 1);
    blobs.push(allBlobs[index - 1]);
  }
  // Ghi lại chỉ số blob theo bảng ánh xạ mới.
  for (const node of kept) {
    const glyphs = (node.derivedTextData?.glyphs ?? []) as Array<Record<string, unknown>>;
    for (const glyph of glyphs) {
      const index = glyph.commandsBlob as number | undefined;
      if (typeof index === 'number' && remap.has(index)) glyph.commandsBlob = remap.get(index);
    }
  }
}

const outMessage = createNodeChangesMessage(kept as never, { blobs: blobs as never });
const encoded = codec.encodeMessage(outMessage as never);
const archive = packArchive({ version: unpacked.version, schema: unpacked.schema, message: encoded });

const html = buildFigmaClipboardHtml({
  metadata: parsed.metadata,
  archive,
  fallbackText: 'Paste from Stitch Local',
});
writeFileSync(outPath, html);

console.log('giữ lại   :', kept.length, 'node');
for (const node of kept) console.log('  -', node.type, JSON.stringify(node.name));
console.log('blob gom  :', referenced.size, 'được tham chiếu ->', blobs.length, 'giữ lại');
console.log('archive   :', archive.length, 'byte');
console.log('đã ghi    :', outPath, '(' + (html.length / 1024).toFixed(1) + 'KB)');
