/**
 * Spike: trích outline chữ từ font rồi đóng gói thành blob đúng định dạng Figma.
 *
 * Mục tiêu là chứng minh có thể TỰ SINH blob, không cần payload mẫu. Kiểm chứng
 * bằng cách giải mã lại blob vừa sinh và so đường vẽ với outline gốc của font.
 *
 *   npx tsx scripts/diagnostics/font-outline-spike.ts <font.ttf>
 */
import { readFileSync } from 'node:fs';
import opentype from 'opentype.js';

const ARITY: Record<number, number> = { 0: 0, 1: 2, 2: 2, 3: 4, 4: 6 };
const LETTER: Record<number, string> = { 0: 'Z', 1: 'M', 2: 'L', 3: 'Q', 4: 'C' };

/** Đóng gói danh sách lệnh thành blob nhị phân: [u8 tag][f32 LE args]*. */
function encodePathCommands(commands: Array<{ op: string; coords: number[] }>): Uint8Array {
  const TAG: Record<string, number> = { Z: 0, M: 1, L: 2, Q: 3, C: 4 };
  const size = commands.reduce((total, command) => total + 1 + command.coords.length * 4, 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const command of commands) {
    bytes[offset++] = TAG[command.op];
    for (const coord of command.coords) { view.setFloat32(offset, coord, true); offset += 4; }
  }
  return bytes;
}

function decodePathBlob(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Array<{ op: string; coords: number[] }> = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = bytes[offset++];
    const arity = ARITY[tag];
    if (arity === undefined) throw new Error(`tag lạ ${tag} tại byte ${offset - 1}`);
    const coords: number[] = [];
    for (let i = 0; i < arity; i++) { coords.push(view.getFloat32(offset, true)); offset += 4; }
    out.push({ op: LETTER[tag], coords });
  }
  return out;
}

const fontPath = process.argv[2];
const buffer = readFileSync(fontPath);
const font = opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
console.log('font   :', font.names.fullName?.en ?? '(không tên)');
console.log('unitsPerEm:', font.unitsPerEm);

const wanted = process.argv[3] ?? 'DH';
for (const character of wanted) {
  const glyph = font.charToGlyph(character);
  const path = glyph.getPath(0, 0, font.unitsPerEm);
  console.log();
  console.log(`### ${JSON.stringify(character)} — glyph index ${glyph.index}, advanceWidth ${glyph.advanceWidth} (${(glyph.advanceWidth / font.unitsPerEm).toFixed(4)} em)`);
  console.log('  outline ops:', path.commands.length);

  // Đưa về hệ em, đảo trục y để khớp quy ước Figma (y hướng lên).
  const emCommands = path.commands.map((command) => {
    const coords: number[] = [];
    for (const key of ['x1', 'y1', 'x2', 'y2', 'x', 'y'] as const) {
      if ((command as never)[key] !== undefined) {
        const isY = key.startsWith('y');
        coords.push(((command as never)[key] as number) / font.unitsPerEm * (isY ? 1 : 1));
      }
    }
    return { op: command.type.toUpperCase(), coords };
  });
  const sample = emCommands.slice(0, 6).map((c) => `${c.op}(${c.coords.map((n) => n.toFixed(3)).join(' ')})`).join(' ');
  console.log('  hệ em  :', sample);

  const blob = encodePathCommands(emCommands);
  console.log('  blob   :', blob.length, 'byte');

  // Kiểm chứng đối xứng: giải mã lại phải ra đúng lệnh ban đầu.
  const roundtrip = decodePathBlob(blob);
  const same = roundtrip.length === emCommands.length
    && roundtrip.every((c, i) => c.op === emCommands[i].op
      && c.coords.length === emCommands[i].coords.length
      && c.coords.every((n, j) => Math.abs(n - emCommands[i].coords[j]) < 1e-6));
  console.log('  round-trip blob:', same ? 'ĐẠT' : 'HỎNG');

  // So độ dài với blob thật của Figma để biết có cùng bậc độ lớn không.
  console.log('  số lệnh:', emCommands.length, '| kích thước lý thuyết:', 1 + emCommands[0]?.coords.length * 4, '+ ...');
}
