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

### Bổ sung sau review Phase 0
- Đã nạp Tailwind cho popup/options (`src/*/index.css` + `import "./index.css"`). Build ra `dist/assets/index-*.css`.
- Thêm `scripts/verify-dist.mjs`, chạy tự động cuối `pnpm run build`. Script kiểm tra:
  - (1) Content script MAIN world (`yt-hook`) phải là file tự chứa, không có `import`/`chrome.runtime`. Nếu sau này CRXJS đổi sang kiểu loader thì build sẽ báo lỗi ngay. Khi đó chuyển sang phương án dự phòng: build riêng IIFE bằng `vite.hook.config.ts`.
  - (2) Phải có file CSS.
- Kết quả: CRXJS 2.7.1 build `yt-hook` ra IIFE `(function(){...})()`, chạy đồng bộ ở `document_start`. Đạt.
- Đã ghim `@crxjs/vite-plugin` ở `^2.7.1` và đặt `version` = `0.1.0`.
- Log của content script và SW chỉ bật trong bản dev (`import.meta.env.DEV`). Log của `yt-hook` tạm giữ cả ở bản build để xác nhận thủ công; sẽ tắt ở Phase 11.
- Lưu ý: CRXJS tự sinh `web_accessible_resources` cho các file content script với `matches` `<all_urls>`. Vì vậy trang web có thể phát hiện extension đang cài. Dùng cá nhân thì chấp nhận được; nếu đưa lên Store thì xem lại (R9).

### Cần xác nhận thủ công (Load unpacked từ `dist/`)
- [ ] Popup có màu nền tối, tiêu đề màu amber (tức là Tailwind đã chạy).
- [ ] Trên `youtube.com/watch`, console của trang có dòng `[SubTrans] YT hook loaded in MAIN world`, và dòng này xuất hiện trước các log của YouTube.
- [ ] Gõ `fetch.toString()` trong console vẫn ra `function fetch() { [native code] }`. Đây là mốc so sánh cho Phase 5: sau khi hook patch `fetch`, kết quả sẽ khác.
- [ ] Chạy Mục 3.3 trên Windows: `go list ./... | Select-String extension` rỗng, `go test ./...` đạt, `cd frontend; pnpm run build` đạt.

---

## Phase 4: Overlay và adapter HTML5 `<track>`

### Đã làm
- `content/videoDetector.ts`: chọn `<video>` lớn nhất (≥ 200×120, có nguồn phát). Khi chưa tìm thấy: dùng MutationObserver (debounce 500ms) và quét lại mỗi 3s. Khi đã tìm thấy: ngắt observer, chỉ kiểm tra `isConnected` mỗi 2s.
- `content/adapters/html5.ts`: chọn track `subtitles`/`captions`, ưu tiên tiếng Anh, bỏ qua track "SubTrans". Đặt `mode = "hidden"` để trình duyệt không vẽ phụ đề gốc, và khôi phục khi dispose. Chờ cue tối đa 10s. Nếu track khác origin thì tải qua `fetchText` của background. Có `onCuesChanged` cho player nạp cue dần.
- `content/overlay/*`:
  - Shadow DOM gắn vào host `<subtrans-overlay>`, style inline `!important`, hỗ trợ 2 chế độ `fixed` và `container`.
  - Fullscreen: nếu fullscreen là khung bọc thì chuyển host vào trong khung đó; nếu fullscreen chính thẻ `<video>` thì bật `NativeTrackFallback` (dùng VTTCue).
  - Port JSX và thuật toán kéo thả từ `App.tsx`. Vị trí lưu ở `chrome.storage.local` với key `overlayPos:<hostname>`.
  - Chấm chỉ báo engine theo từng dòng.
- `content/pipeline/session.ts`: hiển thị dòng EN theo `currentTime`. Vòng rAF chỉ chạy khi video đang phát và tab đang hiện; chỉ cập nhật store khi dòng hiện tại đổi.
- `content/port.ts`: chỉ kết nối khi có request đầu tiên. Tự kết nối lại theo 250ms → 1s → 3s và gửi lại các request đang chờ. Timeout 30s. Gặp "context invalidated" thì dừng hẳn.
- `shared/disposer.ts`: dọn dẹp tài nguyên bằng `AbortController` cộng một danh sách cleanup (theo quy tắc ở Phase 6).
- `settings.ts`: thêm `loadSettings({ includeApiKey: false })`. Content script **không** đọc API key.
- `postcss.config.js`: plugin đổi rem→px (×16), **chỉ** áp cho file trong `src/content/overlay/`. Đã kiểm tra bundle overlay không còn `rem`. Các inline style trong TSX đã đổi sang px bằng tay.
- `dev/test-page.html`: một `<video>` kèm `<track>` VTT 20 cue nhúng bằng `data:` URL, có nút fullscreen khung bọc và checkbox bật CSS cực đoan.

### Lưu ý build
- Content script ISOLATED world giờ có import (React, …), nên CRXJS build ra dạng **loader** (`index.ts-loader-*.js` + `web_accessible_resources`). Ở ISOLATED world thì không sao. `verify-dist` vẫn chỉ ràng buộc script MAIN world (`yt-hook`), và vẫn báo OK.
- Bundle content khoảng 42KB, cộng React khoảng 142KB (dùng chung với popup).

### Cần xác nhận thủ công (Load unpacked từ `dist/`, mở `dev/test-page.html`)
- [ ] Bật "Allow access to file URLs" cho extension, mở `dev/test-page.html` và chọn một file video.
- [ ] Bấm play: phụ đề EN hiện trong hộp tối, viền mảnh, đúng thời điểm (mỗi cue 3s). **Không** hiện phụ đề gốc của trình duyệt.
- [ ] Kéo phụ đề lên góc trên rồi F5: vị trí được giữ. Nhấp đúp: về đáy, có toast. Nhấp đúp **không** làm video fullscreen hoặc pause.
- [ ] Bấm "Fullscreen khung bọc": overlay vẫn hiện và kéo được.
- [ ] Bấm nút fullscreen trên thanh điều khiển của video: phụ đề hiện bằng track gốc ("SubTrans"). Thoát fullscreen: overlay hiện lại, không bị 2 lớp phụ đề.
- [ ] Bật "CSS cực đoan": hộp phụ đề không đổi giao diện.
- [ ] Bật "khoảng trống để cuộn" rồi cuộn trang: overlay bám theo video.
- [ ] Popup/Options: đổi `subtitleMode`/`style` (Phase 7) thì overlay đổi ngay. Hiện có thể thử bằng cách gõ `chrome.storage.local.set({settings:{subtitleMode:"off"}})` trong console của SW.
- [ ] Tắt extension trên host (`disabledHosts`) thì overlay biến mất.
