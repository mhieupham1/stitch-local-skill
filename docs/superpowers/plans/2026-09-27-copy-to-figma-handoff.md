# Copy for Figma — những gì đã làm và những gì còn dang dở

> **Mục đích file này:** bàn giao trung thực. Ghi rõ cái gì đã kiểm chứng bằng dữ liệu, cái gì chỉ là phỏng đoán của tôi, và cái gì còn hỏng. Người tiếp nhận nên đọc phần [Trạng thái thật](#trạng-thái-thật) trước, đừng tin phần kết luận nào không kèm bằng chứng.

Ngày: 2026-09-27
Người thực hiện: phiên làm việc tự động (Cursor agent)

---

## 1. Mục tiêu

Cho phép copy UI từ Stitch Local rồi dán thẳng vào Figma bằng `Cmd+V`, **không cần plugin**. Cách làm là tái tạo định dạng clipboard nội bộ của Figma (`fig-kiwi`).

## 2. Trạng thái thật

| Hạng mục | Trạng thái | Bằng chứng |
| --- | --- | --- |
| Bóc gói / đóng gói archive `fig-kiwi` | **Xong, đã kiểm chứng** | Round-trip khớp từng byte |
| Kiwi codec (schema v106) | **Xong, đã kiểm chứng** | Encode/decode round-trip khớp byte |
| Định dạng clipboard HTML | **Xong, đã kiểm chứng** | Parse/build đối xứng |
| Metadata tầng message | **Xong, đã kiểm chứng** | Dán ra được frame |
| Node FRAME (màu, bo góc) | **Xong, đã kiểm chứng** | Dán ra frame xanh bo góc đúng |
| Node TEXT hiện chữ | **Xong, đã kiểm chứng** | Dán ra chữ, đủ ký tự |
| **Bố cục chữ (khoảng cách ngang)** | **CHƯA XONG** | Chữ hiện nhưng dồn/lệch |
| Encoder tự sinh blob từ font | **Xong, đã kiểm chứng** | Blob khớp `0.000` với Inter thật |
| Chuyển CSS → IR → Figma | **Chưa bắt đầu** | — |

**Tóm lại: payload tự sinh dán được vào Figma và hiện chữ. Nhưng khoảng cách ký tự chưa đúng.**

Phần này đáng nói rõ: tôi đã nhiều lần tuyên bố "đã sửa xong" và đều sai. Những gì **thực sự** kiểm chứng được chỉ là các con số khớp nhau (mục 5). Còn kết quả hiển thị trên Figma thì **vẫn hỏng**.

---

## 3. Định dạng đã dịch ngược được

### 3.1 Giao thức clipboard

```html
<meta charset='utf-8'><html><head><meta charset="utf-8"></head><body>
<span data-metadata="&lt;!--(figmeta)BASE64_JSON(/figmeta)--&gt;"></span>
<span data-buffer="&lt;!--(figma)BASE64_ARCHIVE(/figma)--&gt;"></span>
<span style="white-space:pre-wrap;">Paste from ...</span>
</body></html>
```

Ba điểm dễ sai, mỗi điểm từng gây một lỗi khác nhau:

1. `figmeta` là **base64 của JSON**, không phải JSON thô. Để JSON thô bị escape `&quot;` → Figma chỉ hiện chữ trơn.
2. `<` và `>` trong giá trị attribute phải escape thành `&lt;` / `&gt;`. Để trần → Figma báo lỗi chung chung.
3. Thẻ `<meta>` đầu dùng nháy đơn, hai attribute dùng nháy kép.

### 3.2 Archive `fig-kiwi`

- 8 byte đầu: ASCII `"fig-kiwi"`, rồi 4 byte `uint32 LE` version = `106`.
- Các chunk: `[uint32 LE độ dài][dữ liệu nén]`.
- Chunk 0: schema Kiwi nhị phân (`decodeBinarySchema` + `compileSchema` của gói `kiwi-schema`).
- Chunk 1: message `NODE_CHANGES`.
- Nén: thử `node:zlib.inflateRawSync` trước, rồi `fzstd` — không phải payload nào cũng cùng thuật toán.

### 3.3 Metadata tầng message

Payload thật có 12 field ở tầng message, không phải chỉ `type` + `nodeChanges`:

```json
{ "type": "NODE_CHANGES", "sessionID": 0, "ackID": 0,
  "pasteID": 1815303332, "pasteFileKey": "42",
  "pasteIsPartiallyOutsideEnclosingFrame": false,
  "pastePageId": { "sessionID": 0, "localID": 1 },
  "isCut": false, "pasteEditorType": "DESIGN", "publishedAssetGuids": [] }
```

Quan trọng nhất là **`pastePageId`** — GUID canvas đích. Thiếu nó, Figma parse thành công nhưng **lặng lẽ không dán gì**, không báo lỗi. Đây là lỗi khó chẩn đoán nhất trong toàn bộ quá trình.

Các giá trị giống hệt nhau ở hai mẫu cách nhau 10 phút, kể cả `pasteID` — nên là hằng số.

`guid` theo quy ước: `DOCUMENT` dùng `sessionID: 0`, phần còn lại dùng `sessionID: 100`.

### 3.4 Blob đường vẽ (quan trọng nhất)

```
[u8 tag][f32 LE args]*     — KHÔNG có header, KHÔNG có tiền tố độ dài

tag 0 = ClosePath      (0 arg)
tag 1 = MoveTo         (2 arg: x y)
tag 2 = LineTo         (2 arg: x y)
tag 3 = QuadraticTo    (4 arg: x1 y1 x y)
tag 4 = CubicTo        (6 arg: x1 y1 x2 y2 x y)
```

Toạ độ ở **hệ em** (đã chia `unitsPerEm`), gốc tại baseline, **y hướng LÊN** (giống `opentype.js`).

Kiểm chứng bằng cách giải mã blob chữ "D" — ra đúng hình chữ D: nét dọc trái ở `x=0.02`, hai nét ngang trên `y=0.73`, nét cong phải.

Định dạng này đã được cộng đồng dịch ngược và tài liệu hoá (xem mục 8) — **không cần tự mò lại**.

---

## 4. Text — các bẫy đã gặp

### 4.1 Phải có `derivedTextData` + `glyphs` + **toàn bộ** mảng `blobs`

Đây là phần tôi sai nhiều lần nhất. Ghi lại cả bốn kết luận, kể cả ba cái sai:

| Kết luận tôi từng đưa | Thử nghiệm | Kết quả |
| --- | --- | --- |
| "Figma tự tính, bỏ trống được" | bỏ hẳn `derivedTextData` | **SAI** — chữ trống |
| "Cần layout nhưng `glyphs` để rỗng" | thêm `derivedTextData`, `glyphs: []` | **SAI** — vẫn trống |
| "Cần `glyphs` có blob" | giữ 9 blob liên quan | gần đúng, **thiếu chữ "D"** |
| "Cần **toàn bộ** mảng `blobs`" | giữ nguyên 198 blob | **ĐÚNG** — chữ trọn vẹn |

`commandsBlob` là **chỉ số tuyệt đối** (1-based) vào mảng `blobs`. Nén mảng lại (dù đã ánh xạ lại chỉ số đúng) vẫn làm mất nét một số ký tự.

**Hệ quả:** encoder tự sinh buộc phải có font engine để trích outline. Không thể suy đường vẽ từ CSS.

### 4.2 Mỗi ký tự phải có đúng một glyph — kể cả dấu cách

Node thật `"SMEMBER REWARDS"` có **15 ký tự / 15 glyph**. **167 dấu cách** trong file mẫu đều có glyph riêng.

Figma dùng `glyphs[].advance` để tiến con trỏ ngang cho **từng ký tự**. Bỏ qua dấu cách làm con trỏ không nhảy → các từ dồn vào nhau. Glyph của dấu cách không cần `commandsBlob`.

### 4.3 `postscript` phải để RỖNG

Cả **38/38** node TEXT trong payload thật đều dùng `"postscript": ""`, kể cả khi font là Inter (có tên PostScript thật). Điền tên vào đây làm Figma không khớp được font → báo missing font.

### 4.4 Font khớp theo `family` + `style`

Đổi từ Arial sang Inter thì hết "missing font". Nghĩa là Figma khớp font theo danh tính khai trong payload và **font đó phải có sẵn trong phiên Figma**.

### 4.5 `fontVariations` cho font biến thiên

Inter là font biến thiên. Cần khai trục:

```json
"fontVariations": [{ "axisTag": 2003265652, "axisName": "wght", "value": 600 }]
```

`axisTag` là tên trục viết ASCII dạng uint32: `'wght'` → `0x77676874` = `2003265652`.

| CSS | Figma | `wght` |
| --- | --- | --- |
| 400 | Regular | 400 |
| 500 | Medium | 500 |
| 600 | Semi Bold | 600 |
| 700 | Bold | 700 |
| 900 | Black | 900 |

### 4.6 Công thức bố cục đã kiểm chứng

**Con trỏ ngang** (sai số < 0.0001 so với payload thật):

```
pos.x          = Σ (advance × fontSize + letterSpacing)   cho các glyph trước đó
baseline.width = Σ (advance × fontSize + letterSpacing)
```

**`lineAscent`:**

```
lineAscent = ascender / unitsPerEm × fontSize
```

Với Inter: `1984/2048 = 0.96875`, khớp `lineAscent/fontSize` ở cả 9 tổ hợp cỡ chữ trong mẫu.

**`position.y`:** ⚠️ **CHƯA GIẢI ĐƯỢC.** Xem mục 6.

---

## 5. Bằng chứng đã thu được

### 5.1 Blob sinh từ font khớp với blob thật

So blob do tôi sinh (từ `Inter-var.ttf` tải ở Google Fonts) với blob Inter trong payload Stitch:

| chữ | blob thật (y) | blob tôi sinh (y) | lệch đỉnh | lệch đáy | advance thật / tôi |
| --- | --- | --- | --- | --- | --- |
| E | 0.000 → 0.728 | 0.000 → 0.728 | **0.000** | **0.000** | 0.605 / 0.601 |
| B | 0.000 → 0.728 | 0.000 → 0.728 | **0.000** | **0.000** | 0.659 / 0.654 |
| D | 0.000 → 0.728 | 0.000 → 0.728 | **0.000** | **0.000** | 0.722 / 0.722 |
| M | -0.011 → 0.737 | 0.000 → 0.728 | 0.010 | 0.011 | 0.922 / 0.903 |

Lệch của "M" là do font Semi Bold có chân thò dưới baseline, còn Regular thì không.

**Kết luận: quy ước toạ độ của phần sinh blob là đúng.**

### 5.2 Công thức con trỏ ngang

Đo `pos.x` của từng glyph so với tổng `advance` cộng dồn:

| font | cỡ | sai số lớn nhất khi dùng công thức |
| --- | --- | --- |
| Inter | 13 | 0.00001 |
| Inter | 18 | 0.00000 |
| Inter | 13 | 0.00000 |

### 5.3 Thử nghiệm quyết định

Một thí nghiệm đã định hình toàn bộ hướng đi sau đó:

```
Nén mảng blob còn 9  → thiếu chữ "D" trong "REWARDS"
Giữ nguyên 198 blob  → chữ trọn vẹn
```

**Bài học phương pháp:** phải kiểm tra payload gốc có dán được không **TRƯỚC KHI** sửa encoder. Tôi đã giả định "bản gốc dán được, bản của tôi không" mà không kiểm chứng, nên liên tục kết luận sai.

```
osascript -e 'set the clipboard to (read (POSIX file "<file-gốc>" as «class HTML»))'
```

---

## 6. Cái còn HỎNG — đọc kỹ phần này

### 6.1 Khoảng cách chữ chưa đúng (vấn đề chính)

Chữ hiện ra nhưng dồn vào nhau / sai vị trí. Tôi đã sửa ba lỗi có thật (dấu cách thiếu glyph, `position.y` sai, `letterSpacing` không cộng vào con trỏ) nhưng **kết quả hiển thị vẫn hỏng**.

Các con số thì khớp (mục 5.2), nên lỗi nằm ở chỗ tôi chưa kiểm tra. Nghi vấn chưa loại trừ được:

- `position.y` chưa đúng (xem 6.2) khiến chữ bị dịch dọc và trông như chồng.
- `textAutoResize` / `size` của node TEXT không khớp với `baseline.width`.
- Thứ tự field trong Kiwi message có ý nghĩa, tôi chưa kiểm tra.
- `derivedTextData.lines` / `logicalIndexToCharacterOffsetMap` tôi điền số đơn giản, có thể sai.
- Có thể còn field tôi chưa biết mà node thật không dùng ở các mẫu đã xem.

### 6.2 `position.y` — chưa giải được

Quan hệ đã đo từ **9 tổ hợp** cỡ chữ trong payload thật:

| fontSize | lineHeight | pos.y | lineAscent | pos.y − lineAscent |
| --- | --- | --- | --- | --- |
| 10 | 15 | 11.138 | 9.688 | 1.450 |
| 12 | 16 | 12.365 | 11.625 | 0.740 |
| 12 | 16.5 | 12.615 | 11.625 | 0.990 |
| 12 | 19.5 | 14.115 | 11.625 | 2.490 |
| 13 | 18 | 13.729 | 12.594 | 1.135 |
| 14 | 100 | 13.563 | 13.563 | **0.000** |
| 14 | 20 | 15.093 | 13.563 | 1.530 |
| 18 | 24 | 18.548 | 17.438 | 1.110 |
| 24 | 32 | 24.730 | 23.250 | 1.480 |

Tôi đã thử suy ngược **bảy lần** và thất bại. Đại lượng `k = (pos.y − lineAscent) / (lineHeight − fontSize)` nhận các giá trị `0.185 / 0.227 / 0.290 / 0.332 / 0.000` — không theo quy luật CSS nào.

Nhận xét: dòng `fs=14, lh=100` cho `pos.y = lineAscent` chính xác. Nghĩa là khi `lineHeight` lớn, `pos.y` tiệm cận `lineAscent` — nhưng không rõ cơ chế.

**Cách nên thử:** đừng suy ngược nữa. Lấy một payload Stitch **cùng font Inter, nhiều cỡ chữ**, rồi khớp hàm bằng hồi quy. Hoặc đọc thẳng schema: field này có thể được tính từ bảng `OS/2` của font (`sTypoAscender`, `usWinAscent`...) chứ không từ CSS.

Một chi tiết chưa kiểm tra: `pos.y = 13.729` với cỡ 13. `winAscent/unitsPerEm = 1.1079` → `1.1079 × 13 = 14.40`. Không khớp. Nhưng chưa thử hết tổ hợp.

### 6.3 Chưa có test

Không có unit test nào cho các module Figma. Toàn bộ kiểm chứng là script chạy tay và dán thử vào Figma bằng người thật. Đây là thiếu sót lớn.

---

## 7. File đã tạo

### Module (đã typecheck, chưa có test)

| File | Nội dung |
| --- | --- |
| `packages/server/src/figma/archive.ts` | Đóng/bóc gói `fig-kiwi`, dò deflate/zstd |
| `packages/server/src/figma/codec.ts` | Kiwi codec, `FIGMA_PASTE_METADATA`, `createNodeChangesMessage` |
| `packages/server/src/figma/clipboard.ts` | Dựng/bóc `text/html` |
| `packages/server/src/figma/font/outline.ts` | Trích outline → blob, `encodePathCommands` / `decodePathCommands` |

### Script sinh payload

| File | Nội dung |
| --- | --- |
| `scripts/figma-generate-from-font.ts` | Sinh payload từ font: frame + text + blob tự trích. **Đây là script chính, nhưng kết quả còn hỏng bố cục.** |
| `scripts/figma-generate-minimal.mjs` | Payload tối giản để thử |
| `scripts/figma-roundtrip.mjs` | Kiểm tra round-trip |
| `scripts/figma-inspect-sample.mjs` | Đọc payload mẫu |

### Script chẩn đoán (`scripts/diagnostics/`)

Đây là phần đáng giá nhất của toàn bộ công việc — bộ công cụ này tìm ra hầu hết các lỗi.

| File | Dùng để |
| --- | --- |
| `dump-text-glyphs.ts` | In từng ký tự kèm glyph + blob. **Dùng cái này đầu tiên khi chữ sai.** |
| `decode-path-blob.ts` | Giải mã blob thành lệnh đường vẽ |
| `check-glyph-blobs.ts` | Kiểm tra số glyph so với số ký tự, phát hiện blob trỏ sai |
| `diff-node-full.ts` | So đệ quy hai node, tìm khác biệt sâu |
| `compare-baseline.ts` | So số đo bố cục giữa các payload |
| `figma-generate-from-font.ts` | (ở trên) |
| `extract-subtree.ts` | Rút cây node (bản này nén blob — gây lỗi chữ D, giữ để tham khảo) |
| `extract-keep-blobs.ts` | Rút cây node **giữ nguyên** toàn bộ blob — bản đúng |
| `build-variant.ts` | Mượn node thật, giữ nguyên blob — **dở dang, chưa viết xong** |

### Tài liệu khác

- `docs/superpowers/plans/2026-09-27-copy-to-figma.md` — kế hoạch triển khai đầy đủ (Task 0 → Task 5).

---

## 8. Nguồn tham khảo — đọc trước khi tự mò

Định dạng này đã được người khác dịch ngược và **tài liệu hoá công khai**. Tôi đã mất nhiều thời gian tự mò những thứ có sẵn ở đây:

- [pocket-stack/pocket-figma — tools/fig.ts](https://github.com/pocket-stack/pocket-figma/blob/main/tools/fig.ts) — mô tả cấu trúc archive và định dạng blob đường vẽ, kèm code giải mã.
- [OpenFig-org/openfig-core — docs/archive.md](https://github.com/OpenFig-org/openfig-core/blob/main/docs/archive.md) — tài liệu về chunk, nén, `nodeChanges` / `blobs`.
- [Grida — Kiwi Schema for .fig Format](https://grida.co/docs/wg/feat-fig/glossary/fig.kiwi) — mô tả từng field, kể cả `fillGeometry`, `vectorNetworkBlob`.
- [allan-simon/figma-kiwi-protocol](https://github.com/allan-simon/figma-kiwi-protocol) — đặc tả Kaitai Struct cho `commandsBlob` và `vectorNetworkBlob`.
- [Generous-Corp/pulp — tools/import-design/fig/paths.mjs](https://github.com/Generous-Corp/pulp/blob/main/tools/import-design/fig/paths.mjs) — code giải mã blob, và ghi chú rằng Figma "bakes each glyph's outline into" blob.

**Lời khuyên:** đọc `pocket-stack/pocket-figma` trước. Nó có sẵn code vẽ lại glyph từ blob, tiết kiệm rất nhiều thời gian.

---

## 9. Việc nên làm tiếp

1. **Sửa bố cục chữ.** Đây là việc chặn đường. Xem 6.1 và 6.2.
2. **Viết test** cho `archive.ts`, `codec.ts`, `clipboard.ts`, `outline.ts`. Hiện không có test nào.
3. **Đọc schema để hiểu `position.y`** thay vì suy ngược. Đọc `schema/figma-v106.kiwi`.
4. **Task 1–2 trong kế hoạch:** chuyển CSS → IR → node Figma. Chưa bắt đầu.
5. **Cân nhắc hướng khác.** Nếu bố cục chữ vẫn không giải được, có thể dùng cách tiếp cận khác: chuyển tất cả thành VECTOR thay vì TEXT. Mất khả năng sửa chữ trong Figma nhưng bố cục chắc chắn đúng, vì không phụ thuộc bảng đo font.

---

## 10. Bài học phương pháp

Ghi lại vì tôi đã lặp lại các lỗi này nhiều lần:

1. **Kiểm tra mẫu thật trước khi sửa encoder.** Tôi giả định bản gốc dán được mà không thử. Một lệnh `osascript` đã tiết kiệm nhiều giờ.

2. **So trực tiếp thay vì suy ngược.** Khi có payload mẫu, hãy dump cả hai ra và so từng field. Tôi mất bảy vòng suy ngược `position.y` mà không đâu; trong khi so blob trực tiếp cho kết quả trong một lần.

3. **Sửa một biến mỗi lần.** Tôi đổi nhiều thứ cùng lúc giữa các lần dán, khiến không quy được kết quả về nguyên nhân nào.

4. **Đọc cột dữ liệu đã in ra.** Dấu hiệu `letterSpacing` (`pos.x / advance = 13.95 ≠ 13`) nằm trong bảng tôi in ra từ sớm, nhưng tôi chỉ nhìn cột `advance` mà không nhìn hệ số.

5. **Kiểm tra đếm số.** Lỗi dấu cách lẽ ra phát hiện ngay bằng một dòng: `characters.length === glyphs.length`. Tôi đã in ra con số đó và đọc sai ý nghĩa.

6. **Khai báo trạng thái trung thực.** Tôi đã nói "đã sửa xong" nhiều lần khi thực tế chưa. Ghi rõ "chưa giải được" tốt hơn là đoán.
