# Copy to Figma — Implementation Plan

> **For agentic workers:** Làm theo từng task, đúng thứ tự. Task 0 là cổng quyết định: không bắt đầu Task 1 trở đi khi Task 0 chưa đạt. Steps dùng checkbox (`- [ ]`).

**Goal:** Người dùng chọn một màn hình trên canvas, bấm “Copy cho Figma”, sang Figma nhấn Cmd+V là ra một frame có layer thật (frame, text, hình chữ nhật, màu, bo góc, auto layout) — giống Google Stitch, không cần cài plugin.

**Architecture:** Server dùng Playwright render màn hình, duyệt DOM và computed style thành một cây trung gian (IR). Encoder chuyển IR thành message `NODE_CHANGES` theo schema Kiwi của Figma, đóng gói thành archive `fig-kiwi`, base64 và bọc trong HTML clipboard của Figma. Canvas ghi HTML đó vào clipboard dưới MIME `text/html`.

**Tech Stack:** TypeScript, Playwright (đã có), `kiwi-schema` (encode/decode Kiwi), `pako` (deflate), `fzstd` (giải nén zstd — thuần JS, chạy được trên Node 20). `fig-kiwi` chỉ dùng làm tham chiếu trong test, **không** dùng lúc chạy: nó không hiểu schema v106 và chỉ hỗ trợ deflate.

**Ngày:** 2026-09-27.

**Trạng thái:** Task 0 **ĐẠT trên Figma Desktop** — payload tự sinh dán ra được frame và chữ. Đã xác định đủ định dạng: archive, Kiwi codec, clipboard HTML, metadata tầng message, cơ chế glyph/blob của text, và cách nhúng ảnh. Chưa kiểm trên Figma web. Chưa triển khai Task 1 trở đi.

**Việc chặn đường:** chữ hiện nhưng sai hình/khoảng cách. Nguyên nhân đã tìm ra (chỉ số blob lệch 1, `logicalIndexToCharacterOffsetMap` sai, công thức `position.y`), kế hoạch sửa ở [2026-09-27-copy-to-figma-text-fix.md](2026-09-27-copy-to-figma-text-fix.md). Làm Phase A của file đó trước mọi task khác.

**Tài liệu liên quan:**
- [Plan sửa chữ](2026-09-27-copy-to-figma-text-fix.md) — plan con của Task 3, là nguồn đúng cho mọi chi tiết về text.
- [Handoff phiên trước](2026-09-27-copy-to-figma-handoff.md) — nhật ký thử nghiệm. **Lưu ý:** các kết luận "`commandsBlob` 1-based" và "phải giữ đủ mảng blobs" trong đó là sai (xem plan sửa chữ mục 1.1).

## Bối cảnh: vì sao cách hiện tại không chạy

Hiện có:

- `packages/server/src/figma-export.ts`: `exportScreenForFigma` render bằng Playwright, trích computed style, xuất HTML inline-style với `position:absolute`.
- Route `POST /api/projects/:projectId/screens/:screenId/figma` trong `packages/server/src/app.ts`.
- Nút `copy-figma` trong `packages/canvas/src/App.tsx` (`copyForFigma`), ghi `text/html` + `text/plain` bằng `navigator.clipboard.write`.
- `tests/unit/figma-export.test.ts` kiểm `serializeForFigma`; `diag.mjs` ở gốc repo đọc lại clipboard để xem style có bị strip không.

Figma **không** dựng layer từ HTML thường. Paste HTML bất kỳ chỉ ra text, nên dù thêm toạ độ tuyệt đối kết quả vẫn là “một đống chữ”. Figma chỉ dựng layer khi `text/html` trên clipboard mang đúng định dạng nó tự ghi lúc copy layer ([phân tích](https://alexharri.com/blog/clipboard)):

```html
<meta charset="utf-8">
<span data-metadata="<!--(figmeta)BASE64_JSON(/figmeta)-->"></span>
<span data-buffer="<!--(figma)BASE64_ARCHIVE(/figma)-->"></span>
```

- `figmeta`: JSON `{ fileKey, pasteID, dataType: "scene" }`. Mẫu thật còn có thêm `editorType`, `environment`, `selectedNodeData`.
- `figma`: archive nhị phân: 8 byte `fig-kiwi` + `u32 LE` version + các chunk (`u32 LE` độ dài + dữ liệu nén). Mẫu thật: version **106**, 2 chunk (34.118 + 250.434 byte), tổng 284.572 byte.
- **Hai chunk dùng hai thuật toán nén khác nhau** — đã đo trên mẫu thật: chunk 0 (schema) là `deflateRaw`, chunk 1 (message) là **zstd**. Xem "Xác minh kỹ thuật" mục 3.
- Message có `type: "NODE_CHANGES"` và mảng `nodeChanges` — mỗi phần tử là một node (DOCUMENT, CANVAS, FRAME, TEXT, RECTANGLE, …) có `guid`, `parentIndex { guid, position }`, `size`, `transform`, `fillPaints`, `strokePaints`, `cornerRadius`, `effects`, `stack*` (auto layout), `fontName`, `fontSize`, `textData`, ….

Tham khảo: [`fig-kiwi`](https://www.npmjs.com/package/fig-kiwi) (đọc/ghi, có `writeHTMLMessage({ meta, schema, message })` nhưng **không kèm schema** — schema phải lấy từ một lần copy thật), [Grida io-figma](https://grida.co/docs/wg/feat-fig) (đã làm chiều ghi clipboard cho Figma), [pocket-figma `tools/fig.ts`](https://github.com/pocket-stack/pocket-figma/blob/main/tools/fig.ts) (decode zstd/deflate).

## Stitch làm thế nào — suy ra từ payload

Stitch **không tự viết** bộ chuyển đổi: nó dùng engine của **divRIOTS**, công ty làm plugin Figma [html.to.design](https://html.to.design), nhưng xuất thẳng ra định dạng clipboard nội bộ của Figma thay vì chạy trong plugin. Pipeline của họ trùng với kiến trúc của kế hoạch này.

Bằng chứng (đo trên mẫu 02 — copy từ Stitch — so với mẫu 01 — copy trong Figma, cùng nội dung):

| Dấu vết | Giá trị | Ý nghĩa |
| --- | --- | --- |
| Text dự phòng trong HTML clipboard | `Paste from divriots` | Engine của divRIOTS |
| Tên layer | `Html → Body`, `Container`, `Text`, `Button`, `Section - 1. HERO SECTION (…)` | Quy ước đặt tên của html.to.design: tag/vai trò + comment HTML đứng trước phần tử |
| Nén chunk message | deflate (Figma tự copy: zstd) | Payload sinh ngoài Figma |
| `pasteFileKey`, `pasteID` | `"42"`, hằng số | Giá trị cố định trong encoder |
| Schema | 645 định nghĩa, `NodeChange` 613 field; bản Figma hiện tại: 647 / 615 (thêm `attachedCodeSources`, `nativeCodeSlotId`) | Họ lưu sẵn một bản chụp schema cũ hơn — giống cách ta làm với `figma-v106.kiwi` |
| Font | `Inter/*` và `Liberation Mono/Bold` | `Liberation Mono` là monospace mặc định của Linux ⇒ render bằng Chrome headless trên server Linux, dùng font trình duyệt **thực sự vẽ** |
| Ảnh | `fillPaints[].image = { hash, name, dataBlob }`; `blobs[dataBlob]` là bytes JPEG; `hash` = **SHA-1** của bytes (khớp 3/3) | Ảnh đi kèm ngay trong clipboard |
| Icon | node `VECTOR` tên `Icon`, có `vectorNetworkBlob` | Icon/SVG chuyển thành vector, không rasterize |
| `stackMode` | có `GRID` | CSS grid → grid auto layout của Figma |

Pipeline suy ra:

1. Render HTML trong Chrome headless.
2. Duyệt DOM, lấy computed style, box và font thực dùng; đặt tên layer từ comment/aria/tag.
3. Map sang node Figma: flex → auto layout, grid → `GRID`, `box-shadow` → effect (kèm rectangle `…:shadow`), icon/SVG → VECTOR, ảnh → IMAGE paint + blob.
4. Text: lấy outline glyph từ file font thật, tính `derivedTextData` như Figma.
5. Encode Kiwi bằng schema đã lưu, nén deflate, bọc HTML clipboard.

⇒ Không có lối tắt: engine của divRIOTS đóng mã, dùng plugin html.to.design thì trái mục tiêu "không cần plugin". Kế hoạch này tự làm đúng pipeline trên.

## Xác minh kỹ thuật (đã chạy, 2026-09-27)

Ba thí nghiệm dưới đây đã chạy thật để chốt các giả định của kế hoạch. Ghi lại để không phải suy đoán lại.

### 1. Clipboard giữ nguyên payload — ĐẠT

Ghi `text/html` chứa `data-buffer` + `(figma)` + `(figmeta)` rồi đọc lại, thử cả hai đường:

| Đường ghi | Giữ `(figmeta)` | Giữ `(figma)` | Giữ `data-buffer` |
| --- | --- | --- | --- |
| `navigator.clipboard.write` (Async Clipboard API) | ✅ | ✅ | ✅ |
| sự kiện `copy` + `clipboardData.setData` | ✅ | ✅ | ✅ |

⇒ Rủi ro "trình duyệt sanitize `text/html`" **không xảy ra**. Async Clipboard API dùng được, không cần đổi sang sự kiện `copy` vì lý do sanitize (vẫn có thể đổi để giữ user gesture, xem Task 6).

### 2. Escape HTML — BẮT BUỘC xử lý

Ghi 168 ký tự, đọc lại **180** ký tự. Trình duyệt escape nội dung trong attribute:

```
data-metadata="&lt;!--(figmeta)eyJmaWxlS2V5IjoiQUJDIn0=(/figmeta)--&gt;"
```

⇒ `archive.ts` phải **unescape HTML entities** (`&lt;` `&gt;` `&amp;` `&quot;`) trước khi base64-decode. Bỏ qua bước này thì decode hỏng ngay ở chunk đầu. Đây là chi tiết kế hoạch bản đầu chưa có.

### 3. Nén: mỗi chunk có thể là deflate HOẶC zstd — phải dò

Bản đầu của kế hoạch nói "chỉ deflate" (sau khi đọc mã `fig-kiwi`), rồi tôi tạm sửa thành "chunk 0 deflate, chunk 1 zstd". **Cả hai kết luận đều sai** — mẫu thứ hai bác bỏ kết luận thứ hai.

Hai mẫu thật, **cùng một nội dung** (đều 1131 node, `FRAME: 711, TEXT: 320, VECTOR: 91`, cùng text/font/paint):

| | Mẫu 01 — copy trong Figma | Mẫu 02 — copy từ Stitch |
| --- | --- | --- |
| chunk 0 (schema) | `deflate` → 74.549 B | `deflate` → 74.273 B |
| chunk 1 (message) | **`zstd`** → 773.465 B | **`deflate`** → 1.420.802 B |
| `figmeta` | có `editorType`, `environment`, `selectedNodeData` | chỉ `fileKey`, `pasteID`, `dataType` |
| `pasteFileKey` | `"7Sf3F8LALqVNwVGSDI67Ur"` | `42` |
| `pasteAssetType` | `"UNKNOWN"` | `undefined` |

⇒ **Không được hardcode thuật toán.** Cách dò đã kiểm chứng, giải mã đúng cả hai mẫu:

```js
if (buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd) zstd(buf);
else inflateRaw(buf);
```

`28 b5 2f fd` là frame magic zstd (`0xFD2FB528`, little-endian); deflate không có magic nên là nhánh mặc định.

Hệ quả:
- `archive.ts` cần `decompressAuto()`. **Unit test phải chạy trên cả hai mẫu** để phủ cả hai nhánh.
- Khi **ghi**, tự chọn thuật toán. Dùng deflate cho cả hai chunk để không phụ thuộc zstd khi ghi — chỉ cần zstd khi **đọc** payload do Figma sinh.
- `fzstd` (thuần JS, chỉ giải nén) chạy tốt trên Node 20 ⇒ **không bắt buộc nâng Node**.
- Payload của Figma và của Stitch **đều hợp lệ như nhau**. Đây là bằng chứng cho thấy bên thứ ba (Stitch) tự sinh payload Figma thành công ⇒ hướng của kế hoạch khả thi.

### 4. Stitch chứng minh auto layout là khả thi — và tốt hơn toạ độ tuyệt đối

So sánh độ trung thực giữa hai payload:

| | Mẫu 01 (Figma) | Mẫu 02 (Stitch) |
| --- | --- | --- |
| Frame có auto layout | 644/711 | **711/711** |
| `stackMode` | `VERTICAL:437, HORIZONTAL:200, GRID:7` | `VERTICAL:437, HORIZONTAL:200, GRID:7, NONE:67` |
| Text / font / fontSize | 320, `Inter/Bold:108`, 9..24 | **y hệt** |
| Paint | `SOLID:614, GRADIENT_LINEAR:6, IMAGE:29` | **y hệt** |
| Tên node | `"Html → Body"`, `"Main"` | **y hệt** |

⇒ **Task 4 (Auto Layout) không cần bước "kiểm tra an toàn rồi fallback về absolute".** Stitch chuyển `display:flex` → `stackMode` cho toàn bộ 711 frame mà vẫn giữ layout đúng. Đây là mục tiêu F2 nên làm thẳng, không cần cơ chế phòng ngừa phức tạp.

14 field `stack*` Stitch dùng: `stackMode`, `stackSpacing`, `stackHorizontalPadding`, `stackVerticalPadding`, `stackPaddingRight`, `stackPaddingBottom`, `stackPrimaryAlignItems`, `stackCounterAlignItems`, `stackPrimarySizing`, `stackCounterSizing`, `stackChildAlignSelf`, `stackChildPrimaryGrow`, `stackPositioning`, `stackReverseZIndex`.

Ví dụ frame auto layout thật:

```json
{ "type": "FRAME", "name": "Html → Body",
  "stackMode": "VERTICAL", "stackSpacing": 32,
  "stackHorizontalPadding": 0, "stackVerticalPadding": 0,
  "stackPaddingRight": 0, "stackPaddingBottom": 0,
  "stackPrimaryAlignItems": "MIN", "stackCounterAlignItems": "MIN",
  "stackCounterSizing": "FIXED", "stackReverseZIndex": false }
```

### 5. NodeChange KHÔNG có field bắt buộc

Schema v106: `NodeChange` có **613 field, 0 field bắt buộc**. ⇒ Encoder có thể sinh payload tối thiểu (chỉ field cần thiết), không phải điền hết. Đây là tin quan trọng cho Task 2 — giảm mạnh khối lượng công việc.

### 6. Schema thật khác xa `fig-kiwi`

Schema v106: 647 định nghĩa (`ENUM: 212`, `STRUCT: 30`, `MESSAGE: 405`). Nhiều field có cặp biến thể `x`/`xTag` — union tagged ở tầng Kiwi. Có field nội bộ Figma (`ojansSuperSecretNodeField`, `sevMoonlitLilyData`).

Field thực dùng theo loại node (đo trên mẫu thật) — căn cứ để encoder chỉ sinh đúng ngần này:

| Type | Số node | Field cốt lõi |
| --- | --- | --- |
| `DOCUMENT` | 1 | `guid`, `phase`, `type`, `name`, `visible`, `opacity`, `transform` |
| `CANVAS` | 2 | + `parentIndex`, `backgroundEnabled`, `backgroundOpacity` |
| `FRAME` | 711 | + `size`, `fillPaints`, `cornerRadius`, `effects`, `strokePaints`, `strokeWeight`, `strokeAlign`, `frameMaskDisabled`, `stack*` (14 field) |
| `TEXT` | 320 | + `fontName`, `fontSize`, `lineHeight`, `letterSpacing`, `textData`, `derivedTextData`, `textAutoResize`, `textAlignHorizontal`, `textAlignVertical`, `textCase`, `textDecoration` |
| `VECTOR` | 91 | + `vectorData`, `fillPaints` |
| `ROUNDED_RECTANGLE` | 6 | + `cornerRadius`, `fillPaints`, `strokeWeight` |

Cấu trúc thật đã quan sát:
- `guid`: `{ sessionID, localID }`.
- `parentIndex`: `{ guid, position }`, `position` là fractional index (`"!"` cho con đầu).
- `textData`: `{ characters, lines: [{ lineType, styleId, indentationLevel, sourceDirectionality, listStartOffset, isFirstLineOfList }] }`.
- `derivedTextData`: `{ layoutSize, baselines: [{ position, width, lineY, lineHeight, lineAscent, firstCharacter, endCharacter }], glyphs, fontMetaData, logicalIndexToCharacterOffsetMap }` — **bắt buộc**, Figma không tự tính lại khi dán (xem mục 7).
- `lineHeight`: `{ value, units: "PIXELS" | "PERCENT" | "RAW" }`.

⇒ Củng cố quyết định: **không import `fig-kiwi` lúc chạy**.

### 7. Text: cần `derivedTextData`, `glyphs`, và **mảng `blobs` đầy đủ**

Câu hỏi chặn đường ở Task 0: text có cần dữ liệu glyph không. **Trả lời: CÓ**, và đây là phần tốn nhiều lần thử sai nhất. Ghi lại cả ba kết luận sai để không lặp lại:

| Kết luận | Thử nghiệm | Kết quả |
| --- | --- | --- |
| "Figma tự tính lại, bỏ trống được" | bỏ hẳn `derivedTextData` | **SAI** — node có, chữ trống |
| "Cần layoutSize/baselines, `glyphs` để rỗng" | thêm `derivedTextData`, `glyphs: []` | **SAI** — vẫn trống |
| "Cần `glyphs` có blob" | giữ `glyphs` + 9 blob liên quan | gần đúng, nhưng **thiếu chữ "D"** |
| ~~"Cần **toàn bộ** mảng `blobs`"~~ | giữ nguyên 198 blob | chữ trọn vẹn — nhưng **kết luận sai nguyên nhân**, xem dưới |

Thí nghiệm "nén còn 9 blob thì mất chữ D" hỏng vì ánh xạ lại chỉ số theo giả định 1-based, không phải vì Figma cần mảng đầy đủ.

Cơ chế thật (đo lại trên mẫu 03, chi tiết ở [plan sửa chữ](2026-09-27-copy-to-figma-text-fix.md) mục 1):

- `derivedTextData.glyphs[]` mỗi phần tử là một ký tự (kể cả dấu cách), có `commandsBlob` trỏ vào mảng `blobs`.
- `commandsBlob` là **chỉ số 0-based** trong mảng `blobs`. Mảng này **dùng chung** với `vectorNetworkBlob` của node VECTOR và `dataBlob` của ảnh — trong mẫu 03, `blobs[0]` là blob của một VECTOR, nên glyph đầu tiên trỏ vào `1`.
- Blob chứa **đường vẽ vector của ký tự**: `[u8 tag][f32 LE args]*`, hệ em, gốc baseline, y hướng lên.
- Nhiều ký tự dùng chung blob khi trùng nét (trong `"SMEMBER REWARDS"`: 15 glyph nhưng chỉ 9 blob duy nhất). Dấu cách trỏ tới một blob 1 byte.
- Bỏ blob không dùng là được, miễn chỉ số đúng.

⇒ Hệ quả: **encoder tự sinh bắt buộc phải có font engine để trích outline chữ** (`fontkit`, đọc file font thật). Không thể suy đường vẽ từ CSS, và Canvas API của trình duyệt **không** trả đường vẽ glyph.

### 7b. `fontVariations` — cần cho font biến thiên

`Inter` là font biến thiên, nên chỉ khai `fontName.style: "Bold"` là không đủ:

```json
"fontVariations": [{ "axisTag": 2003265652, "axisName": "wght", "value": 600 }]
```

`axisTag` là tên trục viết theo ASCII dạng uint32: `'wght'` → `0x77676874` = `2003265652`.

| CSS | Figma | `wght` |
| --- | --- | --- |
| 400 | Regular | 400 |
| 500 | Medium | 500 |
| 600 | Semi Bold | 600 |
| 700 | Bold | 700 |
| 900 | Black | 900 |

### 7c. Metadata tầng message — thiếu thì Figma dán ra hư không

Payload thật có 12 field ở tầng message, không phải chỉ `type` + `nodeChanges`:

```json
{ "type": "NODE_CHANGES", "sessionID": 0, "ackID": 0,
  "pasteID": 1815303332, "pasteFileKey": "42",
  "pasteIsPartiallyOutsideEnclosingFrame": false,
  "pastePageId": { "sessionID": 0, "localID": 1 },
  "isCut": false, "pasteEditorType": "DESIGN", "publishedAssetGuids": [] }
```

Quan trọng nhất là **`pastePageId`** — GUID canvas đích. Thiếu nó, Figma parse thành công nhưng **lặng lẽ không dán gì**.

Các giá trị này giống hệt nhau ở hai mẫu Stitch cách nhau 10 phút, kể cả `pasteID` — nên là hằng số, gói trong `FIGMA_PASTE_METADATA` ở `codec.ts`.

`guid` theo quy ước: `DOCUMENT` dùng `sessionID: 0`, phần còn lại dùng `sessionID: 100`.

### 7d. Giao thức clipboard HTML

```html
<meta charset='utf-8'><html><head><meta charset="utf-8"></head><body>
<span data-metadata="&lt;!--(figmeta)BASE64_JSON(/figmeta)--&gt;"></span>
<span data-buffer="&lt;!--(figma)BASE64_ARCHIVE(/figma)--&gt;"></span>
<span style="white-space:pre-wrap;">Paste from ...</span>
</body></html>
```

Ba điểm dễ sai, mỗi điểm từng gây một lỗi khác nhau:

1. **`figmeta` là base64 của JSON**, không phải JSON thô. Để JSON thô bị escape `&quot;` → Figma chỉ hiện chữ trơn.
2. **`<` và `>` trong attribute phải escape** thành `&lt;`/`&gt;`. Để trần → Figma báo lỗi chung chung.
3. Thẻ `<meta>` đầu dùng **nháy đơn**, hai attribute dùng **nháy kép**.

### 7e. Cách kiểm chứng: luôn thử payload gốc trước

Bài học phương pháp: **kiểm tra payload gốc có dán được không TRƯỚC KHI sửa encoder.** Suốt quá trình trên, tôi giả định "bản gốc dán được, bản của tôi không" mà không kiểm chứng, nên đã đưa ra ba kết luận sai liên tiếp và sửa mò nhiều lượt.

Một dòng kiểm tra đã lẽ ra phải chạy ngay từ đầu:

```
osascript -e 'set the clipboard to (read (POSIX file "<file-gốc>" as «class HTML»))'
```

Kết quả "works" của phép thử này là **mốc so sánh vàng** — không có nó thì mọi kết luận sau đều là đoán.

### 8. Mẫu 03 là bản tham chiếu vàng cho encoder

`figma-sample-03` (màn hình đăng nhập, 158 node) có cấu trúc đọc được từng dòng và tên layer giữ nguyên như trong code HTML nguồn:

```
- FRAME: "Html → Body" | 1280x811 | VERTICAL
  - FRAME: "Main" | 1280x755 | VERTICAL
    - FRAME: "Container" | 1024x627 | HORIZONTAL gap=32
      - FRAME: "Left Column: Smember Value Proposition" | 384x385 | VERTICAL gap=20
      - FRAME: "Right Column: Authentication Card" | 448x627 | VERTICAL gap=20 | r=12
        - ROUNDED_RECTANGLE: "Right Column: Authentication Card:shadow"
        - TEXT: "Đăng nhập Smember" | Inter/Bold | 24px | autoResize=WIDTH_AND_HEIGHT
```

Tên layer (`"Right Column: Authentication Card"`, `"Tablist - Auth Mode Switch Tabs"`, `"Benefit Item 1"`) là tên do người viết HTML đặt — không phải Figma tự sinh. `VERTICAL gap=20`, `HORIZONTAL gap=32`, `r=12` khớp chính xác CSS flex của màn hình nguồn.

⇒ Dùng mẫu này làm **golden test**: cho encoder chạy trên cùng màn hình rồi so từng field với payload Stitch. Đây là cách kiểm chứng mạnh hơn tự đối chiếu ảnh chụp.

Quan sát thêm từ mẫu này:
- `ROUNDED_RECTANGLE` được dùng cho **shadow của frame** — đặt cùng toạ độ, nằm dưới, tên `<tên frame>:shadow`. Đây là cách Figma biểu diễn `box-shadow`.
- `stackSpacing` có giá trị âm và cực nhỏ khi CSS dùng giá trị lẻ: `gap=-0.5`, `gap=2.1316282072803006e-14`. Encoder phải chịu được số thực, không làm tròn về 0.
- `autoResize`: `WIDTH_AND_HEIGHT` cho text một dòng, `HEIGHT` cho text có width cố định.
- Có `FRAME` với `stackMode: NONE` — frame không dùng auto layout vẫn là FRAME.
- `r=9999` cho hình tròn (avatar) — Figma giữ nguyên giá trị lớn thay vì kẹp về một nửa cạnh.

### Hệ quả lên Task 0

`writeHTMLMessage` đòi tham số `schema`, mà `fig-kiwi` không kèm schema — schema chỉ lấy được từ một payload thật do Figma ghi. ⇒ **Task 0 là bắt buộc, không thể thay thế bằng fixture tự tạo.** Người dùng phải cài Figma, copy ít nhất một layer, và lưu payload thật.

## Global Constraints

- Không phá các tính năng hiện có: route, nút và error code (`SERVER_NOT_RUNNING`, `SCREEN_NOT_FOUND`, `BROWSER_NOT_INSTALLED`) giữ nguyên hợp đồng; chỉ đổi nội dung `html` trả về.
- Chạy hoàn toàn local, không gọi API Figma, không cần tài khoản Figma để export (chỉ cần để nghiệm thu thủ công).
- Schema Kiwi được commit vào repo dưới dạng file nhị phân có version và ngày lấy mẫu; không tải từ mạng lúc chạy.
- Chỉ thêm `kiwi-schema`, `pako`, `fzstd` (chỉ để đọc) và `fontkit` (outline chữ, Task 3) vào dependencies. Script spike hiện dùng `opentype.js`; thay bằng `fontkit` ở plan sửa chữ Phase C vì `opentype.js` không áp trục `wght`. `fig-kiwi` (0.0.1, không cập nhật từ 2022) **chỉ** vào `devDependencies` nếu cần đối chiếu, không import lúc chạy.
- **Không cần nâng Node.** Nén khi ghi dùng deflate (`pako`); giải nén zstd dùng `fzstd` (thuần JS), đã kiểm chứng chạy trên Node 20.19.0.
- Thứ tự đầu ra phải ổn định (cùng input → cùng payload, trừ `pasteID`) để test golden được.
- Phần tử không chuyển được (canvas, video, iframe, SVG phức tạp ở giai đoạn đầu) phải thành placeholder có tên rõ ràng, không làm hỏng cả payload.

## Review Focus

1. Figma có nhận payload do ta tự sinh không, cả Figma Desktop lẫn Figma trên trình duyệt. Kiểm tra tại Task 0 và Task 8.
2. ~~Clipboard có giữ nguyên `data-buffer` không khi ghi từ canvas~~ — **đã loại trừ** (xem "Xác minh kỹ thuật" mục 1). Còn lại ở Task 6: giữ được user gesture khi phải fetch payload trước.
3. Toạ độ và kích thước sau paste khớp ảnh chụp của màn hình (sai lệch ≤ 1px với box, ≤ 2px với text). Kiểm tra tại Task 2 và Task 8.
4. Text: font thiếu, font fallback, line-height, text nhiều dòng. Kiểm tra tại Task 3.
5. Schema Figma đổi: có cách phát hiện và cập nhật schema mà không sửa encoder. Kiểm tra tại Task 1 và Task 7.

## Thiết kế

### Luồng dữ liệu

```
Canvas (nút Copy cho Figma)
  → POST /api/projects/:p/screens/:s/figma
    → extract.ts   Playwright render + walk DOM  → FigmaIR (cây trung gian)
    → encode.ts    FigmaIR                       → Message NODE_CHANGES
    → archive.ts   schema + message              → fig-kiwi bytes → HTML clipboard
  ← { html, text, screenId, screenName, nodeCount, warnings }
Canvas ghi html vào clipboard (text/html) + text (text/plain)
```

### Cấu trúc file đề xuất

| File | Vai trò |
| --- | --- |
| `packages/server/src/figma/ir.ts` | Kiểu `FigmaIRNode` (frame, text, image, vector, placeholder) |
| `packages/server/src/figma/extract.ts` | Tách phần Playwright + walk DOM từ `figma-export.ts`, xuất IR thay vì HTML |
| `packages/server/src/figma/encode.ts` | IR → `nodeChanges`: guid, `parentIndex.position`, paint, effect, auto layout, text |
| `packages/server/src/figma/archive.ts` | Pack/unpack `fig-kiwi` archive, nén chunk, bọc/tháo HTML `figmeta`/`figma` |
| `packages/server/src/figma/schema/figma-<ngày>.kiwi` | Schema nhị phân lấy từ bản copy thật |
| `packages/server/src/figma/schema/README.md` | Cách lấy lại schema khi Figma đổi |
| `packages/server/src/figma-export.ts` | Giữ `exportScreenForFigma` làm điểm vào, gọi 3 bước trên |
| `scripts/figma-capture-sample.html` | Trang dev: paste từ Figma vào để lưu raw `text/html` (lấy mẫu + schema) |
| `tests/fixtures/figma/*.html` | Mẫu clipboard thật từ Figma, dùng cho test decode |

### Cây trung gian (IR)

Mỗi node mang đủ để encoder không phải đọc lại DOM:

- `kind`: `frame` | `text` | `image` | `vector` | `placeholder`
- `name`: ưu tiên `data-design-id` → `aria-label` → tên tag + class đầu tiên
- `x`, `y`, `width`, `height` (tương đối với cha), `rotation` (giai đoạn sau)
- `fills` (màu solid, gradient tuyến tính), `strokes` + `strokeWeight` theo từng cạnh, `cornerRadius` (4 góc), `opacity`, `effects` (drop/inner shadow), `clipsContent` (từ `overflow`)
- `layout` (nếu cha là flex và có thể map): `direction`, `gap`, `padding`, `mainAlign`, `crossAlign`, `wrap`, và sizing của con (`fixed` / `hug` / `fill`)
- `text`: `characters`, `fontFamily`, `fontWeight`, `fontStyle`, `fontSize`, `lineHeight`, `letterSpacing`, `textAlign`, `textCase`, `color`, `autoResize`
- `image`: bytes PNG (giai đoạn sau)

### Bảng map CSS → Figma

| CSS (computed) | Figma node field | Ghi chú |
| --- | --- | --- |
| box có nền/viền/con | `FRAME` | Mặc định mọi element có box là frame |
| text node | `TEXT` | Gom text trực tiếp của element; inline lồng nhau → giai đoạn sau dùng style runs |
| `background-color` | `fillPaints: [{ type: SOLID, color, opacity }]` | Màu RGBA 0–1 |
| `background-image: linear-gradient` | `GRADIENT_LINEAR` | Task 5 |
| `border-*` | `strokePaints`, `strokeWeight`, `strokeAlign: INSIDE`, weight từng cạnh | CSS border nằm trong box → INSIDE |
| `border-*-radius` | `cornerRadius` hoặc 4 góc riêng | |
| `box-shadow` | `effects: DROP_SHADOW` / `INNER_SHADOW` | Task 5 |
| `opacity` | `opacity` | |
| `overflow: hidden` | `frameMaskDisabled: false` (clip) | |
| `display: flex` | `stackMode` HORIZONTAL/VERTICAL, `stackSpacing`, padding, align | Làm thẳng như Stitch (711/711 frame), không cần kiểm tra rồi fallback |
| `display: grid` | `stackMode: GRID` | Stitch dùng; field grid cụ thể đo từ mẫu ở Task 4 |
| `position: absolute` | `stackPositioning: ABSOLUTE` trong cha auto layout, hoặc toạ độ đo | |
| `font-*`, `line-height`, `letter-spacing` | `fontName`, `fontVariations`, `fontSize`, `lineHeight {value, units}`, `letterSpacing` | Family lấy theo font **thực dùng** (`CSS.getPlatformFontsForNode`), style có dấu cách: `"Semi Bold"`, `"Extra Bold"` |
| `<img>`, `background-image: url()` | fill `IMAGE` với `image: { hash: sha1(bytes), name, dataBlob }` | Bytes nhúng trong `blobs`, đã kiểm chứng trên mẫu Stitch |
| `<svg>`, icon font | `VECTOR` có `vectorNetworkBlob` | Stitch làm vậy; giai đoạn đầu có thể tạm dùng ảnh |

Tên field chính xác phải đối chiếu với schema `figma-v106.kiwi` và mẫu thật, không dùng `fig-kiwi/dist/index.d.ts` (schema 2022, đã lỗi thời).

## Tasks

### Task 0 — Spike xác minh định dạng (cổng quyết định, BẮT BUỘC)

> **Không thể bỏ qua hoặc thay bằng fixture tự tạo.** `writeHTMLMessage` cần tham số `schema`, mà `fig-kiwi` không kèm schema — schema chỉ trích được từ một payload thật do Figma ghi.

**Tiến độ 2026-09-27:** đã có 2 mẫu thật (một copy trong Figma, một copy từ Stitch), decode được **cả hai** và đã trích schema v106. Còn thiếu: mẫu phân loại theo loại node, và bước round-trip sinh payload.

- [x] `scripts/figma-capture-sample.html` — trang nghe `paste`, tải `text/html` về file, kèm chẩn đoán.
- [x] Xác định cấu trúc archive: magic `fig-kiwi`, version **106**, 2 chunk, offset khớp hoàn hảo (`284572/284572` và `977961/977961`).
- [x] Xác định nén: dò tự động theo magic zstd; cả hai mẫu giải mã thành công (mẫu 01 chunk1 = zstd, mẫu 02 chunk1 = deflate).
- [x] Trích schema: `kiwi-schema.decodeBinarySchema` OK, 647 định nghĩa (ENUM 212, STRUCT 30, MESSAGE 405).
- [x] **Giải mã được chunk 1** của cả ba mẫu: `type: NODE_CHANGES`.
- [x] Ghi lại field bắt buộc: **`NodeChange` có 0 field bắt buộc** ⇒ encoder được phép sinh payload tối thiểu.
- [x] Lập bảng field thực dùng theo loại node (xem mục 6).
- [x] **Trả lời câu hỏi `derivedTextData`**: **BẮT BUỘC**, kèm `glyphs` có `commandsBlob` hợp lệ; bỏ trống thì chữ không hiện (xem mục 7). Không phải chuyển sang hướng plugin: tự sinh được bằng font engine.
- [x] Có mẫu tối giản để test: `figma-sample-03` (màn hình đăng nhập, 158 node, đọc được từng dòng) — dùng làm golden test cho encoder.
- [x] Round-trip: decode mẫu 03 → encode lại → paste vào Figma: dán được (theo handoff mục 2).
- [x] Sinh từ đầu: DOCUMENT + CANVAS + FRAME + TEXT → paste: frame đúng; chữ hiện nhưng sai hình/khoảng cách — xử lý ở [plan sửa chữ](2026-09-27-copy-to-figma-text-fix.md).
- [x] Kiểm tra image: **có** — `image.dataBlob` trỏ tới bytes JPEG trong `blobs`, `image.hash` = SHA-1 của bytes (mẫu 02, khớp 3/3).
- [x] Đường clipboard trên máy này: `osascript … «class HTML»` đưa payload vào clipboard và Figma Desktop dán được.
- [ ] Dán thử trên **Figma web**.

**Đạt khi:** payload tự sinh (frame + text) paste được trên Figma Desktop và Figma web. Ghi kết quả vào `.superpowers/sdd/2026-09-27-copy-to-figma/progress.md`.

**Không đạt:** dừng và chọn lại giữa hai hướng dự phòng (xem mục cuối). Không làm tiếp Task 1.

### Task 1 — Archive và schema

- [ ] `archive.ts`: `packArchive(schemaBytes, messageBytes)`, `unpackArchive(bytes)`, `wrapClipboardHtml(meta, archive)`, `unwrapClipboardHtml(html)`. Tự viết (khoảng 100 dòng) dựa trên `kiwi-schema`, không phụ thuộc `fig-kiwi` lúc chạy.
- [ ] **`decompressAuto()` bắt buộc**: đọc magic zstd (`28 b5 2f fd`) → `fzstd.decompress`, còn lại → `pako.inflateRaw`. Không hardcode. Khi **ghi**, dùng deflate cho cả hai chunk (không cần zstd chiều ghi).
- [ ] **`unwrapClipboardHtml` phải unescape HTML entities trước khi base64-decode.** Trình duyệt escape nội dung attribute khi ghi clipboard (`<!--` → `&lt;!--`), đã đo được: ghi 168 ký tự, đọc lại 180. Xử lý `&lt;` `&gt;` `&amp;` `&quot;` (thứ tự: `&amp;` cuối cùng để không double-unescape). `figmeta` cũng là base64, phải decode tương tự.
- [ ] Commit schema từ Task 0 vào `figma/schema/figma-v106.kiwi`, kèm README cách lấy lại. Schema v106: 647 định nghĩa, `NodeChange` 613 field (0 bắt buộc).
- [ ] Load schema một lần lúc khởi động server; lỗi schema → `CanvasError('FIGMA_SCHEMA_INVALID', …)`. Cảnh báo khi version trong archive khác version schema đang commit.
- [ ] Test: **phải chạy trên cả hai mẫu thật** (một zstd, một deflate) → unwrap/unpack → pack lại → decode ra message giống hệt. Giữ cả hai trong `tests/fixtures/figma/`. Thêm test riêng cho ca có entity bị escape.

### Task 2 — IR và encoder cho frame/hình khối

- [ ] Tách phần walk DOM trong `figma-export.ts` sang `extract.ts`, xuất `FigmaIRNode`. Giữ các quy tắc đang có: bỏ `display:none`, `visibility:hidden`, `opacity:0`, box rỗng không có text; bỏ các tag trong `EXPORT_SKIPPED_TAGS`.
- [ ] `encode.ts`: sinh DOCUMENT (`0:0`), CANVAS (`0:1`), frame gốc tên theo `screen.name` với kích thước bằng viewport của màn hình.
- [ ] Guid tăng dần theo thứ tự duyệt; `parentIndex.position` là chuỗi fractional index tăng dần (đúng thứ tự vẽ: con sau nằm trên).
- [ ] Map `background-color`, border từng cạnh, radius 4 góc, opacity, clip content.
- [ ] Transform: `m02 = x`, `m12 = y` tương đối với cha.
- [ ] Test unit: IR → message → decode bằng schema → so sánh field; golden cho một màn hình fixture.

### Task 3 — Text (nặng nhất: cần font engine)

> **Chi tiết đầy đủ ở [plan sửa chữ](2026-09-27-copy-to-figma-text-fix.md)** (Phase A–E) — file đó là nguồn đúng cho công thức bố cục, chỉ số blob và golden test. Dưới đây chỉ là danh sách đầu việc.

- [ ] **Phase A của plan sửa chữ trước tiên** — sửa script spike, dán thử, đạt mới làm tiếp.
- [ ] Text trực tiếp của element → node TEXT con, đặt theo rect đo bằng `Range.getBoundingClientRect()` của text node, không dùng rect của element cha.
- [ ] Map font: lấy family **thực dùng** qua CDP `CSS.getPlatformFontsForNode` (như Stitch dùng `Liberation Mono` khi trình duyệt fallback), weight → tên style Figma có dấu cách (`"Semi Bold"`), italic. Trả `warnings` khi font không có file.
- [ ] `lineHeight`, `letterSpacing`, `textAlignHorizontal`, `textCase` từ computed style.
- [ ] `textData`: `{ characters, lines: [{ lineType: "PLAIN", styleId: 0, indentationLevel: 0, sourceDirectionality: "AUTO", listStartOffset: 0, isFirstLineOfList: false }] }`.
- [ ] `derivedTextData` theo module `text/layout.ts` (plan sửa chữ Phase B): `baseline.y` theo công thức half-leading, `logicalIndexToCharacterOffsetMap` = `position.x` từng ký tự, mỗi ký tự một glyph.
- [ ] `commandsBlob` **0-based**, mảng `blobs` dùng chung với vector và ảnh — cấp chỉ số qua một bảng blob chung cho cả payload.
- [ ] Outline và advance bằng **`fontkit`** (hỗ trợ font biến thiên), file font lấy từ `@font-face` của trang → font hệ thống → Inter đóng gói sẵn (plan sửa chữ Phase C).
- [ ] Ngắt dòng lấy từ trình duyệt (plan sửa chữ Phase D).
- [ ] `fontVariations` với trục `wght` cho font biến thiên (xem mục 7b).
- [ ] Giai đoạn sau: inline lồng nhau (`<b>`, `<a>`) → style overrides trong cùng một TEXT.

### Task 4 — Auto Layout

> Stitch đã chứng minh chuyển `display:flex` → `stackMode` cho **711/711 frame** mà vẫn giữ layout đúng (xem "Xác minh kỹ thuật" mục 4). Bỏ bước "kiểm tra an toàn rồi fallback về absolute" — làm thẳng, giống Stitch.

- [ ] Với cha `display:flex`: suy ra `stackMode` (HORIZONTAL/VERTICAL từ `flex-direction`), `stackSpacing` (từ `gap`), `stackHorizontalPadding`/`stackVerticalPadding`/`stackPaddingRight`/`stackPaddingBottom`, `stackPrimaryAlignItems`, `stackCounterAlignItems`, wrap.
- [ ] Sizing của con: `flex-grow > 0` → `stackChildPrimaryGrow`; width bằng nội dung → hug (`stackPrimarySizing`); còn lại fixed.
- [ ] Con `position:absolute` trong cha flex → `stackPositioning: ABSOLUTE`.
- [ ] `stackCounterSizing`: `FIXED` khi cha không co theo nội dung; xem ví dụ thật ở mục 4.
- [ ] `display: grid` → `stackMode: GRID` (Stitch có 7 frame GRID trong mẫu 02). Dump các field grid của những frame đó trước khi viết encoder.
- [ ] Tên layer theo quy ước Stitch: comment HTML đứng ngay trước phần tử → `data-design-id` → `aria-label` → vai trò/tag (`Container`, `Text`, `Button`); gốc là `Html → Body`.
- [ ] Test với template `templates/basic-screen` và các màn hình mẫu có flex lồng nhau. Đối chiếu kết quả với payload Stitch của cùng màn hình nếu có.

### Task 5 — Hiệu ứng, gradient, ảnh, SVG

- [ ] `box-shadow` (nhiều lớp, inset) → effects. Đối chiếu cách Stitch dùng rectangle `…:shadow` nằm dưới frame (mẫu 03) và làm theo nếu effect trên frame bị clip.
- [ ] `linear-gradient` → `GRADIENT_LINEAR` với transform đúng góc; gradient khác → ảnh chụp phần tử (fallback).
- [ ] `<img>` / `background-image: url()`: lấy bytes gốc (bắt response trong Playwright hoặc đọc file trong project) → thêm vào bảng blob chung → paint `{ type: "IMAGE", image: { hash: sha1(bytes), name, dataBlob }, imageScaleMode, transform }`. Map `object-fit` / `background-size` sang `imageScaleMode` + `transform` (mẫu Stitch dùng `STRETCH` kèm transform để crop). Đối chiếu với mẫu 02.
- [ ] `<svg>` và icon font: mục tiêu là `VECTOR` có `vectorNetworkBlob` như Stitch. Giai đoạn đầu cho phép rasterize thành ảnh (dùng đường ảnh ở trên), ghi `warnings`. Định dạng `vectorNetworkBlob` có tài liệu ở [figma-kiwi-protocol](https://github.com/allan-simon/figma-kiwi-protocol).
- [ ] Phần tử không hỗ trợ (canvas, video, iframe) → ảnh chụp phần tử.

### Task 6 — Ghi clipboard trên canvas

- [x] ~~Xác minh đường clipboard~~ — **đã xác minh 2026-09-27**: cả Async Clipboard API lẫn sự kiện `copy` đều giữ nguyên `data-buffer`/`(figma)`/`(figmeta)`. Async Clipboard API dùng được.
- [ ] `copyForFigma` trong `App.tsx`: giữ cách ghi hiện tại (`navigator.clipboard.write` với `text/html` + `text/plain`). Vấn đề còn lại là **user gesture**: fetch payload trước rồi mới ghi có thể làm mất gesture, nên hoặc prefetch payload khi chọn màn hình, hoặc giữ nút ở trạng thái “Sẵn sàng — bấm để copy”.
- [ ] Hiển thị `warnings` (font thay thế, SVG bị rasterize, ảnh bị thu nhỏ) sau khi copy.
- [ ] Cập nhật `title` của nút (hiện là “Copy màn hình dưới dạng HTML…”).
- [ ] Chuyển `diag.mjs` thành e2e: kiểm clipboard chứa `(figma)` và `(figmeta)`, và decode được bằng schema đã commit.

### Task 7 — CLI, MCP, skill, tài liệu

- [ ] CLI `screen figma <screenId> [--out file.html]`: ghi payload ra file hoặc thẳng vào clipboard macOS (`pbcopy` không set được `text/html` — cần `osascript`/Swift nhỏ hoặc chỉ hỗ trợ `--out`; quyết định khi làm).
- [ ] MCP tool `screen_figma_export` trả về đường dẫn file, không trả payload lớn qua stdio.
- [ ] Cập nhật `README.md`, `docs/usage.md`, `skills/local-design-canvas/references/commands.md`.
- [ ] Script kiểm tra schema: decode một mẫu mới lấy từ Figma bằng schema đang commit; lỗi → cần cập nhật schema.

### Task 8 — Nghiệm thu

- [ ] Test unit/integration: archive round-trip, encoder golden, extractor trên fixture HTML (flex, text nhiều dòng, border, shadow, ảnh).
- [ ] Gỡ hoặc viết lại `tests/unit/figma-export.test.ts` (đang kiểm `serializeForFigma` sẽ không còn dùng).
- [ ] Nghiệm thu thủ công trên Figma Desktop và Figma web với 3 màn hình thật của workspace demo:
  - [ ] Paste ra đúng một frame gốc, đúng kích thước viewport.
  - [ ] Chồng ảnh chụp (`screen capture`) lên frame trong Figma ở opacity 50%: box lệch ≤ 1px, text lệch ≤ 2px.
  - [ ] Text sửa được, đúng font (hoặc có cảnh báo thay font).
  - [ ] Frame flex thành Auto Layout, thêm/xoá con vẫn dàn đúng.
  - [ ] Tên layer đọc được (theo `data-design-id`).
- [ ] `npm run typecheck`, `npm test`, `npm run test:e2e` pass.
- [ ] Ghi kết quả vào progress.

## Mốc phát hành

| Mốc | Phạm vi | Nghiệm thu |
| --- | --- | --- |
| F0 | Task 0 | Payload tự sinh paste được vào Figma |
| F1 — Dùng được | Task 1–3, 6 | Paste ra frame + hình khối + text đúng vị trí |
| F2 — Giống Stitch | Task 4–5 | Auto Layout, shadow, gradient, ảnh |
| F3 — Hoàn thiện | Task 7–8 | CLI/MCP, tài liệu, nghiệm thu đầy đủ |

## Rủi ro

| Rủi ro | Ảnh hưởng | Giảm thiểu |
| --- | --- | --- |
| Định dạng clipboard không có tài liệu, Figma đổi schema | Paste hỏng sau một bản cập nhật Figma | Schema là file tách rời, có script kiểm tra và README lấy lại; encoder chỉ dùng tập field nhỏ, ổn định |
| Figma từ chối payload tự sinh (thiếu field ẩn, sai nén) | Chặn toàn bộ hướng này | Task 0 là cổng quyết định; bắt đầu từ round-trip mẫu thật rồi mới sinh từ đầu |
| ~~Trình duyệt sanitize `text/html`~~ — **đã loại trừ** | — | Đã đo: Async API lẫn sự kiện `copy` đều giữ `data-buffer` nguyên vẹn |
| Chunk message dùng deflate hoặc zstd tuỳ lần copy | Giải mã sai thì không đọc được payload Figma | Đã có `decompressAuto()` kiểm chứng trên 2 mẫu; test phủ cả hai nhánh. Chiều ghi chỉ dùng deflate |
| ~~`derivedTextData` tưởng bỏ trống được~~ — **đã giải quyết** | Ba lần kết luận sai liên tiếp | Cần `derivedTextData` + `glyphs` có `commandsBlob` đúng (mục 7) |
| **Chữ sai hình/khoảng cách** — đang chặn | Không dùng được | Nguyên nhân đã tìm ra: `commandsBlob` 0-based bị dùng như 1-based, `logicalIndexToCharacterOffsetMap` sai, `position.y` thiếu half-leading. Sửa theo [plan sửa chữ](2026-09-27-copy-to-figma-text-fix.md) Phase A |
| **Phải có font engine để trích đường vẽ chữ** | Không thể suy outline từ CSS; Canvas API không trả outline | `fontkit` đọc file font thật (từ `@font-face` của trang, font hệ thống, hoặc Inter đóng gói sẵn) |
| Bản font trên máy khác bản Figma dùng | Advance lệch nhỏ, lộ ra khi sửa chữ | Đo độ lệch ở plan sửa chữ Phase C; ưu tiên font Google Fonts như Stitch |
| Font biến thiên không render | Chữ trống dù node đúng | Gửi `fontVariations` với trục `wght` (mục 7b) |
| Payload bị bỏ qua im lặng | Figma parse thành công nhưng không dán gì | Thiếu `pastePageId` tầng message (mục 7c) |
| Chỉ số blob chồng nhau giữa chữ, vector, ảnh | Chữ/ảnh/icon hiện sai | Một bảng blob chung cho cả payload, cấp chỉ số 0-based; test mọi chỉ số < `blobs.length` |
| `fig-kiwi` bỏ hoang từ 2022, không hiểu schema v106 (`NodeChange` 613 field, field có cặp `x`/`xTag`) | Dùng nó để decode/encode sẽ thất bại | Không import lúc chạy; tự viết encoder trên `kiwi-schema`. Nếu vỡ, chuyển sang hướng plugin (dự phòng 1) |
| Font không có trên máy người dùng | Figma báo missing font, text lệch | Bảng fallback + `warnings`; khuyến nghị template dùng font phổ biến (Inter) |
| ~~Ảnh không mang được qua clipboard~~ — **đã loại trừ** | — | Stitch nhúng bytes vào `blobs` qua `image.dataBlob`, `hash` = SHA-1 (mục "Stitch làm thế nào") |
| Payload lớn vì ảnh nhúng | Clipboard chậm, Figma có thể từ chối | Giới hạn kích thước ảnh (resize trước khi nhúng), cảnh báo khi payload vượt ngưỡng; đo ngưỡng thực tế |
| Payload lớn với màn hình dài | Clipboard chậm | Nén; giới hạn số node và cảnh báo |
| Điều khoản sử dụng Figma với định dạng nội bộ | Pháp lý | Chỉ ghi dữ liệu người dùng tự tạo, không đọc file Figma của người khác; ghi chú trong README |

## Hướng dự phòng nếu Task 0 không đạt

1. **Plugin Figma:** endpoint xuất JSON (chính là IR ở trên); plugin đọc JSON từ clipboard hoặc URL local và dựng node bằng Plugin API chính thức (`figma.createFrame`, `createText`, `layoutMode`, …). Ổn định, hỗ trợ ảnh và font tốt, nhưng người dùng phải cài plugin. IR và extractor dùng lại được 100%.
2. **Paste SVG:** xuất SVG có `<text>`; Figma nhận thành vector và text. Làm nhanh, nhưng layout phẳng, không có Auto Layout.

## Ghi chú

- Trong lúc tìm hiểu đã cài `fig-kiwi` ^0.0.1, `kiwi-schema` ^0.5.0, `pako` ^3.0.2 vào `/tmp/figspike` (ngoài repo) để đọc API; repo không bị thay đổi dependency. Các thí nghiệm clipboard chạy bằng Playwright Chromium tạm, không lưu lại trong repo.
- `diag.mjs` từng ở gốc repo làm script chẩn đoán tạm, đã xoá sau khi xác minh xong; Task 6 sẽ thay bằng e2e thật.
- Script phân tích dùng để suy ra mục "Stitch làm thế nào" và plan sửa chữ: `/tmp/figspike/analyze.ts`, `analyze2.ts`, `compare.ts`, `img.ts` (ngoài repo). Nên chuyển vào `scripts/diagnostics/` khi làm Task 1.
- Máy dev đang chạy Node 20.19.0, trong khi `package.json` khai `engines.node >= 22.12.0`. Không ảnh hưởng kế hoạch này vì chỉ cần `deflateRaw`, nhưng nên biết khi cài dependency mới.
