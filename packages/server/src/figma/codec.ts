/**
 * Codec Kiwi cho message clipboard của Figma.
 *
 * Schema được trích sẵn vào `schema/figma-v106.kiwi` (74KB) nên lúc chạy chỉ cần
 * `decodeBinarySchema` một lần rồi cache. Không import `fig-kiwi` — gói đó ghim
 * schema cũ và đã lệch nhiều so với Figma hiện tại.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileSchema, decodeBinarySchema, type Definition, type Schema } from 'kiwi-schema';

const SCHEMA_PATH = fileURLToPath(new URL('./schema/figma-v106.kiwi', import.meta.url));

/** Các loại node dùng nhiều field nhất, dựa trên thống kê mẫu thật. */
export type FigmaNodeType =
  | 'DOCUMENT'
  | 'CANVAS'
  | 'FRAME'
  | 'GROUP'
  | 'TEXT'
  | 'VECTOR'
  | 'ROUNDED_RECTANGLE'
  | 'ELLIPSE'
  | 'RECTANGLE'
  | 'LINE'
  | 'REGULAR_POLYGON'
  | 'STAR'
  | 'BOOLEAN_OPERATION'
  | 'COMPONENT'
  | 'INSTANCE'
  | 'SLICE';

export interface Vector {
  x: number;
  y: number;
}

export interface Matrix {
  m00: number;
  m01: number;
  m02: number;
  m10: number;
  m11: number;
  m12: number;
}

/** `guid` là `{ sessionID, localID }`; `localID` định danh node trong phiên. */
export interface Guid {
  sessionID: number;
  localID: number;
}

/** Vị trí trong danh sách con, dùng fractional indexing (con đầu là `"!"`). */
export interface ParentIndex {
  guid: Guid;
  position: string;
}

export interface Color {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export interface Paint {
  type: 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'IMAGE' | 'VIDEO' | string;
  color?: Color;
  opacity?: number;
  visible?: boolean;
  blendMode?: string;
}

export type StackMode = 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID';
export type StackSizing = 'FIXED' | 'RESIZE_TO_FIT' | 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE';
export type StackAlign = 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN' | 'BASELINE';

export interface NodeChange {
  guid?: Guid;
  phase?: string;
  type?: FigmaNodeType | string;
  name?: string;
  visible?: boolean;
  opacity?: number;
  transform?: Matrix;
  size?: Vector;
  parentIndex?: ParentIndex;
  fillPaints?: Paint[];
  strokePaints?: Paint[];
  strokeWeight?: number;
  strokeAlign?: string;
  cornerRadius?: number;
  effects?: unknown[];
  // Auto layout
  stackMode?: StackMode;
  stackSpacing?: number;
  stackPadding?: number;
  stackHorizontalPadding?: number;
  stackVerticalPadding?: number;
  stackPaddingRight?: number;
  stackPaddingBottom?: number;
  stackPrimaryAlignItems?: StackAlign;
  stackCounterAlignItems?: StackAlign;
  stackPrimarySizing?: StackSizing;
  stackCounterSizing?: StackSizing;
  stackChildAlignSelf?: StackAlign;
  stackChildPrimaryGrow?: number;
  stackPositioning?: string;
  stackReverseZIndex?: boolean;
  // Text
  fontName?: { family: string; style: string };
  fontSize?: number;
  lineHeight?: { value: number; units: string };
  letterSpacing?: { value: number; units: string };
  textData?: { characters: string; lines?: unknown[] };
  derivedTextData?: unknown;
  textAutoResize?: string;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  textCase?: string;
  textDecoration?: string;
  [key: string]: unknown;
}

export interface MessageBlob {
  bytes?: Uint8Array;
}

export interface NodeChangesMessage {
  type: string;
  /** Phiên của người gửi. Payload thật của Figma dùng `0`. */
  sessionID?: number;
  ackID?: number;
  nodeChanges?: NodeChange[];
  blobs?: MessageBlob[];
  /** Khoá phiên dán — Figma dùng để nhận diện payload. */
  pasteID?: number;
  pasteFileKey?: string;
  pasteIsPartiallyOutsideEnclosingFrame?: boolean;
  /** Canvas đích. THIẾU FIELD NÀY thì Figma không dán vào đâu cả. */
  pastePageId?: Guid;
  isCut?: boolean;
  pasteEditorType?: string;
  publishedAssetGuids?: Guid[];
  [key: string]: unknown;
}

/**
 * Metadata tầng message mà Figma yêu cầu để thực hiện dán.
 *
 * Đây là các giá trị Stitch gửi, đo được từ payload thật và giống hệt nhau ở
 * những lần copy khác thời điểm — nên là hằng số, không phải giá trị ngẫu nhiên.
 * Thiếu `pastePageId` thì Figma parse thành công nhưng lặng lẽ không dán gì.
 */
export const FIGMA_PASTE_METADATA = {
  sessionID: 0,
  ackID: 0,
  pasteID: 1815303332,
  pasteFileKey: '42',
  pasteIsPartiallyOutsideEnclosingFrame: false,
  pastePageId: { sessionID: 0, localID: 1 },
  isCut: false,
  pasteEditorType: 'DESIGN',
  publishedAssetGuids: [] as Guid[],
};

/** Bọc danh sách node thành message `NODE_CHANGES` đủ metadata để Figma dán được. */
export function createNodeChangesMessage(
  nodeChanges: NodeChange[],
  overrides: Partial<NodeChangesMessage> = {},
): NodeChangesMessage {
  return {
    type: 'NODE_CHANGES',
    ...FIGMA_PASTE_METADATA,
    nodeChanges,
    ...overrides,
  };
}

export interface CompiledCodec {
  schema: Schema;
  definitions: Map<string, Definition>;
  encodeMessage(message: NodeChangesMessage): Uint8Array;
  decodeMessage(buffer: Uint8Array): NodeChangesMessage;
}

let cachedSchemaBytes: Uint8Array | null = null;
let cachedCodec: CompiledCodec | null = null;

export function loadSchemaBytes(): Uint8Array {
  if (!cachedSchemaBytes) {
    cachedSchemaBytes = new Uint8Array(readFileSync(SCHEMA_PATH));
  }
  return cachedSchemaBytes;
}

/** Biên dịch schema một lần rồi tái sử dụng — biên dịch lại khá tốn thời gian. */
export function getCodec(): CompiledCodec {
  if (cachedCodec) return cachedCodec;

  const schema = decodeBinarySchema(loadSchemaBytes());
  const compiler = compileSchema(schema);
  const definitions = new Map(schema.definitions.map((definition) => [definition.name, definition]));

  cachedCodec = {
    schema,
    definitions,
    encodeMessage: (message) => compiler.encodeMessage(message) as Uint8Array,
    decodeMessage: (buffer) => compiler.decodeMessage(buffer) as NodeChangesMessage,
  };
  return cachedCodec;
}

export interface SchemaFieldInfo {
  name: string;
  /** Tên định nghĩa Kiwi, hoặc kiểu nguyên thuỷ (`bool`, `int`, `string`...). */
  type: string | null;
  isArray: boolean;
  isDeprecated: boolean;
  /** Tag trên dây. */
  tag: number;
}

/**
 * Liệt kê field của một định nghĩa — dùng khi debug encoder.
 *
 * Lưu ý: Kiwi `MESSAGE` mã hoá theo tag, field chỉ xuất hiện khi có giá trị, nên
 * KHÔNG có khái niệm field bắt buộc. `isDeprecated` là thứ duy nhất làm thay đổi
 * cách đọc ghi (bị coi là dữ liệu cũ, bỏ qua khi decode).
 */
export function describeDefinition(name: string): SchemaFieldInfo[] {
  const definition = getCodec().definitions.get(name);
  if (!definition) throw new Error(`Không có định nghĩa ${JSON.stringify(name)} trong schema.`);
  return definition.fields.map((field) => ({
    name: field.name,
    type: field.type,
    isArray: field.isArray,
    isDeprecated: field.isDeprecated,
    tag: field.value,
  }));
}

/** Các field thực sự có mặt trên một node — tiện so sánh khi round-trip. */
export function presentFields(node: NodeChange): string[] {
  return Object.keys(node)
    .filter((key) => node[key] !== undefined && node[key] !== null)
    .sort();
}
