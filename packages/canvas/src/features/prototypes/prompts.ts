export function createPrototypePrompt(projectId: string, screenIds: string[]): string {
  return `Dùng skill local-design-canvas để tạo prototype cho các màn hình tôi đã chọn.
projectId: ${projectId}
screenIds: ${screenIds.join(', ')}

Hãy đọc nguồn giao diện hiện tại và kiểm tra các data-design-id cần làm điểm bấm. Chọn một prototype ID dạng slug chưa tồn tại trong project; suy luận luồng từ nội dung UI, không theo thứ tự chọn. Đọc prototype sources trước và sau khi phân tích, rồi dùng prototype create với expectedSourceBaseline để lưu các transition. Không sao chép màn hình hay sửa điều hướng thường chỉ để tạo prototype. Báo ID đã tạo, các liên kết và chỗ chưa chắc chắn để tôi có thể bấm Play trong Canvas.`;
}

export function regeneratePrototypePrompt(projectId: string, prototypeId: string, screenIds: string[]): string {
  return `Dùng skill local-design-canvas để tạo lại prototype từ giao diện hiện tại.
projectId: ${projectId}
prototypeId: ${prototypeId}
screenIds: ${screenIds.join(', ')}

Đọc prototype get theo đúng projectId/prototypeId, kiểm tra nguồn và data-design-id hiện tại, suy luận lại toàn bộ liên kết. Đọc prototype sources trước và sau khi phân tích; dùng prototype regenerate với expectedRevision và expectedSourceBaseline. Giữ nguyên prototype ID, không tạo bản sao. Báo các thay đổi và liên kết không chắc chắn; tôi sẽ kiểm tra lại bằng Play.`;
}
