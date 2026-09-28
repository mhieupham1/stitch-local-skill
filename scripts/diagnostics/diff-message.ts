/**
 * So metadata tầng message giữa payload thật và payload do ta đóng gói lại.
 *
 * Khi node đã giống hệt mà Figma vẫn render khác, khác biệt thường nằm ở đây —
 * đặc biệt `pasteID`, `pastePageId`, `pasteFileKey`.
 */
import { readFileSync } from 'node:fs';
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { unpackArchive } from '../../packages/server/src/figma/archive.ts';
import { parseFigmaClipboardHtml } from '../../packages/server/src/figma/clipboard.ts';

function loadMessage(path: string) {
  const parsed = parseFigmaClipboardHtml(readFileSync(path, 'utf8'))!;
  const unpacked = unpackArchive(new Uint8Array(parsed.archive));
  return {
    metadata: parsed.metadata as Record<string, unknown>,
    message: compileSchema(decodeBinarySchema(unpacked.schema)).decodeMessage(unpacked.message) as Record<string, unknown>,
  };
}

const [a, b] = process.argv.slice(2);
const left = loadMessage(a);
const right = loadMessage(b);

console.log('=== figmeta ===');
for (const key of ['fileKey', 'pasteID', 'dataType']) {
  const l = JSON.stringify((left.metadata as never)[key]);
  const r = JSON.stringify((right.metadata as never)[key]);
  console.log(`  ${key.padEnd(12)} ${l === r ? '=' : '!'} trái=${l} phải=${r}`);
}

console.log();
console.log('=== tầng message ===');
const keys = [...new Set([...Object.keys(left.message), ...Object.keys(right.message)])].sort();
for (const key of keys) {
  if (key === 'nodeChanges' || key === 'blobs') continue;
  const l = JSON.stringify(left.message[key]);
  const r = JSON.stringify(right.message[key]);
  console.log(`  ${key.padEnd(38)} ${l === r ? '=' : '!'} trái=${l} phải=${r}`);
}

console.log();
console.log('=== số lượng ===');
console.log('  nodeChanges: trái =', (left.message.nodeChanges as unknown[]).length, '| phải =', (right.message.nodeChanges as unknown[]).length);
console.log('  blobs      : trái =', ((left.message.blobs ?? []) as unknown[]).length, '| phải =', ((right.message.blobs ?? []) as unknown[]).length);
