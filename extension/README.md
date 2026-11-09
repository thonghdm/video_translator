# SubTrans – Phụ đề song ngữ Anh–Việt cho trình duyệt (Chrome Extension, Manifest V3)

Tiện ích cho các trình duyệt nhân Chromium (Chrome, Edge, Brave, Cốc Cốc; Chromium ≥ 116). Tiện ích hiện **phụ đề song ngữ Anh–Việt** đè lên video đang phát. Bản dịch lấy từ Google Translate hoặc Google Gemini.

Đây là phiên bản trình duyệt của SubTrans Desktop (Wails/Go), nằm trong thư mục `extension/` và **không thay đổi** gì của bản Desktop. Bản này chỉ dùng 2 API đám mây, không chạy AI cục bộ (Whisper, Qwen).

---

## Tính năng

**Nguồn phụ đề gốc (tiếng Anh)**
- **YouTube** (`/watch`): phụ đề thủ công hoặc tự động (auto-CC). Tiện ích tự lấy phụ đề kể cả khi bạn đang tắt CC, và ẩn phụ đề gốc của YouTube để không bị hiện 2 lớp.
- **Video HTML5 có `<track>`** trên mọi trang web.
- **Google Drive preview:** tự nhận file phụ đề nằm cùng thư mục (xem chi tiết ở mục riêng bên dưới).
- **Nhập file `.srt` / `.vtt`** cho video không có phụ đề (rê chuột lên video → nút **Nhập**). Đọc được file song ngữ `_bilingual.srt` do bản Desktop xuất (hiện song ngữ ngay, không gọi API) và file chỉ có tiếng Việt.

**Dịch** (chọn trong popup)
| Chế độ | Cách hoạt động | Cần API key |
|---|---|---|
| `google` (mặc định) | Google Translate, nhanh. Nếu Google tạm chặn và bạn có key thì tự chuyển sang Gemini | Không |
| `gemini` | Gemini dịch theo ngữ cảnh, giữ nguyên thuật ngữ lập trình. Gemini lỗi hoặc hết quota thì tạm dùng Google, sau đó tự dịch lại bằng Gemini | Có |
| `hybrid` | Câu đang xem dịch nhanh bằng Google; phần còn lại dịch bằng Gemini. Khi xong hết, các câu Google được nâng cấp dần lên Gemini (chấm chỉ báo đổi từ xanh lá sang cyan) | Có |

- Dịch trước theo vị trí đang xem: ưu tiên đoạn quanh chỗ đang phát (−1s … +15s), sau đó tới phần phía trước, rồi phần phía sau. Tua tới đâu, đoạn đó được ưu tiên.
- **Cache IndexedDB:** xem lại hoặc F5 thì phụ đề hiện ngay, không gọi API. Tự dọn khi quá 200 video hoặc quá 30 ngày (chỉnh được ở Options).
- **Tự phục hồi khi lỗi:** bị giới hạn (429) hoặc mất mạng thì tạm nghỉ, hiện đồng hồ đếm ngược, rồi tự dịch tiếp. Có circuit breaker riêng cho Google và Gemini.

**Hiển thị**
- 4 chế độ: Song ngữ → Chỉ tiếng Việt → Chỉ tiếng Anh → Tắt.
- Overlay nằm trong Shadow DOM, nên không bị CSS của trang làm vỡ. Kéo thả được, vị trí lưu theo từng trang web. Vẫn hiện khi fullscreen (khi fullscreen chính thẻ `<video>` thì dùng track phụ đề của trình duyệt).
- Chấm chỉ báo nguồn dịch của từng dòng: xanh lá = Google, cyan = Gemini, xám = từ file.
- Popup: bật/tắt toàn cục hoặc theo trang, chế độ dịch, Gemini key/model, cỡ chữ, màu chữ, độ mờ nền, tiến độ dịch của tab.
- Trang Options: thông số nâng cao (RPM, timeout, batch, giới hạn cache…), danh sách video đã lưu, xóa cache.

**Xuất phụ đề:** `.srt` hoặc `.vtt` × (Song ngữ / Tiếng Việt / Tiếng Anh), từ popup hoặc từ MiniToolbar trên video. Tên file: `<tiêu đề>.<bilingual|vi|en>.<srt|vtt>`. Định dạng giống hệt bản Desktop xuất, nên hai bên mở được file của nhau.

---

## Google Drive: tự nhận phụ đề

Khi mở preview video trong thư mục trên Google Drive (ví dụ: `001.mp4`), SubTrans tự động quét danh sách file cùng thư mục trong DOM, tìm file phụ đề tương ứng, tải ngầm và hiển thị song ngữ ngay khi bạn phát video.

### Quy tắc đặt tên file phụ đề

File phụ đề phải nằm **cùng thư mục** và có **cùng tên** với video (không phân biệt hoa thường), cộng thêm một trong các hậu tố sau. Ví dụ với `001 Intro.mp4`:

| Ưu tiên | Hậu tố | Ví dụ | Hành vi |
|:---:|---|---|---|
| 1 | `_bilingual`, `.bilingual`, `-bilingual`, ` bilingual` | `001 Intro_bilingual.srt` | File song ngữ (bản Desktop xuất): hiện ngay, **không gọi API dịch** |
| 2 | `_en`, `.en`, `-en`, ` en`, `_eng`, `.eng`, `_english`, `.english`, ` (english)`, ` [english]`, `.en-US`, `_en-US`, `-en-US`, `_en_US`, `.en_US` | `001 Intro_en.srt` | Phụ đề tiếng Anh, tự dịch sang tiếng Việt |
| 3 | (không hậu tố) | `001 Intro.srt` | Coi là tiếng Anh, tự dịch |

- Nhận cả `.srt` và `.vtt`; cùng mức ưu tiên thì `.srt` được chọn trước.
- File tiếng Việt (`_vi`, `.vi`, `-vi`, `_vie`, `.vie`) **không** được tự nhận. Muốn dùng thì bấm **Nhập**.
- Tên phải khớp toàn bộ: `001 Intro.mp4` không nhận nhầm `0010 Intro_en.srt` hay `001 Intro part2_en.srt`.

### Thứ tự ưu tiên nguồn phụ đề

1. **Nhập file thủ công (`user`):** Ưu tiên tuyệt đối. Khi bạn đã bấm **Nhập** file từ máy, tiện ích sẽ không bao giờ để bất kỳ nguồn tự động nào đè lên.
2. **Google Drive tự nhận (`sidecar`):** Tự động nhận file phụ đề nằm cạnh video; có thể thay thế track mặc định của player.
3. **Player HTML5 / YouTube (`adapter`):** Track phụ đề có sẵn trong trình phát video.

### Cách tắt tính năng

Nếu không muốn tiện ích tự tìm và tải phụ đề trên Drive:
1. Nhấp chuột phải vào biểu tượng SubTrans → chọn **Tùy chọn** (Options).
2. Bỏ chọn ô **"Tự nhận phụ đề .srt cùng thư mục trên Google Drive"**.
3. Khi tắt, SubTrans hoàn toàn không gửi request tìm kiếm hay tải file trên Google Drive. Bạn vẫn có thể dùng nút **Nhập** file thủ công.

### Giới hạn

- **Thư mục dài (> 50–60 file):** Do Google Drive ảo hóa danh sách DOM (chỉ dựng các phần tử đang hiển thị trên màn hình), nếu video nằm ở cuối thư mục chưa được cuộn tới, file `.srt` có thể chưa xuất hiện trong DOM. Bạn chỉ cần cuộn danh sách xuống trước khi mở video để Drive nạp các phần tử vào DOM.
- **Thư mục cấm tải xuống:** Với các thư mục chia sẻ có chính sách hạn chế quyền tải xuống của người xem, Google Drive chặn tải file phụ đề (báo toast *"Không có quyền tải phụ đề – bấm Nhập để chọn file"*). Trong trường hợp này, bạn có thể tự nhập file phụ đề từ máy.
- **File trùng tên:** Nếu trong cùng thư mục có nhiều file phụ đề cùng khớp với video ở cùng mức ưu tiên, SubTrans sẽ dừng và báo toast *"Có nhiều file trùng tên – bấm Nhập để chọn"* để tránh nạp sai nội dung.

---

## Yêu cầu

- Node.js **≥ 18** và `pnpm` (≥ 8).
- Trình duyệt nhân Chromium ≥ 116.

## Build và đóng gói

```bash
cd extension
pnpm install
pnpm run typecheck
pnpm run test        # unit test + test tích hợp (jsdom)
pnpm run build       # tạo dist/ và tự chạy scripts/verify-dist.mjs
pnpm run zip         # build rồi tạo release/subtrans-extension-v<version>.zip (tự kiểm tra zip)
```

## Cài vào trình duyệt (Load unpacked)

1. Mở `chrome://extensions` (Edge: `edge://extensions`, Cốc Cốc: `coccoc://extensions`, Brave: `brave://extensions`).
2. Bật **Developer mode**.
3. Bấm **Load unpacked** rồi chọn thư mục `extension/dist`. Nếu dùng file zip thì giải nén trước, sau đó chọn thư mục đã giải nén. Chrome không cài trực tiếp từ file zip.
4. Ghim biểu tượng SubTrans lên thanh công cụ.
5. Sau mỗi lần build lại: bấm **Reload** (↻) ở thẻ SubTrans trong `chrome://extensions`, rồi F5 các tab đang mở.

Muốn dùng với file HTML trên máy (`file://`, ví dụ `dev/test-page.html`) thì bật thêm **Allow access to file URLs** trong chi tiết tiện ích.

## Cấu hình Gemini (cho chế độ `gemini` / `hybrid`)

1. Tạo API key tại [Google AI Studio](https://aistudio.google.com/apikey).
2. Bấm biểu tượng SubTrans → mục **Gemini** → dán key. **Cài đặt tự lưu**, không có nút Lưu.
3. Bấm **Kiểm tra**: hiện ✓ kèm độ trễ, hoặc hiện lỗi.
4. Model mặc định: `gemini-3.5-flash-lite`. Có thể gõ tên model khác, hoặc bấm ↻ để tải danh sách model mà key của bạn dùng được.
5. Chọn chế độ `hybrid` hoặc `gemini`.

Mặc định giới hạn 12 request/phút cho Gemini, để không vượt hạn mức gói miễn phí. Chỉnh trong Options nếu bạn dùng gói trả phí.

## Phím tắt (chỉ hoạt động trên trang đang có phụ đề SubTrans, và không hoạt động khi đang gõ chữ)

| Phím | Tác dụng |
|:---:|---|
| <kbd>V</kbd> | Đổi chế độ hiển thị: Song ngữ → Chỉ VI → Chỉ EN → Tắt |
| <kbd>G</kbd> | Lệch −0.1s: phụ đề hiện **muộn** hơn (dùng khi phụ đề hiện sớm hơn lời nói) |
| <kbd>H</kbd> | Lệch +0.1s: phụ đề hiện **sớm** hơn (dùng khi phụ đề hiện trễ) |
| Kéo hộp phụ đề | Di chuyển vị trí (lưu theo trang web) |
| Nhấp đúp hộp phụ đề | Đưa vị trí về mặc định (giữa, phía dưới) |

Độ lệch được lưu riêng cho từng video. Bấm vào ô hiển thị độ lệch trên MiniToolbar để đặt lại về 0.

---

## So sánh với bản Desktop

| | Extension (trình duyệt) | Desktop (Wails/Go) |
|---|---|---|
| Chạy ở đâu | Ngay trên trang đang xem (YouTube, trang có `<track>`, file `.srt` nhập vào) | Ứng dụng Windows: file video trên máy, link YouTube, Google Drive |
| Video không có phụ đề | Phải nhập file `.srt`/`.vtt` | Whisper tự nghe và tạo phụ đề (offline) |
| Dịch | Google Translate + Gemini | Google Translate + Gemini + Qwen chạy cục bộ (offline) |
| Cài đặt | Vài trăm KB, không cần GPU hay model | Bộ cài, kèm model AI ~1.5GB |
| Trao đổi phụ đề | Xuất/nhập `.srt`/`.vtt` cùng định dạng, mở được file của nhau | ← |

---

## Giới hạn đã biết

- **Dùng cá nhân (Load unpacked).** Chưa đưa lên Chrome Web Store. Chế độ `google` dùng endpoint Google Translate không chính thức (`translate_a/single?client=gtx`), có thể bị chặn bất cứ lúc nào. Nếu muốn publish cần đổi engine và thu hẹp quyền (xem `PLAN.md` › R9).
- **Quyền rộng:** tiện ích chạy trên mọi trang (`<all_urls>`) để tìm `<video>`. Trên trang không có phụ đề, tiện ích không hiện gì và không chiếm phím tắt.
- **Quyền riêng tư:** câu phụ đề được gửi tới Google Translate hoặc Gemini để dịch. Gemini API key được lưu trong `chrome.storage.local` trên máy bạn, chỉ gửi tới `generativelanguage.googleapis.com` (qua header, không nằm trên URL), và không bao giờ được đưa vào trang web. Mọi request dịch đều **không gửi kèm cookie** đăng nhập Google của bạn. Trên Google Drive, SubTrans dùng phiên đăng nhập của bạn để tải file phụ đề nằm cùng thư mục với video đang xem. File chỉ được đọc trong tiện ích, không gửi đi nơi khác ngoài bước dịch như bình thường.
- **YouTube:** không hỗ trợ Shorts và livestream đang phát (VOD của livestream đã kết thúc thì vẫn được). Video YouTube nhúng trên trang khác: phụ đề chỉ được lấy sau khi bấm play.
- **Chưa kiểm chứng trên trang thật:** Google Drive preview, Udemy, Coursera, edX (xem `NOTES.md` › Phase 9 để tự kiểm tra). Nếu tiện ích không lấy được phụ đề trên các trang này, bạn vẫn dùng được nút **Nhập** `.srt`.
- **Video có DRM** (Netflix, Disney+…) không lấy được phụ đề gốc.
- YouTube có thể đổi cách tải phụ đề (token `pot`). Ghi chú kỹ thuật và số liệu kiểm chứng nằm trong `NOTES.md` › Phase 5.

## Tài liệu kỹ thuật

- `PLAN.md`: kế hoạch theo phase, hợp đồng dữ liệu, quy tắc bất biến (không đụng bản Desktop).
- `NOTES.md`: kết quả thử nghiệm [T], các lỗi đã sửa ở từng phase, checklist kiểm thử thủ công.
