# SubTrans – Tiện ích Phụ đề Song ngữ Thông minh (Chrome Extension Manifest V3)

**SubTrans Extension** là tiện ích mở rộng dành cho các trình duyệt Chromium (Google Chrome, Microsoft Edge, Brave, Cốc Cốc, Arc), giúp xem video kèm phụ đề song ngữ Anh – Việt theo thời gian thực trực tiếp trên trình duyệt web mà không cần cài đặt Python, FFmpeg hay các phần mềm nặng nề.

Tiện ích được tối ưu hóa đặc biệt cho **video bài giảng lập trình, công nghệ và khoa học máy tính**, giữ nguyên chính xác các thuật ngữ chuyên ngành (framework, API, biến, hàm, kiến trúc...).

---

## 🚀 Tính năng nổi bật

- **3 Chế độ dịch linh hoạt:**
  - `google` (Google Translate): Hoàn toàn miễn phí, không cần cấu hình API key, phản hồi tức thì (< 2s).
  - `gemini` (Google Gemini AI): Sử dụng Gemini 2.5 Flash / 1.5 Flash dịch chuẩn văn phong kỹ thuật, tự động nhận diện và giữ nguyên thuật ngữ code.
  - `hybrid` (Khuyên dùng): Kết hợp sức mạnh của cả hai — Google Translate dịch nhanh câu đang phát, Gemini nâng cấp bản dịch chất lượng cao và dịch trước các câu tiếp theo ở chế độ nền.
- **Hỗ trợ đa nền tảng:**
  - **YouTube:** Hỗ trợ mọi video, cả phụ đề thủ công lẫn phụ đề tạo tự động (Auto-generated CC). Hỗ trợ cả YouTube Embed trên các trang web bên thứ ba.
  - **Nền tảng khóa học:** Tương thích với Udemy, Coursera, Google Drive video và hầu hết trình phát HTML5 video có sẵn `<track>` phụ đề.
- **Nhập phụ đề ngoài:**
  - Hỗ trợ tải lên file phụ đề rời (`.srt`, `.vtt`, hoặc file song ngữ `_bilingual.srt`) cho bất kỳ video HTML5 nào trên web.
  - Tự động lưu nhớ phụ đề theo URL video.
- **Giao diện hiện đại & tiện ích:**
  - Hiển thị song ngữ (EN + VI) hoặc đơn ngữ (chỉ VI, chỉ EN).
  - Sử dụng **Shadow DOM** cô lập 100%, không bị ảnh hưởng bởi CSS/font chữ của trang web chủ.
  - Kéo thả tự do vị trí overlay trên video (kể cả khi xem chế độ Fullscreen).
  - **Mini Toolbar** nổi tích hợp ngay góc trên video: chỉnh độ trễ thời gian, đổi chế độ, nhập/xuất phụ đề nhanh.
- **Xuất phụ đề đa định dạng:**
  - Xuất ra 6 định dạng thông dụng: `.srt` song ngữ, `.srt` tiếng Việt, `.srt` tiếng Anh gốc, `.txt` đọc nhanh, `.json` dữ liệu thô, `.tsv` bảng tính.
- **Cơ chế chống lỗi & Tối ưu hiệu năng:**
  - **Circuit Breaker:** Tự động phát hiện khi Gemini gặp sự cố hoặc hết hạn ngạch (quota) để chuyển sang Google Translate mà không làm gián đoạn việc xem video.
  - **2-Tier Cache:** Lưu phụ đề trên IndexedDB và bộ nhớ RAM, xem lại video hoặc tải lại trang hiện phụ đề ngay lập tức (0 request dịch).
  - Content script siêu nhẹ (< 50MB RAM), không gây giật lag trình duyệt.

---

## 📋 Yêu cầu hệ thống

- **Node.js**: Phiên bản 18 trở lên (Khuyến nghị Node.js 20 hoặc 22 LTS).
- **Trình quản lý gói**: `pnpm` (khuyến nghị, phiên bản >= 8) hoặc `npm`.
- **Trình duyệt web**: Bất kỳ trình duyệt nào dùng nhân Chromium (Google Chrome, Microsoft Edge, Brave, Cốc Cốc, Vivaldi, Arc...).

---

## 🛠️ Hướng dẫn xây dựng (Build) & Đóng gói (Zip)

Mở terminal tại thư mục gốc của repository hoặc trong thư mục `extension`:

```bash
# 1. Đi vào thư mục extension
cd extension

# 2. Cài đặt các gói phụ thuộc
pnpm install

# 3. Kiểm tra kiểu TypeScript & Unit tests
pnpm run typecheck
pnpm run test

# 4. Build bản phân phối (tạo thư mục dist/)
pnpm run build

# 5. (Tùy chọn) Đóng gói thành file ZIP cài đặt (tạo release/subtrans-extension-v*.zip)
pnpm run zip
```

---

## 📥 Cách cài đặt vào trình duyệt (Load Unpacked)

1. Mở trình duyệt web của bạn và truy cập vào trang quản lý tiện ích:
   - **Google Chrome**: `chrome://extensions/`
   - **Microsoft Edge**: `edge://extensions/`
   - **Cốc Cốc**: `coccoc://extensions/`
   - **Brave**: `brave://extensions/`
2. Bật công tắc **Developer mode** (Chế độ dành cho nhà phát triển) ở góc trên bên phải.
3. Nhấp vào nút **Load unpacked** (Tải tiện ích đã giải nén).
4. Chọn thư mục `extension/dist` trong mã nguồn dự án của bạn (hoặc giải nén file trong thư mục `extension/release/` rồi chọn thư mục đó).
5. Biểu tượng **SubTrans** sẽ xuất hiện trên thanh công cụ của trình duyệt. Bạn nên nhấp vào biểu tượng mảnh ghép (Extensions) và ghim (Pin) SubTrans lên thanh công cụ để tiện thao tác.

---

## 🔑 Cấu hình Gemini API Key

Để kích hoạt chế độ dịch chất lượng cao với Gemini (`gemini` hoặc `hybrid`):

1. Lấy API Key miễn phí tại [Google AI Studio](https://aistudio.google.com/).
2. Nhấp chuột vào biểu tượng **SubTrans** trên thanh công cụ trình duyệt (hoặc click chuột phải chọn **Options / Tùy chọn**).
3. Trong mục **Gemini API Key**, dán khóa API vừa tạo.
4. Chọn mô hình Gemini mong muốn:
   - `gemini-2.5-flash` (Mặc định - tốc độ cực nhanh, dịch thuật ngữ kỹ thuật rất chuẩn).
   - `gemini-1.5-flash` (Dự phòng ổn định).
5. Chọn **Chế độ dịch mặc định**: Khuyên dùng `hybrid` (kết hợp) hoặc `google` (nếu chưa có API key).
6. Bấm nút **Lưu cài đặt**. Trạng thái kiểm tra key sẽ hiển thị ngay bên dưới ô nhập.

---

## ⌨️ Bảng phím tắt tiện ích

Khi đang ở trang video (YouTube, khóa học...):

| Phím tắt | Thao tác | Mô tả |
| :---: | :--- | :--- |
| <kbd>V</kbd> | **Đổi chế độ hiển thị** | Chuyển vòng lặp: **Song ngữ (EN + VI)** ➔ **Chỉ tiếng Việt** ➔ **Chỉ tiếng Anh** ➔ **Tắt tạm thời**. |
| <kbd>G</kbd> | **Lùi thời gian phụ đề (-0.1s)** | Bấm khi phụ đề tiếng Việt xuất hiện sớm hơn lời nói của nhân vật. |
| <kbd>H</kbd> | **Tiến thời gian phụ đề (+0.1s)** | Bấm khi phụ đề tiếng Việt xuất hiện trễ hơn lời nói của nhân vật. |
| **Kéo thả** | **Di chuyển khung phụ đề** | Giữ chuột trái vào thanh đầu đề (header bar) của khung phụ đề để kéo đến vị trí mong muốn trên màn hình. Vị trí sẽ tự động lưu lại. |
| **Nhấp đúp** | **Đổi nhanh kích thước font** | Nhấp đúp chuột vào vùng chữ phụ đề để chuyển đổi giữa các kích cỡ chữ: Nhỏ ➔ Vừa ➔ Lớn. |

---

## ⚖️ So sánh: SubTrans Extension vs Bản SubTrans Desktop

| Tiêu chí | SubTrans Extension (Bản Web) | SubTrans Desktop (Bản Wails Go) |
| :--- | :--- | :--- |
| **Mục đích chính** | Dịch và xem phụ đề song ngữ trực tiếp ngay khi lướt web. | Xử lý file video offline trên máy, dịch hàng loạt bài giảng. |
| **Yêu cầu cài đặt** | Siêu nhẹ; chỉ cần trình duyệt Chromium (Chrome, Edge...). Không cần Python, FFmpeg hay GPU. | Cần cài Go, Wails, WebView2; xử lý tốn tài nguyên máy tính. |
| **Video không có phụ đề gốc** | Người dùng tải file `.srt` ngoài lên để dịch, hoặc dùng video có sẵn phụ đề/CC. | Tích hợp **Whisper AI** tự động nghe và chuyển tiếng nói thành văn bản từ file âm thanh/video. |
| **Tốc độ hiển thị** | Tức thì theo thời gian thực của video đang phát. | Cần thời gian render và xử lý toàn bộ video trước khi xem. |
| **Xuất file** | Hỗ trợ xuất 6 định dạng (`.srt`, `.txt`, `.json`, `.tsv`) trực tiếp trên web. | Hỗ trợ xuất và đóng gói video có phụ đề cứng (hardsub) qua FFmpeg. |

---

## ⚠️ Lưu ý & Giới hạn đã biết

1. **Sử dụng cá nhân:**
   - Phiên bản này được thiết kế và tối ưu cho mục đích sử dụng cá nhân hoặc nội bộ thông qua hình thức nạp mã trực tiếp (**Load unpacked**).
2. **Quyền truy cập mạng:**
   - Tiện ích cần gửi yêu cầu dịch thuật đến `translate.googleapis.com` và `generativelanguage.googleapis.com`. Key Gemini được lưu trữ an toàn trong máy người dùng (`chrome.storage.local`) và không bao giờ bị chia sẻ ra ngoài.
3. **Iframe bị hạn chế bản quyền:**
   - Một số trang web đặt video trong thẻ `iframe` với thuộc tính `sandbox` chặn toàn bộ script nội tuyến có thể ngăn content script inject vào player. Trong trường hợp này, hãy mở liên kết video trực tiếp trong tab mới.

---

## 📄 Bản quyền & Đóng góp

Dự án được phát triển nhằm phục vụ học tập và nghiên cứu công nghệ. Mọi đóng góp, báo lỗi (issue) hoặc ý tưởng nâng cấp đều được hoan nghênh!
