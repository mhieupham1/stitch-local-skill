/**
 * Rút cây node nhưng GIỮ NGUYÊN toàn bộ mảng blobs.
 *
 * Dùng để kiểm chứng: chỉ số `commandsBlob` là vị trí tuyệt đối trong mảng blobs,
 * nên nén mảng lại có thể làm sai lệch nếu có chỗ nào đó tham chiếu ngoài dự kiến.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { unpackArchive, packArchive } from '../../packages/server/src/figma/archive.ts';
import { buildFigmaClipboardHtml, parseFigmaClipboardHtml } from '../../packages/server/src/figma/clipboard.ts';
import { createNodeChangesMessage } from '../../packages/server/src/figma/codec.ts';

const [sourcePath, outPath] = process.argv.slice(2);
const parsed = parseFigmaClipboardHtml(readFileSync(sourcePath, 'utf8'))!;
const unpacked = unpackArchive(new Uint8Array(parsed.archive));
const codec = compileSchema(decodeBinarySchema(unpacked.schema));
const message = codec.decodeMessage(unpacked.message) as Record<string, any>;
const changes = (message.nodeChanges ?? []) as Array<Record<string, any>>;

const document = changes.find((node) => node.type === 'DOCUMENT')!;
const canvas = changes.find((node) => node.type === 'CANVAS')!;
const text = changes.find((node) => node.type === 'TEXT')!;
text.parentIndex = { guid: canvas.guid, position: '!' };

// Giữ nguyên mảng blobs, đúng chỉ số gốc.
const outMessage = createNodeChangesMessage([document, canvas, text] as never, {
  blobs: (message.blobs ?? []) as never,
});
const encoded = codec.encodeMessage(outMessage as never);
const archive = packArchive({ version: unpacked.version, schema: unpacked.schema, message: encoded });
const html = buildFigmaClipboardHtml({ metadata: parsed.metadata, archive, fallbackText: 'Paste from Stitch Local' });
writeFileSync(outPath, html);
console.log('giữ nguyên', (message.blobs ?? []).length, 'blob | archive:', archive.length, 'byte ->', outPath);
