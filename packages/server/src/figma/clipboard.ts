/**
 * Dựng chuỗi `text/html` để đưa vào clipboard cho Figma.
 *
 * Cú pháp này bám sát payload thật của Figma/Stitch. Ba điểm dễ làm sai:
 *
 * 1. `<` và `>` bên trong giá trị attribute PHẢI escape thành `&lt;`/`&gt;`.
 *    Để trần thì trình duyệt cắt attribute tại đó và Figma nhận chuỗi rác.
 * 2. `data-metadata` và `data-buffer` bao bằng nháy kép, còn thẻ `<meta>` đầu
 *    dùng nháy đơn.
 * 3. Phải có `<html><head><body>` bao ngoài và một đoạn text hiển thị sau các
 *    span, để nơi không hiểu định dạng vẫn có nội dung thay thế.
 */

export interface FigmaClipboardParts {
  /** JSON `figmeta`, ví dụ `{ fileKey, pasteID, dataType: "scene" }`. */
  metadata: unknown;
  /** Phần lưu trữ nhị phân đã đóng gói. */
  archive: Uint8Array;
  /** Text hiển thị thay thế cho nơi không đọc được định dạng. */
  fallbackText?: string;
}

/** Ghép metadata + archive thành chuỗi `text/html` để ghi vào clipboard. */
export function buildFigmaClipboardHtml(parts: FigmaClipboardParts): string {
  // `figmeta` là base64 của JSON (không phải JSON thô). Base64 chỉ gồm ký tự an
  // toàn trong attribute nên KHÔNG cần escape — escape vào sẽ làm Figma đọc hỏng.
  const metadata = Buffer.from(JSON.stringify(parts.metadata), 'utf8').toString('base64');
  if (!/^[A-Za-z0-9+/=]*$/.test(metadata)) {
    throw new Error('figmeta base64 chứa ký tự lạ — sẽ hỏng khi nhúng vào attribute.');
  }
  const archive = Buffer.from(parts.archive).toString('base64');
  const fallback = parts.fallbackText ?? 'Paste from Stitch Local';

  return [
    "<meta charset='utf-8'>",
    '<html><head><meta charset="utf-8"></head><body>',
    `<span data-metadata="&lt;!--(figmeta)${metadata}(/figmeta)--&gt;"></span>`,
    `<span data-buffer="&lt;!--(figma)${archive}(/figma)--&gt;"></span>`,
    `<span style="white-space:pre-wrap;">${fallback}</span>`,
    '</body></html>',
  ].join('');
}

/** Bóc `text/html` trở lại thành metadata + archive. */
export function parseFigmaClipboardHtml(html: string): { metadata: unknown; archive: Uint8Array } | null {
  const unescape = (value: string) => value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

  const metadataMatch = html.match(/\(figmeta\)([\s\S]*?)\(\/figmeta\)/);
  const archiveMatch = html.match(/\(figma\)([\s\S]*?)\(\/figma\)/);
  if (!metadataMatch || !archiveMatch) return null;

  try {
    const metadata = JSON.parse(Buffer.from(unescape(metadataMatch[1]).replace(/\s/g, ''), 'base64').toString('utf8'));
    const archive = Buffer.from(unescape(archiveMatch[1]).replace(/\s/g, ''), 'base64');
    return { metadata, archive };
  } catch {
    return null;
  }
}
