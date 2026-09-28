/**
 * Sinh payload clipboard Figma TỪ SỐ KHÔNG, không dựa mẫu nào.
 *
 * Đây là phép thử thật của encoder: dựng cây DOCUMENT > CANVAS > FRAME > TEXT chỉ
 * bằng code, rồi đóng gói thành clipboard để dán vào Figma.
 *
 *   node scripts/figma-generate-minimal.mjs [--clipboard] [--out <file.html>]
 *
 * LƯU Ý về schema: `MESSAGE` dùng tag nên field nào cũng optional, nhưng `STRUCT`
 * ghi cố định theo thứ tự nên MỌI field đều bắt buộc — kể cả khi rỗng (ví dụ
 * `FontName.postscript` phải là `""`, không được bỏ). Vì vậy các struct ở đây
 * luôn được khai đủ field.
 */
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { packArchive } = require('../packages/server/src/figma/archive.ts');
const { getCodec, loadSchemaBytes, createNodeChangesMessage } = require('../packages/server/src/figma/codec.ts');
const { buildFigmaClipboardHtml } = require('../packages/server/src/figma/clipboard.ts');

const args = process.argv.slice(2);
const toClipboard = args.includes('--clipboard');
const outIndex = args.indexOf('--out');
const outputPath = outIndex >= 0 ? args[outIndex + 1] : null;

// Stitch dùng sessionID 100 cho toàn bộ cây node; DOCUMENT dùng 0.
const SESSION = 100;
let nextLocalId = 0;
const guid = () => ({ sessionID: SESSION, localID: nextLocalId++ });

/** `position` là fractional index: con đầu tiên là "!". */
const position = (index) => '!'.repeat(1) + (index === 0 ? '' : String.fromCharCode(33 + index));

/** Vector là STRUCT: phải có đủ `x` và `y`. */
const vector = (x, y) => ({ x, y });

/** Ma trận đơn vị cho node đặt tại gốc. */
const identity = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };

/** FontName là STRUCT 3 field: `postscript` bắt buộc, để rỗng nếu không có. */
const fontName = (family, style, postscript = '') => ({ family, style, postscript });

/**
 * Trục biến thiên của font. `axisTag` là tên trục viết theo ASCII dạng uint32:
 * `'wght'` = 0x77676874 = 2003265652, `'ital'` = 0x6974616C = 1769234796.
 *
 * `Inter` là font biến thiên, nên Figma dùng `fontVariations` để chọn nét chứ
 * không chỉ dựa vào `fontName.style`. Thiếu field này thì chữ không render.
 */
const axisTag = (name) => (name.charCodeAt(0) << 24 | name.charCodeAt(1) << 16 | name.charCodeAt(2) << 8 | name.charCodeAt(3)) >>> 0;
const fontVariation = (axisName, value) => ({ axisTag: axisTag(axisName), axisName, value });

/** Nét chữ theo `font-weight` của CSS. */
const WEIGHT_VALUE = { Regular: 400, Medium: 500, 'Semi Bold': 600, Bold: 700, Black: 900 };

/** Màu là STRUCT, `a` là kênh alpha riêng của Figma và bắt buộc. */
const solidPaint = (r, g, b, a = 1) => ({
  type: 'SOLID',
  color: { r, g, b, a },
  opacity: 1,
  visible: true,
  blendMode: 'NORMAL',
});

const canvasId = guid();
const frameId = guid();
const textId = guid();

const nodeChanges = [
  {
    guid: guid(),
    phase: 'CREATED',
    type: 'DOCUMENT',
    name: 'Document',
    visible: true,
    opacity: 1,
    transform: identity,
  },
  {
    guid: canvasId,
    phase: 'CREATED',
    type: 'CANVAS',
    name: 'Page 1',
    visible: true,
    opacity: 1,
    transform: identity,
    parentIndex: { guid: { sessionID: 0, localID: 0 }, position: '!' },
    backgroundEnabled: true,
    backgroundOpacity: 1,
  },
  {
    guid: frameId,
    phase: 'CREATED',
    type: 'FRAME',
    name: 'Khối thử nghiệm',
    visible: true,
    opacity: 1,
    transform: identity,
    parentIndex: { guid: canvasId, position: position(0) },
    size: vector(400, 240),
    fillPaints: [solidPaint(0.15, 0.39, 0.92)],
    cornerRadius: 16,
    strokeWeight: 1,
    strokeAlign: 'INSIDE',
    strokeJoin: 'MITER',
    effects: [],
    horizontalConstraint: 'MIN',
    verticalConstraint: 'MIN',
    frameMaskDisabled: true,
    stackMode: 'VERTICAL',
    stackSpacing: 12,
    stackHorizontalPadding: 24,
    stackVerticalPadding: 24,
    stackPaddingRight: 24,
    stackPaddingBottom: 24,
    stackPrimaryAlignItems: 'MIN',
    stackCounterAlignItems: 'MIN',
    stackPrimarySizing: 'FIXED',
    stackCounterSizing: 'FIXED',
    stackReverseZIndex: false,
  },
  {
    guid: textId,
    phase: 'CREATED',
    type: 'TEXT',
    name: 'Tiêu đề',
    visible: true,
    opacity: 1,
    transform: identity,
    parentIndex: { guid: frameId, position: position(0) },
    size: vector(352, 32),
    fillPaints: [solidPaint(1, 1, 1)],
    fontName: fontName('Helvetica', 'Bold'),
    fontSize: 24,
    // Inter là font biến thiên: phải khai trục `wght` thì Figma mới render được.
    // Helvetica là font tĩnh, không có trục biến thiên -> không gửi fontVariations.
    // Bật lại dòng dưới khi dùng font biến thiên như Inter.
    // fontVariations: [fontVariation('wght', WEIGHT_VALUE.Bold)],
    fontVersion: '',
    fontVariantCommonLigatures: true,
    fontVariantContextualLigatures: true,
    textUserLayoutVersion: 4,
    textExplicitLayoutVersion: 1,
    textBidiVersion: 1,
    autoRename: true,
    detachOpticalSizeFromFontSize: true,
    strokeWeight: 1,
    strokeAlign: 'OUTSIDE',
    strokeJoin: 'MITER',
    lineHeight: { value: 32, units: 'PIXELS' },
    letterSpacing: { value: 0, units: 'PIXELS' },
    textAlignHorizontal: 'LEFT',
    textAlignVertical: 'CENTER',
    textAutoResize: 'WIDTH_AND_HEIGHT',
    // Figma KHÔNG vẽ text nếu thiếu `derivedTextData` — node tồn tại nhưng không
    // render (chỉ hiện khi double click vào để sửa). Mọi TEXT trong payload thật
    // đều có field này, và `layoutSize` khớp đúng `size` của node. Ta biết kích
    // thước và số dòng từ CSS nên dựng được mà không cần font engine.
    derivedTextData: {
      layoutSize: vector(352, 32),
      baselines: [
        {
          position: vector(0, 24),
          width: 340,
          lineY: 0,
          lineHeight: 32,
          lineAscent: 24,
          firstCharacter: 0,
          endCharacter: 'Xin chào Figma'.length,
        },
      ],
      glyphs: [],
      fontMetaData: [
        {
          key: fontName('Helvetica', 'Bold'),
          fontLineHeight: 1.21,
          fontStyle: 'NORMAL',
          fontWeight: WEIGHT_VALUE.Bold,
        },
      ],
      decorations: [],
      blockquotes: [],
      hyperlinkBoxes: [],
      truncationStartIndex: -1,
      truncatedHeight: -1,
      logicalIndexToCharacterOffsetMap: Array.from({ length: 'Xin chào Figma'.length }, (_, i) => i),
      mentionBoxes: [],
      derivedLines: [],
      checklistMarkers: [],
    },
    textData: {
      characters: 'Xin chào Figma',
      lines: [
        {
          lineType: 'PLAIN',
          styleId: 0,
          indentationLevel: 0,
          sourceDirectionality: 'AUTO',
          listStartOffset: 0,
          isFirstLineOfList: false,
        },
      ],
    },
  },
];

const message = createNodeChangesMessage(nodeChanges);
const codec = getCodec();

console.log('metadata tầng message:');
for (const key of ['sessionID', 'pasteID', 'pasteFileKey', 'pastePageId', 'isCut', 'pasteEditorType']) {
  console.log(`  ${key}: ${JSON.stringify(message[key])}`);
}
console.log();

// Kiểm tra decode lại trước khi đóng gói — bắt lỗi sớm, không đoán mò.
const encoded = codec.encodeMessage(message);
const decoded = codec.decodeMessage(encoded);
console.log('message      :', encoded.length, 'byte, decode lại được', (decoded.nodeChanges ?? []).length, 'node:');
for (const node of decoded.nodeChanges ?? []) {
  console.log(`  - ${node.type}: ${JSON.stringify(node.name)}${node.size ? ` ${Math.round(node.size.x)}x${Math.round(node.size.y)}` : ''}`);
}
const text = (decoded.nodeChanges ?? []).find((n) => n.type === 'TEXT');
console.log('text giữ nguyên:', JSON.stringify(text?.textData?.characters));
console.log('font giữ nguyên:', JSON.stringify(text?.fontName), text?.fontSize + 'px');
// Sửa lại kết luận cũ: KHÔNG phải "Figma tự tính lại". Thực nghiệm cho thấy thiếu
// derivedTextData thì node tồn tại nhưng không render, nên phải gửi kèm.
console.log('derivedTextData:', text?.derivedTextData
  ? `CÓ (layoutSize ${Math.round(text.derivedTextData.layoutSize.x)}x${Math.round(text.derivedTextData.layoutSize.y)}, ${text.derivedTextData.baselines.length} baseline)`
  : 'KHÔNG CÓ — text sẽ không render');

const archive = packArchive({ version: 106, schema: loadSchemaBytes(), message: encoded });
console.log();
console.log('archive      :', archive.length, 'byte');

const meta = { fileKey: '', pasteID: Math.floor(Math.random() * 2 ** 31), dataType: 'scene' };
const html = buildFigmaClipboardHtml({
  metadata: meta,
  archive,
  fallbackText: 'Paste from Stitch Local',
});

console.log('clipboard    :', (html.length / 1024).toFixed(1) + 'KB');
console.log('mở đầu       :', JSON.stringify(html.slice(0, 80)));
if (outputPath) { writeFileSync(outputPath, html); console.log('đã ghi       :', outputPath); }
if (toClipboard) {
  writeFileSync('/tmp/figma-clipboard.html', html);
  execFileSync('osascript', ['-e', 'set the clipboard to (read (POSIX file "/tmp/figma-clipboard.html") as «class HTML»)']);
  console.log('đã vào clipboard — sang Figma bấm Cmd+V');
}

