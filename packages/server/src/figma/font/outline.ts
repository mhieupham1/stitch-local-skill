/**
 * Chuyển outline chữ thành blob đường vẽ của Figma.
 *
 * Định dạng blob (đã dịch ngược và kiểm chứng, không có header):
 *
 *   [u8 tag][f32 LE args]*;  tag 0=ClosePath, 1=MoveTo, 2=LineTo, 3=QuadTo, 4=CubicTo
 *
 * Toạ độ ở hệ em (chia cho unitsPerEm), gốc tại baseline, trục y hướng LÊN.
 */
export interface PathCommand {
  op: 'Z' | 'M' | 'L' | 'Q' | 'C';
  coords: number[];
}

const TAG: Record<PathCommand['op'], number> = { Z: 0, M: 1, L: 2, Q: 3, C: 4 };
const ARITY: Record<number, number> = { 0: 0, 1: 2, 2: 2, 3: 4, 4: 6 };
const LETTER: Record<number, PathCommand['op']> = { 0: 'Z', 1: 'M', 2: 'L', 3: 'Q', 4: 'C' };

/** Đóng gói lệnh thành blob nhị phân. */
export function encodePathCommands(commands: PathCommand[]): Uint8Array {
  const size = commands.reduce((total, command) => total + 1 + command.coords.length * 4, 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const command of commands) {
    bytes[offset++] = TAG[command.op];
    for (const coord of command.coords) {
      view.setFloat32(offset, coord, true);
      offset += 4;
    }
  }
  return bytes;
}

/** Giải mã blob trở lại thành lệnh. Ném lỗi khi gặp tag lạ để không hiểu sai dữ liệu. */
export function decodePathCommands(bytes: Uint8Array): PathCommand[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const commands: PathCommand[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = bytes[offset++];
    const arity = ARITY[tag];
    if (arity === undefined) throw new Error(`Tag lạ ${tag} tại byte ${offset - 1}.`);
    if (offset + arity * 4 > bytes.length) throw new Error(`Lệnh ${tag} bị cắt tại byte ${offset - 1}.`);
    const coords: number[] = [];
    for (let i = 0; i < arity; i++) {
      coords.push(view.getFloat32(offset, true));
      offset += 4;
    }
    commands.push({ op: LETTER[tag], coords });
  }
  return commands;
}

/** Một hình dạng đường vẽ trích từ font, kèm thông tin bố cục. */
export interface GlyphOutline {
  /** Lệnh đường vẽ ở hệ em. */
  commands: PathCommand[];
  /** Bề rộng tiến con trỏ, theo em. */
  advance: number;
}

/**
 * Trích outline của một ký tự từ font.
 *
 * Trả về `null` nếu font không có ký tự đó, để phía gọi quyết định thay thế.
 */
export function outlineFromFont(
  font: { charToGlyph(character: string): { getPath(x: number, y: number, size: number): { commands: Array<Record<string, unknown>> }; advanceWidth?: number } ; unitsPerEm: number },
  character: string,
): GlyphOutline | null {
  const glyph = font.charToGlyph(character);
  if (!glyph || !glyph.getPath) return null;
  const path = glyph.getPath(0, 0, font.unitsPerEm);
  const scale = 1 / font.unitsPerEm;
  const commands: PathCommand[] = [];
  for (const raw of path.commands) {
    const type = String(raw.type).toUpperCase() as PathCommand['op'];
    if (!(type in TAG)) continue;
    const coords: number[] = [];
    for (const key of ['x1', 'y1', 'x2', 'y2', 'x', 'y'] as const) {
      const value = raw[key];
      if (typeof value !== 'number') continue;
      // PHẢI đảo dấu y. `opentype.js` cho y hướng lên; Figma lưu y hướng xuống.
      // Kiểm chứng bằng thử nghiệm dán: không đảo thì chữ LỘN NGƯỢC trong Figma.
      // (Blob mẫu của Stitch có y âm vì font Inter của họ ở hệ khác, nhưng tự
      // sinh từ font thì buộc phải đảo.)
      coords.push(key.startsWith('y') ? -value * scale : value * scale);
    }
    commands.push({ op: type, coords });
  }
  return { commands, advance: (glyph.advanceWidth ?? 0) * scale };
}
