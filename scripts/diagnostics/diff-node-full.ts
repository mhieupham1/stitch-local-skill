/**
 * So TOÀN BỘ nội dung một node giữa hai payload, đi sâu vào mọi field lồng nhau.
 *
 * Khác với diff-text.ts (chỉ so khoá ở mức cao), script này đệ quy để phát hiện
 * khác biệt nằm sâu trong struct, ví dụ bên trong `derivedTextData`.
 */
import { readFileSync } from 'node:fs';
import { decodeBinarySchema, compileSchema } from 'kiwi-schema';
import { unpackArchive } from '../../packages/server/src/figma/archive.ts';
import { parseFigmaClipboardHtml } from '../../packages/server/src/figma/clipboard.ts';

function load(path: string) {
  const parsed = parseFigmaClipboardHtml(readFileSync(path, 'utf8'))!;
  const unpacked = unpackArchive(new Uint8Array(parsed.archive));
  return {
    message: compileSchema(decodeBinarySchema(unpacked.schema)).decodeMessage(unpacked.message) as Record<string, any>,
    blobCount: ((parsed.archive) as Uint8Array).length,
  };
}

const [a, b, type = 'TEXT'] = process.argv.slice(2);
const left = load(a), right = load(b);
const pick = (message: Record<string, any>) =>
  (message.nodeChanges as Array<Record<string, any>>).find((node) => node.type === type);
const l = pick(left.message), r = pick(right.message);
if (!l || !r) { console.error('Không tìm thấy node loại ' + type); process.exit(1); }

const differences: string[] = [];
function walk(x: unknown, y: unknown, path: string) {
  if (x instanceof Uint8Array || y instanceof Uint8Array) {
    const len = (v: unknown) => (v instanceof Uint8Array ? v.length : -1);
    if (len(x) !== len(y)) differences.push(`${path}: byte ${len(x)} vs ${len(y)}`);
    return;
  }
  if (Array.isArray(x) || Array.isArray(y)) {
    const ax = Array.isArray(x) ? x : [], ay = Array.isArray(y) ? y : [];
    if (ax.length !== ay.length) {
      differences.push(`${path}: mảng ${ax.length} vs ${ay.length} phần tử`);
      return;
    }
    for (let i = 0; i < ax.length; i++) walk(ax[i], ay[i], `${path}[${i}]`);
    return;
  }
  if (x && y && typeof x === 'object' && typeof y === 'object') {
    for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
      walk((x as never)[key], (y as never)[key], path ? `${path}.${key}` : key);
    }
    return;
  }
  if (JSON.stringify(x) !== JSON.stringify(y)) {
    differences.push(`${path}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
  }
}

walk(l, r, '');
console.log('node:', type, '|', JSON.stringify(l.name), 'vs', JSON.stringify(r.name));
console.log();
if (!differences.length) console.log('KHÔNG có khác biệt nào trong node.');
else for (const d of differences) console.log('  ' + d);
console.log();
console.log('blob trong file: trái =', (left.message.blobs ?? []).length, '| phải =', (right.message.blobs ?? []).length);
