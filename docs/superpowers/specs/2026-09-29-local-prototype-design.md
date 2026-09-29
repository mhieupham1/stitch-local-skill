# Local Design Canvas: prototype từ nhiều màn hình

## Mục tiêu và trải nghiệm

Người dùng chọn từ hai màn hình trở lên trong cùng project và bấm **Tạo prototype**. Canvas sao chép một prompt ghi rõ project ID và danh sách screen ID theo thứ tự đã chọn, đồng thời hiện nội dung prompt để tự sao chép nếu clipboard thất bại. Người dùng dán prompt vào Codex. Agent dùng skill `local-design-canvas` đọc nguồn các màn hình, tự suy luận các điểm bấm và màn hình đích, rồi lưu một prototype. Không tích hợp ô chat, model API hay tiến trình AI chạy ngầm trong Canvas.

Prototype xuất hiện như một mục riêng trong Canvas, không phải một `Screen` và không sao chép HTML/CSS/JS. Mục này có nút **Play** mở một trang chạy thử riêng. Trang chạy thử luôn dùng bản preview mới nhất của các màn hình gốc; bấm các điểm đã nối chuyển sang màn hình đích. Nếu UI gốc thay đổi, các liên kết cũ vẫn giữ nguyên và Canvas báo **Cần tạo lại**. Người dùng quyết định lúc nào tạo lại bằng cách copy prompt và gửi Codex; Canvas không tự chạy AI hay ghi đè liên kết. Người dùng cũng có thể nhắn Codex để sửa một liên kết cụ thể, đổi màn hình bắt đầu, hoặc thêm/bớt màn hình thuộc prototype.

Mỗi prototype có ID cố định để phân biệt khi một project có nhiều prototype. Canvas hiển thị và cho sao chép ID này; người dùng có thể nhắc tới nó trong prompt sửa prototype. Một prototype được xác định duy nhất bởi cặp `projectId/prototypeId`, ví dụ `cgv-home/movie-booking`.

Thành công khi một luồng gồm ba màn hình như `home` → `movie-detail` → `seat-selection` chạy được bằng các điểm bấm AI chọn, không sửa mã điều hướng trong ba màn hình gốc và vẫn phản ánh các sửa đổi giao diện sau đó.

## Quyết định thiết kế

- Dùng một tệp dữ liệu prototype tham chiếu màn hình gốc, thay vì sinh một màn hình HTML tổng hợp. Bản sao HTML sẽ phải đồng bộ khi giao diện gốc thay đổi.
- Agent suy luận liên kết từ cấu trúc, nhãn, href và ngữ cảnh giao diện. Runtime chỉ thực thi các liên kết đã lưu; không dùng thuật toán heuristic ở mỗi lần Play. Điều này cho phép người dùng sửa kết quả bằng prompt và giữ kết quả ổn định.
- Mỗi lần tạo/tạo lại, server ghi dấu vân tay nguồn mà agent đã dùng. Khi nguồn đổi, Play vẫn dùng UI mới nhưng không tự sửa liên kết; trạng thái stale chỉ được xóa sau một lần tạo lại có chủ đích. Một yêu cầu sửa lẻ hoặc đổi tên prototype không tự đánh dấu luồng đã được tạo lại.
- Chỉ hỗ trợ sự kiện `click` trong phiên bản đầu. Các thao tác chưa được nối vẫn có thể dùng tương tác tại chỗ nếu không điều hướng ra ngoài prototype; không tự đoán đích khi đang Play.
- Không coi thứ tự chọn màn hình là thứ tự tuyến tính bắt buộc. Agent chọn màn hình bắt đầu và các nhánh dựa trên nội dung, ưu tiên màn hình kiểu trang chủ khi có. Prompt ghi đúng tập màn hình đã chọn; prototype không được trỏ tới màn hình ngoài tập đó.

## Dữ liệu và lưu trữ

Lưu mỗi prototype tại `projects/<project-id>/prototypes/<prototype-id>.json`, độc lập với `project.json`. Schema ban đầu:

```json
{
  "schemaVersion": 1,
  "revision": 0,
  "id": "movie-booking",
  "name": "Đặt vé xem phim",
  "screenIds": ["home", "movie-detail", "seat-selection"],
  "startScreenId": "home",
  "sourceBaseline": {
    "home": "hash-of-source-at-generation",
    "movie-detail": "hash-of-source-at-generation",
    "seat-selection": "hash-of-source-at-generation"
  },
  "transitions": [
    { "fromScreenId": "home", "elementId": "home-el-12", "toScreenId": "movie-detail" }
  ]
}
```

`id` của prototype là slug ổn định, duy nhất trong project, chẳng hạn `movie-booking`; cùng slug ở project khác vẫn hợp lệ. Tên hiển thị được đổi mà không đổi ID. `elementId` là giá trị `data-design-id` trong màn hình nguồn, không phải CSS selector hoặc UUID được tạo lúc Play. Mỗi cặp `(fromScreenId, elementId)` chỉ có một đích; tất cả screen ID phải tồn tại trong project và thuộc `screenIds`. Tên/ID hợp lệ, đường dẫn tệp, kích thước dữ liệu và số liên kết đều được giới hạn/kiểm tra tại server. Ghi tệp nguyên tử và từ chối dữ liệu không hợp lệ. Không sửa trực tiếp `project.json` hoặc mã nguồn màn hình khi tạo prototype; nếu một điểm bấm thiếu ID, agent chỉ bổ sung `data-design-id` tại đúng phần tử nguồn cần nối rồi kiểm tra lại.

`sourceBaseline` do server xác nhận khi agent tạo/tạo lại prototype, không phải sao chép nội dung UI. Dấu vân tay của một màn hình bao gồm tệp trong thư mục màn hình và nguồn dùng chung ở cấp project (`design-system.css`, `shared/`, `assets/`); thay đổi nguồn dùng chung có thể bảo thủ đánh dấu nhiều prototype cần tạo lại. Thay đổi một màn hình không thuộc prototype không làm prototype đó stale. Nếu nguồn đổi trong lúc agent đang phân tích, server từ chối ghi baseline cũ và yêu cầu agent đọc lại.

## Giao diện Canvas và player

- Nút **Tạo prototype** chỉ hiện khi chọn ít nhất hai màn hình. Nhấn nút tạo prompt thuần văn bản, cố sao chép vào clipboard và hiện thông báo thành công/thất bại cùng nút sao chép lại. Nó chưa tạo prototype rỗng.
- Canvas tải danh sách prototype của project qua management API. Mỗi mục hiển thị tên, ID có thể sao chép, số màn hình, trạng thái nguồn và **Play**. Khi nguồn đổi, mục có nhãn **Cần tạo lại** và nút **Copy prompt tạo lại** chứa cả `projectId/prototypeId`; nút này chỉ copy prompt, không thay đổi prototype. Không đưa prototype vào danh sách `screens`, không cho kéo/resize như màn hình thiết kế.
- Play mở một tab mới trên management origin, với project/prototype ID trong URL. Player tải metadata và preview URL của phiên Canvas, hiển thị iframe của màn hình hiện tại ở kích thước screen tương ứng, cùng tên màn hình, Back, Restart và Exit. Mở trực tiếp URL hoặc reload vẫn chạy được.
- Player gửi danh sách `elementId` có liên kết của màn hình hiện tại cho preview bridge cùng token/nonce phiên. Bridge tìm phần tử gần nhất trong đường tổ tiên của mục tiêu click có ID nằm trong danh sách đó, **chặn điều hướng gốc ngay trong iframe**, rồi gửi ID lên player. Player kiểm tra origin, `event.source`, project/screen và token trước khi đối chiếu ID với `transitions` và chuyển iframe sang màn hình đích. Click chưa nối không chuyển màn hình; thao tác tại chỗ vẫn dùng được, còn liên kết điều hướng chưa nối bị giữ lại trong prototype và có thể báo “Chưa nối điểm bấm”. Không cho iframe tự điều hướng ra ngoài tập màn hình.
- Player hiển thị cảnh báo stale nhưng vẫn cho Play với UI mới và liên kết cũ. Player hiển thị lỗi rõ ràng nếu prototype bị xóa, màn hình đích không còn, preview không sẵn sàng hoặc điểm bấm được nối không còn trong DOM. Các liên kết hỏng không làm mất những liên kết khác. Khi ID của phần tử bị đổi/xóa, người dùng có thể copy prompt tạo lại hoặc nhắn Codex sửa liên kết đó; runtime không tự gắn lại sang phần tử khác.

## Agent, API và CLI

- Management API cung cấp list/get/create/update/delete prototype, trả lỗi có mã cho dữ liệu sai hoặc xung đột ID. Tệp có `revision`; cập nhật/xóa yêu cầu revision dự kiến để tránh ghi đè một chỉnh sửa khác. List/get trả thêm trạng thái stale bằng cách so `sourceBaseline` với dấu vân tay hiện tại. Thao tác tạo lại là một cập nhật tường minh thay toàn bộ transitions và baseline; chỉnh sửa lẻ không cập nhật baseline. Server kiểm tra cấu trúc ID và màn hình đích, nhưng không bắt buộc ID phần tử phải còn trong DOM tại lúc ghi: điều này cho phép báo và sửa liên kết cũ sau khi nguồn thay đổi. Server phát sự kiện `prototype.updated` để Canvas làm mới danh sách; watcher làm mới trạng thái stale khi nguồn đổi và không phát nhầm `project.error` khi xóa prototype.
- CLI (và MCP adapter nếu cùng thao tác có thể được gọi qua MCP) cung cấp lệnh đọc/list/tạo/cập nhật/tạo lại/xóa prototype bằng `projectId` và `prototypeId`. Agent dùng lệnh này, không sửa tệp metadata bằng tay. Skill thêm workflow: đọc prompt đã dán, xác nhận đúng project/màn hình, kiểm tra nguồn và `data-design-id`, suy luận các liên kết có bằng chứng rõ, lưu qua CLI, chạy kiểm tra và báo các điểm không chắc chắn. Lệnh tạo lại đọc UI hiện tại, tính lại toàn bộ luồng, rồi cập nhật cùng prototype ID; không tạo bản sao mới và không chạy tự động. Khi một project có nhiều prototype, agent yêu cầu ID nếu prompt sửa không xác định được duy nhất prototype cần thay đổi. Prompt sửa lẻ chỉ thay đổi những liên kết người dùng yêu cầu và không xóa cảnh báo stale.
- Không gọi model từ server. Khi người dùng bấm nút, Canvas chỉ chuẩn bị ngữ cảnh để Codex xử lý sau khi người dùng paste prompt.

## Kiểm thử và ranh giới

- Unit: schema, ID prototype duy nhất trong project, quy tắc unique liên kết, prompt chứa đúng project và danh sách screen ID, không phụ thuộc tên hiển thị.
- Integration: API/CLI create/update/regenerate/delete, revision/source conflict, screen ID không thuộc project, element ID rỗng/trùng, đọc tệp hỏng, watcher và thao tác trên nhiều project; sửa màn hình ngoài tập không làm stale, sửa tệp dùng chung có làm stale.
- E2E: chọn nhiều màn hình → copy prompt; tạo prototype bằng CLI → mục Play xuất hiện; click hotspot trong player chuyển đúng màn hình; Back/Restart; reload; sửa HTML/CSS gốc làm hiện UI mới và cảnh báo stale nhưng không tự đổi liên kết; copy prompt tạo lại chứa đúng prototype ID; tạo lại xóa cảnh báo; ID không còn thì báo lỗi không chuyển nhầm.
- Chưa làm hotspot editor kéo-thả, animation giữa màn hình, xuất bản ra Internet, chia sẻ URL ngoài localhost, hay mô phỏng dữ liệu/backend của ứng dụng thật.
