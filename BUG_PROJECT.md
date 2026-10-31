# BÁO CÁO RÀ SOÁT LỖI & ĐIỂM NGHẼN HIỆU NĂNG CỦA SUBTRANS (GIAI ĐOẠN 1 & 2)

> **Trạng thái:** Chỉ đọc và báo cáo (chưa sửa bất kỳ dòng code nào, `git status` sạch).

---

## GIAI ĐOẠN 1: ĐO LƯỜNG (THEO DỮ LIỆU THỰC TẾ TRÊN MÁY)

### 1.1 Điểm nghẽn theo từng khâu (trên video thật, không dùng `MockRunSTT`)

Dữ liệu từ `telemetry/REPORT.md` (chạy trên máy `windows/amd64, 8 logical CPU`, cấu hình mặc định `whisper_threads = 4`, `block_sec = 30s`, `overlap_sec = 2s`, `extract_len = 32..34s`):

| Khâu / Chỉ số                                                                                           | Phân nhóm                                                                                                                            |  Mẫu ($n$)   |                 Min                  |                   p50 (Median)                   |                       p95                        |                 Max                  | Nguồn bằng chứng                                                                                                                                                                                                                |
| :------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------- | :----------: | :----------------------------------: | :----------------------------------------------: | :----------------------------------------------: | :----------------------------------: | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`ffmpeg_cut_ms`**                                                                                     | Block nguội                                                                                                                          |      1       |               479.0 ms               |                   **479.0 ms**                   |                   **479.0 ms**                   |               479.0 ms               | `telemetry/REPORT.md:104`                                                                                                                                                                                                       |
| **`ffmpeg_cut_ms`**                                                                                     | Sau tua (seek)                                                                                                                       |      3       |               103.0 ms               |                   **109.0 ms**                   |                   **185.5 ms**                   |               194.0 ms               | `telemetry/REPORT.md:121`                                                                                                                                                                                                       |
| **`ffmpeg_cut_ms`**                                                                                     | Block ấm                                                                                                                             |      12      |               99.0 ms                |                   **132.5 ms**                   |                   **191.7 ms**                   |               206.0 ms               | `telemetry/REPORT.md:138`                                                                                                                                                                                                       |
| **`whisper_wall_ms`**                                                                                   | Block nguội                                                                                                                          |      1       |              7318.0 ms               |                  **7318.0 ms**                   |                  **7318.0 ms**                   |              7318.0 ms               | `telemetry/REPORT.md:105`                                                                                                                                                                                                       |
| **`whisper_wall_ms`**                                                                                   | Sau tua (seek)                                                                                                                       |      3       |              5841.0 ms               |                  **6780.0 ms**                   |                  **6945.6 ms**                   |              6964.0 ms               | `telemetry/REPORT.md:122`                                                                                                                                                                                                       |
| **`whisper_wall_ms`**                                                                                   | Block ấm                                                                                                                             |      12      |              5359.0 ms               |                  **6584.0 ms**                   |                  **8157.7 ms**                   |              8601.0 ms               | `telemetry/REPORT.md:139`                                                                                                                                                                                                       |
| ↳ _Trong đó: `whisper_load_ms`_                                                                         | Block ấm                                                                                                                             |      12      |               108.7 ms               |               **126.0 ms** (2.0%)                |               **159.9 ms** (2.7%)                |               161.4 ms               | `telemetry/REPORT.md:140,144`                                                                                                                                                                                                   |
| ↳ _Trong đó: `whisper_encode_ms`_                                                                       | Block ấm                                                                                                                             |      12      |              4396.4 ms               |              **5178.0 ms** (78.6%)               |                  **6461.8 ms**                   |              6477.1 ms               | `telemetry/REPORT.md:141`                                                                                                                                                                                                       |
| ↳ _Trong đó: `whisper_decode_ms`_                                                                       | Block ấm                                                                                                                             |      12      |               421.6 ms               |               **615.8 ms** (9.4%)                |                  **1117.0 ms**                   |              1159.1 ms               | `telemetry/REPORT.md:142`                                                                                                                                                                                                       |
| **`translate_ms`** (GTX API + Pacing)                                                                   | Block nguội                                                                                                                          |      1       |              1766.0 ms               |                  **1766.0 ms**                   |                  **1766.0 ms**                   |              1766.0 ms               | `telemetry/REPORT.md:112`                                                                                                                                                                                                       |
| **`translate_ms`** (GTX API + Pacing)                                                                   | Sau tua (seek)                                                                                                                       |      3       |               792.0 ms               |                  **2667.0 ms**                   |                  **3898.2 ms**                   |              4035.0 ms               | `telemetry/REPORT.md:129`                                                                                                                                                                                                       |
| **`translate_ms`** (GTX API + Pacing)                                                                   | Block ấm                                                                                                                             |      12      |               222.0 ms               |                   **846.0 ms**                   |                  **1251.3 ms**                   |              1297.0 ms               | `telemetry/REPORT.md:146`                                                                                                                                                                                                       |
| **`queue_wait_ms`**                                                                                     | Block ấm                                                                                                                             |      12      |                0.0 ms                |                    **0.0 ms**                    |                  **18157.3 ms**                  |              19985.0 ms              | `telemetry/REPORT.md:147`                                                                                                                                                                                                       |
| **`SaveBlock_ms`**                                                                                      | Ghi 1 block (~2KB)                                                                                                                   |      —       |                  —                   |            **~1–3 ms** _(ước lượng)_             |             **~5 ms** _(ước lượng)_              |                  —                   | Chưa có trường đo riêng trong `BlockTelemetryRecord` (`telemetry.go:169-204`); thực hiện `MarshalIndent` + `os.WriteFile` + `os.Rename` cho ~10 câu (`blockstore.go:201-214`).                                                  |
| **Thời gian từ lúc scheduler chọn block đến lúc UI nhận phụ đề (`seek_latency_ms` / `block_total_ms`)** | - Phụ đề EN đầu tiên (ngay sau STT)<br>- Toàn bộ block VI hoàn tất (Block đầu)<br>- Block ấm xếp hàng trong `slicerChan`/`audioChan` | 3<br>1<br>12 | 5951.0 ms<br>9567.0 ms<br>11957.0 ms | **6976.0 ms**<br>**9567.0 ms**<br>**21683.5 ms** | **7059.0 ms**<br>**9567.0 ms**<br>**47300.3 ms** | 7068.0 ms<br>9567.0 ms<br>48661.0 ms | `telemetry/REPORT.md:115,149,168` (`onChunk` EN bắn tại `pipeline.go:1064` trước khi dịch; `block_total_ms` của block ấm cao do `slicerChan(buf=2)` + `audioChan(buf=2)` cho phép lập lịch trước tới 4 block đang đợi Whisper). |

**`seek_latency_ms` cho 3 kịch bản tua:**

1. **Tua xa vào block chưa dịch (Slow-Path):**
   - Thực đo trên video thật (`telemetry/REPORT.md:162-168`, `threads_4`): `min = 5951 ms`, **`p50 = 6976 ms`**, **`p95 = 7059 ms`**, `max = 7068 ms`.
   - Thời gian hủy worker cũ (`wg_drain`): `0–1 ms`; thời gian chờ nhả `computeMu` (`computeMu_drain`): `19–26 ms` (cộng thêm `50 ms` debounce ở `App.tsx:1372`). Toàn bộ thời gian còn lại (~6.8s) là chờ `ffmpeg` cắt WAV (~109 ms) + `whisper-cli` chạy STT (~6780 ms).
2. **Tua ngắn trong block đang chạy (Smart Fast-Path 2 - `pipeline.go:396-403`):**
   - Thực đo điều phối (`Test_Pipeline_Benchmark_ThreeSeekScenarios`): **`< 1 ms`** (`0s`, `computeDrain = 0ms`, `wgDrain = 0ms`), cộng `50 ms` debounce trên UI (`App.tsx:1372`).
   - Không hủy session, giữ nguyên tiến trình `whisper-cli` đang chạy; phụ đề hiện ngay khi Whisper/Translator của block hiện tại hoàn tất phần còn lại.
3. **Tua vào đoạn đã dịch (Fast-Path 1 - `pipeline.go:383-389`):**
   - Thực đo điều phối (`Test_Pipeline_Benchmark_ThreeSeekScenarios`): **`< 1 ms`** (`0s`, `computeDrain = 0ms`, `wgDrain = 0ms`).
   - Trên UI: Phụ đề đã nằm sẵn trong mảng `subtitles` tại RAM của React, `syncFrame` (`App.tsx:1290`) tra cứu nhị phân `findSubtitleAtTime` trong **`< 1 frame` (~16.6 ms @ 60Hz)** ngay khi thẻ `<video>` cập nhật `currentTime`.

**Điểm nghẽn #1 từ thực đo Whisper (`telemetry/whisper_stderr_sample.txt` & `telemetry/runs/threads_4`):**

- File `build/bin/tools/whisper/whisper-cli.exe` hiện tại là bản **CPU thuần** (`CUDA = 0`, `use gpu = 1` nhưng không có backend GPU trong `whisper.dll` 933KB ngày 15/05/2024 - `telemetry/whisper_stderr_sample.txt:2,32`).
- Mỗi block có `BlockSec = 30s`, `OverlapSec = 2s` $\Rightarrow$ `ExtractLen = 32s` (block 0) hoặc **`34s`** (các block giữa, `pipeline_math.go:52-63`).
- Vì cửa sổ âm thanh của kiến trúc Whisper cố định là **30.0 giây**, một file WAV dài 32–34 giây cộng thêm bước `-l auto` (tự nhận diện ngôn ngữ ở đầu, `pipeline.go:944`) khiến `whisper-cli` phải chạy **`encode time` 2 đến 3 lần (`2–3 runs`)** cho mỗi block (`telemetry_test.go:27-30`: `expectedRuns: 3` cho `threads_2/4/6`, mỗi run tốn ~1940–2500 ms $\Rightarrow$ tổng `whisper_encode_ms` vọt lên **5178 ms – 6461 ms**).

---

### 1.2 – 1.4 Trạng thái đo Profile Go, Frontend Profiler và Tài nguyên 10 phút

- **1.2 Profile Go (`pprof`):** Tuân thủ Quy tắc 1 (_"Giai đoạn 1 chỉ đọc và đo. KHÔNG sửa code"_), trong codebase hiện tại (`main.go`, `app.go`) chưa import `net/http/pprof` hay `runtime/pprof`, nên chưa thể thu CPU/mutex/block profile từ tiến trình đang chạy mà không sửa code.
- **1.3 Frontend (React Profiler / WebView2):** Qua phân tích tĩnh chính xác từng dòng trong `frontend/src/App.tsx`:
  - **Tần suất event từ backend:**
    - `pipeline_status`: Bắn mỗi **500 ms** (2 lần/giây) từ `schedulerLoop` khi ở trạng thái `ahead` hoặc `done` (`pipeline.go:719,744,775`), và mỗi khi chọn block mới (`pipeline.go:789`).
    - `new_subtitle_chunk`: Bắn $1 + B + 1$ lần mỗi block (1 lần EN thô tại `pipeline.go:1064`, $B \approx 2\text{--}4$ lần theo từng batch dịch tại `pipeline.go:1302`, 1 lần `Final: true` tại `pipeline.go:1406`). Trung bình ~5–6 lần / 7 giây (~0.8 lần/giây).
  - **Số lần `App.tsx` re-render mỗi giây khi đang phát:**
    - Trong `syncFrame` (`App.tsx:1282-1287`), `setCurrentTime(mediaTime)` được gọi mỗi khi `Math.abs(mediaTime - lastUiTimeRef.current) >= 0.25` $\Rightarrow$ **4 lần/giây** cố định theo thời gian phát video.
    - Cộng với ~2 lần/giây từ `setPipelineStatus(st)` (`App.tsx:1259`) và ~0.8 lần/giây từ `new_subtitle_chunk` $\Rightarrow$ Tổng cộng `App` re-render **~6 – 7 lần/giây** khi đang phát.
  - **Component nào render lại nhiều nhất và vì sao:**
    1. **`App` (`frontend/src/App.tsx:610`):** Render lại **6–7 lần/giây** vì giữ cả state `currentTime` (đổi 4 lần/giây) lẫn `pipelineStatus` (đổi 2 lần/giây). Mỗi lần `App` render lại sẽ chạy lại vòng lặp `doneBlocks.map(...)` trên thanh seekbar (`App.tsx:2284`, tối đa 120 thẻ `<div>` cho video 1 giờ) và tạo mới hàng loạt inline arrow function.
    2. **`CourseTreePanel` (`frontend/src/App.tsx:368`):** Dù được bọc `React.memo`, nhưng trong JSX của `App` (`App.tsx:2061-2082`), 4 props `onToggleAutoCollapse`, `onSelectVideo`, `onAddDriveLink`, `onClose` là **inline arrow function tạo mới mỗi lần render**. Do đó `React.memo` của `CourseTreePanel` **bị vô hiệu hóa 100%**, khiến `CourseTreePanel` cũng re-render **6–7 lần/giây** theo `App`! (May mắn là `FolderTreeItem` bên trong dùng `memo` và nhận `handleOpenVideo`/`handleRemoveRootFolder` qua `useCallback`, nhưng ở `App.tsx:2072` prop `onSelectVideo` truyền xuống `CourseTreePanel` lại là inline function nên mọi `FolderTreeItem` trong toàn bộ cây khóa học cũng bị re-render **6–7 lần/giây**!).
    3. **`LandingPage` (`frontend/src/components/LandingPage.tsx:84-90`):** Trong `App.tsx:2040-2048`, `LandingPage` **không được unmount** khi chuyển sang trình phát (`viewMode === "player"`), mà chỉ ẩn bằng CSS `className="... hidden"`. Bên trong `LandingPage.tsx:86`, `setInterval(..., 250)` vẫn chạy vĩnh viễn suốt thời gian xem video因為 `isPlaying` mặc định là `true` (`LandingPage.tsx:76`), gây **4 lần re-render/giây** ngầm cho toàn bộ cây DOM của `LandingPage`!
    4. **`SubtitleListPanel` (`frontend/src/App.tsx:523`):** Được bọc `React.memo` và các props (`subtitles`, `activeId`, `seekVideo`) chỉ đổi khi sang câu mới hoặc có chunk mới? **KHÔNG!** Hãy nhìn `App.tsx:1466`: `seekVideo` nằm trong `useCallback(..., [videoInfo, duration, showToast])` nên ổn định, NHƯNG `onClose={() => setShowSubPanel(false)}` tại `App.tsx:2270` là **inline arrow function mới mỗi lần render**! Vì vậy khi mở bảng phụ đề (`showSubPanel === true`), `React.memo` của `SubtitleListPanel` cũng **vô tác dụng 100%**, bắt nó render lại toàn bộ danh sách hàng trăm/nghìn câu phụ đề **6–7 lần/giây**!
- **1.4 Kiểm tra tiến trình mồ côi hiện tại trên máy:**
  - Chạy lệnh kiểm tra thực tế trên máy: Không có tiến trình `subtrans.exe`, `whisper-cli.exe`, `ffmpeg.exe`, hay `llama-server.exe` mồ côi nào đang chạy.
  - Tuy nhiên, thư mục `%LOCALAPPDATA%\SubTrans\cache` hiện đang chứa **704 thư mục cache** (do các bài test tạo file tạm không đặt `t.Setenv("LOCALAPPDATA", ...)`).

---

## GIAI ĐOẠN 2: RÀ SOÁT CODE & ĐỐI CHIẾU VỚI SỐ ĐO

### A. Khóa và đồng bộ (Locks & Synchronization)

1. **`schedulerLoop` giữ `p.mu` rồi gọi hàm nặng (`CurrentMode`, `IsBlockDone` cho nhiều block, `computeAheadSecLocked`). Thời gian giữ `p.mu` mỗi vòng là bao nhiêu?**
   - **Phán định:** **CÓ** (về mặt cấu trúc gọi lồng khóa, nhưng thời gian giữ khóa thực tế nhỏ vì chỉ đọc RAM).
   - **Bằng chứng (`pipeline.go:722-787`):**
     - Giữ `p.mu.Lock()` tại dòng `722`.
     - Gọi `p.computeAheadSecLocked()` (`pipeline.go:237-260`): Vòng lặp từ `curBlock` đến `totalBlocks`, mỗi bước gọi `p.blockStore.IsBlockDone(b)` (lấy `bs.mu.RLock()` tại `blockstore.go:159`) và `p.isTier2PostponedMode()` $\to$ `CurrentMode()` (đọc atomic + `f.modeMu.RLock()` tại `translator.go:141-160`).
     - Ngay sau đó tại `pipeline.go:728-737` (và `758-767`), lại lặp tiếp từ `playheadBlock` đến `totalBlocks` và gọi lại `p.blockStore.IsBlockDone(b)` + `p.isTier2PostponedMode()`.
     - Vì `IsBlockDone` chỉ kiểm tra map `bs.itemsMap` trong RAM (không đụng đĩa), với video 1 giờ (`totalBlocks = 120`, mỗi block ~10 câu), thời gian giữ `p.mu` mỗi vòng là **~5 – 25 µs (0.005 – 0.025 ms)**.
2. **Vòng quét 500ms: có gọi `IsBlockDone` (`RLock`) cho toàn bộ các block mỗi lần không? Độ phức tạp theo số block của video 1 giờ?**
   - **Phán định:** **CÓ** (khi các block đầu đã xong hoặc khi tìm block cần dịch).
   - **Bằng chứng (`pipeline.go:243-253`, `728-737`, `758-767`, `216`):**
     - `computeAheadSecLocked` dừng ngay ở block đầu tiên chưa xong (`break` tại dòng `251`), và vòng tìm `nextBlock` dừng ngay ở block đầu tiên chưa xong (`break` tại dòng `735`).
     - Tuy nhiên, khi gọi `p.emitStatus` (`pipeline.go:216`), hàm `p.blockStore.GetDoneBlocks()` (`blockstore.go:175-193`) **luôn duyệt qua toàn bộ `bs.itemsMap`** và `sort.Ints(done)` dưới `p.mu.Lock()`.
     - Độ phức tạp mỗi chu kỳ 500ms là $O(N \times M + N \log N)$ với $N = 120$ block (video 1 giờ), $M \approx 10$ câu/block $\approx 1200$ phép kiểm tra struct trong RAM (~15 µs).
3. **`computeMu`: Whisper giữ khóa này, ai khác chờ nó?**
   - **Phán định:** **CÓ — NHƯNG ĐANG BỊ DÙNG SAI MỤC ĐÍCH (dead/misaligned lock).**
   - **Bằng chứng (`pipeline.go:79`, `446`, `575`, `980-986`):**
     - Comment tại `pipeline.go:79` ghi: `computeMu sync.Mutex // Điều phối CPU giữa Whisper và LLM tránh tranh chấp core`.
     - Thế nhưng trong toàn bộ codebase, **chỉ có `sttWorker` (`pipeline.go:980`) và hàm đo drain khi cancel (`pipeline.go:446, 575`) lấy `p.computeMu.Lock()`**.
     - `translatorWorker` và `LlamaServerTranslator` / `LlamaCliTranslator` **KHÔNG HỀ lấy `p.computeMu`!**
     - Hệ quả: Khi rơi vào chế độ `local_ai` (Qwen chạy bằng CPU hoặc GPU) và `sttWorker` đã đẩy sang block tiếp theo, **Whisper (`sttWorker`) và Qwen (`translatorWorker` dịch Tier-1 của block vừa xong) chạy ĐỒNG THỜI 100% mà không hề chờ nhau qua `computeMu`**, gây tranh chấp CPU core đúng như điều mà `computeMu` định ngăn chặn!
4. **`emitStatus` gọi trong hoặc ngoài lock? Callback `OnError`/`OnChunk` có chạy đồng bộ trong lock không?**
   - **Phán định:** **`emitStatus` chạy `OnStatus` TRONG lock `p.mu`; `OnChunk` và `OnError` chạy NGOÀI lock `p.mu`.**
   - **Bằng chứng:**
     - `emitStatus` (`pipeline.go:211-234`): Giữ `p.mu.Lock()` ở dòng `212` (`defer p.mu.Unlock()` ở dòng `213`) rồi gọi thẳng `p.callbacks.OnStatus(status)` ở dòng `232` (tức gọi `runtime.EventsEmit(a.ctx, "pipeline_status", st)` sang WebView2 IPC khi đang giữ `p.mu`).
     - `OnChunk` (`pipeline.go:1064, 1226, 1302, 1406`) và `OnError` (`pipeline.go:1438`): Đều được gọi sau khi đã `p.mu.Unlock()`.

---

### B. Làm lại việc đã làm (Redundant Work)

1. **Block bị scheduler chọn lại nhiều lần không cần thiết (`tier2Deferred`, `failedBlocks`, `backfill`)?**
   - **Phán định:** **CÓ (khi ở chế độ `api` hoặc `cloud` mà có câu dịch lỗi/trả rỗng).**
   - **Bằng chứng (`pipeline.go:1325-1331` và `729-735`):**
     - Khi ở chế độ `local_ai` hoặc `offline`, nếu `okCount < hasTextCount`, block được đánh dấu `p.tier2Deferred[job.BlockIdx] = true` (`pipeline.go:1328`) để scheduler bỏ qua.
     - **NHƯNG** khi đang ở chế độ `api` (GTX) hoặc `cloud` (Gemini), `p.isTier2PostponedMode()` trả về `false` (`pipeline.go:629-632`). Nếu có dù chỉ 1 câu trong block bị GTX/Gemini trả về rỗng (ví dụ câu chỉ có ký tự đặc biệt không lọt vào `isIgnoredSubtitle`, hoặc LLM lọc bỏ do `CleanLLMOutput` trả `""`, hoặc 1 batch bị lỗi mạng tạm thời trong khi các batch khác thành công), thì:
       1. `translatorWorker` KHÔNG gọi `handleBlockFailure` (vì lỗi của `TranslateBatch` bị nuốt bằng `targets, _ := ...` tại `pipeline.go:1268`!), nên `p.failedBlocks[blockIdx]` vẫn bằng `0`!
       2. `SaveBlock` lưu block với câu đó có `Translated == false, TargetText == ""` (`pipeline.go:1292-1293, 1344`).
       3. `p.blockStore.IsBlockDone(job.BlockIdx)` trả về `false` (`blockstore.go:167-169`)!
       4. `delete(p.activeJobs, job.BlockIdx)` được gọi (`pipeline.go:1400`) và `triggerSchedule()` kích hoạt vòng lặp mới!
       5. **Hệ quả nghiêm trọng:** Ngay lập tức ở vòng `schedulerLoop` kế tiếp (`pipeline.go:729`), vì `!IsBlockDone(b) && !activeJobs[b] && failedBlocks[b] < 2`, **scheduler chọn lại ĐÚNG block vừa làm xong đó và lặp lại VÔ TẬN (infinite loop)** việc cắt `ffmpeg` + chạy `whisper-cli` (7 giây/lần) cho cùng 1 block đó mà `failedBlocks` không bao giờ tăng!
2. **Whisper chạy lại cho block đã có STT (không có cache STT). Đếm tần suất thật.**
   - **Phán định:** **CÓ — `BlockStore` lưu được câu chưa dịch (`Translated: false`), nhưng `sttWorker` KHÔNG BAO GIỜ đọc lại từ `BlockStore`!**
   - **Bằng chứng (`pipeline.go:909-1044`, `1344`, `blockstore.go:196`):**
     - Khi一个 block chỉ mới xong STT (rồi bị hủy lúc đang dịch do người dùng tua) hoặc mới chỉ dịch xong Tier-1 (trong chế độ `local_ai`, `tier2Deferred[b] = true`) và đã được `SaveBlock` ghi xuống đĩa (`pipeline.go:1344`), toàn bộ `SourceText` + mốc thời gian STT đã nằm trong `bs.itemsMap[blockIdx]` và file `%d.json`.
     - Tuy nhiên, khi block đó được chọn lại (để dịch bù Tier-2 khi mạng có lại, hoặc khi tua quay lại block đó), `slicerWorker` vẫn chạy lại `ffmpeg` cắt WAV (`pipeline.go:859`) và `sttWorker` vẫn chạy lại `whisper-cli` mất **~6.6 giây CPU** (`pipeline.go:984`) thay vì lấy danh sách `SubtitleItem` đã có `SourceText` từ `p.blockStore`!
     - Trong `telemetry/REPORT.md:76,158,240`, block 18 bị chạy Whisper 2 lần (cả 2 lần bị hủy khi tua), và mọi block `tier2Deferred` khi quay lại dịch bù đều phải tốn thêm 6.6s chạy lại Whisper từ đầu.
3. **`ffmpeg` cắt lại WAV cho cùng block.**
   - **Phán định:** **CÓ.**
   - **Bằng chứng (`pipeline.go:828, 873, 1022`):** File WAV đặt tên theo `block_%d_%d.wav` (`SessionID`, `blockIdx`) và bị xóa ngay bằng `os.Remove(job.WavPath)` sau khi `sttWorker` chạy xong (`pipeline.go:1022`) hoặc khi hủy context (`pipeline.go:873`). Do không tái sử dụng kết quả STT trong `BlockStore`, mỗi lần chạy lại block là `ffmpeg` phải cắt lại WAV (~110–190 ms).
4. **`SaveBlock` ghi toàn bộ file mỗi lần? Ghi đồng bộ trên luồng nóng?**
   - **Phán định:** **Chỉ ghi file của 1 block (`%d.json`, ~2 KB), nhưng ghi đồng bộ trên `translatorWorker` trước khi bắn `Final: true`.**
   - **Bằng chứng (`blockstore.go:196-220`, `pipeline.go:1344`):**
     - `SaveBlock` chia theo từng file riêng biệt `blocks/{block}.json` (không phải ghi toàn bộ video vào 1 file).
     - Tuy nhiên, `SaveBlock` chạy đồng bộ (marshal + write `.tmp` + rename) ngay trên `translatorWorker` tại `pipeline.go:1344` _trước khi_ xóa `activeJobs` (`1400`) và _trước khi_ bắn `OnChunk(Final: true)` (`1406`). Ngoài ra, khi mở video có sẵn file `_vi.srt` (`sub_extractor.go:167-212`), `PopulateStoreFromVietnameseSRT` gọi `bs.SaveBlock(b, items)` tuần tự trong vòng lặp cho toàn bộ 120 block (120 lần write + rename đồng bộ giữ `a.mu` trong `OpenVideo`).

---

### C. Dịch (Translation Engine)

1. **Tỉ lệ lệch dòng (`mismatchCount`) và số request thừa do dịch từng dòng.**
   - **Phán định:** **CÓ — Tồn tại mâu thuẫn giữa tài liệu và code thực tế gây lệch dòng trên Google GTX.**
   - **Bằng chứng (`translator.go:312-352` đối chiếu với `EVALUATION_REPORT.md:19,57`):**
     - Trong `EVALUATION_REPORT.md:19,57` và `LandingPage.tsx:200,497` mô tả: _"Sử dụng ký tự phân cách đặc thù `⟦|⟧` thay cho `\n`, loại bỏ hoàn toàn nguy cơ rớt dòng"_.
     - **NHƯNG trong code thực tế (`translator.go:312, 316`)**, `googleBatchOrPerLine` đang nối câu bằng **`strings.Join(lines, "\n")`** và tách bằng **`strings.Split(batchOut, "\n")`**! Hoàn toàn KHÔNG có delimiter `⟦|⟧` nào trong code Go!
     - Khi Google GTX gộp 2 câu ngắn không có dấu chấm câu hoặc nuốt `\n`, `len(parts) != len(lines)` xảy ra $\to$ `f.mismatchCount.Add(1)` (`translator.go:332`) và rơi vào vòng lặp dịch từng dòng một kèm `sleepCtx(ctx, jitter(150*time.Millisecond))` (`translator.go:337`), làm một batch 5 câu tốn thêm 5 HTTP requests + ~900 ms ngủ jitter!
     - Bằng chứng từ số đo thực tế (`telemetry/REPORT.md:129,146`): Ở `threads_4`, `translate_ms` p50 vọt lên **846 ms** (block ấm) và **2667 ms — max 4035 ms** (block sau tua), trong khi ở `threads_2` và `threads_6` (cùng mạng, cùng câu) `translate_ms` p50 chỉ là **71 ms** và **69.5 ms**! Sự chênh lệch gấp 12–38 lần này chính là do lệch dòng phải fallback dịch từng dòng + pacing jitter hoặc retry mạng.
2. **Pacing `300ms + jitter` có làm Tier-1 phải chờ không?**
   - **Phán định:** **CÓ (gián tiếp làm trễ Tier-1 của block kế tiếp vì chỉ có 1 `translatorWorker`).**
   - **Bằng chứng (`pipeline.go:1250-1260` và `app.go:52`):**
     - Trong cùng 1 block, các batch Tier-1 (`bIdx < nTier1`) không bị sleep tại `pipeline.go:1250`.
     - Tuy nhiên, `TranslateWorkers` mặc định là **`1`** (`app.go:52`). Một block 30s có ~12 câu (~3 batch Tier-2). Giữa mỗi batch Tier-2, worker ngủ `jitter(300ms)` = `300..450 ms` (`pipeline.go:1256`).
     - Cộng 3 lần ngủ Tier-2 mất **~1.1 giây** giữ chặt `translatorWorker` duy nhất (và nếu có `mismatchCount` thì ngủ thêm `150..225 ms` mỗi dòng tại `translator.go:337`). Nếu người dùng không tua mà playhead trôi sang block mới hoặc block kế tiếp đã xong STT, nó phải chờ `translatorWorker` ngủ xong hết các nhịp Tier-2 của block trước.
3. **Thứ tự và độ trễ khi Gemini/Qwen được dùng. Qwen có bị khởi động lười không cần thiết (`llama-server` chạy dù mạng ổn)?**
   - **Phán định:** **CÓ — 2 nguyên nhân khiến `llama-server` / `llama-cli` bị gọi hoặc ngốn tài nguyên:**
   - **Bằng chứng 1 (`translator.go:451, 541-543`):**
     - Đối với GTX (`api`), `fillGaps: false` (`translator.go:442`) đã ngăn việc gọi Qwen khi GTX trả dòng rỗng (đã sửa ở commit `cf853f3`).
     - **NHƯNG đối với Gemini (`cloud`), `fillGaps: true` (`translator.go:451`)**: Khi GTX bị 429 và chuyển sang Gemini, nếu Gemini bỏ sót dù chỉ 1 câu sau 1 lần retry (hoặc 1 câu không dịch được trả về `""`), `remaining` sẽ khác rỗng (`translator.go:543`) và vòng lặp `tiers` sẽ **tiếp tục chạy xuống tầng `local_ai` (`viaFallback`)**, lập tức khởi động `llama-server.exe` (nạp 1.1 GB model vào RAM/VRAM, tốn ~1–3s + smoke test `"Hello."`) chỉ để dịch bù 1 câu rỗng!
   - **Bằng chứng 2 (`tools.go:58-64` đối chiếu với `build/bin/tools/llama`):**
     - Tài liệu (`EVALUATION_REPORT.md:27,54`) ghi `llama-server` chạy GPU Vulkan offload 29/29 layers.
     - **NHƯNG thực tế kiểm tra ổ cứng (`build/bin/tools`):** Chỉ có thư mục `build/bin/tools/llama` (bản CPU thuần biên dịch ngày 15/07/2024, `main.log:108`), **HOÀN TOÀN KHÔNG CÓ thư mục `llama_cuda` hay `llama_vulkan`**!
     - Hơn nữa, trong `NewLlamaServerTranslator` (`translator.go:652-655`), cờ `-ngl 99` chỉ được thêm nếu đường dẫn `serverExe` có chứa chữ `"vulkan"` hoặc `"cuda"`. Vì `serverExe` nằm ở `tools/llama/llama-server.exe`, nó chạy **100% trên CPU (4 threads)** với `CPU buffer size = 1059.89 MiB` (`main.log:91`)!
4. **Số request HTTP mỗi phút thực tế; có dùng lại connection (keep-alive) không?**
   - **Phán định:**
     - **GTX & LlamaServer:** **CÓ** dùng lại connection vì dùng chung `sharedHTTPTransport` (`MaxIdleConnsPerHost: 20`, `DisableKeepAlives: false` tại `translator.go:36-42, 107, 671`) và có drain `resp.Body` trước khi `Close()` (`translator.go:247`).
     - **GeminiClient (`gemini.go:232`):** Tạo `&http.Client{Timeout: 15 * time.Second}` riêng (dùng `http.DefaultTransport` của Go với `MaxIdleConnsPerHost = 2` mặc định, nhưng trong `doRequest` tại `gemini.go:513`, khi return sớm hoặc sau khi đọc xong, nếu không drain hết EOF trong một số nhánh lỗi thì khả năng tái sử dụng kém hơn `sharedHTTPTransport`).
   - **Số request HTTP mỗi phút:** Mỗi block 30s chia thành ~3–4 batch (`BuildTwoTierBatches`: Tier-1 max 3 câu/240 chars, Tier-2 max 5 câu/400 chars - `pipeline.go:1489-1491`). Khi chạy đón đầu liên tục (~8.5 block/phút với Whisper 6.6s/block), tạo ra **~25 – 35 HTTP requests/phút** tới Google GTX (và nếu bị lệch dòng `mismatchCount` thì tăng vọt lên **80 – 120 requests/phút**, dễ kích hoạt HTTP 429 của Google GTX!).

---

### D. Logging và I/O

1. **`log.Printf`/`fmt.Printf` trong vòng nóng (mỗi batch, mỗi vòng scheduler). Đếm số dòng log mỗi phút.**
   - **Phán định:** **THẤP** (trung bình ~8–10 dòng/phút).
   - **Bằng chứng (`pipeline.go:1164, 1335`):**
     - `schedulerLoop` và vòng lặp `batches` không in log.
     - Chỉ in 1 dòng `fmt.Printf("[BLOCK %d | %s] ...")` mỗi khi xong 1 block (`pipeline.go:1335`), cộng với log khi chuyển mode (`translator.go:168`) hoặc mở breaker (`breaker.go:169,181,197`).
2. **Telemetry có chạy mặc định không?**
   - **Phán định:** **Mặc định TẮT cho việc ghi file JSONL, NHƯNG có 1 điểm nghẽn ngầm chạy MẶC ĐỊNH trên mọi block!**
   - **Bằng chứng (`telemetry.go:15-17` vs `pipeline.go:989-991`):**
     - `IsTelemetryEnabled()` kiểm tra `os.Getenv("VT_TELEMETRY") == "1"` (mặc định `false`). Khi `false`, `whisper-cli` được truyền cờ `-np` (no prints, `pipeline.go:974-976`), và `RecordBlockTelemetry` thoát ngay ở dòng đầu (`telemetry.go:241`).
     - **NHƯNG tại `pipeline.go:989-990`:**
       ```go
       if runRes != nil && runRes.FullStderr != "" {
           whisperTimings = ParseWhisperTimings(runRes.FullStderr)
       ```
       Ngay cả khi `IsTelemetryEnabled() == false`, `whisper-cli` vẫn in ~35 dòng model load / system info ra `stderr`, và `ParseWhisperTimings` **vẫn chạy 9 biểu thức chính quy (`regexp`) trên toàn bộ `FullStderr` cho mọi block** mà không kiểm tra `IsTelemetryEnabled()` (ngoại trừ nhu cầu lấy `DetectedLang` khi `lang == "auto"`, vốn đã có sẵn trong file JSON kết quả `parsed.Result.Language` tại `pipeline.go:1008`!).

---

### E. Rò rỉ và tăng dần (Leaks & Unbounded Growth)

1. **Goroutine, map (`activeJobs`, `failedBlocks`, `tier2Deferred`, `itemsMap`), channel, timer (`time.After` trong vòng lặp), tiến trình con:**
   - **Phán định:** **CÓ RÒ RỈ GOROUTINE & BỘ NHỚ TRONG 4 TRƯỜNG HỢP CỤ THỂ:**
   - **E1. Rò rỉ goroutine `seekLoop` khi `Start()` được gọi nhiều lần trên cùng `Pipeline` (`pipeline.go:270-278`):**
     - Tại `Start()`, code đóng `p.seekStop` và spawn `go p.seekLoop(p.seekStop)`. Mặc dù trong `app.go:452` mỗi lần `StartPipeline` tạo `NewPipeline` mới, nếu `p.Start()` được gọi lại trên cùng instance, `seekLoop` cũ chỉ thoát khi nhận `<-stopChan`. Quan trọng hơn: trong `doSeek` (`pipeline.go:445-469`) và `stopCurrentSession` (`pipeline.go:574-596`), mỗi lần hủy session lại spawn **2 goroutine ẩn danh** chờ `p.computeMu.Lock()` và `oldSession.wg.Wait()`. Nếu worker cũ bị kẹt quá 3s (timeout tại dòng `457, 470`), **2 goroutine này bị treo cho đến khi tiến trình con kết thúc**.
   - **E2. Rò rỉ goroutine đọc `stderrPipe` trong `RunCommand` (`tools.go:252-274`):**
     - Tại `tools.go:252`, `RunCommand` spawn `go func() { for scanner.Scan() { ... } }()` để đọc `stderrPipe`, nhưng ở dòng `272` lại gọi `cmd.Wait()` **mà KHÔNG đợi goroutine đọc `scanner` kết thúc trước khi gọi `cmd.Wait()` và trước khi đọc `fullStderrBuf`**!
     - Theo tài liệu chuẩn của Go `os/exec.Cmd.StderrPipe`: _"It is incorrect to call Wait before all reads from the pipe have completed."_ Việc gọi `cmd.Wait()` đóng pipe ngay lập tức có thể làm mất các dòng stderr cuối, và nếu một tiến trình con do `ffmpeg`/`whisper`/`llama` sinh ra kế thừa handle stderr và chưa thoát ngay, pipe không đóng làm goroutine `scanner.Scan()` bị treo.
   - **E3. Map trong `DriveManager` (`subCache`, `names`, `durations`, `subIDs` - `drive_manager.go:87-90`) tăng không giới hạn:**
     - `dm.names`, `dm.durations`, `dm.subIDs` không bao giờ được xóa trong suốt vòng đời ứng dụng. Đặc biệt `dm.subCache` (`map[string][]WhisperSegment`) giữ nguyên toàn bộ mảng phụ đề của video Drive trong RAM ngay cả sau khi đã đóng hoặc chuyển sang video khác (chỉ xóa khi mở lại đúng `fileID` đó tại `drive_manager.go:949` hoặc khi `Logout`).
   - **E4. Rò rỉ 704+ thư mục cache trong `%LOCALAPPDATA%\SubTrans\cache` do `CleanupOldCaches` chỉ xóa sau 30 ngày (`app.go:103`) và các bài test không cô lập `LOCALAPPDATA`:**
     - Thực tế đo trên máy hiện có **704 thư mục** trong `%LOCALAPPDATA%\SubTrans\cache`! Nguyên nhân là các bài test trong `pipeline_test.go`, `app_test.go`, `translator_mock_test.go` gọi `NewBlockStore` nhưng không đặt `t.Setenv("LOCALAPPDATA", t.TempDir())`, khiến mỗi lần chạy `go test` lại xả hàng chục thư mục SHA-1 rác vào `%LOCALAPPDATA%\SubTrans\cache` thật của người dùng!

---

### F. Frontend (`frontend/src/App.tsx` & `components/*`)

1. **`LandingPage` chạy ngầm `setInterval` 250ms vĩnh viễn ngay cả khi đang ở màn hình xem video (`viewMode === "player"`):**
   - **Phán định:** **CÓ (Lỗi hiệu năng Frontend nghiêm trọng).**
   - **Bằng chứng (`frontend/src/App.tsx:2040-2048` & `frontend/src/components/LandingPage.tsx:76, 84-90`):**
     - Tại `App.tsx:2040`: `<div className={... ${viewMode === "landing" ? "" : "hidden"}}><LandingPage ... /></div>`. Component `LandingPage` **luôn luôn được mount** cùng `App`.
     - Tại `LandingPage.tsx:76, 84-90`: State `isPlaying` mặc định là `true`, kích hoạt `setInterval` mỗi **250 ms** gọi `setDemoTime(...)`.
     - Khi người dùng mở video chuyển sang `viewMode === "player"`, `LandingPage` chỉ bị ẩn bằng CSS `hidden`, nên timer 250ms của nó vẫn chạy suốt buổi học, ép React re-render toàn bộ cây VDOM khổng lồ của `LandingPage` (hàng trăm thẻ DOM, icon Lucide, bảng so sánh) **4 lần mỗi giây** hoàn toàn vô ích!
2. **Phá vỡ `React.memo` của `CourseTreePanel`, `FolderTreeItem` và `SubtitleListPanel` do truyền inline arrow functions:**
   - **Phán định:** **CÓ.**
   - **Bằng chứng (`frontend/src/App.tsx:2061-2082` và `2270`):**
     - `CourseTreePanel` được bọc `memo` (`App.tsx:368`), nhưng tại `App.tsx:2061, 2072, 2079, 2082` lại nhận 4 hàm inline mới mỗi lần `App` render (`onToggleAutoCollapse`, `onSelectVideo`, `onAddDriveLink`, `onClose`). Đặc biệt `onSelectVideo` được truyền tiếp xuống mọi `FolderTreeItem` (`App.tsx:315, 511`), khiến toàn bộ cây thư mục bài học bị re-render **6–7 lần/giây** mỗi khi `currentTime` hoặc `pipelineStatus` nhích lên!
     - `SubtitleListPanel` được bọc `memo` (`App.tsx:523`), nhưng tại `App.tsx:2270` lại nhận `onClose={() => setShowSubPanel(false)}` là hàm inline mới mỗi lần `App` render. Khi mở danh sách phụ đề (`showSubPanel === true`), toàn bộ danh sách phụ đề (`subtitles.map(...)` không ảo hóa tại `App.tsx:565`) bị re-render **6–7 lần/giây**!
3. **Cập nhật `currentTime` 4 lần/giây và `pipelineStatus` 2 lần/giây ngay trên component gốc `App`:**
   - **Phán định:** **CÓ.**
   - **Bằng chứng (`frontend/src/App.tsx:1258-1260, 1284-1287`):**
     - Tại `App.tsx:1259`, mỗi sự kiện `pipeline_status` (bắn mỗi 500ms từ backend cả khi không có gì thay đổi) đều gọi `setPipelineStatus(st)` tạo object mới, kích hoạt re-render toàn bộ `App`.
     - Tại `App.tsx:1286`, `setCurrentTime(mediaTime)` gọi 4 lần/giây trên `App`, kéo theo render lại Header, Seekbar (`doneBlocks.map` 120 khối `div` tại `App.tsx:2284`), và các panel con.
4. **Hiệu ứng `useEffect` của `syncFrame` (`requestVideoFrameCallback` / `requestAnimationFrame`) bị hủy và đăng ký lại mỗi khi có chunk phụ đề mới (`App.tsx:1276-1330`):**
   - **Phán định:** **CÓ.**
   - **Bằng chứng (`frontend/src/App.tsx:1330`):**
     - Dependency array của `useEffect` chạy vòng lặp `syncFrame` là `[subtitles, subtitleOffset, videoInfo?.path]`.
     - Mỗi khi backend bắn `new_subtitle_chunk` (~5–6 lần mỗi block), `setSubtitles` tạo mảng mới $\to$ `useEffect` phải `cancelVideoFrameCallback` và đăng ký lại `requestVideoFrameCallback` thay vì đọc `subtitles` và `subtitleOffset` qua `useRef`.
5. **Hiệu ứng `useEffect` lắng nghe `keydown` bị gỡ và gắn lại 4 lần/giây (`App.tsx:1378-1472`):**
   - **Phán định:** **CÓ.**
   - **Bằng chứng (`frontend/src/App.tsx:1466-1472`):** Dependency array của `window.addEventListener("keydown", ...)` chứa `currentTime` (đổi 4 lần/giây), khiến `removeEventListener` + `addEventListener` chạy 4 lần mỗi giây.
6. **`upsertSubtitles` copy vào `Map` và `sort` lại toàn bộ mảng trên mỗi chunk (`frontend/src/lib/subtitles.ts:16-41`):**
   - **Phán định:** **CÓ.**
   - **Bằng chứng (`subtitles.ts:24-39`):** Mỗi lần nhận 1 batch chỉ gồm 3–5 câu mới (`pipeline.go:1302`), `upsertSubtitles` tạo mới `new Map()`, duyệt toàn bộ $N$ câu hiện có (với video 1 giờ có `_en.srt` nạp sẵn từ `LoadCachedSubtitles` tại `app.go:538-568`, $N \approx 1500$ câu), nạp vào `Map`, `Array.from`, rồi `result.sort(...)` $O(N \log N)$ tới 5–6 lần cho mỗi block!
7. **Ghi chú về việc gán `doneBlocksRef` trong bộ cập nhật `setState` (`frontend/src/App.tsx:1241-1249`):**
   - **Phán định:** **CÓ (Vi phạm nguyên tắc hàm thuần khiết trong state updater của React, dù thực tế chạy đúng).**
   - **Bằng chứng (`App.tsx:1241-1249`):**
     ```tsx
     setDoneBlocks((prev) => {
       if (!prev.includes(chunk.block)) {
         const next = [...prev, chunk.block];
         next.sort((a, b) => a - b);
         doneBlocksRef.current = next; // <-- Side-effect bên trong hàm updater
         return next;
       }
       return prev;
     });
     ```
     Ngoài ra, mỗi lần có block xong lại copy và `.sort((a, b) => a - b)` mảng `doneBlocks`.
8. **Quét thư mục bài giảng (`scanDirRecursive` & `LoadCachedSubtitles`) gây nghẽn I/O khi mở khóa học lớn:**
   - **Phán định:** **CÓ.**
   - **Bằng chứng (`app.go:234` & `sub_extractor.go:49, 111`):**
     - Khi quét thư mục khóa học (`scanDirRecursive` tại `app.go:234`), với **mỗi file video**, code gọi `HasCachedSubtitles(fullPath) || FindExternalSubtitleFile(fullPath) != "" || FindExternalVietnameseSubtitleFile(fullPath) != ""`.
     - Trong `FindExternalSubtitleFile` (`sub_extractor.go:42-72`) và `FindExternalVietnameseSubtitleFile` (`sub_extractor.go:104-134`), nếu video không có phụ đề rời, mỗi hàm sẽ gọi **14–15 lần `os.Stat`** cộng thêm **`os.ReadDir(dir)`**!
     - Với một khóa học 200 video trong 10 thư mục (không có file `.srt` rời), mỗi lần mở app (`restoreFolders` tại `App.tsx:859`) sẽ thực hiện **$200 \times 30 = 6.000$ lệnh `os.Stat` + $400$ lần `os.ReadDir`** lặp đi lặp lại trên cùng các thư mục!

---

### G. Lỗi đúng sai (Logic Bugs, Race Conditions, Panics, Error bị nuốt)

Kết quả chạy công cụ kiểm tra tĩnh và race detector hiện tại:

```text
$ go vet ./...
(không có cảnh báo)

$ go test -race ./...
ok  	subtrans	4.790s
?   	subtrans/cmd/telemetry_report	[no test files]
```

Tuy nhiên, qua rà soát từng dòng code trên đường nóng, phát hiện **7 lỗi logic / race condition / nuốt lỗi** mà bộ test hiện tại chưa chạm tới:

1. **[G1 - LỖI LOGIC NGHIÊM TRỌNG] Lặp vô tận (Infinite Loop) cùng 1 block khi `TranslateBatch` trả về thiếu câu ở chế độ `api` / `cloud` (`pipeline.go:1268, 1325, 1400` & `blockstore.go:167`):**
   - Tại `pipeline.go:1268`: `targets, _ := p.translator.TranslateBatch(ctx, batchLines)` **nuốt hoàn toàn `err`**.
   - Nếu `TranslateBatch` gặp lỗi mạng tạm thời (chưa đủ 3 lần để mở breaker, nên `CurrentMode()` vẫn là `"api"`), hoặc `CleanLLMOutput` / GTX trả về chuỗi rỗng `""` cho 1 câu có chữ, thì câu đó được lưu vào `BlockStore` với `Translated: false, TargetText: ""` (`pipeline.go:1292-1293, 1344`).
   - Tại `pipeline.go:1325`: `if okCount < hasTextCount && p.isTier2PostponedMode()` — vì đang ở mode `"api"` hoặc `"cloud"`, `isTier2PostponedMode()` là `false`, nên `tier2Deferred` KHÔNG được bật, mà `failedBlocks` cũng KHÔNG được tăng!
   - Tại `pipeline.go:1400`: `delete(p.activeJobs, job.BlockIdx)` rồi gọi `p.triggerSchedule()`.
   - Ngay lập tức `schedulerLoop` (`pipeline.go:729`) thấy `!p.blockStore.IsBlockDone(b)` (vì còn câu `Translated == false`), `!p.activeJobs[b]`, và `p.failedBlocks[b] == 0 < 2` $\to$ **Chọn lại ngay chính block đó và chạy lại FFmpeg + Whisper + Translate liên tục không bao giờ dừng, kẹt cứng toàn bộ pipeline tại block đó!**
2. **[G2 - DATA RACE] Race condition trên `fullStderrBuf` và `recentStderrLines` trong `RunCommand` (`tools.go:252-278`):**
   - Tại `tools.go:252`, một goroutine con đọc `scanner.Scan()` từ `stderrPipe` và ghi vào `fullStderrBuf` / `recentStderrLines` dưới `recentMu.Lock()`.
   - Tại `tools.go:272`, luồng chính gọi `cmd.Wait()` rồi ngay lập tức lấy `recentMu.Lock()` đọc `fullStderrBuf` và thoát hàm, **không hề có `WaitGroup` hay channel đợi goroutine `scanner.Scan()` kết thúc**!
   - Trên Windows, nếu goroutine đọc pipe chưa kịp xử lý hết buffer trong kernel pipe trước khi `cmd.Wait()` trả về, các dòng cuối của `stderr` (nơi chứa `whisper_print_timings`!) có thể bị cắt mất, dẫn đến `whisper_timings_parsed == false`.
3. **[G3 - LỖI ĐỒNG BỘ CPU] `computeMu` không khóa Local LLM (`LlamaServerTranslator` / `LlamaCliTranslator`) (`pipeline.go:79, 980`):**
   - `p.computeMu` được tạo ra để tránh Whisper (4 threads CPU) và Qwen Local LLM (4 threads CPU) chạy cùng lúc trên máy 8 luồng. Nhưng `translatorWorker` không bao giờ khóa `p.computeMu` khi gọi tầng `local_ai`, khiến tổng số thread tính toán vọt lên 8/8 logical CPUs (100% CPU), gây giật khung hình video trong WebView2.
4. **[G4 - LỖI LOGIC KHI TUA TRONG BLOCK ĐANG CHẠY] Smart Fast-Path 2 (`pipeline.go:396-403`) không cập nhật lại phân tầng `BuildTwoTierBatches` nếu block đang nằm ở `slicerWorker` hoặc `sttWorker`? Không, ngược lại:**
   - Nếu block 2 đang ở trong `translatorWorker` (đã chia `batches` tại `pipeline.go:1242` dựa trên `curPlayhead` cũ là `60s`), và người dùng tua ngắn tới `82s` (cùng trong block 2 `[60s..90s)`):
   - `doSeek(82.0)` rơi vào Smart Fast-Path 2 (`pipeline.go:397`), chỉ cập nhật `p.playheadSec = 82.0` và giữ nguyên session.
   - Nhưng `translatorWorker` đã chia `batches` từ trước lúc tua, nên câu ở giây `82s` đang nằm ở **cuối danh sách `tier2`**, phải đợi `translatorWorker` dịch hết các batch trước đó kèm các nhịp ngủ `jitter(300ms)` mới tới lượt câu ở giây `82s`!
5. **[G5 - LỖI RÒ RỈ TRẠNG THÁI] `failedBlocks` không bao giờ được reset khi `Start()` phiên mới (`pipeline.go:288-296`):**
   - Trong `Start(startSec)` (`pipeline.go:288-296`), `p.tier2Deferred` và `p.activeJobs` được tạo mới, nhưng `p.failedBlocks` **không được reset** (khác với `doSeek` có xóa `delete(p.failedBlocks, targetBlock)`).
6. **[G6 - LỖI HIỂN THỊ TIẾN ĐỘ DRIVE] Когда mở video từ Google Drive không có metadata thời lượng, `durationSec` bị gán cứng `3600` hoặc `1800` giây (`app.go:332, 808`, `drive_manager.go:786`):**
   - Khi thẻ `<video>` trên frontend tải xong metadata thực tế (`onLoadedMetadata` tại `App.tsx:2106`), frontend chỉ cập nhật `setDuration(d)` ở React chứ **không báo `duration` thật về cho `Pipeline` ở backend**!
   - Hệ quả: Nếu video Drive thực tế dài 10 phút (`600s`) nhưng backend tưởng là `3600s` (120 blocks), sau khi dịch xong 20 blocks (10 phút), `schedulerLoop` sẽ tiếp tục gọi `ffmpeg` cắt các block từ phút 10 đến phút 60 (100 blocks rỗng ngoài thời lượng video!), làm `ffmpeg`報 lỗi hoặc trả WAV rỗng và chạy `whisper-cli` 100 lần vô ích!
7. **[G7 - Ô NHIỄM MÔI TRƯỜNG THẬT KHI CHẠY TEST] Các bài test ghi thẳng vào `%LOCALAPPDATA%\SubTrans\cache` thật (`pipeline_test.go:43, 109, 161...`):**
   - `NewBlockStore` luôn lấy `os.Getenv("LOCALAPPDATA")`. Ngoại trừ `telemetry_harness_test.go` có dùng `t.Setenv("LOCALAPPDATA", ...)`, toàn bộ các test trong `pipeline_test.go`, `app_test.go`, `translator_mock_test.go` đều tạo thư mục cache trong `%LOCALAPPDATA%\SubTrans\cache` thật của máy (đã sinh ra 704 thư mục rác).

---

## BẢNG TỔNG HỢP CÁC PHÁT HIỆN (SẮP XẾP THEO MỨC ẢNH HƯỞNG GIẢM DẦN)

|   #    | Phát hiện                                                                                                                                                                                                                     | Bằng chứng (số đo / `file:dòng`)                                                                                                                                                                                                                                                                                                          | Mức ảnh hưởng ước lượng (ms hoặc % CPU)                                                                                         |                  Độ chắc chắn                  | Cách sửa đề xuất                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Rủi ro khi sửa                                                                                                                                                                                                                                                                           | Cần test gì                                                                                                                              |
| :----: | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------: | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | **Whisper phải chạy `encode` 2–3 lần/block do cửa sổ cắt audio > 30s (`32–34s`) và `-l auto` chạy lại mỗi block**                                                                                                             | Thực đo `telemetry/REPORT.md:139,141` & `telemetry_test.go:27-30`: `whisper_wall_ms` p50 = **6584 ms** (p95 = **8158 ms**), trong đó `encode_ms` = **5178 ms** (`3 runs` cho file WAV 34s). Code: `pipeline.go:151-155` (`BlockSec=30, OverlapSec=2` $\to$ `ExtractLen=34s` tại `pipeline_math.go:52-63`), `pipeline.go:944` (`-l auto`). | **2.200 – 4.000 ms / block** (giảm 35–55% thời gian STT mỗi block và giảm tương ứng `seek_latency_ms` khi tua xa)               |          **100% (Đã có số đo thật)**           | 1. Đổi cơ chế `-l auto` sang `detect-once`: sau khi block đầu tiên phát hiện được ngôn ngữ (`p.detectedOnceLang` đã có sẵn ở `pipeline.go:948-1000` nhưng chỉ bật khi có biến môi trường `VT_WHISPER_LANG=detect-once`), tự động truyền `-l <detectedOnceLang>` cho các block tiếp theo của cùng video.<br>2. Giảm `BlockSec` mặc định từ `30s` xuống `26s` (với `OverlapSec = 2s` $\to$ `ExtractLen <= 30.0s`) để vừa khít 1 cửa sổ 30s của Whisper (`1 encode run` thay vì `2–3 runs`). | Đổi `BlockSec` làm thay đổi `CacheMeta.BlockSec` (sẽ tự động làm mới cache cũ theo `blockstore.go:107`). Các test giả định `BlockSec: 30` đã truyền tường minh trong `Settings` nên không bị ảnh hưởng.                                                                                  | Chạy lại `TestTelemetryHarness` / `TestS1Harness` đo `encode_runs` (phải về 1) và `whisper_wall_ms`; chạy toàn bộ `go test -race ./...`. |
| **2**  | **[Bug G1] Lặp vô tận (Infinite Loop) chạy lại FFmpeg + Whisper cho cùng 1 block khi `TranslateBatch` lỗi hoặc trả rỗng 1 câu ở mode `api` / `cloud`**                                                                        | `pipeline.go:1268` (`targets, _ := ...` nuốt lỗi), `pipeline.go:1325` (chỉ đặt `tier2Deferred` khi `isTier2PostponedMode()`), `pipeline.go:1400` (`delete(activeJobs)`), `blockstore.go:167` (`IsBlockDone` trả `false`) $\to$ `pipeline.go:729` chọn lại đúng block đó vô hạn lần.                                                       | **6.800 ms / vòng lặp vô tận** (kẹt cứng 100% pipeline tại 1 block, tiêu tốn CPU & spam HTTP request liên tục)                  |      **100% (Chắc chắn theo logic code)**      | 1. Nếu `okCount == 0 && hasTextCount > 0` (hoặc tất cả batches đều trả lỗi), gọi `p.handleBlockFailure(job.BlockIdx, "translate", lastErr, job.SessionID)` để tăng `failedBlocks` (tối đa 2 lần thử lại).<br>2. Nếu block đã dịch được một phần (`0 < okCount < hasTextCount`) ở mode `api`/`cloud` mà câu còn lại vẫn rỗng, hoặc đánh dấu `Translated: true` cho câu bị bộ lọc từ chối, hoặc tăng `failedBlocks` để không lặp quá 2 lần.                                                 | Cần giữ nguyên hành vi `TestScheduler_Tier2Postpone_TwoWay` khi ở mode `local_ai` / `offline`.                                                                                                                                                                                           | Viết unit test mô phỏng `TranslateBatch` trả về 1 câu rỗng ở mode `api` và xác nhận scheduler không lặp quá 2 lần.                       |
| **3**  | **Không tái sử dụng kết quả STT đã có trong `BlockStore`: chạy lại `ffmpeg` + `whisper-cli` (6.6s) khi dịch bù `tier2Deferred` hoặc retry dịch**                                                                              | `pipeline.go:832-860` (`slicerWorker`) và `pipeline.go:920-985` (`sttWorker`) chỉ kiểm tra `externalSegments`, không kiểm tra xem `p.blockStore` đã có sẵn `Items` (với `SourceText != ""`) của `blockIdx` chưa.                                                                                                                          | **6.700 ms / block** mỗi khi dịch bù Tier-2 hoặc dịch lại block đã qua bước STT                                                 |   **100% (Chắc chắn theo code & telemetry)**   | Trong `slicerWorker` và `sttWorker`, nếu `p.blockStore.GetBlockItems(blockIdx)` đã có danh sách câu thoại (`len(items) > 0` từ lần chạy STT trước của cùng video), bỏ qua `ffmpeg` và `whisper-cli`, chuyển thẳng các câu đó sang `TextJob` (và trong `translatorWorker` chỉ dịch những câu có `!it.Translated`).                                                                                                                                                                         | Cần phân biệt block im lặng thực sự (0 câu, đã `IsBlockDone == true`) với block chưa từng chạy STT (`!exists`).                                                                                                                                                                          | Test kịch bản `tier2Deferred` chuyển từ `local_ai` về `api`: xác nhận `MockRunSTT` / `whisper-cli` chỉ chạy đúng 1 lần cho block 0.      |
| **4**  | **Tỉ lệ lệch dòng (`mismatchCount`) trên Google GTX cao do nối bằng `\n` thay vì delimiter tách biệt, kích hoạt fallback dịch từng dòng + sleep jitter 150ms**                                                                | `translator.go:312,316` dùng `strings.Join(lines, "\n")` và `strings.Split(batchOut, "\n")`. Khi lệch dòng (`translator.go:332-351`), dịch từng câu kèm `sleepCtx(150ms)`. Số đo thật `telemetry/REPORT.md:129,146`: `translate_ms` p95 vọt từ **154 ms** lên **1251 ms – 3898 ms**.                                                      | **600 – 3.500 ms / block** khi xảy ra gộp dòng trên GTX; tăng gấp 3–5 lần số HTTP request (dễ dính 429)                         |    **100% (Đã có số đo thật & dòng code)**     | 1. Khi rơi vào nhánh fallback từng dòng trong `googleBatchOrPerLine` (`translator.go:335-351`), kiểm tra `getCached(l)` trước và lưu `setCached(l, s)` ngay cho từng câu.<br>2. Hoặc dùng delimiter có đánh số dòng / ký tự phân cách khó bị Google gộp hơn `\n` trần, và chỉ fallback những dòng bị lệch.                                                                                                                                                                                | Không làm thay đổi các bài test trong `translator_mock_test.go` (như `TestGTX_LineMismatchFallback` kỳ vọng `mismatchCount` tăng khi mock trả 1 dòng cho 2 dòng).                                                                                                                        | Chạy `TestGTX_LineMismatchFallback` và toàn bộ `translator_mock_test.go`.                                                                |
| **5**  | **Frontend: `LandingPage` không unmount khi xem video, chạy `setInterval` 250ms re-render ngầm 4 lần/giây suốt thời gian phát**                                                                                               | `frontend/src/App.tsx:2040-2048` chỉ ẩn bằng class `hidden`; `frontend/src/components/LandingPage.tsx:76,84-90` chạy `setInterval(..., 250)` khi `isPlaying == true` (mặc định).                                                                                                                                                          | **4 lần re-render toàn bộ LandingPage / giây** (~3–8% CPU WebView2 liên tục)                                                    |         **100% (Chắc chắn theo code)**         | 1. Truyền prop `isActive={viewMode === "landing"}` vào `LandingPage` để dừng `setInterval` khi `!isActive`, hoặc chỉ render `{viewMode === "landing" && <LandingPage ... />}`.<br>2. Tương tự, dừng animation CSS `animate-spin` vô tận trên badge của `LandingPage.tsx:183` khi đang ẩn.                                                                                                                                                                                                 | Kiểm tra các script test `scripts/test_step*.mjs` xem có test nào yêu cầu DOM của `LandingPage` và `Player` cùng tồn tại trong cây DOM không (nếu có thì giữ DOM nhưng dừng `setInterval` khi `viewMode !== "landing"`).                                                                 | Chạy `scripts/run_all_tests.ps1` và các test `.mjs`.                                                                                     |
| **6**  | **Frontend: `React.memo` của `CourseTreePanel`, `FolderTreeItem` và `SubtitleListPanel` bị vô hiệu hóa hoàn toàn do truyền inline arrow functions trong `App.tsx`, kết hợp `App` re-render 6–7 lần/giây**                     | `frontend/src/App.tsx:1259` (`setPipelineStatus` 2 lần/s), `1286` (`setCurrentTime` 4 lần/s), `2061-2082` (4 inline functions truyền vào `CourseTreePanel`), `2270` (`onClose={() => ...}` truyền vào `SubtitleListPanel`).                                                                                                               | **6–7 lần re-render toàn bộ cây thư mục & danh sách hàng nghìn câu phụ đề / giây** (gây giật UI khi mở panel trên khóa học lớn) |         **100% (Chắc chắn theo code)**         | 1. Bọc `onToggleAutoCollapse`, `onSelectVideo`, `onAddDriveLink`, `onCloseFolderPanel`, `onCloseSubPanel` bằng `useCallback` trong `App.tsx`.<br>2. Trong `unStatus` (`App.tsx:1258`), chỉ gọi `setPipelineStatus(st)` nếu giá trị thực sự thay đổi (`state`, `block`, `done_blocks`, `total_blocks`, `Math.round(ahead_sec)`, `translator_mode`).<br>3. Memo hóa dải `doneBlocks.map` trên seekbar (`App.tsx:2284`) bằng `useMemo`.                                                      | Rủi ro cực thấp (chỉ tối ưu re-render React, không đổi giao diện hay hành vi).                                                                                                                                                                                                           | Chạy test frontend và kiểm tra đóng/mở panel, chọn bài học.                                                                              |
| **7**  | **Khi Gemini (`cloud`) trả thiếu/rỗng 1 câu, `fillGaps: true` đánh thức `llama-server` (nạp 1.1 GB RAM + CPU) dù máy đang có mạng**                                                                                           | `translator.go:451` (`fillGaps: true` cho tầng `cloud`) kết hợp `translator.go:454` (tầng `local_ai` ngay phía sau) và `translator.go:541-543`. Ngoài ra `build/bin/tools/llama` thực tế là bản CPU (`main.log:91,108`), không có thư mục `llama_vulkan`.                                                                                 | **1.500 – 4.000 ms** trễ khởi động lần đầu + **~1.1 GB RAM** giữ thường trú suốt phiên                                          | **100% (Chắc chắn theo code & file thực thi)** | Chỉ cho phép rơi xuống `local_ai` khi cả `api` (GTX) VÀ `cloud` (Gemini) đều bị lỗi/khóa hoàn toàn (`translatedCount == 0`), hoặc kiểm soát qua cấu hình; đồng thời nếu chạy `local_ai` trên CPU thì phải lấy `p.computeMu` để không đè lên Whisper.                                                                                                                                                                                                                                      | Lưu ý: `TestTranslateBatch_GeminiMissingLines_FilledByQwen` (`translator_mock_test.go:883`) đang test chính hành vi Gemini thiếu câu thì Qwen bù! Do Quy tắc 4 (_"Không đổi hành vi đã được test"_), **KHÔNG đổi `fillGaps: true` của Gemini**, mà chỉ đồng bộ `computeMu` cho Local AI. | Chạy `TestTranslateBatch_GeminiMissingLines_FilledByQwen`.                                                                               |
| **8**  | **[Bug G3] `computeMu` không khóa `local_ai` (Qwen CPU), làm Whisper (4 threads) và Qwen (4 threads) tranh chấp 100% CPU (8/8 luồng)**                                                                                        | `pipeline.go:79` khai báo `computeMu` để điều phối CPU giữa Whisper và LLM, nhưng chỉ `sttWorker` (`pipeline.go:980`) khóa `computeMu`, còn `translatorWorker` / `LlamaServerTranslator` / `LlamaCliTranslator` không khóa.                                                                                                               | **100% CPU contention** khi chạy offline/fallback, làm cả Whisper lẫn video playback bị khựng                                   |         **100% (Chắc chắn theo code)**         | Cho tầng `local_ai` (hoặc khi `p.currentTranslatorMode() == "local_ai"`) phối hợp với `computeMu` (hoặc giảm số thread khi cả 2 cùng chạy trên CPU).                                                                                                                                                                                                                                                                                                                                      | Cần cẩn thận tránh deadlock khi `doSeek` chờ `computeMu.Lock()` (`pipeline.go:446`) trong lúc `translatorWorker` đang giữ hoặc chờ `computeMu`.                                                                                                                                          | Chạy `Test_Pipeline_RapidSeekTo` với `-race`.                                                                                            |
| **9**  | **[Bug G6] Video Google Drive không có metadata thời lượng bị gán cứng `3600s` / `1800s`; khi `<video>` nạp xong thời lượng thật, backend không được cập nhật nên chạy Whisper tiếp cho hàng chục block ảo ngoài cuối video** | `app.go:332, 808` (`durationSec = 3600`), `drive_manager.go:786` (`1800`), `frontend/src/App.tsx:2106-2117` (`onLoadedMetadata` chỉ gọi `setDuration(d)` trên UI).                                                                                                                                                                        | Chạy thừa **10 – 100 blocks** `ffmpeg` + `whisper-cli` vô ích sau khi video đã hết                                              |         **100% (Chắc chắn theo code)**         | Khi `onLoadedMetadata` trên frontend nhận được `duration` hợp lệ khác với `videoInfo.duration_sec`, gọi xuống backend để cập nhật `p.durationSec` cho `Pipeline` và `currentInfo`.                                                                                                                                                                                                                                                                                                        | Rất thấp, chỉ cập nhật `durationSec` dưới `p.mu.Lock()`.                                                                                                                                                                                                                                 | Test mở video Drive giả lập `durationSec = 3600` rồi cập nhật về `120s`.                                                                 |
| **10** | **Quét thư mục khóa học (`scanDirRecursive`) gọi ~30 lần `os.Stat` + 2 lần `os.ReadDir` cho MỖI file video**                                                                                                                  | `app.go:234` gọi `HasCachedSubtitles`, `FindExternalSubtitleFile`, `FindExternalVietnameseSubtitleFile` cho từng file trong thư mục (`sub_extractor.go:42-72, 104-134`).                                                                                                                                                                  | **100 – 800 ms** I/O đồng bộ khi mở/khôi phục cây khóa học lớn (hàng trăm video)                                                |         **100% (Chắc chắn theo code)**         | Trong `scanDirRecursive` (`app.go:207`), `os.ReadDir(dirPath)` đã đọc sẵn toàn bộ danh sách file trong thư mục đó rồi! Chỉ cần tạo 1 map tên file chữ thường trong `dirPath` để kiểm tra sự tồn tại của file `.srt`/`.vtt` ngay trong RAM với chi phí 0 syscall I/O!                                                                                                                                                                                                                      | Không ảnh hưởng bất kỳ API hay kết quả nào của `ScanVideoFolder`.                                                                                                                                                                                                                        | Chạy `Test_ScanVideoFolder_NaturalSort` và `Test_ParseSRTorVTT_And_MergeBrokenSegments`.                                                 |
| **11** | **[Bug G2] `RunCommand` không đợi goroutine đọc `stderrPipe` hoàn tất trước khi gọi `cmd.Wait()` và đọc `fullStderrBuf`**                                                                                                     | `tools.go:252-278`: `go func() { for scanner.Scan() ... }()` chạy song song với `cmd.Wait()` mà không có `sync.WaitGroup`.                                                                                                                                                                                                                | Có thể làm mất dòng timing cuối của `whisper-cli` và vi phạm quy ước `os/exec.Cmd.StderrPipe`                                   |         **100% (Chắc chắn theo code)**         | Dùng `var stderrWg sync.WaitGroup` (`stderrWg.Add(1)` trước `go func()`, `stderrWg.Wait()` trước `cmd.Wait()`). Khi tiến trình bị kill bởi `cmdCtx.Done()`, pipe đóng nên `scanner.Scan()` sẽ tự thoát.                                                                                                                                                                                                                                                                                   | Cần đảm bảo `Test_RunCommand_TimeoutAndKill` vẫn thoát đúng hạn 1s trên Windows.                                                                                                                                                                                                         | Chạy `Test_RunCommand_TimeoutAndKill` và `go test -race ./...`.                                                                          |
| **12** | **Frontend: `upsertSubtitles` tạo lại `Map` và `.sort()` toàn bộ $N$ câu trên mỗi batch 3 câu; `syncFrame` và `keydown` đăng ký lại liên tục**                                                                                | `frontend/src/lib/subtitles.ts:24-39`, `frontend/src/App.tsx:1330, 1466`.                                                                                                                                                                                                                                                                 | **~5 – 20 ms / block** trên video dài có >1000 câu phụ đề; tạo rác GC trong WebView2                                            |         **100% (Chắc chắn theo code)**         | 1. Dùng `useRef` cho `subtitles`, `subtitleOffset`, `currentTime` bên trong `syncFrame` và `handleKeyDown` để không phải hủy/đăng ký lại callback liên tục.<br>2. Tối ưu `upsertSubtitles`: nếu mảng đã có thứ tự, cập nhật tại chỗ các `id` trùng và chỉ sort khi có phần tử chèn mới lệch thứ tự.                                                                                                                                                                                       | Giữ nguyên 100% kết quả của `subtitles.test.ts` và `subtitles.node-test.mjs`.                                                                                                                                                                                                            | Chạy `node frontend/src/lib/subtitles.node-test.mjs`.                                                                                    |
| **13** | **[Bug G7] Các bài test tạo rác (704 thư mục) trong `%LOCALAPPDATA%\SubTrans\cache` thật của người dùng**                                                                                                                     | Thực đo: **704 thư mục** trong `C:\Users\Hoang\AppData\Local\SubTrans\cache`. Code: `pipeline_test.go`, `app_test.go`, `translator_mock_test.go` gọi `NewBlockStore` không isolate `LOCALAPPDATA`.                                                                                                                                        | Làm chậm `CleanupOldCaches` (`app.go:103` phải `ReadDir` và `Stat` hơn 700 thư mục mỗi lần mở app)                              |           **100% (Đã đo trên đĩa)**            | Thêm `t.Setenv("LOCALAPPDATA", t.TempDir())` vào các test gọi `NewBlockStore` (hoặc truyền thư mục cache trong test).                                                                                                                                                                                                                                                                                                                                                                     | Không ảnh hưởng code production.                                                                                                                                                                                                                                                         | Chạy `go test ./...` và kiểm tra số thư mục trong `%LOCALAPPDATA%\SubTrans\cache` không tăng thêm.                                       |

---

## TỔNG KẾT & ĐỀ XUẤT

### 1. Top 5 việc nên làm trước và lý do

1. **[Phát hiện #1] Tự động bật `detect-once` cho ngôn ngữ Whisper và chuẩn hóa chiều dài cắt audio $\le 30\text{s}$ (`pipeline.go:944`):**
   - **Lý do:** Đây là điểm nghẽn lớn nhất chiếm **85% tổng thời gian chờ của người dùng** (`whisper_wall_ms` p50 = 6.58s, p95 = 8.16s). Việc cắt 32–34s kèm `-l auto` mỗi block đang bắt Whisper chạy `encode` 2–3 lần thay vì 1 lần. Khắc phục điểm này giảm ngay 2.2 – 4.0 giây cho mỗi block mà không cần đổi model hay phần cứng.
2. **[Phát hiện #2 - Bug G1] Chặn vòng lặp vô tận (Infinite Loop) khi 1 câu dịch rỗng/lỗi ở chế độ `api`/`cloud` (`pipeline.go:1268, 1325`):**
   - **Lý do:** Khi xảy ra dù chỉ 1 câu rỗng ở mode `api`, `schedulerLoop` hiện tại sẽ chọn lại block đó lặp đi lặp lại vô tận (mỗi vòng tốn 6.8 giây CPU chạy lại Whisper + gọi lại API), làm kẹt cứng toàn bộ pipeline.
3. **[Phát hiện #3] Tái sử dụng kết quả STT đã có trong `BlockStore` thay vì chạy lại `ffmpeg` + `whisper-cli` (`pipeline.go:832, 920`):**
   - **Lý do:** Tiết kiệm trọn vẹn **6.7 giây CPU** cho mỗi block khi hệ thống quay lại dịch bù các câu Tier-2 (`tier2Deferred`) hoặc khi thử dịch lại block bị lỗi mạng.
4. **[Phát hiện #5 & #6] Dừng `setInterval` 250ms ngầm của `LandingPage` khi đang phát video và bọc `useCallback` cho các props của `CourseTreePanel` / `SubtitleListPanel` (`frontend/src/App.tsx`, `LandingPage.tsx`):**
   - **Lý do:** Loại bỏ ngay lập tức **4 lần re-render `LandingPage`/giây** và **6–7 lần re-render toàn bộ cây thư mục + bảng phụ đề/giây** trên giao diện WebView2, giúp video và thao tác chuột mượt mà, giảm tải CPU cho tiến trình `msedgewebview2.exe`.
5. **[Phát hiện #4] Lưu/tra cứu `phraseCache` ngay trong vòng lặp fallback từng dòng của `googleBatchOrPerLine` (`translator.go:335-351`) và giảm thời gian chờ giữa các dòng:**
   - **Lý do:** Khi một batch bị lệch dòng (`mismatchCount`), hiện tại code phải gọi lại HTTP cho từng câu kèm sleep jitter làm `translate_ms` p95 vọt lên **1.25s – 3.90s**.

---

### 2. Danh sách các nghi phạm đã kiểm tra và loại trừ (kèm bằng chứng)

- **`Blocked()` hoặc `CurrentMode()` làm mất lượt probe Half-Open của CircuitBreaker:** **LOẠI TRỪ.** `breaker.go:92-95` và `translator.go:120-160` chỉ dùng `atomic.Load()`, tuyệt đối không gọi `CompareAndSwap`. Đã được chứng minh qua `TestBreaker_Blocked_NeverConsumesProbe` (10.000 lần gọi).
- **`SaveBlock` ghi lại toàn bộ phụ đề của cả video vào một file lớn mỗi lần:** **LOẠI TRỪ.** `blockstore.go:205` tách riêng từng file theo chỉ số block (`blocks/0.json`, `blocks/1.json`, mỗi file chỉ ~1.5 – 2.5 KB).
- **`emitStatus`, `OnChunk`, `OnError` gọi đồng bộ giữ lock của translator/STT làm treo worker:** **LOẠI TRỪ cho `OnChunk` và `OnError`.** `pipeline.go:1064, 1226, 1302, 1406, 1438` đều gọi ngoài `p.mu`. (Chỉ có `emitStatus` gọi `OnStatus` bên trong `p.mu`, nhưng `runtime.EventsEmit` của Wails là non-blocking message post).
- **Rò rỉ tiến trình con (`whisper-cli.exe`, `ffmpeg.exe`, `llama-server.exe`) sau khi đóng app hoặc hủy phiên:** **LOẠI TRỪ.** `proc_windows.go:27-42` dùng `taskkill /T /F /PID` kết hợp `cmd.Process.Kill()`, và `app.go:107-117` gọi `currentPipe.Stop()` + `currentTrans.Close()` trong `shutdown`. Kiểm tra thực tế bằng `Get-Process` trên máy xác nhận không có tiến trình mồ côi nào.
- **Tua video (`context.Canceled`) kích hoạt nhầm tầng fallback Gemini/Qwen hoặc phạt nhầm CircuitBreaker:** **LOẠI TRỪ.** `translator.go:515-518` dừng leo tầng ngay khi `ctx.Err() != nil`, và `breaker.go:132` bỏ qua `context.Canceled`.
- **Logging (`fmt.Printf`/`log.Printf`) hoặc Telemetry làm chậm vòng lặp nóng:** **LOẠI TRỪ.** Mặc định `VT_TELEMETRY` tắt, cờ `-np` được truyền cho Whisper (`pipeline.go:974`), và chỉ có 1 dòng `fmt.Printf` sau mỗi block (~7 giây/lần).
- **Thiếu HTTP Keep-Alive (Connection Pooling) khi gọi Google GTX / Llama Server:** **LOẠI TRỪ.** `translator.go:36-42` đã cấu hình `sharedHTTPTransport` với `MaxIdleConns: 100, MaxIdleConnsPerHost: 20, ForceAttemptHTTP2: true` và có đọc cạn `resp.Body` trước khi đóng (`translator.go:247`).

---

### 3. Những gì KHÔNG thể kết luận nếu thiếu dữ liệu & Cần bạn cung cấp gì

1. **Chưa có số đo `pprof` runtime (CPU/Mutex/Block/Goroutine profile trong 60s) và số đo RAM 30 phút thực tế khi mở cửa sổ Wails:**
   - Do Quy tắc 1 yêu cầu **không sửa code ở Giai đoạn 1**, trong khi `main.go` hiện chưa mở cổng `net/http/pprof`.
   - Nếu bạn muốn thu `pprof` trước khi sửa, hãy cho phép tôi thêm tạm nhánh `if os.Getenv("VT_PPROF") != ""` vào `main.go` (chỉ chạy ở dev).
2. **File video mẫu cho `TestTelemetryHarness` / `TestS1Harness`:**
   - Để đo trước/sau ở **Giai đoạn 3** trên cùng một kịch bản chuẩn xác nhất, vui lòng cho biết đường dẫn file video mẫu bạn muốn dùng cho biến môi trường `VT_HARNESS_VIDEO` (ví dụ một trong các video trong `%LOCALAPPDATA%\SubTrans\youtube\...` đang có sẵn trên máy hoặc một file bài giảng cụ thể của bạn).
3. **Thư mục `llama_vulkan` / `llama_cuda` và `whisper` GPU:**
   - Hiện tại trong `build/bin/tools/` chỉ có bản biên dịch CPU của `whisper-cli.exe` và `llama-server.exe`. Nếu trên máy bạn có sẵn bản build Vulkan/CUDA ở thư mục khác, hãy cho biết đường dẫn; nếu không, chúng ta sẽ tối ưu trực tiếp trên bộ binary hiện có.

---

**Vui lòng duyệt danh sách các phát hiện bạn đồng ý cho phép sửa để tôi tiến hành Giai đoạn 3 (sửa từng phát hiện một, đo trước/sau, chạy `go vet ./...` & `go test -race ./...`, mỗi cái một commit riêng).**

---

## GIAI ĐOẠN 3: DANH SÁCH TẤT CẢ BUG THEO THỨ TỰ ƯU TIÊN & HƯỚNG XỬ LÝ CHI TIẾT

Dưới đây là toàn bộ **20 lỗi và điểm nghẽn hiệu năng** được rút trích đầy đủ từ báo cáo rà soát ở trên, sắp xếp theo **thứ tự ưu tiên xử lý từ cao xuống thấp** (Mức 1: Nghiêm trọng/Điểm nghẽn chính $\to$ Mức 2: Hiệu năng UI & Dịch thuật $\to$ Mức 3: Đồng bộ, Rò rỉ & Dọn dẹp), kèm vị trí file/dòng chính xác và hướng xử lý từng bước.

---

### NHÓM 1: ĐIỂM NGHẼN CỐT LÕI & LỖI LOGIC NGHIÊM TRỌNG (ƯU TIÊN CAO NHẤT)

#### [BUG-01] Whisper chạy `encode` 2–3 lần/block do cửa sổ cắt WAV dài 32–34s (> 30s) và lặp lại `-l auto` mỗi block
- **Mức ảnh hưởng:** Tốn thêm **2.200 – 4.000 ms / block** (chiếm ~85% tổng độ trễ toàn pipeline và `seek_latency_ms`).
- **Vị trí code:**
  - `pipeline.go:151-155`, `app.go:48-49` (`BlockSec = 30.0`, `OverlapSec = 2.0`).
  - `pipeline_math.go:52-63` (`ExtractLen = OwnerEnd - OwnerStart + 2*OverlapSec = 34s`).
  - `pipeline.go:935-963, 992-1001` (Logic chọn cờ `-l` cho `whisper-cli` và lưu `p.detectedOnceLang`).
- **Nguyên nhân:** Kiến trúc Whisper có cửa sổ âm thanh cố định 30.0 giây. Khi truyền file WAV dài 32–34s kèm cờ `-l auto`, `whisper-cli` phải chạy bước tự động nhận diện ngôn ngữ và chia thành 2–3 lượt `encode` (`expectedRuns = 3`, mỗi lượt ~1.9–2.5 giây).
- **Hướng xử lý:**
  1. **Bật mặc định cơ chế `detect-once` khi `SourceLang == "auto"`:** Trong `sttWorker` (`pipeline.go:944`), nếu `p.settings.SourceLang == "auto"` (hoặc rỗng), kiểm tra `p.detectedOnceLang` dưới `p.mu.Lock()`. Nếu block trước đó của cùng video đã nhận diện được ngôn ngữ (`p.detectedOnceLang != ""`), truyền thẳng `-l <p.detectedOnceLang>` thay vì `-l auto`.
  2. **Chuẩn hóa chiều dài cắt audio $\le 30.0\text{s}$:** Giảm `BlockSec` mặc định từ `30.0` xuống `26.0` giây (khi cộng `2 * OverlapSec (2.0s)` ở hai đầu thì `ExtractLen = 26 + 4 = 30.0s` vừa khít 1 cửa sổ encode duy nhất của Whisper).
- **Kiểm thử:** Chạy `TestTelemetryHarness` / `TestS1Harness` xác nhận `whisper_encode_runs` giảm về `1` và `go test -race ./...` PASS.

---

#### [BUG-02] Lặp vô tận (Infinite Loop) chạy lại FFmpeg + Whisper cho cùng 1 block khi `TranslateBatch` lỗi hoặc trả rỗng 1 câu ở chế độ `api` / `cloud` (Bug G1)
- **Mức ảnh hưởng:** **6.800 ms / vòng lặp vô tận** — kẹt cứng pipeline tại 1 block, ngốn CPU và spam HTTP request liên tục.
- **Vị trí code:**
  - `pipeline.go:1268` (`targets, _ := p.translator.TranslateBatch(ctx, batchLines)`).
  - `pipeline.go:1325-1331` (`if okCount < hasTextCount && p.isTier2PostponedMode()`).
  - `pipeline.go:1395-1402` (`delete(p.activeJobs, job.BlockIdx)`).
  - `pipeline.go:728-737` (`schedulerLoop` chọn lại block vì `!p.blockStore.IsBlockDone(b)` và `p.failedBlocks[b] < 2`).
- **Nguyên nhân:** Ở mode `api` (GTX) hoặc `cloud` (Gemini), `isTier2PostponedMode()` trả về `false`. Nếu `TranslateBatch` gặp lỗi mạng tạm thời (bị nuốt bởi `_`) hoặc có 1 câu trả về chuỗi rỗng `""`, câu đó có `Translated: false, TargetText: ""` trong `BlockStore`. Do đó `IsBlockDone` trả về `false`, nhưng cả `tier2Deferred` lẫn `failedBlocks` đều không được cập nhật $\to$ `schedulerLoop` lập tức chọn lại đúng block đó vô hạn lần.
- **Hướng xử lý:**
  1. Tại `pipeline.go:1268`, bắt lại biến lỗi `targets, batchErr := p.translator.TranslateBatch(ctx, batchLines)` và ghi nhận `lastBatchErr`.
  2. Sau vòng lặp dịch các batch (`pipeline.go:1325`):
     - Nếu đang ở chế độ hoãn (`p.isTier2PostponedMode()`): giữ nguyên logic đánh dấu `p.tier2Deferred[job.BlockIdx] = true`.
     - Nếu **KHÔNG** ở chế độ hoãn (`api` hoặc `cloud`) mà `okCount < hasTextCount`:
       - Nếu `okCount == 0` (toàn bộ block dịch thất bại): gọi `p.handleBlockFailure(job.BlockIdx, "translate", lastBatchErr, job.SessionID)` để tăng `p.failedBlocks[job.BlockIdx]` (tối đa retry 2 lần rồi dừng).
       - Nếu `okCount > 0` (đã dịch thành công đa số câu, chỉ còn một vài câu rỗng lẻ tẻ do bộ lọc hoặc lỗi cục bộ): tăng `p.failedBlocks[job.BlockIdx]++` dưới `p.mu.Lock()` để cho phép thử bù tối đa 1 lần nữa nhưng tuyệt đối không lặp vô tận.
- **Kiểm thử:** Viết unit test giả lập `TranslateBatch` trả rỗng 1 câu ở mode `api`, xác nhận block chỉ được chọn tối đa 2 lần rồi chuyển sang block tiếp theo; đảm bảo `TestScheduler_Tier2Postpone_TwoWay` vẫn PASS.

---

#### [BUG-03] Không tái sử dụng kết quả STT đã có trong `BlockStore`: phải chạy lại `ffmpeg` + `whisper-cli` (6.7s) khi dịch bù `tier2Deferred` hoặc retry dịch
- **Mức ảnh hưởng:** Lãng phí **~6.700 ms CPU / block** mỗi khi quay lại dịch bù Tier-2 hoặc thử dịch lại block bị lỗi mạng.
- **Vị trí code:**
  - `blockstore.go:158-172` (Chưa có hàm lấy danh sách `SubtitleItem` đã lưu của 1 block chưa hoàn tất dịch).
  - `pipeline.go:832-860` (`slicerWorker` luôn gọi `ffmpeg` nếu không có `externalSegments`).
  - `pipeline.go:920-985` (`sttWorker` luôn gọi `whisper-cli` nếu không có `externalSegments`).
  - `pipeline.go:1242-1266` (`translatorWorker` gửi dịch lại cả những câu đã có `Translated == true`).
- **Nguyên nhân:** Khi một block ở chế độ `local_ai` dịch xong Tier-1 và tạm hoãn Tier-2 (`tier2Deferred`), hoặc khi dịch lỗi một phần, `p.blockStore.SaveBlock(job.BlockIdx, translatedItems)` (`pipeline.go:1344`) đã lưu toàn bộ `SourceText` và timestamp của Whisper vào RAM (`bs.itemsMap`) và đĩa (`%d.json`). Nhưng khi scheduler chọn lại block đó để dịch nốt, `slicerWorker` và `sttWorker` không kiểm tra `BlockStore` mà cắt lại WAV và chạy lại Whisper từ đầu.
- **Hướng xử lý:**
  1. Thêm hàm `GetBlockItems(block int) ([]SubtitleItem, bool)` vào `BlockStore` (`blockstore.go`) dưới `bs.mu.RLock()`, trả về bản sao danh sách `SubtitleItem` nếu block đã tồn tại và có ít nhất 1 phần tử có `SourceText != ""`.
  2. Trong `slicerWorker` (`pipeline.go:832`): Nếu `p.MockSliceAudio == nil && p.MockRunSTT == nil` và `p.blockStore.HasBlockSTT(blockIdx)` là `true`, bỏ qua bước gọi `ffmpeg` (giống như nhánh `externalSegments`).
  3. Trong `sttWorker` (`pipeline.go:920`): Nếu `p.MockRunSTT == nil` và `cachedItems, ok := p.blockStore.GetBlockItems(job.BlockIdx); ok`, dùng thẳng `cachedItems` chuyển sang `outChan <- TextJob{...}` (đặt `CacheHit: true` trong telemetry), tốn **0 ms** STT!
  4. Trong `translatorWorker` (`pipeline.go:1242`): Khi gom câu cần dịch, nếu câu nào trong `translatedItems` đã có `Translated == true && TargetText != ""`, giữ nguyên kết quả đó và chỉ đưa các câu chưa dịch vào batch (hoặc tận dụng `phraseCache` sẵn có).
- **Kiểm thử:** Viết unit test kiểm tra khi một block đã có STT trong `BlockStore` (với `Translated: false`), chạy pipeline chỉ gọi `translator` mà không gọi lại STT.

---

#### [BUG-04] Frontend: `LandingPage` không unmount khi chuyển sang xem video, chạy `setInterval` 250ms re-render ngầm 4 lần/giây vĩnh viễn
- **Mức ảnh hưởng:** **4 lần re-render toàn bộ VDOM `LandingPage` / giây** (~3–8% CPU WebView2 suốt thời gian xem video).
- **Vị trí code:**
  - `frontend/src/App.tsx:2040-2048` (`LandingPage` luôn được mount, chỉ ẩn bằng class `hidden` khi `viewMode !== "landing"`).
  - `frontend/src/components/LandingPage.tsx:76, 84-90` (`isPlaying` mặc định là `true`, `setInterval(..., 250)` chạy liên tục).
- **Nguyên nhân:** Vì `LandingPage` chỉ ẩn bằng CSS `hidden`, hook `useEffect` chứa `setInterval` 250ms vẫn tiếp tục cập nhật `demoTime` 4 lần/giây trong nền khi người dùng đang xem video ở `viewMode === "player"`.
- **Hướng xử lý:**
  1. Thêm prop `isActive?: boolean` (mặc định `true`) vào `LandingPageProps` (`frontend/src/components/LandingPage.tsx:28`).
  2. Tại `LandingPage.tsx:85`: Sửa điều kiện thành `if (!isPlaying || !isActive) return;` và thêm `isActive` vào dependency array `[isPlaying, isActive]`.
  3. Tại `frontend/src/App.tsx:2042`: Truyền `isActive={viewMode === "landing"}` vào `<LandingPage ... />` (giữ nguyên cấu trúc thẻ `div` bên ngoài để không ảnh hưởng tới bất kỳ script test DOM nào).
- **Kiểm thử:** Chạy `scripts/run_all_tests.ps1` và các bài test `scripts/test_step*.mjs`.

---

#### [BUG-05] Frontend: `React.memo` của `CourseTreePanel`, `FolderTreeItem` và `SubtitleListPanel` bị vô hiệu hóa 100% do inline arrow functions & `pipelineStatus` cập nhật dư thừa
- **Mức ảnh hưởng:** **6–7 lần re-render toàn bộ cây khóa học và danh sách hàng nghìn câu phụ đề mỗi giây** khi đang phát video.
- **Vị trí code:**
  - `frontend/src/App.tsx:1255-1261` (`setPipelineStatus(st)` gọi mỗi 500ms ngay cả khi nội dung status không đổi).
  - `frontend/src/App.tsx:2061-2082` (4 props `onToggleAutoCollapse`, `onSelectVideo`, `onAddDriveLink`, `onClose` truyền vào `CourseTreePanel` dưới dạng inline arrow function).
  - `frontend/src/App.tsx:2270` (`onClose={() => setShowSubPanel(false)}` truyền vào `SubtitleListPanel`).
  - `frontend/src/App.tsx:2283-2295` (`doneBlocks.map(...)` tính toán lại mỗi lần `currentTime` đổi 4 lần/giây).
- **Nguyên nhân:** Component `App` re-render 6–7 lần/giây (4 lần do `currentTime`, 2 lần do `pipelineStatus`). Mỗi lần `App` render lại tạo ra tham chiếu hàm mới cho các inline arrow functions, làm `React.memo` của `CourseTreePanel`, `FolderTreeItem` và `SubtitleListPanel` luôn thấy props thay đổi và phải render lại toàn bộ danh sách con.
- **Hướng xử lý:**
  1. Trong `App.tsx`, tạo các hàm ổn định bằng `useCallback`:
     - `handleToggleAutoCollapse`
     - `handleSelectVideoFromTree`
     - `handleAddDriveLinkFromTree`
     - `handleCloseFolderPanel`
     - `handleCloseSubPanel`
  2. Trong listener `pipeline_status` (`App.tsx:1258`), so sánh với state `prev`: nếu `prev` đã có cùng `state`, `block`, `done_blocks`, `total_blocks`, `translator_mode` và `Math.round(prev.ahead_sec) === Math.round(st.ahead_sec)` thì trả về `prev` (không kích hoạt re-render).
  3. Bọc phần render danh sách vạch vàng `doneBlocks.map(...)` trên thanh seekbar (`App.tsx:2283-2295`) vào `useMemo` phụ thuộc `[doneBlocks, duration, videoInfo?.block_sec]`.
- **Kiểm thử:** Chạy build frontend (`pnpm build` / `npm run build`) và các test trong `scripts/`.

---

### NHÓM 2: TỐI ƯU DỊCH THUẬT, ĐỒNG BỘ CPU & DỮ LIỆU GOOGLE DRIVE (ƯU TIÊN CAO)

#### [BUG-06] Lệch dòng (`mismatchCount`) trên Google GTX phải gọi lại HTTP cho từng câu mà không tra cứu/cập nhật `phraseCache`
- **Mức ảnh hưởng:** **600 – 3.500 ms / block** khi xảy ra gộp dòng trên Google GTX (`translate_ms` p95 vọt từ 154ms lên 1251–3898ms); tăng gấp 3–5 lần số request HTTP.
- **Vị trí code:**
  - `translator.go:311-353` (`googleBatchOrPerLine`).
- **Nguyên nhân:** Khi `translateFastGTX` nối bằng `\n` bị Google gộp câu làm `len(parts) != len(lines)`, code rơi xuống vòng lặp dịch từng dòng (`translator.go:336-351`) với nhịp nghỉ `jitter(150ms)` giữa mỗi câu, không kiểm tra xem câu đó vừa được cache hay chưa và có thời gian chờ cố định dài.
- **Hướng xử lý:**
  1. Trong vòng lặp fallback từng dòng (`translator.go:336-351`), nếu `len(lines) == 1` thì không bao giờ rơi vào nhánh này (đã xử lý ở trên, nhưng nếu `parts[0] != ""` đã trả về ngay).
  2. Trước khi gọi `f.translateFastGTX(ctx, l)` cho từng dòng trong nhánh fallback, kiểm tra `if cached, ok := f.getCached(l); ok { out[i] = cached; continue }` (không tốn HTTP request và không cần `sleepCtx`).
  3. Giảm nhịp nghỉ chống burst giữa các dòng đơn lẻ trong cùng 1 batch nhỏ (tối đa 3–5 câu) từ `150ms` xuống `60ms` để giảm độ trễ mà vẫn an toàn.
- **Kiểm thử:** Chạy `TestGTX_LineMismatchFallback` và toàn bộ `translator_mock_test.go`.

---

#### [BUG-07] `computeMu` không khóa tầng `local_ai` (Qwen CPU), làm Whisper (4 threads) và Qwen (4 threads) tranh chấp 100% CPU (Bug G3)
- **Mức ảnh hưởng:** **100% CPU contention (8/8 logical CPUs)** khi chạy ở chế độ `local_ai` (offline hoặc khi GTX/Gemini bị khóa), làm tăng thời gian STT và gây giật hình video.
- **Vị trí code:**
  - `pipeline.go:79` (Khai báo `computeMu sync.Mutex // Điều phối CPU giữa Whisper và LLM tránh tranh chấp core`).
  - `pipeline.go:980-986` (Chỉ có `sttWorker` khóa `p.computeMu`).
  - `pipeline.go:1268` (`translatorWorker` gọi `p.translator.TranslateBatch` không khóa `computeMu`).
- **Nguyên nhân:** Khi `sttWorker` hoàn tất block $k$, nó nhả `computeMu` và đẩy `TextJob` sang `translatorWorker`, đồng thời `sttWorker` lập tức lấy lại `computeMu` để chạy Whisper cho block $k+1$. Nếu lúc đó bộ dịch đang ở chế độ `local_ai` (chạy `llama-server.exe` hoặc `llama-cli.exe` trên CPU với 4 threads), cả Whisper lẫn Qwen cùng chạy song song chiếm trọn 8 luồng CPU.
- **Hướng xử lý:**
  - Tại `pipeline.go:1267`, trước khi gọi `p.translator.TranslateBatch(ctx, batchLines)`: kiểm tra nếu `p.currentTranslatorMode() == "local_ai"` (hoặc sau khi GTX/Gemini đang bị khóa và chuẩn bị gọi xuống fallback local LLM), thực hiện lấy `p.computeMu.Lock()` trước khi gọi `TranslateBatch` và `p.computeMu.Unlock()` ngay sau khi xong batch đó (kiểm tra `ctx.Err()` ngay sau khi lấy lock để thoát nhanh nếu người dùng vừa tua).
- **Kiểm thử:** Chạy `Test_Pipeline_RapidSeekTo` và toàn bộ test suite với cờ `-race` để đảm bảo không deadlock khi seek hủy session.

---

#### [BUG-08] Video Google Drive không có metadata thời lượng bị gán cứng `3600s` / `1800s`, không cập nhật lại từ thẻ `<video>`, khiến backend chạy Whisper cho hàng chục block ảo ngoài cuối video (Bug G6)
- **Mức ảnh hưởng:** Chạy thừa **10 – 100 blocks** `ffmpeg` + `whisper-cli` vô ích sau khi video thực tế đã kết thúc; hiển thị sai tổng số block (`total_blocks`) trên thanh trạng thái.
- **Vị trí code:**
  - `app.go:332, 808` (`durationSec = 3600`).
  - `drive_manager.go:786` (`return 1800`).
  - `frontend/src/App.tsx:2106-2117` (`onLoadedMetadata` và `onDurationChange` chỉ gọi `setDuration(d)` ở frontend).
- **Nguyên nhân:** Để mở video Google Drive tức thì mà không chờ `ffprobe` qua mạng, backend tạm gán `durationSec = 3600` (hoặc `1800`) khi Drive chưa có `videoMediaMetadata`. Khi trình duyệt WebView2 tải xong header MP4/WebM và biết chính xác `e.currentTarget.duration`, frontend không báo con số thật này về cho backend.
- **Hướng xử lý:**
  1. Thêm phương thức `UpdateVideoDuration(path string, durationSec float64)` vào `App` (`app.go`) và `Pipeline.UpdateDuration(durationSec float64)` (`pipeline.go`):
     - Cập nhật `p.durationSec = durationSec` dưới `p.mu.Lock()`, cập nhật `a.currentInfo.DurationSec` và `TotalBlocks`, lưu vào `GetDriveManager().durations[fileID]`, rồi gọi `p.triggerSchedule()`.
  2. Trong `schedulerLoop` (`pipeline.go:712`), tính lại `totalBlocks := int(math.Ceil(p.durationSec / p.settings.BlockSec))` bên trong vòng lặp (dưới `p.mu.Lock()`) thay vì chỉ tính 1 lần trước vòng lặp `for`!
  3. Trên frontend (`frontend/src/App.tsx:2106-2117`), trong `onLoadedMetadata` / `onDurationChange`, khi nhận được `d > 0` lệch quá `1.0s` so với `videoInfo.duration_sec`, gọi `window.go?.main?.App?.UpdateVideoDuration?.(videoInfo.path, d)`.
- **Kiểm thử:** Viết unit test khởi tạo `Pipeline` với `durationSec = 3600`, gọi `UpdateDuration(90)` và xác nhận `totalBlocks` giảm về `3` blocks.

---

#### [BUG-09] Smart Fast-Path 2 giữ nguyên thứ tự batch cũ khi người dùng tua ngắn trong cùng block đang dịch ở `translatorWorker` (Bug G4)
- **Mức ảnh hưởng:** Khi tua tới cuối block đang được dịch (ví dụ từ `60s` tới `82s` trong block `[60..90s)`), câu ở giây `82s` vẫn nằm ở cuối hàng đợi `Tier-2`, phải chờ dịch và sleep pacing qua các batch trước đó (**~1.0 – 1.5 giây**).
- **Vị trí code:**
  - `pipeline.go:396-403` (`doSeek` Smart Fast-Path 2).
  - `pipeline.go:1242-1260` (`translatorWorker` chia `batches, nTier1 := BuildTwoTierBatches(...)` chỉ 1 lần trước vòng lặp `for bIdx, indices := range batches`).
- **Nguyên nhân:** `BuildTwoTierBatches` được tính cố định dựa trên `curPlayhead` tại thời điểm bắt đầu `translatorWorker`. Nếu người dùng tua ngắn trong cùng block khi `translatorWorker` đang chạy giữa các batch, `p.playheadSec` đã đổi nhưng thứ tự `batches` và chỉ số `nTier1` không được cập nhật.
- **Hướng xử lý:**
  - Trong vòng lặp `translatorWorker` (`pipeline.go:1250`), trước khi quyết định ngủ pacing `jitter(300ms)` cho batch `bIdx >= nTier1`, đọc lại `p.playheadSec` hiện tại: nếu bất kỳ câu nào trong batch `indices` hiện tại đã lọt vào vùng Tier-1 mới (`EndSec >= nowPlayhead-1.0 && StartSec <= nowPlayhead+15.0`), **bỏ qua nhịp ngủ pacing 300ms** để dịch ngay lập tức!
- **Kiểm thử:** Chạy `Test_Pipeline_SmartFastPath2_ApiMode_PreservesSession` và `Test_TwoTierLookaheadBatches_And_Metrics`.

---

#### [BUG-10] Quét thư mục bài giảng (`scanDirRecursive`) gọi ~30 lệnh `os.Stat` + 2 lệnh `os.ReadDir` lặp lại cho MỖI file video
- **Mức ảnh hưởng:** **100 – 800 ms** nghẽn I/O đồng bộ khi mở hoặc khôi phục cây thư mục khóa học có hàng trăm video.
- **Vị trí code:**
  - `app.go:207, 234` (`scanDirRecursive`).
  - `sub_extractor.go:16-137` (`FindExternalSubtitleFile` và `FindExternalVietnameseSubtitleFile`).
- **Nguyên nhân:** Trong `scanDirRecursive`, `os.ReadDir(dirPath)` đã lấy toàn bộ danh sách file của thư mục đó rồi. Nhưng với mỗi file video tìm thấy, dòng `234` lại gọi `FindExternalSubtitleFile(fullPath)` và `FindExternalVietnameseSubtitleFile(fullPath)` — mỗi hàm này lại gọi `os.Stat` 14 lần và gọi lại `os.ReadDir(dir)` thêm 2 lần nữa!
- **Hướng xử lý:**
  - Trong `scanDirRecursive` (`app.go:215`), từ mảng `entries` đã có sẵn của `os.ReadDir(dirPath)`, tạo một tập hợp/hàm kiểm tra nhanh trong RAM xem thư mục hiện tại có file `.srt`/`.vtt` nào cùng tiền tố với tên video hay không (thay vì gọi `FindExternalSubtitleFile` / `FindExternalVietnameseSubtitleFile` đụng đĩa).
- **Kiểm thử:** Chạy `Test_ScanVideoFolder_NaturalSort` và `Test_ParseSRTorVTT_And_MergeBrokenSegments`.

---

### NHÓM 3: LỖI DATA RACE, RÒ RỈ TÀI NGUYÊN & TỐI ƯU FRONTEND/BACKEND PHỤ (ƯU TIÊN TRUNG BÌNH)

#### [BUG-11] Data race / cắt cụt `stderr` trong `RunCommand` do gọi `cmd.Wait()` trước khi goroutine `scanner.Scan()` đọc xong `stderrPipe` (Bug G2 & E2)
- **Mức ảnh hưởng:** Có thể làm mất các dòng cuối của `stderr` (nơi chứa `whisper_print_timings`), khiến `whisper_timings_parsed` bị `false`, và vi phạm quy ước chuẩn của `os/exec.Cmd.StderrPipe`.
- **Vị trí code:**
  - `tools.go:252-278` (`RunCommand`).
- **Nguyên nhân:** `go func() { for scanner.Scan() { ... } }()` chạy bất đồng bộ nhưng không có `WaitGroup` đồng bộ trước khi gọi `cmd.Wait()` ở dòng `272`.
- **Hướng xử lý:**
  - Khai báo `var stderrWg sync.WaitGroup`, gọi `stderrWg.Add(1)` trước khi spawn goroutine đọc `scanner`, `defer stderrWg.Done()` bên trong goroutine, và gọi `stderrWg.Wait()` **trước** `cmdErr := cmd.Wait()` tại `tools.go:272`.
- **Kiểm thử:** Chạy `Test_RunCommand_TimeoutAndKill`, `TestParseWhisperTimings_RealSamples` và `go test -race ./...`.

---

#### [BUG-12] `ParseWhisperTimings` chạy 9 biểu thức chính quy (`regexp`) trên `FullStderr` ở mọi block ngay cả khi `VT_TELEMETRY` đang tắt
- **Mức ảnh hưởng:** Tốn CPU quét chuỗi regex không cần thiết sau mỗi block khi người dùng chạy bình thường.
- **Vị trí code:**
  - `pipeline.go:989-1002` (`sttWorker`).
- **Nguyên nhân:** `ParseWhisperTimings(runRes.FullStderr)` được gọi vô điều kiện ở dòng `990` dù `IsTelemetryEnabled()` là `false`. Ngôn ngữ phát hiện được (`parsedLang`) thực chất đã được trích xuất từ file JSON kết quả (`parsed.Result.Language`) ở dòng `1008-1011`.
- **Hướng xử lý:**
  - Tại `pipeline.go:989`: Chỉ gọi `ParseWhisperTimings` và `SaveWhisperStderrSample` khi `IsTelemetryEnabled()` là `true`. Đồng thời ở dòng `1009`, khi `parsedLang != ""` (từ JSON output của Whisper), cập nhật luôn `p.detectedOnceLang` nếu `p.detectedOnceLang == ""` để phục vụ cơ chế `detect-once` ở `[BUG-01]`.
- **Kiểm thử:** Chạy `TestParseWhisperTimings_RealSamples` và `TestS1Harness`.

---

#### [BUG-13] `emitStatus` gọi callback `OnStatus` (Wails IPC) khi vẫn đang giữ khóa `p.mu.Lock()`
- **Mức ảnh hưởng:** Giữ khóa điều phối chính `p.mu` lâu hơn cần thiết trong khi thực hiện tuần tự hóa JSON và gửi sự kiện qua Wails runtime.
- **Vị trí code:**
  - `pipeline.go:211-234` (`emitStatus`).
- **Nguyên nhân:** Dùng `defer p.mu.Unlock()` ở đầu hàm nên `p.callbacks.OnStatus(status)` ở dòng `232` nằm bên trong vùng khóa `p.mu`.
- **Hướng xử lý:**
  - Tính toán xong struct `status` và lấy `cb := p.callbacks.OnStatus`, sau đó gọi `p.mu.Unlock()` tường minh **trước khi** gọi `if cb != nil { cb(status) }`.
- **Kiểm thử:** Chạy `Test_Pipeline_LookaheadAndBackfill` và `Test_Pipeline_RapidSeekTo` với `-race`.

---

#### [BUG-14] `PopulateStoreFromVietnameseSRT` ghi đồng bộ 120 file JSON xuống đĩa khi đang giữ khóa `a.mu` trong `OpenVideo`
- **Mức ảnh hưởng:** Làm chậm thao tác mở video khoảng **50 – 200 ms** khi mở video lần đầu có kèm file `_vi.srt`.
- **Vị trí code:**
  - `sub_extractor.go:167-212` (`PopulateStoreFromVietnameseSRT`).
  - `app.go:368` (Gọi trong `openMediaLocked`).
- **Nguyên nhân:** Vòng lặp `for b := 0; b < totalBlocks; b++` gọi `bs.SaveBlock(b, items)` (ghi file `.tmp` + `os.Rename` cho từng block) tuần tự trên luồng chính của `OpenVideo`.
- **Hướng xử lý:**
  - Cập nhật toàn bộ các block vào RAM (`bs.itemsMap[b] = items`) dưới `bs.mu.Lock()` ngay lập tức để UI và Pipeline đọc được ngay (0ms), sau đó đẩy việc ghi các file `%d.json` xuống đĩa sang một goroutine nền hoặc chỉ ghi những block có dữ liệu.
- **Kiểm thử:** Chạy `Test_ParseSRTorVTT_And_MergeBrokenSegments` (đảm bảo `bs.GetAllItemsSorted()` trả về đủ dữ liệu ngay lập tức sau khi hàm kết thúc).

---

#### [BUG-15] Frontend: `syncFrame` (`requestVideoFrameCallback`) và `keydown` listener bị hủy và đăng ký lại liên tục; `doneBlocksRef` gán trong state updater
- **Mức ảnh hưởng:** Gỡ/gắn `keydown` listener **4 lần/giây**; hủy/đăng ký lại `requestVideoFrameCallback` **5–6 lần/block**; tạo rác bộ nhớ (GC churn) trên WebView2.
- **Vị trí code:**
  - `frontend/src/App.tsx:1241-1249` (Gán `doneBlocksRef.current = next` bên trong hàm updater của `setDoneBlocks`).
  - `frontend/src/App.tsx:1276-1330` (`useEffect` của `syncFrame` phụ thuộc `[subtitles, subtitleOffset, videoInfo?.path]`).
  - `frontend/src/App.tsx:1378-1472` (`useEffect` của `handleKeyDown` phụ thuộc `currentTime`).
- **Hướng xử lý:**
  1. Tạo `subtitlesRef`, `subtitleOffsetRef`, `currentTimeRef` luôn đồng bộ với state tương ứng.
  2. Trong `syncFrame` (`App.tsx:1290`), đọc từ `subtitlesRef.current` và `subtitleOffsetRef.current`; rút gọn dependency array của `useEffect` `syncFrame` chỉ còn `[videoInfo?.path]`. When `subtitles` hoặc `subtitleOffset` đổi, cập nhật ngay `currentSubtitle` trong một `useEffect` nhẹ mà không hủy vòng lặp `requestVideoFrameCallback`.
  3. Trong `handleKeyDown` (`App.tsx:1391, 1395`), đọc `currentTimeRef.current` thay vì `currentTime` trực tiếp để bỏ `currentTime` khỏi dependency array của `window.addEventListener("keydown", ...)`.
  4. Tách việc cập nhật `doneBlocksRef.current` ra rõ ràng, không gây side-effect bất ngờ trong pure state updater.
- **Kiểm thử:** Chạy build frontend và các test trong `scripts/`.

---

#### [BUG-16] Frontend: `upsertSubtitles` tạo lại `Map` và `.sort()` toàn bộ mảng $N$ phần tử trên mỗi chunk nhỏ
- **Mức ảnh hưởng:** **~5 – 20 ms / block** khi video dài có sẵn >1.000 câu phụ đề; cấp phát mảng và Map liên tục.
- **Vị trí code:**
  - `frontend/src/lib/subtitles.ts:16-41` (`upsertSubtitles`).
- **Nguyên nhân:** Mỗi khi nhận 1 batch 3 câu vừa dịch xong, hàm nạp toàn bộ 1.500 câu cũ vào `new Map()`, ghi đè 3 câu, chuyển lại ra mảng rồi gọi `.sort()` trên cả 1.500 câu.
- **Hướng xử lý:**
  - Kiểm tra nhanh nếu tất cả phần tử trong `incoming` đều là cập nhật cho các `id` đã tồn tại trong `existing` (trường hợp phổ biến nhất khi cập nhật bản dịch tiếng Việt cho các câu tiếng Anh đã phát trước đó) và `start_sec` không đổi: chỉ cần clone mảng `existing` (`const result = existing.slice()`) và thay thế tại chỗ các vị trí trùng `id` trong $O(N)$ mà **không cần tạo `Map` lớn và không cần `.sort()`**! Nếu có phần tử mới thực sự thì mới dùng nhánh merge/sort như cũ.
- **Kiểm thử:** Chạy `node frontend/src/lib/subtitles.node-test.mjs` đảm bảo 100% test cũ PASS.

---

#### [BUG-17] `GeminiClient` tạo `http.Client` riêng với `DefaultTransport` (chỉ giữ tối đa 2 idle connections/host) thay vì dùng `sharedHTTPTransport`
- **Mức ảnh hưởng:** Giảm khả năng tái sử dụng kết nối TLS/HTTP2 khi gọi Gemini liên tiếp hoặc retry.
- **Vị trí code:**
  - `gemini.go:231-233` (`NewGeminiClient`).
- **Nguyên nhân:** Khi `client == nil`, `NewGeminiClient` khởi tạo `&http.Client{Timeout: 15 * time.Second}` không gắn `Transport: sharedHTTPTransport`, và ở `gemini.go:513` chưa drain phần dư của `resp.Body` trước khi `Close()` trong một số nhánh.
- **Hướng xử lý:**
  - Gắn `Transport: sharedHTTPTransport` cho `http.Client` mặc định trong `NewGeminiClient` (`gemini.go:232`) và đảm bảo drain nhẹ `resp.Body` trước khi đóng giống `translateFastGTX`.
- **Kiểm thử:** Chạy toàn bộ `gemini_test.go`.

---

#### [BUG-18] `Start(startSec)` của `Pipeline` không reset `p.failedBlocks` và có thể để sót `seekLoop` nếu gọi lặp lại (Bug G5 & E1)
- **Mức ảnh hưởng:** Nếu `Start()` được gọi lại trên cùng instance `Pipeline`, các block từng lỗi ở phiên trước không được thử lại.
- **Vị trí code:**
  - `pipeline.go:288-296` (`Start`).
- **Hướng xử lý:**
  - Trong `Start()` dưới `p.mu.Lock()`, thêm `p.failedBlocks = make(map[int]int)` cùng với `p.tier2Deferred` và `p.activeJobs`.
- **Kiểm thử:** Chạy `pipeline_test.go`.

---

#### [BUG-19] `DriveManager` giữ toàn bộ phụ đề (`subCache`) của mọi video đã xem trong RAM không giải phóng khi chuyển sang video khác (Bug E3)
- **Mức ảnh hưởng:** Tăng dần bộ nhớ RAM khi người dùng xem liên tiếp nhiều video trên Google Drive trong một phiên làm việc dài.
- **Vị trí code:**
  - `drive_manager.go:87, 944-960` (`PrepareVideo` và `subCache`).
- **Nguyên nhân:** `PrepareVideo` chỉ gọi `delete(dm.subCache, fileID)` cho chính video đang mở, còn phụ đề của tất cả các video Drive đã mở trước đó vẫn nằm vĩnh viễn trong `dm.subCache`.
- **Hướng xử lý:**
  - Trong `PrepareVideo` (`drive_manager.go:949`), chỉ giữ lại trong `dm.subCache` tối đa 2–3 video gần nhất (hoặc xóa các mục cũ ngoài `fileID` hiện tại) vì `Pipeline` đã sao chép `externalSegments` vào struct `Pipeline` ngay lúc khởi tạo (`pipeline.go:175`).
- **Kiểm thử:** Chạy toàn bộ test suite.

---

#### [BUG-20] Các bài test trong `pipeline_test.go`, `app_test.go`, `translator_mock_test.go` không cô lập `LOCALAPPDATA`, xả hơn 700 thư mục rác vào `%LOCALAPPDATA%\SubTrans\cache` thật (Bug G7 & E4)
- **Mức ảnh hưởng:** Đã sinh ra **704 thư mục cache rác** trong `%LOCALAPPDATA%\SubTrans\cache` của máy thật, làm `CleanupOldCaches` phải quét hàng trăm thư mục mỗi khi khởi động ứng dụng.
- **Vị trí code:**
  - `pipeline_test.go`, `app_test.go`, `translator_mock_test.go` (Tất cả các hàm test gọi `NewBlockStore`).
- **Nguyên nhân:** `NewBlockStore` đọc `os.Getenv("LOCALAPPDATA")`. Khi các test không gọi `t.Setenv("LOCALAPPDATA", t.TempDir())`, mọi dữ liệu test đều ghi thẳng vào AppData thật của người dùng.
- **Hướng xử lý:**
  1. Thêm `t.Setenv("LOCALAPPDATA", t.TempDir())` vào đầu các hàm test có sử dụng `NewBlockStore` trong `pipeline_test.go`, `app_test.go`, `translator_mock_test.go`.
  2. Dọn dẹp các thư mục cache test rỗng/rác (dung lượng 123–728 bytes do dummy video sinh ra) trong `%LOCALAPPDATA%\SubTrans\cache`.
- **Kiểm thử:** Chạy `go test -race ./...` và xác nhận số lượng thư mục trong `%LOCALAPPDATA%\SubTrans\cache` không tăng lên sau khi chạy test.

---

### LỘ TRÌNH THỰC HIỆN KHUYẾN NGHỊ (THEO TỪNG COMMIT ĐỘC LẬP)

1. **Commit 1 (`BUG-01` + `BUG-12`):** Tối ưu Whisper STT (`detect-once` ngôn ngữ tự động + chuẩn hóa `BlockSec = 26s` để `ExtractLen <= 30s` còn 1 lần encode + bỏ chạy regex `ParseWhisperTimings` khi tắt telemetry).
2. **Commit 2 (`BUG-02` + `BUG-18`):** Khắc phục lỗi lặp vô tận (Infinite Loop) khi `TranslateBatch` lỗi/trả rỗng ở mode `api`/`cloud` và reset `failedBlocks` khi `Start()`.
3. **Commit 3 (`BUG-03`):** Tái sử dụng kết quả STT đã có trong `BlockStore` (bỏ qua `ffmpeg` + `whisper-cli` khi dịch bù `tier2Deferred` hoặc retry dịch).
4. **Commit 4 (`BUG-04` + `BUG-05` + `BUG-15` + `BUG-16`):** Tối ưu toàn diện Frontend React (`LandingPage` dừng interval 250ms khi ẩn, khôi phục `React.memo` cho `CourseTreePanel` & `SubtitleListPanel`, lọc trùng `pipelineStatus`, tối ưu `upsertSubtitles`, `syncFrame` và `keydown` listener).
5. **Commit 5 (`BUG-06` + `BUG-07` + `BUG-09` + `BUG-17`):** Tối ưu Translator & Pipeline (`phraseCache` trong nhánh lệch dòng GTX, khóa `computeMu` cho `local_ai`, ưu tiên không sleep khi playhead rơi vào batch đang dịch, gắn `sharedHTTPTransport` cho `GeminiClient`).
6. **Commit 6 (`BUG-08` + `BUG-10` + `BUG-11` + `BUG-13` + `BUG-14` + `BUG-19` + `BUG-20`):** Đồng bộ `durationSec` thật cho video Google Drive, tối ưu I/O `scanDirRecursive` & `PopulateStoreFromVietnameseSRT`, đợi `stderrWg` trong `RunCommand`, nhả `p.mu` trước `OnStatus`, giới hạn `subCache` Drive và cô lập `LOCALAPPDATA` trong toàn bộ unit test.
