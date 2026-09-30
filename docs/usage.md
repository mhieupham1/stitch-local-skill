# Hướng dẫn sử dụng Local Design Canvas

Local Design Canvas là công cụ thiết kế UI chạy hoàn toàn trên máy. Agent (Codex hoặc Claude Code) tạo và sửa file HTML/CSS/JavaScript trong workspace của bạn; một server local quản lý project, theo dõi file và hiển thị nhiều màn hình cạnh nhau trong canvas trên trình duyệt. Ứng dụng không gọi model, không cần API key, không tải asset từ CDN, và chỉ bind vào `127.0.0.1`.

Mục lục:

- [1. Yêu cầu](#1-yêu-cầu)
- [2. Cài đặt và build](#2-cài-đặt-và-build)
- [3. Cài skill cho agent](#3-cài-skill-cho-agent)
- [4. Khởi động canvas](#4-khởi-động-canvas)
- [5. Dùng qua hội thoại với agent](#5-dùng-qua-hội-thoại-với-agent)
- [6. Thao tác trên canvas](#6-thao-tác-trên-canvas)
- [7. Tham chiếu lệnh CLI](#7-tham-chiếu-lệnh-cli)
- [8. Chọn phần tử bằng Chỉnh sửa](#8-chọn-phần-tử-bằng-chỉnh-sửa)
- [9. Chụp ảnh, biến thể và snapshot](#9-chụp-ảnh-biến-thể-và-snapshot)
- [10. Dùng qua MCP](#10-dùng-qua-mcp)
- [11. Cấu trúc workspace](#11-cấu-trúc-workspace)
- [12. Xử lý sự cố](#12-xử-lý-sự-cố)

## 1. Yêu cầu

- Node.js phiên bản 22.12 trở lên.
- macOS cho bản nghiệm thu hiện tại (lệnh `--open` mở trình duyệt bằng `open`).
- Để chụp ảnh preview (`screenshot`) cần Playwright Chromium. Nếu chưa cài, lệnh chụp trả `BROWSER_NOT_INSTALLED` kèm hướng dẫn `npx playwright install chromium`.

## 2. Cài đặt và build

Từ thư mục mã nguồn của dự án:

```bash
npm install
npm run build
```

`npm run build` biên dịch canvas, đóng gói CLI + server, và tạo thư mục phát hành tại `dist/release/local-design-canvas`. Thư mục này tự chứa mọi thứ cần để chạy: CLI, server, asset canvas đã build, template, và runner `scripts/run.mjs`.

Chạy trực tiếp từ bản phát hành:

```bash
node dist/release/local-design-canvas/scripts/run.mjs start \
  --workspace /duong/dan/tuyet/doi/toi/design-workspace --open --json
```

`--workspace` trỏ tới nơi bạn muốn lưu các thiết kế. Nếu bỏ qua, CLI dùng thư mục làm việc hiện tại. `--open` mở canvas trong trình duyệt; `--json` in đúng một kết quả JSON ra stdout.

Canvas không dùng token: sau khi server chạy, bạn có thể mở thẳng `http://127.0.0.1:<port>/`. Lần đầu, Canvas hiện preview do chính phiên server này quản lý; bấm **Dùng preview này** để tải giao diện. Canvas nhớ lựa chọn cho các lần reload; dùng **Đổi preview** trên header khi cần chọn lại. `--open` vẫn truyền sẵn preview để mở thẳng vào canvas. API quản lý vẫn kiểm tra `Host`/`Origin`, nên một trang web khác không gọi được vào workspace của bạn.

## 3. Cài skill cho agent

Installer copy bản phát hành thành một skill tên `local-design-canvas` vào thư mục bạn chỉ định. Thư mục đích phải tồn tại sẵn, và installer từ chối ghi đè nếu skill đã có.

Với Codex:

```bash
mkdir -p ~/.codex/skills
node scripts/install-skill.mjs --target ~/.codex/skills
```

Với Claude Code:

```bash
mkdir -p ~/.claude/skills
node scripts/install-skill.mjs --target ~/.claude/skills
```

Sau khi cài, khởi động lại phiên agent. Claude Code có thể gọi bằng `/local-design-canvas`; Codex tự phát hiện `SKILL.md` theo cấu hình skill đang bật. Installer không thay đổi cấu hình của agent, không xóa workspace thiết kế khi bạn gỡ hoặc nâng cấp.

## 4. Khởi động canvas

Mỗi workspace có tối đa một server. Gọi `start` nhiều lần trên cùng workspace sẽ tái sử dụng đúng server đang chạy; nhiều workspace khác nhau chạy song song ở các cổng khác nhau.

```bash
# Bản phát hành trực tiếp
canvas='node /duong/dan/toi/local-design-canvas/scripts/run.mjs'
workspace='/duong/dan/toi/design workspace'

$canvas start --workspace "$workspace" --open --json
$canvas status --workspace "$workspace" --json
$canvas stop --workspace "$workspace" --json
```

`status` không tự tạo server; nó chỉ báo trạng thái. `stop` dừng server qua API có xác thực. Luôn truyền `--workspace` như một tham số shell duy nhất, kể cả khi đường dẫn có dấu cách hoặc Unicode.

## 5. Dùng qua hội thoại với agent

Đây là cách dùng chính. Bạn chỉ nói chuyện với agent, agent điều khiển CLI.

Ví dụ prompt:

> Thiết kế ba màn hình quản lý bán hàng: Tổng quan, Đơn hàng, Chi tiết đơn hàng.

Agent sẽ:

1. Đọc `status`, nếu chưa chạy thì `start --open` để bạn thấy canvas.
2. Tạo project và các màn hình còn thiếu qua CLI.
3. Viết HTML/CSS vào file `index.html` và `styles.css` mà lệnh `screen add` trả về, giữ typography/khoảng cách/màu nhất quán giữa các màn bằng cách đặt token dùng chung trong `design-system.css`.
4. Canvas hiển thị các màn hình cạnh nhau và tự cập nhật khi file thay đổi. Agent tự chụp `screenshot` từng màn để soi lại bố cục và tinh chỉnh.

Đây là luồng thiết kế mới nhiều màn. Nếu thay vì thiết kế từ đầu, bạn muốn clone một trang có sẵn, xem mục [9. Chụp ảnh...](#9-chụp-ảnh-biến-thể-và-snapshot) phần "Clone một trang UI".

Sau đó bạn tiếp tục yêu cầu chỉnh sửa qua hội thoại, ví dụ “đổi sidebar của Tổng quan sang nền tối”. Agent chỉ sửa màn hình liên quan; preview cập nhật mà không làm mất vị trí hay mức zoom của canvas.

Khi bạn bấm một màn hình trên sidebar hoặc trên khung canvas rồi nói “sửa màn hình này”, agent đọc lệnh `screen focus` và biết đúng màn hình đang được tô sáng. Agent không tự nhìn canvas; nó hỏi runtime tại lúc bạn gửi prompt. Trong lúc sửa, agent gọi `screen edit start` để canvas hiện lớp “Đang chỉnh sửa” và tạm khóa tương tác/chọn phần tử trên khung đó; xong thì `screen edit done` để bạn thao tác lại. Chọn phần tử bên trong bằng nút **Chỉnh sửa** chi tiết hơn và dùng `selection get`.

Agent không tự sửa `project.json` hay thư mục `.local-canvas/` — đó là metadata do server quản lý.

## 6. Thao tác trên canvas

Trên giao diện canvas trong trình duyệt:

- Bấm một khung màn hình để chọn. Trên header có nút **Preview** để ẩn/hiện bộ chọn kích thước: Mobile (390), Tablet (768), Máy tính (1280). Chọn một mức sẽ đổi chiều ngang khung đang chọn. Bấm nền canvas trống, bấm lại tên màn trên sidebar, hoặc nhấn `Escape` để bỏ chọn.
- **Chọn nhiều màn hình** — dùng một trong ba cách:
  1. **Kéo một vùng chọn** trên nền canvas trống: khung nào vùng kéo chạm vào sẽ được chọn. Giữ `Cmd`/`Ctrl` khi kéo để **cộng thêm** vào lựa chọn hiện có, thay vì thay thế.
  2. **`Shift`/`Cmd`/`Ctrl` + click** vào khung hoặc tên màn trên sidebar để thêm/bỏ từng màn.
  3. Bấm một khung rồi kéo **thanh tiêu đề** của nó: toàn bộ nhóm đang chọn di chuyển cùng nhau.

  Khi chọn từ 2 màn trở lên, header hiện kèm số màn đang chọn. Lựa chọn chỉ tồn tại trong phiên trình duyệt; chỉ vị trí/kích thước sau khi kéo được lưu.
- **Tạo prototype**: chọn ít nhất hai màn hình rồi bấm **Tạo prototype** để copy prompt. Dán prompt vào Codex; skill sẽ phân tích các điểm bấm, lưu prototype có ID riêng và Canvas hiện nút **Play**. Prototype dùng trực tiếp UI gốc, không nhân bản màn hình. Nếu UI gốc đổi, Play vẫn hiện UI mới và các liên kết cũ; Canvas báo **Cần tạo lại**. Bấm **Copy prompt tạo lại** và dán vào Codex khi bạn muốn AI tính lại luồng cho đúng prototype ID. Nút trong Canvas không tự gọi AI.
- **Pan**: giữ `Shift` và kéo, hoặc dùng bánh xe/trackpad. **Zoom**: `Ctrl`/`Cmd` + cuộn, hoặc nút `+` / `−`. **Fit all** đưa toàn bộ màn hình vào khung nhìn.
- Hai chế độ ở góc trên bên phải:
  - **Arrange**: kéo thanh tiêu đề để di chuyển khung, kéo góc để đổi kích thước viewport của màn hình. Vị trí/kích thước được lưu qua server.
  - **Interact**: click và nhập liệu bên trong preview. Khung không cuộn như một cửa sổ trình duyệt; cả trang nằm trong artboard.
- **Chỉnh sửa phần tử**: khi đang ở Arrange và đã chọn một màn hình, bấm nút **Chỉnh sửa** nổi trên canvas. Nút hiển thị **Đang bật chọn…** trong lúc chuẩn bị; sau đó click phần tử để lấy ngữ cảnh cho agent (xem mục 8). Bấm **Thoát chỉnh sửa** để quay lại Arrange. Không có nút Select riêng.
- Ô **Width/Height** ở header đặt kích thước tối thiểu của màn hình. Chiều rộng là viewport CSS thật. Nếu trang dài hơn chiều cao đã đặt, khung giãn thêm để hiện toàn bộ nội dung, giống artboard trên Figma; zoom canvas chỉ đổi cách nhìn. **Fit all** đưa mọi khung vào vùng nhìn.
- Trạng thái lưu (Saved / Saving / Unsaved) và trạng thái kết nối hiển thị ở header. Khi mất kết nối, canvas báo đang kết nối lại và không giả vờ đã lưu.

## 7. Tham chiếu lệnh CLI

Mọi lệnh nhận `--workspace <path>` và `--json`. Ở chế độ `--json`, stdout chỉ chứa một kết quả `{ "ok": true, "data": ... }` (exit 0) hoặc `{ "ok": false, "error": { "code", "message" } }` (exit 1). Log ghi vào stderr.

| Mục đích | Lệnh |
| --- | --- |
| Xem trạng thái runtime | `$canvas status --workspace "$workspace" --json` |
| Khởi động và mở canvas | `$canvas start --workspace "$workspace" --open --json` |
| Dừng runtime | `$canvas stop --workspace "$workspace" --json` |
| Liệt kê project | `$canvas project list --workspace "$workspace" --json` |
| Tạo project | `$canvas project create shop-dashboard --name 'Quản lý bán hàng' --workspace "$workspace" --json` |
| Liệt kê màn hình | `$canvas screen list --project shop-dashboard --workspace "$workspace" --json` |
| Thêm màn hình | `$canvas screen add overview --project shop-dashboard --name 'Tổng quan' --width 1440 --height 1000 --workspace "$workspace" --json` |
| Di chuyển / đổi kích thước khung | `$canvas screen update overview --project shop-dashboard --x 1600 --y 0 --width 1280 --height 900 --workspace "$workspace" --json` |
| Nhân bản màn hình | `$canvas screen duplicate overview --new-id overview-alt --project shop-dashboard --workspace "$workspace" --json` |
| Chụp ảnh preview | `$canvas screenshot overview --project shop-dashboard --workspace "$workspace" --json` |
| Tạo / khôi phục snapshot | `$canvas snapshot create --project shop-dashboard --workspace "$workspace" --json` / `$canvas snapshot restore <snapshot-id> --project shop-dashboard --workspace "$workspace" --json` |
| Đọc màn hình đang được chọn trên canvas | `$canvas screen focus --project shop-dashboard --workspace "$workspace" --json` |
| Khóa màn hình khi agent đang sửa | `$canvas screen edit start --project shop-dashboard --screen overview --message 'Đang chỉnh sửa…' --workspace "$workspace" --json` |
| Mở khóa sau khi sửa xong | `$canvas screen edit done --project shop-dashboard --workspace "$workspace" --json` |
| Đọc phần tử đang chọn | `$canvas selection get --project shop-dashboard --workspace "$workspace" --json` |
| Liệt kê prototype | `$canvas prototype list --project shop-dashboard --workspace "$workspace" --json` |
| Đọc prototype theo ID | `$canvas prototype get booking --project shop-dashboard --workspace "$workspace" --json` |
| Đọc dấu vân tay nguồn | `$canvas prototype sources --project shop-dashboard --screens home,detail --workspace "$workspace" --json` |
| Tạo hoặc tạo lại prototype | `$canvas prototype create booking --project shop-dashboard --input prototype.json --workspace "$workspace" --json` / `$canvas prototype regenerate booking --project shop-dashboard --input regeneration.json --workspace "$workspace" --json` |
| Lấy một trang web làm tham chiếu | `$canvas reference fetch 'https://example.com/page' --project shop-dashboard --workspace "$workspace" --json` |
| Chạy MCP qua stdio | `$canvas mcp serve --workspace "$workspace"` |

Lưu ý:

- ID project và màn hình là slug ASCII chữ thường, chữ số và dấu gạch ngang; tên hiển thị cho phép Unicode.
- `screen add` trả `data.entryPath` là đường dẫn tuyệt đối tới `index.html` cần sửa; `styles.css` nằm cùng thư mục. Mỗi project có `design-system.css` cho token dùng chung.
- Chiều rộng/cao là số nguyên từ 240 đến 4096.
- Gặp `REVISION_CONFLICT`: đọc lại project hoặc danh sách màn hình rồi thử lại đúng thao tác. Gặp `SERVER_NOT_RUNNING`: chạy `start`.

## 8. Chọn phần tử bằng Chỉnh sửa

Khi bạn muốn nói “sửa phần tử này” mà không cần mô tả dài:

1. Chọn một màn hình trên canvas, rồi bấm **Chỉnh sửa**.
2. Đợi nút đổi thành **Thoát chỉnh sửa**; preview đã sẵn sàng nhận lựa chọn.
3. Click phần tử trong màn hình. Canvas tô sáng phần tử, tự sao chép `data-design-id` vào clipboard và hiện ID phía trên để bạn có thể bấm **Sao chép lại**.
4. Dán ID vào prompt, ví dụ: “đổi nền phần tử `overview-el-3` thành màu xanh”. Bạn cũng có thể nói “đổi nút đang chọn”; trường hợp đó agent đọc ngữ cảnh bằng:

   ```bash
   $canvas selection get --project shop-dashboard --workspace "$workspace" --json
   ```

Kết quả trả về `{ context, stale }`. `context` gồm `screenId`, `selector`, `elementId`, `text` và `bounds`. Khi prompt nêu ID cụ thể, agent tìm `data-design-id` đó trong HTML nguồn của project và chỉ sửa màn hình chứa nó; không cần giữ phần tử đó đang được chọn trên canvas.

Nếu `stale` là `true`, nghĩa là nguồn của màn hình đã thay đổi sau lần click, nên lựa chọn cũ không còn đáng tin — hãy chọn lại hoặc đọc lại nguồn trước khi sửa. Highlight trên canvas cũng chuyển sang màu cam để báo stale.

Khi bật **Chỉnh sửa**, Canvas bổ sung `data-design-id` vào các thẻ trong phần thân HTML nguồn của màn hình nếu chúng chưa có ID. ID đã có sẽ được giữ nguyên; ID mới tồn tại qua lần tải lại và khởi động lại server. Phần tử được tạo động bằng JavaScript cần được gắn `data-design-id` ngay trong mã tạo phần tử nếu bạn muốn nhắc lại ID đó về sau. Bridge chọn phần tử được inject vào preview, không ghi vào file nguồn; mỗi frame có một nonce riêng nên message giả từ nguồn khác bị từ chối.

## 9. Chụp ảnh, biến thể và snapshot

**Chụp ảnh preview** để kiểm tra trực quan hoặc để agent tự sửa lỗi render:

```bash
$canvas screenshot overview --project shop-dashboard --workspace "$workspace" --json
```

Trả về đường dẫn PNG, kích thước và danh sách lỗi (console, page, resource) lưu trong `artifacts/captures` của project. Vòng lặp gợi ý: chụp → agent đọc ảnh và lỗi → sửa → chụp lại; nên dừng sau ba vòng và báo phần chưa đạt.

**Nhân bản** một màn hình thành biến thể có ID và đường dẫn riêng, vẫn dùng chung token:

```bash
$canvas screen duplicate overview --new-id overview-alt --project shop-dashboard --workspace "$workspace" --json
```

**Snapshot** trước khi làm thay đổi rủi ro, và khôi phục khi cần:

```bash
$canvas snapshot create --project shop-dashboard --workspace "$workspace" --json
$canvas snapshot restore <snapshot-id> --project shop-dashboard --workspace "$workspace" --json
```

`snapshot create` lưu manifest, HTML/CSS và assets (loại runtime, snapshot lồng nhau và artifacts). Nếu file đang thay đổi, lệnh thử lại và có thể trả `PROJECT_BUSY`. `snapshot restore` tự tạo một snapshot backup của trạng thái hiện tại trước khi thay nguồn, và trả `backupSnapshotId`.

**Tham chiếu một trang web** khi bạn muốn dựng thiết kế tương tự một trang có sẵn (kể cả trang cần JavaScript để hiển thị):

```bash
$canvas reference fetch 'https://example.com/page' --project shop-dashboard --workspace "$workspace" --json
```

Lệnh mở URL bằng trình duyệt headless **ngay trên máy bạn**, chờ trang render, rồi lưu vào `artifacts/references` của project: tiêu đề, các heading, đoạn text theo section, danh sách link (file `.json`) và một ảnh chụp full-page (`.png`). Agent đọc kết quả này để hiểu bố cục rồi tự viết HTML/CSS tĩnh của riêng mình.

Lưu ý:

- Lệnh sẽ mở đúng URL bạn đưa vào, kể cả địa chỉ nội bộ (`localhost`, LAN). Vì công cụ chạy local trên máy bạn nên đây là hành vi có chủ đích; agent nên xác nhận URL với bạn trước khi fetch.
- Cần Playwright Chromium; thiếu thì trả `BROWSER_NOT_INSTALLED`.

**Clone một trang UI**: khi bạn yêu cầu "clone trang này", agent làm việc dựa trên ảnh full-page mà `reference fetch` lưu lại — xem ảnh như bản mẫu và dựng lại HTML/CSS bám sát bố cục, khoảng cách, màu và font, rồi lặp `screenshot` → so với ảnh gốc → chỉnh cho khớp. Ranh giới: sao chép giao diện để học tập/thiết kế nội bộ thì được, nhưng thay ảnh và nội dung có bản quyền của trang gốc bằng placeholder hoặc nội dung của bạn; kết quả luôn là file tĩnh cục bộ, không phụ thuộc CDN.

## 10. Dùng qua MCP

MCP là cách thay thế cho CLI, nói giao thức Model Context Protocol qua stdio để host (Claude Code, Codex, v.v.) gọi tool trực tiếp.

```bash
$canvas mcp serve --workspace "$workspace"
```

stdout dành riêng cho giao thức, log ra stderr. Adapter khởi động hoặc kết nối đúng runtime theo workspace, dùng chung API với CLI. Các tool sẵn có:

- `canvas_status` — báo runtime có đang chạy không.
- `project_list`, `project_create`.
- `screen_list`, `screen_add`.
- `screen_capture` — chụp ảnh preview kèm lỗi render.
- `reference_fetch` — mở một URL và trích nội dung + ảnh full-page làm tham chiếu thiết kế.
- `screen_focus` — đọc màn hình đang được tô sáng trên canvas.
- `screen_edit_start` / `screen_edit_done` — khóa/mở khóa khung đang chỉnh sửa.
- `selection_get` — đọc phần tử đang chọn kèm cờ `stale`.

Ví dụ cấu hình một MCP server trong host hỗ trợ file cấu hình MCP:

```json
{
  "mcpServers": {
    "local-design-canvas": {
      "command": "node",
      "args": [
        "/duong/dan/toi/local-design-canvas/scripts/run.mjs",
        "mcp", "serve",
        "--workspace", "/duong/dan/toi/design-workspace"
      ]
    }
  }
}
```

CLI và MCP là hai cửa vào cùng một ứng dụng. Nếu không cần MCP, bạn vẫn dùng skill + CLI như bình thường.

## 11. Cấu trúc workspace

```text
design-workspace/
  .local-canvas/
    runtime.json        # PID, cổng, instance ID — không đưa vào Git
    server.log          # Log chẩn đoán local
  projects/
    shop-dashboard/
      project.json       # Metadata do server quản lý: ID, revision, màn hình, bố cục
      design-system.css  # Token dùng chung
      screens/
        overview/
          index.html
          styles.css
          script.js       # Không bắt buộc
      assets/
      snapshots/          # Các phiên bản đã lưu
      artifacts/          # Ảnh chụp, chẩn đoán render
```

Bạn (hoặc agent) sửa file trong `screens/`, `assets/`, `design-system.css`. Không sửa tay `project.json` hay `.local-canvas/`. Skill và runtime nằm trong gói ứng dụng, không nằm trong workspace, nên nâng cấp ứng dụng không đụng tới thiết kế.

## 12. Xử lý sự cố

- **`SERVER_NOT_RUNNING`**: chạy `start` cho workspace đó trước khi gọi lệnh project/screen.
- **`REVISION_CONFLICT`**: có thay đổi song song. Đọc lại project rồi thử lại đúng thao tác.
- **`BROWSER_NOT_INSTALLED`** khi chụp ảnh: chạy `npx playwright install chromium`.
- **`PORT_IN_USE`**: chỉ xảy ra khi bạn tự chỉ định `--port` và cổng đó đang bận; bỏ `--port` để hệ điều hành tự cấp cổng.
- **Canvas báo mất kết nối**: server đã dừng hoặc đổi cổng. Chạy lại `start` rồi mở lại URL trong `runtime.json`. Dữ liệu đã lưu vẫn còn.
- **Selection báo `stale`**: nguồn màn hình đã đổi sau lần click; chọn lại phần tử.
- Xem log tại `.local-canvas/server.log` trong workspace khi cần chẩn đoán sâu hơn.

## Kiểm tra nhanh (cho người phát triển)

```bash
npm run typecheck
npm test
npm run test:e2e
```
