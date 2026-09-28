/**
 * Round-trip mẫu clipboard Figma: đọc file `.html` -> bóc gói -> encode lại -> ghi ra file.
 *
 * Mục đích là cổng quyết định của Task 0: chứng minh hiểu đúng định dạng. Nếu file
 * sinh ra dán được vào Figma, thì encoder tự sinh payload từ IR cũng sẽ chạy.
 *
 *   node scripts/figma-roundtrip.mjs <vào.html> [--out <ra.html>] [--clipboard]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { unpackArchive, packArchive } = require('../packages/server/src/figma/archive.ts');
const { getCodec, loadSchemaBytes } = require('../packages/server/src/figma/codec.ts');
const { buildFigmaClipboardHtml, parseFigmaClipboardHtml } = require('../packages/server/src/figma/clipboard.ts');

const args = process.argv.slice(2);
const inputPath = args.find((a) => !a.startsWith('--'));
if (!inputPath) {
  console.error('Dùng: node scripts/figma-roundtrip.mjs <vào.html> [--out <ra.html>] [--clipboard]');
  process.exit(1);
}
const outIndex = args.indexOf('--out');
const outputPath = outIndex >= 0 ? args[outIndex + 1] : null;
const toClipboard = args.includes('--clipboard');

// ---------- 1. Bóc clipboard ----------
const html = readFileSync(inputPath, 'utf8');
const parsed = parseFigmaClipboardHtml(html);
if (!parsed) {
  console.error('Không bóc được (figmeta)/(figma) từ file.');
  process.exit(1);
}
console.log('Đọc vào :', inputPath.split('/').pop());
console.log('figmeta :', JSON.stringify(parsed.metadata));
console.log('archive :', parsed.archive.length, 'byte');

// ---------- 2. Bóc archive ----------
const unpacked = unpackArchive(new Uint8Array(parsed.archive));
console.log('version :', unpacked.version);
console.log('chunk 0 :', unpacked.schema.length, 'B (' + unpacked.schemaAlgorithm + ')');
console.log('chunk 1 :', unpacked.message.length, 'B (' + unpacked.messageAlgorithm + ')');

// ---------- 3. Giải mã rồi encode lại ----------
const codec = getCodec();
const message = codec.decodeMessage(unpacked.message);
const reencoded = Buffer.from(codec.encodeMessage(message));
const identical = reencoded.length === unpacked.message.length
  && Buffer.compare(reencoded, Buffer.from(unpacked.message)) === 0;

console.log();
console.log('=== KIỂM TRA MÃ HOÁ ===');
console.log('decode -> encode:', reencoded.length, 'B, khớp bản gốc:', identical ? 'CÓ' : 'KHÔNG');
console.log('type    :', message.type, '| nodeChanges:', (message.nodeChanges ?? []).length, '| blobs:', (message.blobs ?? []).length);

// ---------- 4. Đóng gói lại ----------
const archiveOut = packArchive({
  version: unpacked.version,
  schema: loadSchemaBytes(),
  message: reencoded,
});
console.log();
console.log('=== ĐÓNG GÓI LẠI ===');
console.log('archive ra:', archiveOut.length, 'byte (vào', parsed.archive.length + ')');
const verify = unpackArchive(archiveOut);
console.log('bóc lại  :', verify.message.length, 'B, khớp:', Buffer.compare(Buffer.from(verify.message), Buffer.from(unpacked.message)) === 0 ? 'CÓ' : 'KHÔNG');

// ---------- 5. Dựng clipboard đúng cú pháp ----------
const htmlOut = buildFigmaClipboardHtml({
  metadata: parsed.metadata,
  archive: archiveOut,
  fallbackText: 'Paste from Stitch Local',
});
console.log();
console.log('=== CLIPBOARD ===');
console.log('độ dài:', (htmlOut.length / 1024).toFixed(1) + 'KB');
console.log('mở đầu:', JSON.stringify(htmlOut.slice(0, 90)));
console.log('kết thúc:', JSON.stringify(htmlOut.slice(-60)));

// Bóc lại chính chuỗi vừa dựng — bảo đảm đối xứng.
const recheck = parseFigmaClipboardHtml(htmlOut);
console.log('bóc lại chính nó:', recheck ? `ĐẠT (${recheck.archive.length} byte, pasteID ${recheck.metadata.pasteID})` : 'HỎNG');

if (outputPath) {
  writeFileSync(outputPath, htmlOut);
  console.log('đã ghi  :', outputPath);
}
if (toClipboard) {
  writeFileSync('/tmp/figma-clipboard.html', htmlOut);
  execFileSync('osascript', ['-e', 'set the clipboard to (read (POSIX file "/tmp/figma-clipboard.html") as «class HTML»)']);
  console.log('đã vào clipboard — sang Figma bấm Cmd+V');
}
