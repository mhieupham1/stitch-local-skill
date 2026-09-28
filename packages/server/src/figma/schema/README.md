# Schema Kiwi của Figma

`figma-v106.kiwi` là **binary schema** (định dạng Kiwi) mô tả cấu trúc message clipboard của Figma. Encoder/decoder cần file này để biết field nào tồn tại và kiểu của chúng.

Lấy từ payload thật do Figma sinh, không tải từ mạng lúc chạy. Xem mục "Vì sao phải commit" bên dưới.

## Thông số

| | |
| --- | --- |
| Version archive | 106 |
| Kích thước | 74.549 byte |
| Số định nghĩa | 647 (`ENUM` 212, `STRUCT` 30, `MESSAGE` 405) |
| `NodeChange` | 613 field, **0 field bắt buộc** |
| Nguồn | `figma-sample-01-2026-09-27-08-17-40.html`, copy trong Figma Desktop, 2026-09-27 |

## Vì sao phải commit schema

`fig-kiwi` (npm, 0.0.1) không kèm schema — nó chỉ có `readHTMLMessage()` để *trích ra* schema từ một payload thật. Không có schema thì không encode được message.

Ngoài ra `fig-kiwi` viết cho định dạng cũ và **không hiểu schema v106** (`NodeChange` giờ có 613 field với các cặp union tagged `x`/`xTag`). Vì vậy ta tự viết `archive.ts` trên `kiwi-schema` và giữ schema như một dữ liệu có version.

## Cách lấy lại khi Figma đổi schema

Khi paste vào Figma báo lỗi, hoặc `version` trong archive khác `106`, làm lại các bước sau.

### 1. Lấy một mẫu mới

```bash
open scripts/figma-capture-sample.html
```

Trang này nghe sự kiện `paste`, hiển thị chẩn đoán, và tự tải `text/html` về file.

Trong Figma: chọn một frame nhỏ (có cả text để test đủ đường) → `Cmd+C` → dán vào trang trên.

### 2. Đọc version và kiểm tra nén

```bash
node --input-type=module -e '
import { readFileSync } from "node:fs";
const html = readFileSync(process.argv[1], "utf8");
const un = (s) => s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");
const a = Buffer.from(un(html.match(/\(figma\)([\s\S]*?)\(\/figma\)/)[1]), "base64");
console.log("magic:", a.slice(0,8).toString("latin1"), "| version:", a.readUInt32LE(8));
let o = 12;
while (o + 4 <= a.length) {
  const l = a.readUInt32LE(o);
  if (!l) break;
  const head = a.slice(o+4, o+8).toString("hex");
  const algo = head.startsWith("28b52ffd") ? "zstd" : "deflate";
  console.log("chunk:", l, "byte ->", algo);
  o += 4 + l;
}
' <file-mẫu.html>
```

### 3. Trích schema

Cần `fzstd` và `kiwi-schema` (xem `package.json`). Script nằm ở `docs/superpowers/plans/2026-09-27-copy-to-figma.md` phần "Xác minh kỹ thuật"; logic cốt lõi:

1. Unescape HTML entities trong `data-buffer`.
2. Base64-decode → archive.
3. Đọc chunk 0: `[u32 LE độ dài][dữ liệu nén]` → giải nén (dò zstd hay deflate).
4. `decodeBinarySchema(bytes)` → ghi lại thành `.kiwi`.
5. Cập nhật `figma-v<version>.kiwi` và bảng thông số ở trên.

### 4. Kiểm tra

```bash
npm test
```

Test `archive round-trip` phải pass. Nếu schema mới làm vỡ encoder, xem field nào đổi tên trong `NodeChange`.

## Ghi chú

- **Không** xoá file schema cũ ngay: giữ lại để decode payload cũ nếu cần đối chiếu.
- Schema là dữ liệu nhị phân, không sửa tay. Mọi thay đổi phải qua quy trình trên.
- Version trong tên file theo `version` của archive, không theo version của app Figma.
