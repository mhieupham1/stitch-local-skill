/**
 * Sinh payload hoàn chỉnh TỪ SỐ KHÔNG: frame + text có blob đường vẽ tự trích từ font.
 *
 * Đây là phép thử cuối của spike font engine: nếu chữ hiện đủ trong Figma thì đã
 * chứng minh được toàn bộ đường đi — từ font trên máy tới blob trong clipboard —
 * mà không mượn dữ liệu nào từ payload mẫu.
 *
 *   npx tsx scripts/figma-generate-from-font.ts --font <font.ttf> [--text "Xin chào"] [--clipboard]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import opentype from 'opentype.js';

const require = createRequire(import.meta.url);
const { packArchive } = require('../packages/server/src/figma/archive.ts');
const { getCodec, loadSchemaBytes, createNodeChangesMessage } = require('../packages/server/src/figma/codec.ts');
const { buildFigmaClipboardHtml } = require('../packages/server/src/figma/clipboard.ts');
const { outlineFromFont, encodePathCommands } = require('../packages/server/src/figma/font/outline.ts');

const args = process.argv.slice(2);
const fontIndex = args.indexOf('--font');
const fontPath = fontIndex >= 0 ? args[fontIndex + 1] : '/System/Library/Fonts/Geneva.ttf';
const textIndex = args.indexOf('--text');
const text = textIndex >= 0 ? args[textIndex + 1] : 'Xin chào Figma';
const toClipboard = args.includes('--clipboard');
const outIndex = args.indexOf('--out');
const outputPath = outIndex >= 0 ? args[outIndex + 1] : null;
const FONT_SIZE = 32;
const SESSION = 100;
/**
 * Khoảng cách thêm giữa các ký tự, tính bằng pixel.
 *
 * Công thức con trỏ ngang đã kiểm chứng trên payload thật (sai số < 0.0001):
 *   pos.x          = Σ (advance × fontSize + letterSpacing) cho các glyph trước
 *   baseline.width = Σ (advance × fontSize + letterSpacing)
 * Bỏ qua số hạng này làm chữ dồn sát nhau khi nguồn có `letter-spacing`.
 */
const LETTER_SPACING = Number(args[args.indexOf('--letter-spacing') + 1]) || 0;

// ---------- 1. Trích outline từng ký tự từ font ----------
const buffer = readFileSync(fontPath);
const font = opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
// Tên font: ưu tiên `fontFamily` rồi mới tới `fullName`, vì một số font (Geneva)
// chỉ có `fontFamily` ở bảng macintosh và thiếu `fullName` ở bảng windows.
const names = font.names as unknown as Record<string, Record<string, Record<string, string>>>;
const family = names.macintosh?.fontFamily?.en
  ?? names.windows?.fontFamily?.en
  ?? names.macintosh?.fullName?.en
  ?? names.windows?.fullName?.en
  ?? 'Unknown';
const postscript = names.macintosh?.postScriptName?.en ?? names.windows?.postScriptName?.en ?? '';
const fontStyle = names.macintosh?.fontSubfamily?.en ?? 'Regular';
console.log('font       :', family, '|', fontStyle, '|', postscript, '| unitsPerEm:', font.unitsPerEm);

/** Mỗi blob là một hình dạng; cùng một ký tự dùng lại blob cũ cho gọn. */
const blobs: Array<{ bytes: Uint8Array }> = [];
const cache = new Map<string, number>();

/**
 * `position.y` là ĐƯỜNG CƠ SỞ (baseline), và blob ở hệ y HƯỚNG LÊN như
 * `opentype.js` (đo từ payload thật: chữ "M" có `y` nhỏ nhất là -0.011, tức
 * phần chân chữ thò dưới baseline).
 *
 * Kiểm chứng: với fontSize 13 và node cao 18px, `pos.y − max(y)×fontSize` cho
 * đỉnh chữ nằm trong node; còn nếu coi `pos.y` là đỉnh dòng thì đáy chữ tràn ra
 * ngoài node (23.3 > 18) — nên cách hiểu baseline là đúng.
 */
const ascender = (font as unknown as { ascender: number }).ascender ?? font.unitsPerEm * 0.8;
const descender = (font as unknown as { descender: number }).descender ?? -font.unitsPerEm * 0.2;
const lineHeight = Math.round((ascender - descender) / font.unitsPerEm * FONT_SIZE);
/** Khoảng cách từ mép trên dòng tới đường cơ sở, quy về hệ pixel. */
const baselineY = (ascender / font.unitsPerEm) * FONT_SIZE;
console.log('đo font    : ascender', ascender, '| descender', descender, '| lineHeight', lineHeight, '| baselineY', baselineY.toFixed(3));

interface GlyphEntry {
  /** Không có với ký tự không nét vẽ (dấu cách): Figma chỉ dùng `advance`. */
  commandsBlob?: number;
  firstCharacter: number;
  fontSize: number;
  advance: number;
  position: { x: number; y: number };
  rotation: number;
}

const glyphs: GlyphEntry[] = [];
let penX = 0;
let totalAdvance = 0;

for (let i = 0; i < text.length; i++) {
  const character = text[i];
  const outline = outlineFromFont(font as never, character);

  // Dấu cách không có nét vẽ, nhưng VẪN PHẢI có một glyph.
  //
  // Figma dùng `glyphs[].advance` để tiến con trỏ ngang cho TỪNG ký tự. Bỏ qua
  // dấu cách làm con trỏ không nhảy qua khoảng trắng, khiến các từ dồn vào nhau
  // ("lộn xộn chữ"). Glyph của dấu cách không có `commandsBlob`.
  const advance = outline?.advance
    ?? (font.charToGlyph(character)?.advanceWidth ?? font.unitsPerEm * 0.25) / font.unitsPerEm;

  if (!outline || !outline.commands.length) {
    glyphs.push({
      firstCharacter: i,
      fontSize: FONT_SIZE,
      advance,
      position: { x: penX, y: baselineY },
      rotation: 0,
    });
    penX += advance * FONT_SIZE + LETTER_SPACING;
    totalAdvance += advance * FONT_SIZE + LETTER_SPACING;
    continue;
  }

  // Cùng ký tự -> cùng blob, giống cách Figma nén.
  const key = `${character}:${FONT_SIZE}`;
  let blobIndex = cache.get(key);
  if (blobIndex === undefined) {
    blobs.push({ bytes: encodePathCommands(outline.commands) });
    blobIndex = blobs.length; // 1-based
    cache.set(key, blobIndex);
  }

  glyphs.push({
    commandsBlob: blobIndex,
    firstCharacter: i,
    fontSize: FONT_SIZE,
    // `advance` ở hệ em, phía vẽ tự nhân với fontSize.
    advance: outline.advance,
    // `position.x` là con trỏ chạy theo bề rộng các ký tự trước.
    // `position.y` là ĐƯỜNG CƠ SỞ, chung cho cả dòng.
    position: { x: penX, y: baselineY },
    rotation: 0,
  });
  penX += outline.advance * FONT_SIZE + LETTER_SPACING;
  totalAdvance += outline.advance * FONT_SIZE + LETTER_SPACING;
}

console.log('ký tự      :', JSON.stringify(text), '|', text.length, 'ký tự,', glyphs.length, 'có nét vẽ');
console.log('blob sinh  :', blobs.length, '| tổng', blobs.reduce((total, blob) => total + blob.bytes.length, 0), 'byte');
const textWidth = Math.max(Math.ceil(penX), 40);
console.log('bề rộng đo :', textWidth.toFixed(1), 'px');

// ---------- 2. Dựng cây node ----------
let nextLocalId = 0;
const guid = () => ({ sessionID: SESSION, localID: nextLocalId++ });
const vector = (x: number, y: number) => ({ x, y });
const identity = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
const solidPaint = (r: number, g: number, b: number) => ({
  type: 'SOLID', color: { r, g, b, a: 1 }, opacity: 1, visible: true, blendMode: 'NORMAL',
});

const frameWidth = Math.max(Math.ceil(textWidth) + 48, 120);
const frameHeight = 110;
const canvasId = guid();
const frameId = guid();
const textId = guid();

const nodeChanges = [
  { guid: guid(), phase: 'CREATED', type: 'DOCUMENT', name: 'Document', visible: true, opacity: 1, transform: identity },
  {
    guid: canvasId, phase: 'CREATED', type: 'CANVAS', name: 'Page 1', visible: true, opacity: 1, transform: identity,
    parentIndex: { guid: { sessionID: 0, localID: 0 }, position: '!' },
    backgroundEnabled: true, backgroundOpacity: 1,
  },
  {
    guid: frameId, phase: 'CREATED', type: 'FRAME', name: 'Từ font', visible: true, opacity: 1, transform: identity,
    parentIndex: { guid: canvasId, position: '!' },
    size: vector(frameWidth, frameHeight),
    fillPaints: [solidPaint(0.09, 0.11, 0.16)],
    cornerRadius: 12,
    strokeWeight: 1, strokeAlign: 'INSIDE', strokeJoin: 'MITER',
    effects: [], horizontalConstraint: 'MIN', verticalConstraint: 'MIN', frameMaskDisabled: true,
    stackMode: 'NONE',
  },
  {
    guid: textId, phase: 'CREATED', type: 'TEXT', name: text, visible: true, opacity: 1, transform: identity,
    parentIndex: { guid: frameId, position: '!' },
    size: vector(Math.ceil(textWidth), FONT_SIZE),
    fillPaints: [solidPaint(1, 1, 1)],
    // `postscript` LUÔN để rỗng: cả 38 node thật của Stitch đều vậy, kể cả Inter.
    // Điền tên PostScript vào đây làm Figma không khớp được font -> báo missing.
    fontName: { family, style: fontStyle, postscript: '' },
    fontSize: FONT_SIZE,
    fontVersion: '',
    fontVariantCommonLigatures: true,
    fontVariantContextualLigatures: true,
    textUserLayoutVersion: 4,
    textExplicitLayoutVersion: 1,
    textBidiVersion: 1,
    autoRename: true,
    detachOpticalSizeFromFontSize: true,
    strokeWeight: 1, strokeAlign: 'OUTSIDE', strokeJoin: 'MITER',
    lineHeight: { value: lineHeight, units: 'PIXELS' },
    letterSpacing: { value: LETTER_SPACING, units: 'PIXELS' },
    textAlignHorizontal: 'LEFT',
    textAlignVertical: 'CENTER',
    textAutoResize: 'WIDTH_AND_HEIGHT',
    textData: {
      characters: text,
      lines: [{ lineType: 'PLAIN', styleId: 0, indentationLevel: 0, sourceDirectionality: 'AUTO', listStartOffset: 0, isFirstLineOfList: false }],
    },
    derivedTextData: {
      layoutSize: vector(Math.ceil(textWidth), FONT_SIZE),
      baselines: [{
        position: vector(0, baselineY),
        width: totalAdvance,
        lineY: 0,
        lineHeight,
        lineAscent: baselineY,
        firstCharacter: 0,
        endCharacter: text.length,
      }],
      glyphs,
      fontMetaData: [{
        key: { family, style: fontStyle, postscript: '' },
        fontLineHeight: lineHeight / FONT_SIZE,
        fontStyle: 'NORMAL',
        fontWeight: 400,
      }],
      decorations: [], blockquotes: [], hyperlinkBoxes: [],
      truncationStartIndex: -1, truncatedHeight: -1,
      logicalIndexToCharacterOffsetMap: Array.from({ length: text.length }, (_, i) => i),
      mentionBoxes: [], derivedLines: [], checklistMarkers: [],
    },
  },
];

// ---------- 3. Đóng gói và kiểm tra ----------
const message = createNodeChangesMessage(nodeChanges as never, {
  blobs: blobs as never,
});
const codec = getCodec();
const encoded = codec.encodeMessage(message as never);
const decoded = codec.decodeMessage(encoded) as Record<string, any>;

console.log();
console.log('=== KIỂM TRA ===');
console.log('message    :', encoded.length, 'byte');
console.log('blobs      :', (decoded.blobs ?? []).length);
const decodedText = (decoded.nodeChanges as Array<Record<string, any>>).find((node) => node.type === 'TEXT')!;
const decodedGlyphs = decodedText.derivedTextData.glyphs as Array<Record<string, any>>;
console.log('glyphs     :', decodedGlyphs.length);
const maxBlob = Math.max(...decodedGlyphs.filter((glyph) => typeof glyph.commandsBlob === 'number').map((glyph) => glyph.commandsBlob));
console.log('blob lớn nhất được trỏ tới:', maxBlob, '| blob thực có:', (decoded.blobs ?? []).length, maxBlob <= (decoded.blobs ?? []).length ? 'OK' : 'LỖI');
console.log('ký tự / glyph:', String(decodedText.textData.characters).length, '/', decodedGlyphs.length,
  String(decodedText.textData.characters).length === decodedGlyphs.length ? 'KHỚP' : 'LỆCH — mỗi ký tự phải có một glyph');

// Giải mã lại một blob để chắc chắn dữ liệu đường vẽ còn nguyên.
const { decodePathCommands } = require('../packages/server/src/figma/font/outline.ts');
const sampleBlob = (decoded.blobs as Array<{ bytes: Uint8Array }>)[0].bytes;
const commands = decodePathCommands(sampleBlob);
console.log('blob[0]    :', sampleBlob.length, 'byte ->', commands.length, 'lệnh:', commands.slice(0, 4).map((c: { op: string; coords: number[] }) => c.op + '(' + c.coords.map((n) => n.toFixed(2)).join(' ') + ')').join(' '));

const archive = packArchive({ version: 106, schema: loadSchemaBytes(), message: encoded });
console.log('archive    :', archive.length, 'byte');

const meta = { fileKey: '', pasteID: 1815303332, dataType: 'scene' };
const html = buildFigmaClipboardHtml({ metadata: meta, archive, fallbackText: 'Paste from Stitch Local' });
console.log('clipboard  :', (html.length / 1024).toFixed(1) + 'KB');

if (outputPath) { writeFileSync(outputPath, html); console.log('đã ghi     :', outputPath); }
if (toClipboard) {
  writeFileSync('/tmp/figma-from-font.html', html);
  execFileSync('osascript', ['-e', 'set the clipboard to (read (POSIX file "/tmp/figma-from-font.html") as «class HTML»)']);
  console.log('đã vào clipboard — sang Figma bấm Cmd+V');
}
