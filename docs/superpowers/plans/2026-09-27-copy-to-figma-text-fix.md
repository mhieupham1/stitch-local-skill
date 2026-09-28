# Copy to Figma — Kế hoạch sửa bố cục chữ

> **For agentic workers:** Làm theo thứ tự Phase A → E. Phase A là cổng quyết định: chưa dán được chữ đúng vào Figma thì không làm Phase B trở đi. Mỗi lần dán thử chỉ đổi **một** biến. Steps dùng checkbox (`- [ ]`).

**Goal:** Node TEXT tự sinh dán vào Figma hiện đúng chữ, đúng khoảng cách, đúng vị trí dọc — khớp với payload Stitch trên cùng nội dung.

**Bối cảnh:** Tiếp nối [handoff](2026-09-27-copy-to-figma-handoff.md) mục 6 ("Cái còn HỎNG") và [kế hoạch chính](2026-09-27-copy-to-figma.md) Task 3.

**Ngày:** 2026-09-27.

**Trạng thái:** Đã tìm ra nguyên nhân (mục 1), chưa sửa code.

## 1. Nguyên nhân — đã đo trên mẫu thật

Đo bằng script đọc `figma-sample-03` (payload Stitch, 158 node, 198 blob). Mọi con số dưới đây lấy trực tiếp từ payload, không suy đoán.

### 1.1 `commandsBlob` là chỉ số 0-based — script đang lệch 1 (nguyên nhân chính)

Handoff và kế hoạch chính đều ghi `commandsBlob` là "chỉ số tuyệt đối 1-based". **Sai.** Nó là chỉ số trực tiếp vào mảng `blobs`, bắt đầu từ 0. Trong mẫu 03, `blobs[0]` tình cờ là `vectorNetworkBlob` của một node VECTOR, nên glyph đầu tiên trỏ vào `1` — dễ nhầm thành 1-based.

Bằng chứng, chữ `"SMEMBER REWARDS"` (Inter Semi Bold 13), so bề rộng hình vẽ của blob với `advance`:

| Ký tự | `commandsBlob` | advance | rộng `blobs[idx]` | rộng `blobs[idx-1]` |
| --- | --- | --- | --- | --- |
| S | 1 | 0.650 | 0.557 | — (là blob vector) |
| M | 2 | 0.922 | **0.776** | 0.557 (hình chữ S) |
| E | 3 | 0.605 | **0.475** | 0.776 (hình chữ M) |
| W | 7 | 0.953 | **0.971** | — |
| D | 9 | 0.722 | **0.598** | 0.679 (hình chữ A) |

Đọc `blobs[idx]` cho đúng hình từng chữ (W rộng nhất, E hẹp nhất). Đọc `blobs[idx-1]` cho hình của chữ khác.

Script `scripts/figma-generate-from-font.ts` làm:

```ts
blobs.push({ bytes: encodePathCommands(outline.commands) });
blobIndex = blobs.length; // 1-based
```

⇒ Mỗi ký tự vẽ **hình của ký tự mới kế tiếp** nhưng dùng `advance` của chính nó, còn ký tự mới cuối cùng trỏ ra ngoài mảng. Đó chính là "chữ hiện nhưng dồn/lệch" dù `pos.x` khớp tuyệt đối.

Hệ quả phụ — **cần sửa kết luận cũ:**
- Thí nghiệm "nén còn 9 blob thì mất chữ D" hỏng vì ánh xạ lại theo giả định 1-based, không phải vì Figma cần mảng blob đầy đủ. Nén/loại blob không dùng là **được phép** nếu chỉ số đúng.
- `scripts/diagnostics/dump-text-glyphs.ts` và `check-glyph-blobs.ts` đang đọc `blobs[index - 1]` → in sai blob cho từng ký tự.

### 1.2 `logicalIndexToCharacterOffsetMap` là toạ độ x, không phải chỉ số

Mẫu thật:

```
[0, 9.105, 21.746, 30.267, 42.908, 52.127, 60.648, 69.779, 73.704, ...]
```

Đây là `position.x` (px) của từng ký tự. Script điền `[0, 1, 2, 3, ...]`. Nhiều khả năng Figma dùng mảng này cho con trỏ/hit-test và có thể cả bố cục — phải điền đúng.

### 1.3 `position.y` — đã giải, khớp 0.0000 ở cả 9 tổ hợp

Là half-leading chuẩn CSS, dùng số đo `hhea` của font:

```
fontLineHeight = (ascender + |descender|) / unitsPerEm          // Inter: 2478/2048 = 1.2099609375
lineHeightPx   = PIXELS → value
                 PERCENT → value/100 × fontLineHeight × fontSize
lineAscent     = ascender / unitsPerEm × fontSize
baseline.y     = lineIndex × lineHeightPx
               + (lineHeightPx − fontLineHeight × fontSize) / 2
               + lineAscent
```

| fontSize | lineHeight | baseline.y thật | công thức | lệch |
| --- | --- | --- | --- | --- |
| 10 | 15 px | 11.138 | 11.138 | 0.0000 |
| 12 | 16 px | 12.365 | 12.365 | 0.0000 |
| 12 | 19.5 px | 14.115 | 14.115 | 0.0000 |
| 13 | 18 px | 13.729 | 13.729 | 0.0000 |
| 14 | **100 PERCENT** | 13.563 | 13.563 | 0.0000 |
| 24 | 32 px | 24.730 | 24.730 | 0.0000 |

Handoff thất bại vì chia cho `(lineHeight − fontSize)` thay vì `(lineHeight − fontLineHeight × fontSize)`, và coi `lineHeight = 100` là 100px trong khi nó là 100 **PERCENT**.

### 1.4 Các sai lệch khác so với mẫu thật

| Field | Mẫu thật | Script hiện tại |
| --- | --- | --- |
| `size.y`, `layoutSize.y` | `lineHeightPx × số dòng` (18) | `fontSize` (32) |
| `glyph.position.y` | = `baseline.y` của dòng chứa nó | `ascender × fontSize` (không có half-leading) |
| glyph dấu cách | có `commandsBlob` trỏ tới blob **1 byte** | không có `commandsBlob` |
| `baseline.lineAscent` | `ascender/upm × fontSize` | `baselineY` (trùng giá trị khi không có leading, lệch khi có) |
| `fontMetaData.fontLineHeight` | `1.2099609375` (tỉ lệ font) | `lineHeight / fontSize` |
| `fontMetaData.fontWeight`, `fontName.style`, `fontVariations` | 600, `"Semi Bold"`, `wght=600` | 400, lấy từ `fontSubfamily` của file |
| Nhiều dòng | mỗi dòng một `baseline`, `lineY` = 0 ở mọi dòng, `position.y` cộng dồn `lineHeightPx` | chỉ hỗ trợ một dòng |

### 1.5 Outline sai weight với font biến thiên

`opentype.js` không áp trục `wght`: sinh từ `Inter-var.ttf` luôn ra outline và advance của instance mặc định (Regular). Mẫu thật: `M` advance 0.922 (Semi Bold) so với 0.903 (Regular). Sai số này không gây "dồn chữ" nhưng làm lệch dần theo độ dài dòng.

## 2. Hướng giải quyết

1. Sửa script spike theo mục 1.1 → 1.4, dán thử từng bước (Phase A).
2. Tách thành module bố cục chữ thuần (pure function) có golden test so với mẫu 03 (Phase B).
3. Nguồn font và chọn instance theo weight bằng `fontkit` (Phase C).
4. Ngắt dòng lấy từ trình duyệt, không tự tính (Phase D).
5. Sửa tài liệu và công cụ chẩn đoán (Phase E).

Nguyên tắc: **so trực tiếp với mẫu thật**, không suy ngược. Mọi field của `derivedTextData` phải có một test đối chiếu với node tương ứng trong mẫu 03.

## Phase A — Sửa script và dán thử (cổng quyết định)

Mốc so sánh vàng trước khi bắt đầu:

- [ ] Dán lại mẫu gốc bằng `osascript -e 'set the clipboard to (read (POSIX file "<figma-sample-03>.html") as «class HTML»)'` và xác nhận nó hiện đúng trong Figma phiên đang dùng. Chụp màn hình làm mốc.

Sửa `scripts/figma-generate-from-font.ts`, **mỗi bước một lần dán**, ghi kết quả vào progress:

- [ ] **A1 — chỉ số blob.** `blobIndex = blobs.length - 1` (sau `push`). Dán thử với `--text "SMEMBER REWARDS"`, font Inter, cỡ 13. Kỳ vọng: đúng hình từng chữ. Nếu A1 đã đủ để chữ đúng thì ghi lại và vẫn làm tiếp A2–A5 để khớp mẫu.
- [ ] **A2 — `logicalIndexToCharacterOffsetMap`** = mảng `position.x` của từng ký tự.
- [ ] **A3 — dọc.** Tham số `--line-height` (mặc định 18 cho cỡ 13), tính `baseline.y`, `lineAscent`, `fontLineHeight` theo mục 1.3; `size.y = layoutSize.y = lineHeightPx`; `glyph.position.y = baseline.y`.
- [ ] **A4 — dấu cách.** Thêm blob 1 byte dùng chung cho mọi ký tự không có nét, gán `commandsBlob` như mẫu thật. (Kiểm tra byte đó là gì — nhiều khả năng `[0]` = ClosePath.)
- [ ] **A5 — weight.** Tham số `--weight 600` → `fontName.style: "Semi Bold"`, `fontVariations: [{ axisTag: 2003265652, axisName: "wght", value: 600 }]`, `fontMetaData.fontWeight: 600`. Tạm thời vẫn dùng outline Regular (sửa ở Phase C).
- [ ] **Đối chiếu số:** sinh `"SMEMBER REWARDS"` Inter 600 cỡ 13 lh 18, rồi chạy `scripts/diagnostics/diff-node-full.ts` so với node thật trong mẫu 03. Mọi field số trong `derivedTextData` lệch ≤ 0.01 (trừ advance/outline, chờ Phase C).

**Đạt khi:** chữ dán vào Figma đúng hình, đúng khoảng cách, đúng vị trí dọc, chồng khít lên ảnh chụp mẫu 03 ở opacity 50%.

**Không đạt:** so `diff-node-full.ts` giữa node tự sinh và node thật, liệt kê mọi field khác nhau, thử lần lượt từng field. Chỉ khi đã loại trừ hết mới xét hướng dự phòng (mục cuối).

## Phase B — Module bố cục chữ + golden test

- [ ] `packages/server/src/figma/text/layout.ts` — hàm thuần:

  ```ts
  layoutText(input: {
    characters: string;
    lines: Array<{ first: number; end: number }>;   // từ Phase D
    fontSize: number;
    lineHeight: { value: number; units: 'PIXELS' | 'PERCENT' };
    letterSpacing: number;                           // px
    metrics: { unitsPerEm: number; ascender: number; descender: number };
    advanceOf(character: string): number;            // em
    blobOf(character: string): number;               // chỉ số 0-based vào blobs
  }): DerivedTextData
  ```

  Trả về `layoutSize`, `baselines[]`, `glyphs[]`, `fontMetaData`, `logicalIndexToCharacterOffsetMap`, và các field hằng (`truncationStartIndex: -1`, `truncatedHeight: -1`, các mảng rỗng) đúng như mẫu thật.
- [ ] `packages/server/src/figma/text/blobs.ts` — bảng blob: dedup theo (font, weight, ký tự), trả chỉ số 0-based, **nhận offset** vì blob chữ dùng chung mảng với `vectorNetworkBlob` của node VECTOR.
- [ ] **Golden test** `tests/unit/figma-text-layout.test.ts`: với **mọi** node TEXT trong mẫu 03, lấy `characters`, `fontSize`, `lineHeight`, `letterSpacing`, ngắt dòng (từ `baselines[].firstCharacter/endCharacter`) và `advance` của từng glyph thật làm đầu vào; so đầu ra với `derivedTextData` thật:
  - `baselines[].position`, `width`, `lineHeight`, `lineAscent`: lệch ≤ 0.001
  - `glyphs[].position`: lệch ≤ 0.001
  - `logicalIndexToCharacterOffsetMap`: lệch ≤ 0.001
  - `layoutSize`: ghi lại quy tắc làm tròn (mẫu: `142.78` so với `width = 142.128` — **chưa rõ**, phải đo thêm trước khi chốt)
- [ ] Test chỉ số blob: trong payload tự sinh, mọi `commandsBlob` < `blobs.length`, và hình của `blobs[commandsBlob]` có bề rộng nhỏ hơn hoặc gần bằng `advance` của ký tự đó.
- [ ] Đưa mẫu 03 vào `tests/fixtures/figma/` (chỉ cần một bản, khoảng 118 KB).

## Phase C — Nguồn font và outline đúng weight

- [ ] Thay `opentype.js` bằng **`fontkit`**: hỗ trợ font biến thiên (`font.getVariation({ wght: 600 })`), trả outline và advance đúng instance. Kiểm lại quy ước toạ độ blob (em, gốc baseline, y hướng lên) bằng cách so với blob `E`, `B`, `D`, `M` của mẫu 03 — sai số bbox ≤ 0.002 em, advance ≤ 0.001 em.
- [ ] Lấy file font, theo thứ tự ưu tiên:
  1. Font trang tải qua `@font-face`: trong Playwright, bắt response có `content-type: font/*` hoặc đuôi `.woff2/.woff/.ttf`, lưu bytes theo `family + weight + style`. (`fontkit` đọc được WOFF2.)
  2. Font hệ thống: dò `/System/Library/Fonts`, `/Library/Fonts`, `~/Library/Fonts` theo tên family.
  3. Fallback: đóng gói sẵn Inter (giấy phép OFL cho phép) và trả `warnings` khi phải thay.
- [ ] **Không dùng Canvas API để lấy outline** — Canvas không trả đường vẽ glyph. Kế hoạch chính Task 3 phương án (b) cần gạch bỏ.
- [ ] Map weight → tên style Figma (`400 Regular`, `500 Medium`, `600 Semi Bold`, `700 Bold`, `800 Extra Bold`, `900 Black`; có dấu cách như mẫu thật). Italic → thêm `Italic`.
- [ ] Rủi ro cần đo: bản Inter trên máy khác bản Figma dùng → advance lệch nhỏ. Giả thuyết (chưa kiểm chứng): Figma vẽ theo `derivedTextData` của ta cho tới khi người dùng sửa chữ, nên lệch chỉ lộ ra lúc sửa. Xác minh bằng cách dán rồi gõ thêm một ký tự, và ghi lại độ lệch đo được.

## Phase D — Ngắt dòng lấy từ trình duyệt

Không tự viết thuật toán ngắt dòng. Trình duyệt đã ngắt đúng; chỉ cần đọc lại.

- [ ] Trong `extract.ts` (Playwright), với mỗi text node: dùng `Range` cho từng ký tự, `getClientRects()` → nhóm theo `top` để ra các dòng `{ first, end }`, và bề rộng box text.
- [ ] Text một dòng: `textAutoResize: WIDTH_AND_HEIGHT`. Nhiều dòng do bị ép bề rộng: `textAutoResize: HEIGHT`, `size.x` = bề rộng box. Nhiều dòng do `<br>`/`\n`: giữ `\n` trong `characters` như mẫu thật.
- [ ] Đối chiếu với node nhiều dòng của mẫu 03 (`"Áp dụng trực tiếp vào mọi hóa đơn…"`, 2 dòng: `baselines[1].position.y = 28.365 = 12.365 + 16`, `lineY = 0` ở cả hai dòng).
- [ ] `letter-spacing`, `text-transform`, `text-align` lấy từ computed style như kế hoạch chính.

## Phase E — Sửa tài liệu và công cụ chẩn đoán

Để người sau không bị dẫn sai lần nữa:

- [ ] `scripts/diagnostics/dump-text-glyphs.ts`, `check-glyph-blobs.ts`: đổi `blobs[index - 1]` → `blobs[index]`.
- [ ] `packages/server/src/figma/font/outline.ts`: sửa comment đảo trục y. Thực tế: `getPath()` của `opentype.js` trả **y hướng xuống**, đảo dấu cho ra **y hướng lên** — khớp mẫu thật. Code đúng, comment ngược. (Nếu Phase C thay bằng `fontkit` thì viết lại theo quy ước của `fontkit`.)
- [ ] [Handoff](2026-09-27-copy-to-figma-handoff.md):
  - mục 4.1 và 5.3: bỏ kết luận "cần toàn bộ mảng blobs"; nguyên nhân thật là lệch chỉ số.
  - mục 4.1: "`commandsBlob` 1-based" → 0-based, dùng chung mảng với `vectorNetworkBlob`.
  - mục 6.2: đánh dấu đã giải, dẫn công thức mục 1.3 file này.
  - mục 2 bảng trạng thái: cập nhật sau Phase A.
- [x] [Kế hoạch chính](2026-09-27-copy-to-figma.md) — đã cập nhật: thêm mục "Stitch làm thế nào"; sửa mục 6, 7, Task 0, Task 3–5, bảng map CSS → Figma, Review Focus 2 và bảng rủi ro theo các phát hiện ở file này.

## Nghiệm thu

- [ ] Phase A đạt: dán vào Figma Desktop **và** Figma web, chữ khớp ảnh chụp mẫu 03.
- [ ] Golden test Phase B pass trên mọi node TEXT của mẫu 03.
- [ ] Sinh lại toàn bộ màn hình đăng nhập (nguồn của mẫu 03) bằng pipeline mới, dán cạnh bản Stitch, chồng opacity 50%: text lệch ≤ 2px.
- [ ] Sửa chữ trong Figma sau khi dán: Figma layout lại được, không báo missing font (với Inter).
- [ ] `npm run typecheck`, `npm test` pass.

## Hướng dự phòng

Chỉ dùng khi Phase A không đạt **sau khi** đã so hết field với mẫu thật:

1. **Mượn khung node thật:** lấy nguyên một node TEXT của mẫu 03 làm template, chỉ thay `characters`, `glyphs`, `baselines`, `blobs` — thu hẹp khác biệt về đúng phần bố cục. (`scripts/diagnostics/build-variant.ts` đang dở dang theo hướng này.)
2. **Chữ thành VECTOR:** vẽ chữ bằng node VECTOR từ outline. Bố cục chắc chắn đúng, mất khả năng sửa chữ trong Figma.

## Ghi chú

- Các script phân tích dùng để lập kế hoạch này nằm ở `/tmp/figspike/analyze.ts` và `analyze2.ts` (ngoài repo). Nên chuyển thành `scripts/diagnostics/verify-text-layout.ts` ở Phase B.
- Điểm chưa rõ cần đo thêm: quy tắc làm tròn `layoutSize.x` (142.78 so với `baseline.width` 142.128), và nội dung blob 1 byte của dấu cách.
