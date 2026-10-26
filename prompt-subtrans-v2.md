# PROMPT v2 — Trình phát video kiểu VLC với phụ đề dịch Anh→Việt chạy offline (Wails v2)

> Cách dùng: dán toàn bộ nội dung từ mục "VAI TRÒ" trở xuống vào AI. Nên yêu cầu xuất theo **2 lượt** (xem mục 12).

---

## 0. VAI TRÒ

Bạn là Senior Systems & Fullstack Desktop Engineer, thành thạo Go (concurrency, `os/exec`, `context`), Wails v2, React + TypeScript + Tailwind CSS, và tích hợp CLI của ffmpeg / whisper.cpp / llama.cpp trên Windows.

Nguyên tắc làm việc:
- Viết mã chạy được, không pseudo-code, không "TODO", không để trống thân hàm.
- Chỉ dùng API có thật của Wails v2 (`runtime.OpenFileDialog`, `runtime.EventsEmit`, `assetserver.Options{Assets, Handler}`…). Nếu không chắc một API hay một cờ CLI có tồn tại, **nói rõ là chưa chắc** thay vì bịa.
- Các cờ dòng lệnh của whisper-cli / llama-cli thay đổi theo phiên bản. Gom tất cả cờ vào một chỗ (hằng số hoặc hàm dựng args), và ghi chú cờ nào cần kiểm tra bằng `--help` của bản build đang dùng.

## 1. MỤC TIÊU SẢN PHẨM

Ứng dụng desktop Windows giống VLC/IINA: **mở file là phát ngay**, phụ đề tiếng Anh và tiếng Việt được sinh ngầm theo thời gian thực, **hoàn toàn offline**, không gọi API ngoài.

Kịch bản chính:
1. Người dùng mở video dài 1–2 giờ.
2. Video phát ngay lập tức; backend bắt đầu xử lý từ vị trí đang xem và **đón đầu** phía trước.
3. Phụ đề tiếng Anh xuất hiện trước, vài giây sau bản dịch tiếng Việt thay thế/ghép vào.
4. Người dùng tua tới chỗ chưa xử lý → pipeline nhảy tới đó, ưu tiên đoạn đang xem.
5. Mở lại video lần sau → phụ đề đã xử lý hiện ngay từ cache, phần còn thiếu tiếp tục được xử lý.

Mục tiêu hiệu năng (đo và báo cáo, không cam kết suông):
- Từ lúc phát đến lúc có phụ đề tiếng Anh đầu tiên: ≤ 15 giây trên CPU 6 nhân.
- Khi phát liên tục, phụ đề phải luôn ở **phía trước** playhead ít nhất `lookahead_min` giây; nếu không theo kịp, UI hiển thị trạng thái "Đang đuổi kịp…" thay vì im lặng.
- Giao diện không giật khi pipeline đang chạy (ưu tiên thấp cho tiến trình con, xem 5.8).

## 2. NGĂN XẾP VÀ CẤU TRÚC THƯ MỤC

- Go ≥ 1.21, Wails v2, React 18 + TypeScript, Tailwind CSS **3.x**.
- Hệ điều hành đích: Windows 10/11 (WebView2).

```
subtrans/
├── main.go                 // Wails + AssetServer
├── app.go                  // struct App, method bind, vòng đời
├── pipeline.go             // scheduler, 3 stage, hàng đợi ưu tiên
├── blockstore.go           // cache theo block (đĩa + bộ nhớ)
├── tools.go                // đường dẫn, kiểm tra, runCommand, build args
├── translator.go           // interface Translator + LlamaCliTranslator
├── media.go                // phục vụ video (Range) cho thẻ <video>
├── proc_windows.go / proc_other.go
├── frontend/src/App.tsx
├── frontend/src/lib/subtitles.ts   // upsert, sort, binary search
└── build/bin/
    ├── subtrans.exe
    ├── tools/ffmpeg/{ffmpeg.exe, ffprobe.exe}
    ├── tools/whisper/whisper-cli.exe + DLL
    ├── tools/llama/llama-cli.exe + DLL
    └── models/{ggml-base.bin, qwen2.5-0.5b-instruct-q4_k_m.gguf}
```

Lý do mỗi công cụ một thư mục: whisper.cpp và llama.cpp cùng kèm `ggml*.dll` nhưng khác phiên bản; để chung dễ nạp nhầm DLL. Đường dẫn tính từ thư mục chứa file `.exe` (fallback `cwd/build/bin` khi chạy `wails dev`).

## 3. HỢP ĐỒNG DỮ LIỆU (bắt buộc đúng từng trường)

Thời gian luôn là **số giây kiểu float64** tính từ đầu video. Không dùng chuỗi `HH:MM:SS`.

```json
// SubtitleItem
{
  "id": 12003,            // = block*1000 + seq, ổn định; dùng để upsert
  "block": 12,
  "start_sec": 360.42,
  "end_sec": 363.10,
  "source_text": "So what happens next?",
  "target_text": "",      // rỗng cho tới khi dịch xong
  "translated": false
}

// VideoInfo (trả về bởi OpenVideo)
{
  "path": "D:\\Phim\\a.mkv",
  "duration_sec": 5423.7,
  "block_sec": 30,
  "total_blocks": 181,
  "media_url": "http://127.0.0.1:53211/media/<token>",
  "playable": true,
  "playable_reason": "",  // vd "audio codec ac3 không được WebView2 hỗ trợ"
  "done_blocks": [0,1,2]  // lấy từ cache
}
```

Sự kiện Go → JS (`runtime.EventsEmit`):

| Event | Payload | Khi nào |
|---|---|---|
| `new_subtitle_chunk` | `{ "video": string, "block": int, "items": SubtitleItem[], "final": bool }` | sau Whisper (target rỗng) **và** sau khi dịch xong block đó (`final=true`, cùng `id` → frontend ghi đè) |
| `pipeline_status` | `{ "state": "idle"\|"seeking"\|"processing"\|"ahead"\|"catching_up"\|"backfill"\|"done"\|"error", "message": string, "block": int, "done_blocks": int, "total_blocks": int, "ahead_sec": float }` | mỗi khi đổi trạng thái hoặc xong 1 block |
| `pipeline_error` | `{ "block": int, "stage": "slice"\|"stt"\|"translate", "message": string, "fatal": bool }` | lỗi từng block (không fatal) hoặc lỗi chặn toàn bộ (fatal) |

Mọi payload gắn `video` (đường dẫn) để frontend **bỏ qua sự kiện muộn của video cũ**.

## 4. API BACKEND (method bind với Wails)

```go
SelectVideoFile() (string, error)                 // dialog; "" nếu người dùng hủy
OpenVideo(path string) (VideoInfo, error)         // probe, nạp cache, dựng media_url, KHÔNG chờ xử lý
StartPipeline(path string, startSec float64) error
SeekTo(path string, startSec float64) error       // idempotent, xem 5.5
UpdatePlayhead(path string, sec float64, playing bool) // frontend gọi mỗi ~2 giây
StopPipeline() error
LoadCachedSubtitles(path string) ([]SubtitleItem, error)
ExportSRT(path string, mode string) (string, error)    // mode: "source"|"target"|"bilingual"; mở dialog lưu
GetSettings() Settings / SaveSettings(Settings) error
```

`Settings` (lưu JSON trong `%LOCALAPPDATA%\SubTrans\settings.json`): `block_sec` (mặc định 30), `overlap_sec` (2), `lookahead_min_sec` (45), `lookahead_max_sec` (180), `translate_workers` (1–2), `whisper_threads`, `source_lang` ("en"), `translator` ("cli" | "server").

## 5. PIPELINE — CHI TIẾT BẮT BUỘC

### 5.1 Chia block có chồng lấn

- Block `i` **sở hữu** khoảng `[i·B, (i+1)·B)` (B = `block_sec`).
- Audio thực tế cắt cho block `i`: `[max(0, i·B − O), min(duration, (i+1)·B + O)]` (O = `overlap_sec`). Lưu `extract_start` để cộng offset.
- Sau Whisper, mỗi segment có thời gian tuyệt đối = `extract_start + t_rel`. **Chỉ giữ segment có điểm giữa `(start+end)/2` nằm trong khoảng sở hữu của block** → hai block kề nhau không trùng câu và không cắt giữa câu.
- Cắt audio bằng ffmpeg với seek trước `-i` (nhanh): `-ss <extract_start> -t <len> -i video -vn -ar 16000 -ac 1 -c:a pcm_s16le`. Mỗi block ra một file WAV riêng trong thư mục tạm; xóa ngay khi block xong hoặc bị hủy.

### 5.2 Ba stage chạy song song bằng goroutine + channel

```
Scheduler ──blockIdx──▶ [Slicer] ──audioChan(buf=2)──▶ [STT] ──textChan(buf=2)──▶ [Translator ×N] ──▶ emit/cache
```

- Channel có **buffer nhỏ (2)** để áp lực ngược (back-pressure) khiến slicer không cắt trước quá xa.
- Slicer: 1 goroutine. STT: **1 goroutine** (whisper đã đa luồng nội bộ). Translator: `translate_workers` goroutine.
- Một block đi qua cả 3 stage mới được ghi cache; block lỗi ở stage nào thì phát `pipeline_error` (không fatal), đánh dấu `failed`, **không retry vô hạn** (tối đa 1 lần retry).
- Mọi stage nhận `context.Context` của "phiên" (session) và thoát ngay khi `ctx.Done()`.

### 5.3 Scheduler & đón đầu (lookahead)

- Trạng thái: `playheadBlock`, tập `done`, tập `failed`, `cursor`.
- Chọn block kế tiếp: block chưa `done` **đầu tiên** tính từ `playheadBlock` trở đi.
- **Chặn đón đầu:** chỉ đẩy block mới vào pipeline khi `ahead_sec = (cuối vùng đã xong liên tục kể từ playhead) − playhead < lookahead_max_sec`. Vượt ngưỡng → trạng thái `ahead`, tạm nghỉ; `UpdatePlayhead` làm scheduler tỉnh lại khi `ahead_sec` giảm.
- `ahead_sec < lookahead_min_sec` khi đang phát → trạng thái `catching_up`.
- Khi đã tới cuối video mà còn block trống phía sau playhead cũ (do người dùng từng tua nhảy) → trạng thái `backfill`: xử lý các block thiếu từ đầu video theo thứ tự, **ưu tiên thấp hơn** mọi thứ liên quan playhead.
- Tất cả block `done` → `done`.

### 5.4 Cache theo block

- Thư mục: `%LOCALAPPDATA%\SubTrans\cache\<hash>\blocks\<index>.json`, với `hash = sha1(đường dẫn + kích thước + mtime)`; kèm `meta.json` (`block_sec`, `overlap_sec`, `model`, version). Đổi `block_sec`/model → vô hiệu cache.
- Ghi file **nguyên tử** (ghi `.tmp` rồi `os.Rename`). File hỏng → bỏ qua block đó, xử lý lại, không crash.
- Bộ nhớ: map block→items có mutex; `LoadCachedSubtitles` trả toàn bộ để frontend nạp một lần khi mở video.

### 5.5 SeekTo — quy tắc chính xác

1. Tính `target = floor(startSec / B)`.
2. **Nếu `target` đã `done`:** không hủy gì cả; chỉ cập nhật `playheadBlock` và để scheduler chọn block chưa xong kế tiếp phía sau.
3. **Nếu chưa `done` và đang xử lý đúng block `target` hoặc block ngay sau nó:** không làm gì (đã đúng hướng).
4. **Ngược lại:** hủy phiên hiện tại (`cancel()`), **chờ các goroutine con thoát** (WaitGroup, timeout 3 giây), xóa file tạm của phiên cũ, tạo phiên mới với `playheadBlock = target`.
5. Hàm phải an toàn khi gọi dồn dập từ nhiều goroutine (mutex + số thứ tự phiên). Lệnh seek đến muộn của phiên cũ không được phép làm hỏng phiên mới.
6. Biên: `startSec < 0` → 0; `startSec ≥ duration` → block cuối; video không có audio → `pipeline_error{fatal:true, stage:"slice"}` với thông báo rõ ràng.

### 5.6 Whisper

- Mỗi block gọi `whisper-cli` với: model `ggml-base.bin`, ngôn ngữ cố định từ `source_lang`, đầu ra SRT hoặc JSON (ưu tiên định dạng cho timestamps chính xác), số luồng từ settings. Ghi output vào thư mục tạm ASCII.
- **Lọc ảo giác (hallucination):** bỏ segment rỗng, bỏ `[BLANK_AUDIO]`, `(music)`, `♪`, bỏ segment lặp y hệt segment liền trước quá 2 lần, bỏ các câu ảo giác phổ biến của Whisper khi im lặng (ví dụ "Thank you for watching", "Subtitles by…") **chỉ khi** block đó RMS rất thấp hoặc segment quá ngắn so với text. Đặt danh sách lọc trong một biến dễ sửa.
- Segment dài hơn 7 giây hoặc hơn 84 ký tự: tách theo dấu câu thành các dòng ngắn, chia thời gian theo tỷ lệ độ dài ký tự.

### 5.7 Dịch (Translator)

```go
type Translator interface {
    Translate(ctx context.Context, line string, prevContext []string) (string, error)
    Close() error
}
```
- Triển khai bắt buộc: `LlamaCliTranslator` (gọi `llama-cli.exe` mỗi dòng). Triển khai tùy chọn (Giai đoạn 3): `LlamaServerTranslator` (spawn `llama-server` một lần, gọi HTTP `127.0.0.1`). Chọn qua `Settings.translator`.
- Dùng **ChatML thủ công** (chạy không tương tác: `-no-cnv` hoặc cờ tương đương của bản đang dùng), `--temp 0.2`, `-n` giới hạn, `--no-display-prompt`. System prompt viết **bằng tiếng Anh** (model nhỏ tuân thủ tốt hơn), yêu cầu đầu ra tiếng Việt:
  > "You are a video subtitle translator. Translate the user's English line into natural, concise Vietnamese. Output only the translation. No explanations, no notes, no quotation marks."
- Truyền tối đa 2 dòng nguồn liền trước làm ngữ cảnh, đánh dấu rõ "context only, do not translate".
- Hậu xử lý đầu ra: bỏ token điều khiển (`<|im_end|>`, `[end of text]`…), cắt dấu ngoặc kép bao ngoài, lấy dòng không rỗng đầu tiên, nếu đầu ra dài bất thường (> 4× độ dài nguồn + 40 ký tự) coi là lỗi dịch.
- Dòng không phải lời thoại (nhạc, tiếng động) bỏ qua dịch, `target_text` để rỗng.
- Smoke test khi khởi động phiên đầu tiên: dịch "Hello." để bắt sớm lỗi cờ/DLL, báo lỗi fatal rõ ràng nếu hỏng.
- Lỗi một dòng: `target_text` rỗng + log, không làm hỏng block. Nếu **toàn bộ** dòng của 3 block liên tiếp thất bại → `pipeline_error{fatal:true, stage:"translate"}`.

### 5.8 Tiến trình con & tài nguyên

- Mọi lệnh qua một hàm `runCommand(ctx, bin, args, onStderrLine)`: `exec.CommandContext`, ẩn cửa sổ console (`CREATE_NO_WINDOW`), đọc stderr bằng scanner tách theo cả `\r` và `\n`, giữ vài dòng cuối để đính vào thông báo lỗi, timeout riêng cho từng loại (ffmpeg 60 giây/block, whisper 5 phút/block, llama 90 giây/dòng).
- Hạ ưu tiên tiến trình con (`BELOW_NORMAL_PRIORITY_CLASS` qua `SysProcAttr.CreationFlags`) để video đang phát không bị giật.
- Thư mục tạm có đường dẫn **ASCII** (thử `%TEMP%`, rồi `%PUBLIC%`, `%ProgramData%`); dọn khi thoát/hủy; dọn thư mục tồn dư của lần chạy trước khi khởi động.
- `shutdown`: hủy phiên, chờ goroutine, đóng media server, dừng translator.
- Bọc mỗi goroutine stage bằng `recover()`, chuyển panic thành `pipeline_error`.

### 5.9 Quản lý tiến trình con triệt để trên Windows (Job Object & Process Tree)

- **Vấn đề thực tế:** Khi Go hủy `exec.CommandContext` trên Windows, hàm hủy chỉ gọi `Process.Kill()` đối với tiến trình cha trực tiếp. Nếu ffmpeg/whisper/llama tạo subprocess hoặc chạy gián tiếp, chúng có nguy cơ trở thành tiến trình mồ côi (zombie process) tiếp tục chiếm dụng 100% CPU/GPU.
- **Giải pháp bắt buộc:** Trong `proc_windows.go`, triển khai gán tiến trình vào Windows **Job Object** với cờ `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, hoặc gọi cơ chế fallback cưỡng chế `taskkill /T /F /PID <pid>` khi context bị hủy / phiên kết thúc / app đóng.
- Đảm bảo khi người dùng tua video nhiều lần hoặc tắt app, không có bất kỳ tiến trình ffmpeg/whisper/llama nào còn sót lại trong Task Manager.

### 5.10 Cơ chế Mock / Stub CLI cho Test Pipeline tự động

- Pipeline được trừu tượng hóa để có thể nhận `CommandRunner` (giao diện thực thi lệnh).
- Cung cấp triển khai `MockCommandRunner` dùng riêng cho Unit/Integration Test:
  - Mock ffmpeg: tạo file WAV giả lập kích thước hợp lệ mà không cần ffmpeg thật.
  - Mock whisper-cli: đọc file WAV giả lập và trả về chuỗi JSON/SRT mẫu với timestamps chính xác.
  - Mock llama-cli: nhận prompt và trả về câu dịch tiếng Việt giả lập.
- Mục đích: Bộ test tự động có thể chạy nhanh trong vài giây trên mọi máy CI/CD mà không phụ thuộc vào GPU hay bộ model nặng 1–2 GB.

## 6. PHÁT VIDEO (MEDIA)

- Cần `ffprobe.exe` (đi kèm bản ffmpeg build) để lấy `duration`, codec video/audio.
- `media.go`: hỗ trợ **HTTP Range** bằng `http.ServeContent`/`http.ServeFile`, đặt `Content-Type` theo đuôi (`.mp4`, `.webm`, `.mkv`), `Cache-Control: no-store`.
- Hai chế độ, chọn bằng một hằng số, **mặc định `loopback`**:
  1. `loopback`: server `127.0.0.1:0` (cổng ngẫu nhiên) + **token ngẫu nhiên 128-bit** trong URL, so sánh bằng `subtle.ConstantTimeCompare`, chỉ phục vụ đúng file đang mở.
  2. `asset`: `assetserver.Options{ Handler: ... }` trong `main.go`, đường dẫn `/media/<token>`, cùng logic Range.
  Giải thích trong comment vì sao `loopback` là mặc định (độ ổn định khi tua trong file lớn trên WebView2 cần được kiểm chứng với chế độ `asset`); phải test cả hai và báo kết quả.
- **Chính sách codec:** `playable = true` chỉ khi video ∈ {h264, vp8, vp9, av1} và audio ∈ {aac, mp3, opus, vorbis}. Còn lại → `playable=false` kèm lý do tiếng Việt, và frontend hiện hộp thoại đề nghị **chuyển mã nền** (Giai đoạn 2): `ffmpeg -c:v copy -c:a aac` nếu video là h264, ngược lại `libx264 -preset veryfast -crf 23 -c:a aac`, ghi vào thư mục cache, có tiến độ và nút hủy. Âm thanh đưa cho Whisper luôn lấy từ **file gốc**, không phải file chuyển mã.

## 7. FRONTEND

### 7.1 State & dữ liệu phụ đề

- Danh sách phụ đề giữ dạng mảng **đã sắp theo `start_sec`**; hàm `upsert(items)` ghi đè theo `id`, chèn đúng vị trí (hoặc dựng lại + sort khi payload lớn). Đặt trong `lib/subtitles.ts`, thuần hàm, dễ test.
- Bỏ qua sự kiện có `video` khác video hiện tại.
- Tra phụ đề đang hiển thị bằng **tìm kiếm nhị phân** theo `currentTime + subtitleOffset`.

### 7.2 Đồng bộ chính xác

`onTimeUpdate` của `<video>` chỉ bắn ~4 lần/giây nên **không** đủ chính xác. Yêu cầu:
- Khi đang phát: ưu tiên `video.requestVideoFrameCallback` (đọc `metadata.mediaTime`), nếu không có thì `requestAnimationFrame`.
- Vẫn gắn `onTimeUpdate`, `onSeeked`, `onPause` để cập nhật khi tạm dừng hoặc tua.
- Chỉ `setState` khi chỉ số phụ đề thay đổi (tránh render lại toàn app 60 lần/giây). Danh sách phụ đề bên cạnh phải `React.memo`.

### 7.3 Giao diện (tối giản, tối màu, kiểu VLC/IINA)

- **Header:** nút "Mở video" nổi bật (+ kéo-thả file vào cửa sổ), tên file, nhãn trạng thái động lấy từ `pipeline_status` (ví dụ "Đang đón đầu phụ đề — phút 02:30", "Đang đuổi kịp…", "Đã xử lý 41/181 đoạn", "Sẵn sàng"), nút chế độ phụ đề.
- **Chế độ phụ đề:** Tắt / Tiếng Anh / Tiếng Việt / Song ngữ. Song ngữ: dòng Anh nhỏ, mờ ở trên; dòng Việt lớn, nổi bật ở dưới.
- **Player:** Play/Pause, âm lượng + tắt tiếng, seekbar, thời gian hiện tại/tổng, tốc độ phát (0.5×–2×), toàn màn hình. Seekbar hiển thị **vùng đã có phụ đề** (các đoạn `done_blocks`) bằng dải màu mờ dưới thanh — giúp người dùng thấy vùng nào đã sẵn sàng.
- **Overlay phụ đề:** `pointer-events-none`, canh giữa, nền `bg-black/75`, chữ `text-amber-300` cho tiếng Việt, drop-shadow, cỡ chữ tỷ lệ theo chiều cao player (vẫn đọc được khi toàn màn hình), tự xuống dòng, giới hạn 2 dòng mỗi ngôn ngữ.
- **Panel danh sách phụ đề** (bật/tắt được): bấm vào dòng để tua; dòng đang phát được tô sáng và tự cuộn vào tầm nhìn.
- **Phím tắt:** Space (phát/dừng), ←/→ (±5 giây), Shift+←/→ (±30 giây), ↑/↓ (âm lượng), F (toàn màn hình), M (tắt tiếng), V (đổi chế độ phụ đề), G/H (lệch phụ đề −/+ 0,1 giây, hiện toast giá trị), Ctrl+O (mở video).
- Truy cập: focus rõ ràng, `aria-label` cho nút icon, `role="switch"` cho công tắc.

### 7.4 Tua video — chống dồn lệnh

- **Không** gọi `SeekTo` trong lúc đang kéo seekbar. Chỉ gọi khi **thả chuột/phím** (hoặc từ sự kiện `seeked` đã debounce 250 ms), và dùng cờ để không gọi trùng cho cùng một block.
- Khi đang phát: gọi `UpdatePlayhead(path, currentTime, playing)` mỗi ~2 giây và khi tạm dừng/tiếp tục.
- Khi mở video mới: hủy lắng nghe cũ, xóa danh sách phụ đề, gọi `OpenVideo` → `LoadCachedSubtitles` → `StartPipeline(path, 0)`; **bắt đầu phát trước, không chờ pipeline**.
- `playable=false`: hiện thông báo và nút "Chuyển mã để phát", không để thẻ `<video>` im lặng báo lỗi.

## 8. XỬ LÝ LỖI — DANH SÁCH TỐI THIỂU

Thiếu file công cụ/model (báo đúng file nào thiếu) · video không có audio · file bị xóa/di chuyển giữa chừng · đĩa đầy khi ghi cache · ffmpeg/whisper/llama timeout hoặc crash · output rỗng/hỏng · đường dẫn Unicode · tua quá cuối video · mở video khác khi đang xử lý (hủy phiên cũ sạch sẽ) · đóng app giữa chừng (không để tiến trình mồ côi) · cache hỏng · WebView2 không giải mã được video. Thông báo lỗi hướng người dùng cách khắc phục, bằng tiếng Việt.

## 9. KIỂM THỬ

- **NGUYÊN TẮC TEST HOÀN TOÀN TRƯỚC KHI DONE:** Sau mỗi bước/giai đoạn thực thi, bắt buộc phải viết testcase kiểm thử cho bước đó và chạy kiểm thử hồi quy (regression test) toàn bộ hệ thống từ đầu tới thời điểm hiện tại. Chỉ khi 100% test case pass thì mới được coi là hoàn thành (DONE) bước đó và chuyển sang bước tiếp theo.
- Unit test Go cho: parse SRT/JSON của whisper, quy tắc "điểm giữa trong vùng sở hữu", lọc ảo giác, `cleanLLMOutput`, chọn block kế tiếp của scheduler, quy tắc `SeekTo` (dùng fake clock/fake stage/mock runner), HTTP Range Server, atomic write cache.
- Unit test TS cho `upsert` và tìm kiếm nhị phân.
- Bảng kiểm thủ công để tôi chạy: mở video 2 giờ; tua liên tục 20 lần; tua về vùng đã xử lý; đóng/mở lại (cache); video không audio; video HEVC; hủy giữa chừng; tên file có dấu tiếng Việt.

## 10. TIÊU CHÍ NGHIỆM THU

1. Mở video 2 giờ: video phát ngay, không đứng hình chờ xử lý.
2. Phụ đề tiếng Anh đầu tiên ≤ 15 giây; bản dịch tiếng Việt đến sau và **thay thế đúng dòng** (không nhân đôi).
3. Không có câu trùng hoặc bị cắt đôi ở ranh giới giữa hai block.
4. Tua đến vùng chưa xử lý: phụ đề của vùng đó xuất hiện sau thời gian tương đương xử lý một block; không còn tiến trình ffmpeg/whisper/llama của phiên cũ chạy (kiểm tra bằng Task Manager).
5. Đóng và mở lại cùng video: phụ đề đã xử lý hiện ngay, không xử lý lại.
6. Không có cửa sổ console nhấp nháy; CPU không làm giật video ở 1080p.
7. Bật/tắt/đổi chế độ phụ đề, G/H, xuất SRT hoạt động đúng.

## 11. NHỮNG ĐIỀU KHÔNG ĐƯỢC LÀM

- Không xử lý tuần tự "xong hết audio rồi mới STT rồi mới dịch".
- Không cắt audio cả video ra đĩa trước.
- Không gọi `SeekTo` mỗi lần `onChange` của thanh tua.
- Không dùng `localStorage` để lưu phụ đề.
- Không dùng thư viện cần mạng khi chạy; không gọi dịch vụ đám mây.
- Không bịa API Wails hoặc cờ CLI; không im lặng nuốt lỗi.

## 12. ĐẦU RA VÀ CÁCH CHIA LƯỢT

**Lượt 1 — Backend:** `main.go`, `app.go`, `pipeline.go`, `blockstore.go`, `tools.go`, `translator.go`, `media.go`, `proc_windows.go`, `proc_other.go`, kèm unit test cho các hàm thuần. Cuối lượt, liệt kê: (a) danh sách cờ CLI cần xác nhận bằng `--help`, (b) các giả định đã đặt ra, (c) hợp đồng event cuối cùng nếu có thay đổi so với mục 3.

**Lượt 2 — Frontend + vận hành** (sau khi tôi xác nhận hợp đồng): `frontend/src/App.tsx`, `frontend/src/lib/subtitles.ts`, cấu hình Tailwind 3, `scripts/download-tools.ps1` (tải ffmpeg+ffprobe, whisper.cpp, llama.cpp, hai model; lấy bản mới nhất qua GitHub Releases API), `SETUP.md` (khởi tạo dự án, lệnh `wails dev` / `wails build`, xử lý sự cố thường gặp).

**Giai đoạn mở rộng (làm sau khi 1–2 chạy ổn):** chuyển mã nền cho codec không hỗ trợ (6), `LlamaServerTranslator` (5.7), hiển thị dải "đã có phụ đề" trên seekbar nếu chưa làm ở lượt 2.

## 13. KẾ HOẠCH TRIỂN KHAI TỪNG BƯỚC & MA TRẬN TESTCASE NGHIỆM THU

> **Nguyên tắc xuyên suốt:** Sau mỗi bước, phải bổ sung test case tương ứng và chạy lại toàn bộ test suite (`go test -v -race ./...` và frontend test). Tất cả phải **PASS 100%** mới chuyển bước.

### Bước 0: Thiết lập môi trường & Bộ khung dự án
- **Mục tiêu:** Khởi tạo project structure, `go.mod`, skeleton Wails v2, package frontend, cấu hình Tailwind CSS 3.
- **Test nghiệm thu:**
  - `go mod tidy` không lỗi.
  - Cấu trúc thư mục khớp chuẩn mục 2.
  - Skeleton build thành công.

### Bước 1: Core Pure Logic & Bộ Unit Test Thuần
- **Mục tiêu:** Viết toàn bộ hàm toán học, parser, sanitizer không phụ thuộc I/O.
  - Phép tính phân block, overlap audio, quy tắc điểm giữa `(start+end)/2 ∈ [i·B, (i+1)·B)`.
  - Bộ lọc hallucination của Whisper, tách câu dài theo dấu câu.
  - Bộ làm sạch output ChatML của Llama, kiểm tra tỷ lệ độ dài.
  - `frontend/src/lib/subtitles.ts`: hàm `upsert` duy trì sắp xếp theo `start_sec`, hàm `binarySearch` tìm kiếm phụ đề theo `currentTime`.
- **Test nghiệm thu:**
  - `Test_BlockOverlapAndOwnershipMath`: Đảm bảo block đầu, giữa, cuối video không bao giờ đè hay nuốt câu.
  - `Test_WhisperParser_HallucinationFilter`: Lọc triệt để câu rỗng, câu lặp, tags âm nhạc, hallucination khi RMS thấp.
  - `Test_WhisperParser_SplitLongSegments`: Tách câu dài theo dấu chấm/phẩy tỷ lệ đúng thời gian.
  - `Test_CleanLLMOutput`: Lọc `<|im_end|>`, dấu ngoặc kép bọc ngoài, output dài bất thường.
  - `Test_Subtitles_Upsert_And_BinarySearch`: Test TypeScript chạy với Vitest/Jest, verify tìm nhị phân chính xác ở các mốc thời gian biên.
  - **Tiêu chuẩn hoàn thành:** 100% test case pass.

### Bước 2: Subprocess Windows, Process Tree & Media Range Server
- **Mục tiêu:**
  - `proc_windows.go` / `proc_other.go`: Quản lý tiến trình ẩn cửa sổ (`CREATE_NO_WINDOW`), hạ ưu tiên (`BELOW_NORMAL_PRIORITY_CLASS`), gắn Job Object / process tree killer để dập tắt triệt để tiến trình con khi bị hủy.
  - `tools.go`: Wrapper `runCommand` có scanner đọc stderr `\r` và `\n`, timeout riêng biệt.
  - `media.go`: HTTP Range Server (chế độ Loopback cổng ngẫu nhiên + token 128-bit), codec detector qua `ffprobe`.
- **Test nghiệm thu:**
  - Chạy lại toàn bộ test Bước 1.
  - `Test_MediaServer_RangeRequest`: Giả lập HTTP GET với header `Range: bytes=0-1023`, `bytes=1024-` kiểm tra status 206 Partial Content, Content-Range, Content-Length.
  - `Test_MediaServer_TokenAuth`: Truy cập sai hoặc thiếu token phải bị chặn (401/403).
  - `Test_RunCommand_TimeoutAndProcessTreeKill`: Chạy lệnh giả lập quá timeout, verify context bị hủy và toàn bộ cây tiến trình bị dọn sạch khỏi hệ thống.
  - **Tiêu chuẩn hoàn thành:** Test Bước 1 + Bước 2 PASS 100%.

### Bước 3: Cache Storage & Pipeline Engine 3-Stage (Goroutine/Channel/Context)
- **Mục tiêu:**
  - `blockstore.go`: Đọc/ghi cache JSON theo block với atomic write (`.tmp` -> `os.Rename`).
  - `pipeline.go`:
    - Bộ lập lịch (Scheduler) tính `ahead_sec`, tự chuyển trạng thái `ahead`, `catching_up`, `backfill`, `done`.
    - 3 stage song song qua Channel (buffer = 2): Slicer -> STT -> Translator.
    - Logic `SeekTo` an toàn tuyệt đối: Kiểm tra block đích, hủy session cũ an toàn với WaitGroup timeout 3s, tăng session counter.
- **Test nghiệm thu:**
  - Chạy lại toàn bộ test Bước 1 + Bước 2.
  - `Test_BlockStore_AtomicWriteAndCorruptRecovery`: Ghi đè file hỏng, verify không bị crash mà xử lý lại.
  - `Test_Scheduler_LookaheadStates`: Kiểm tra chuyển trạng thái `ahead` khi vượt `lookahead_max_sec`, `catching_up` khi tụt dưới `lookahead_min_sec`.
  - `Test_Pipeline_RapidSeekTo`: Bắn 20 lệnh `SeekTo` liên tiếp từ nhiều goroutine, verify không xảy ra deadlock, goroutine rò rỉ hoặc race condition (chạy với cờ `-race`).
  - `Test_Pipeline_BackfillOrder`: Khi xem đoạn giữa xong đến cuối video, pipeline tự động quay lại backfill các block đầu còn thiếu.
  - **Tiêu chuẩn hoàn thành:** Toàn bộ test Bước 1 + 2 + 3 PASS 100% với `go test -race ./...`.

### Bước 4: Backend API & Wails Lifecycle Binding
- **Mục tiêu:**
  - `app.go` & `main.go`: Hoàn thiện struct `App`, bind toàn bộ API backend với Wails v2 (`SelectVideoFile`, `OpenVideo`, `StartPipeline`, `SeekTo`, `UpdatePlayhead`, `StopPipeline`, `ExportSRT`, `GetSettings`, `SaveSettings`).
  - Bắn sự kiện định dạng chuẩn qua `runtime.EventsEmit`.
- **Test nghiệm thu:**
  - Chạy lại toàn bộ test Bước 1 + 2 + 3.
  - `Test_App_ExportSRT`: Test xuất file SRT định dạng chuẩn cho cả 3 mode: `source`, `target`, `bilingual`.
  - `Test_App_OpenVideo_ProbeAndCache`: Mở video mẫu, nạp cache và trả về `VideoInfo` chính xác.
  - **Tiêu chuẩn hoàn thành:** Toàn bộ test Bước 1 -> 4 PASS 100%.

### Bước 5: Frontend UI & Subtitle Sync Engine
- **Mục tiêu:**
  - Xây dựng giao diện chuẩn VLC/IINA phong cách dark tối giản: Header, Video Player, Seekbar hiển thị dải vùng `done_blocks`, Overlay phụ đề chống click, Panel danh sách phụ đề có thể click để tua.
  - Xử lý đồng bộ `requestVideoFrameCallback` / RAF, debounce `SeekTo` 250ms khi thả thanh trượt.
  - Hệ thống phím tắt đầy đủ (Space, mũi tên, Shift+mũi tên, F, M, V, G/H chỉnh offset, Ctrl+O).
- **Test nghiệm thu:**
  - Chạy lại toàn bộ test Backend Bước 1 -> 4.
  - Frontend Component / Logic Test:
    - Test debounce SeekTo không bắn lệnh khi đang kéo chuột.
    - Test phím tắt cập nhật đúng trạng thái (V đổi chế độ subtitle, G/H dịch offset).
    - Test lọc bỏ các event subtitle có `video` path khác video hiện tại.
  - **Tiêu chuẩn hoàn thành:** Toàn bộ test Backend + Frontend PASS 100%.

### Bước 6: Scripts Tự Động Hóa & Kiểm Thử E2E Toàn Diện
- **Mục tiêu:**
  - Viết `scripts/download-tools.ps1`: Tải tự động ffmpeg/ffprobe, whisper-cli, llama-cli và 2 model (`ggml-base.bin`, `qwen2.5-0.5b-instruct-q4_k_m.gguf`), hỗ trợ resume download và verify hash.
  - Viết tài liệu `SETUP.md`.
  - Thực hiện kịch bản kiểm thử E2E theo mục 9 & 10 của spec.
- **Test nghiệm thu:**
  - Chạy toàn bộ test tự động (Backend + Frontend).
  - Nghiệm thu thực tế trên video dài theo đúng 7 tiêu chí của Mục 10.
  - **Tiêu chuẩn hoàn thành:** Hệ thống sẵn sàng đóng gói và phân phối (`wails build`).

---

## 14. ĐẶC TẢ SCRIPT TẢI TOOLS & MODELS (`scripts/download-tools.ps1`)

- **Nguồn tải:**
  - `ffmpeg` & `ffprobe`: Bản build tĩnh cho Windows từ Gyan.dev hoặc BtbN GitHub Releases.
  - `whisper-cli` + DLLs: Bản phát hành chính thức từ `ggerganov/whisper.cpp` GitHub Releases.
  - `llama-cli` + DLLs: Bản phát hành chính thức từ `ggerganov/llama.cpp` GitHub Releases.
  - Model Whisper (`ggml-base.bin`): Hugging Face (`ggerganov/whisper.cpp`).
  - Model Llama (`qwen2.5-0.5b-instruct-q4_k_m.gguf`): Hugging Face (`Qwen/Qwen2.5-0.5B-Instruct-GGUF`).
- **Yêu cầu script:**
  - Kiểm tra file đích đã tồn tại và đúng kích thước/hash chưa; nếu đã có thì bỏ qua (idempotent).
  - Hỗ trợ tải lại khi rớt mạng (resume download với BITS / System.Net.Http).
  - Đặt đúng cấu trúc cây thư mục độc lập trong `build/bin/tools/` và `build/bin/models/` để tránh xung đột file DLL `ggml.dll` giữa Whisper và Llama.

---

Với mỗi file: xuất **toàn bộ nội dung**, không rút gọn bằng "…phần còn lại giữ nguyên". Nếu một yêu cầu trong prompt này mâu thuẫn hoặc không khả thi, **nêu rõ mâu thuẫn và đề xuất phương án**, đừng tự lặng lẽ bỏ qua.
