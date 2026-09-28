/**
 * Đóng gói / bóc gói phần lưu trữ nhị phân trong clipboard Figma (`(figma)`).
 *
 * Định dạng:
 *
 *   "fig-kiwi" | uint32 LE version | [uint32 LE độ dài][chunk nén]...
 *
 * Chunk 0 là schema Kiwi, chunk 1 là message. Chunk có thể nén bằng deflate thô
 * hoặc zstd — Figma đổi thuật toán theo phiên bản, nên phải dò lúc đọc.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { decompress as zstdDecompress } from 'fzstd';

const MAGIC = 'fig-kiwi';
const HEADER_LENGTH = 12;
/** Magic frame của zstd: uint32 LE `0xFD2FB528`. */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

export type ReadAlgorithm = 'deflate' | 'zstd';
/** Chỉ đọc được zstd: `fzstd` không có hàm nén, và Figma đọc được deflate. */
export type WriteAlgorithm = 'deflate';

export interface FigmaArchive {
  version: number;
  /** Chunk 0: schema Kiwi. */
  schema: Uint8Array;
  /** Chunk 1: message (`NODE_CHANGES`). */
  message: Uint8Array;
}

export function isZstdFrame(buffer: Uint8Array): boolean {
  return buffer.length >= ZSTD_MAGIC.length
    && ZSTD_MAGIC.every((byte, index) => buffer[index] === byte);
}

/** Dò thuật toán theo magic rồi giải nén. */
export function decompressAuto(buffer: Uint8Array): { algorithm: ReadAlgorithm; data: Uint8Array } {
  if (isZstdFrame(buffer)) {
    return { algorithm: 'zstd', data: zstdDecompress(buffer) };
  }
  return { algorithm: 'deflate', data: inflateRawSync(buffer) };
}

export function compress(buffer: Uint8Array, algorithm: WriteAlgorithm = 'deflate'): Uint8Array {
  return algorithm === 'deflate'
    ? deflateRawSync(buffer)
    : (() => { throw new Error(`Không hỗ trợ nén ${algorithm}: fzstd chỉ giải nén.`); })();
}

function toBuffer(data: Uint8Array): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Bóc phần lưu trữ thành các chunk thô (chưa giải nén). */
export function splitChunks(archive: Uint8Array): Uint8Array[] {
  const buffer = toBuffer(archive);
  if (buffer.length < HEADER_LENGTH) {
    throw new Error(`Lưu trữ quá ngắn: ${buffer.length} byte, cần ít nhất ${HEADER_LENGTH}.`);
  }
  const magic = buffer.subarray(0, 8).toString('latin1');
  if (magic !== MAGIC) {
    throw new Error(`Sai magic: ${JSON.stringify(magic)}, mong đợi ${JSON.stringify(MAGIC)}.`);
  }

  const chunks: Uint8Array[] = [];
  let offset = HEADER_LENGTH;
  while (offset + 4 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    if (length === 0) break;
    const start = offset + 4;
    if (start + length > buffer.length) {
      throw new Error(`Chunk ở offset ${offset} vượt biên: cần ${start + length}, chỉ có ${buffer.length}.`);
    }
    chunks.push(buffer.subarray(start, start + length));
    offset = start + length;
  }
  return chunks;
}

/** Bóc phần lưu trữ và giải nén schema + message. */
export function unpackArchive(archive: Uint8Array): FigmaArchive & { schemaAlgorithm: ReadAlgorithm; messageAlgorithm: ReadAlgorithm } {
  const buffer = toBuffer(archive);
  const version = buffer.readUInt32LE(8);
  const chunks = splitChunks(archive);
  if (chunks.length < 2) {
    throw new Error(`Chỉ có ${chunks.length} chunk, cần ít nhất 2 (schema + message).`);
  }

  const schemaChunk = decompressAuto(chunks[0]);
  const messageChunk = decompressAuto(chunks[1]);
  return {
    version,
    schema: schemaChunk.data,
    message: messageChunk.data,
    schemaAlgorithm: schemaChunk.algorithm,
    messageAlgorithm: messageChunk.algorithm,
  };
}

export interface PackOptions {
  /** Mặc định 106 — phiên bản schema Figma hiện hành. */
  version?: number;
  /** Mặc định `deflate`: luôn đọc được, không phụ thuộc thư viện zstd của Figma. */
  algorithm?: WriteAlgorithm;
}

/** Đóng gói schema + message thành phần lưu trữ hoàn chỉnh. */
export function packArchive(archive: FigmaArchive, options: PackOptions = {}): Uint8Array {
  const version = options.version ?? 106;
  const algorithm = options.algorithm ?? 'deflate';

  const schemaChunk = compress(archive.schema, algorithm);
  const messageChunk = compress(archive.message, algorithm);

  const header = Buffer.alloc(HEADER_LENGTH);
  header.write(MAGIC, 0, 'latin1');
  header.writeUInt32LE(version, 8);

  const parts: Buffer[] = [header];
  for (const chunk of [schemaChunk, messageChunk]) {
    const lengthPrefix = Buffer.alloc(4);
    lengthPrefix.writeUInt32LE(chunk.length);
    parts.push(lengthPrefix, toBuffer(chunk));
  }
  return Buffer.concat(parts);
}
