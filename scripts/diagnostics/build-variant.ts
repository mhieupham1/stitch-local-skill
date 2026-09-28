/**
 * Dựng payload bằng cách MƯỢN node TEXT thật của Stitch rồi chỉ thay phần chữ.
 *
 * Mục đích là cô lập nguồn lỗi: mọi field ngoài `textData.characters` và
 * `derivedTextData` đều giữ nguyên từ payload đã biết là dán được, nên nếu bản
 * này hiển thị đúng thì lỗi nằm ở phần node tự dựng, không phải ở glyph.
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
const text = changes.find((node) => node.type === 'TEXT' && String(node.textData?.characters) === 'SMEMBER REWARDS')!;

// Giữ NGUYÊN toàn bộ node, kể cả derivedTextData và mọi field lạ.
// Chỉ đổi cha về canvas để node đứng độc lập.
text.parentIndex = { guid: canvas.guid, position: '!' };

console.log('node mượn nguyên bản:', JSON.stringify(text.name));
console.log('  fontSize:', text.fontSize, '| pos.y:', text.derivedTextData.glyphs[1].position.y);
console.log('  glyphs:', text.derivedTextData.glyphs.length, '| blobs cần:', new Set(text.derivedTextData.glyphs.map((g: any) => g.commandsBlob)).size);

// Giữ NGUYÊN toàn bộ mảng blob gốc — đây là điều đã chứng minh là bắt buộc.
const outMessage = createNodeChangesMessage([document, canvas, text] as never, {
  blobs: (message.blobs ?? []) as never,
});
const encoded = codec.encodeMessage(outMessage as never);
const archive = packArchive({ version: unpacked.version, schema: unpacked.schema, message: encoded });
writeFileSync(outPath, buildFigmaClipboardHtml({ metadata: parsed.metadata, archive, fallbackText: 'Paste from Stitch Local' }));
console.log('archive:', archive.length, 'byte | blob giữ nguyên:', (message.blobs ?? []).length, '->', outPath);
