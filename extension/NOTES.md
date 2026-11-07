# SubTrans Extension — Ghi chú kỹ thuật & Kết quả thử nghiệm

Tài liệu này ghi lại kết quả của các mục đánh dấu **[T] (cần thử nghiệm)** trong `PLAN.md`.

---

## Phase 0: Thử nghiệm CRXJS với content script `world: "MAIN"`
- **Mục tiêu**: Kiểm tra xem `@crxjs/vite-plugin` (v2.7.1) có hỗ trợ khai báo content script với `world: "MAIN"` trong `manifest.config.ts` hay không.
- **Kết quả**: **Thành công (PASS)**.
- **Chi tiết**:
  - `dist/manifest.json` xuất ra đúng cấu trúc:
    ```json
    {
      "js": ["assets/yt-hook.ts-NaFRTsQh.js"],
      "matches": ["https://www.youtube.com/*"],
      "run_at": "document_start",
      "world": "MAIN"
    }
    ```
  - Không cần dùng phương án dự phòng (build riêng file IIFE bằng vite config độc lập).
  - Go tooling (`go list ./... | Select-String extension`) hoàn toàn không bị ảnh hưởng bởi thư mục `extension/node_modules/`. Không cần tạo `extension/go.mod`.
