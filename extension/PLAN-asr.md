# PLAN-asr.md: Phase 10-PoC, nghe âm thanh video không có phụ đề rồi dịch (ASR chạy trên máy)

> Trạng thái: **kế hoạch**. Thay cho thiết kế cũ ở PLAN.md §7 Phase 10 (tabCapture → Gemini). Thiết kế cũ **bỏ** vì Firefox không có `tabCapture` hay `offscreen`, và gửi âm thanh lên cloud thì tốn quota và lộ dữ liệu.
> Trình duyệt mục tiêu: **Edge, Cốc Cốc** (Chromium) và **Firefox** (gói build bằng `scripts/zip.mjs`, Phase F).
> **Phạm vi so với YouTube:** adapter YouTube đã dùng phụ đề tự động của YouTube (`kind=asr`) khi video không có phụ đề thủ công (`pickYouTubeTrack`, đã có test trong `tests/youtubeAdapter.test.ts`). Vì vậy nút ASR chỉ xuất hiện khi YouTube **không có track tiếng Anh nào**, kể cả auto, hoặc khi xem trang không phải YouTube (Drive, khóa học, `<video>` thường). PoC chỉ nhận dạng tiếng Anh; video nói tiếng khác sẽ ra kết quả sai, và điều này được chấp nhận trong PoC.
> **Chính sách trình duyệt:** Edge và Cốc Cốc là **bắt buộc**. Firefox **bắt buộc về an toàn** (G1, G5, G6) nhưng **best-effort về hiệu năng** (G2, G3, G4): nếu Firefox chỉ chạy được WASM và chậm, tính năng vẫn GO cho Chromium, còn Firefox hiện cảnh báo "máy/trình duyệt chưa đủ nhanh".
> Đây là **PoC có cổng go/no-go**. Nếu A5 không đạt, tính năng giữ nguyên ở dạng tắt mặc định hoặc gỡ bỏ, và không có gì khác bị ảnh hưởng.

---

## 0. Đọc trước khi code (bắt buộc với AI thực thi)

1. Đọc `PLAN.md` §3 (quy tắc bất biến, bảo mật) và §6 (hợp đồng dữ liệu), sau đó đọc tài liệu này. Thứ tự phải làm: **A0 → A1 → A2 → A3 → A4 → A5**. Không được gộp phase.
2. Mỗi phase kết thúc bằng các lệnh `pnpm typecheck`, `pnpm test`, `pnpm build` và đều phải xanh. Sau đó ghi tóm tắt vào `NOTES.md` dưới tiêu đề `## Phase 10-PoC Ax`.
3. Mục đánh dấu **[T]** là kiểm chứng **thật**: người dùng chạy trên trình duyệt thật rồi ghi số liệu. AI **không được tự điền kết quả [T]**. Nếu chưa chạy thì ghi `CHƯA KIỂM`.
4. Gặp điều gì trái với tài liệu này (API không tồn tại, kích thước khác hẳn, trình duyệt chặn...): **dừng lại, ghi vào NOTES.md và hỏi**. Không tự đổi kiến trúc.

---

## 1. Luật bất biến của Phase 10 (vi phạm = phase không đạt)

**L1. Không ảnh hưởng tính năng hiện tại**

- Tất cả test có sẵn trong `tests/` phải xanh mà **không sửa một dòng nào**. Muốn kiểm hành vi mới thì thêm file test mới.
- Thứ tự tìm nguồn phụ đề giữ nguyên: Nhập file → Drive sidecar → phụ đề của player (CC/`<track>`/khóa học). ASR chỉ là **lựa chọn cuối cùng**, và chỉ khi người dùng bấm.
- Khi `settings.asr.enabled === false` (mặc định trong PoC), hành vi phải **giống hệt** bản hiện tại: không có nút, không nạp module, không tạo AudioContext.

**L2. Không bao giờ tự chạy**

- Chỉ bắt đầu khi người dùng bấm nút "🎧 Nghe & dịch". Lý do: `createMediaElementSource` **không gỡ ra được**, và AudioContext cần cú bấm của người dùng.

**L3. Không làm hỏng âm thanh video**

- Nguồn đã nối vào video thì **luôn** được nối tiếp tới `destination`.
- **Không bao giờ** gọi `AudioContext.close()` khi thẻ `<video>` còn sống, vì đóng context sẽ làm video câm.
- Khi dừng ASR chỉ ngắt nhánh "tap". Mỗi `<video>` có đúng **một** graph, lưu trong `WeakMap`, và được dùng lại khi bật lại.
- Video có `src` khác origin mà không có CORS thì **không được tap**: báo lỗi và không tạo source node (xem A2).
- **[BỔ SUNG] Giới hạn 1 tab & giải phóng tài nguyên:** Mỗi tab mở một iframe sẽ nạp một bản model riêng vào RAM/VRAM (_ước tính vài trăm MB/tab, cần đo ở A0_). PoC quy định **mỗi lần chỉ cho phép 1 tab chạy ASR** thông qua cơ chế khóa trên **Port `"subtrans"` của Background Service Worker** (`asr.claim` / `asr.yield`, không dùng `chrome.storage.session` từ content script và không cần quyền `tabs`); bật ở tab mới sẽ gửi `asr.yield` dừng tab cũ, và tab đóng đột ngột tự nhả khóa qua `port.onDisconnect`. Bắt buộc **terminate Worker và gỡ iframe** ngay khi người dùng bấm dừng, video tạm dừng quá lâu (> 5 phút), hoặc đóng tab/chuyển video (vẫn giữ `AudioContext` theo L3).

**L4. Thực tế phụ đề ưu tiên hơn ASR**

- Đang chạy ASR mà xuất hiện nguồn thật (track mới, CC nạp muộn, sidecar về muộn, người dùng nhập file): **dừng ASR** và chuyển sang nguồn thật.

**L5. Tách module, nạp lười**

- Code nhận dạng (`@huggingface/transformers`, onnxruntime) **chỉ** nằm trong trang ASR host của extension.
- Content script **không bao giờ** import thư viện đó.
- Phần ASR phía content (audio tap, bridge, source) được nạp bằng `import()` động, chỉ khi bấm nút.

**L6. Không thêm quyền nhạy cảm**

- Không dùng `tabCapture`, `offscreen`, `scripting`, `tabs`.
- Manifest chỉ được thêm bốn thứ: (a) trang `src/asr/host.html` cùng tài nguyên của nó trong `web_accessible_resources`; (b) `content_security_policy.extension_pages` có `'wasm-unsafe-eval'`; (c) các file wasm của onnxruntime **đóng gói sẵn trong extension**; (d) **[BỔ SUNG v3]** `host_permissions` cho `https://huggingface.co/*` và domain CDN tải model, **chỉ khi A0 xác nhận cần**.
- CSP của trang web người dùng xem không bị đụng tới.

**L7. Không có remote code**

- Mọi file JS và WASM phải nằm trong `dist/`.
- Chỉ **dữ liệu model** (`.onnx`, `.json`) được tải lúc chạy, từ `https://huggingface.co/` với **revision ghim cố định**, rồi cache trong origin của extension (Cache API).
- Lần đầu dùng phải hiện **hộp xác nhận trước khi tải model** (ghi rõ dung lượng thật đo ở A0 và việc tải từ `huggingface.co`), người dùng đồng ý mới tải và hiện % tải; có nút **"Xóa model đã tải"** trong Options để dọn cache model. Không dùng tính năng thì không tải gì.

**L8. Quyền riêng tư**

- Âm thanh **không rời khỏi máy**: không gửi lên Gemini, DeepL hay bất kỳ đâu.
- Chỉ **văn bản** đã nhận dạng mới đi vào luồng dịch hiện có, giống phụ đề thường.
- Trang host không đọc `chrome.storage` và không biết API key.

**L9. Build Chrome không phình ngoài dự kiến**

- `verify-dist.mjs` phải kiểm thêm các điều sau:
  - Bundle content script (`index.ts-*.js` và các chunk nó import tĩnh) không chứa chuỗi `onnxruntime`, `transformers` hay `InferenceSession`.
  - Không có URL `http(s)://` lạ trong JS ngoài allowlist hiện tại cộng `huggingface.co`.
- Ghi kích thước `dist/` trước và sau vào NOTES. Phần tăng dự kiến khoảng 10–25 MB, chủ yếu là wasm của onnxruntime.

---

## 2. Kiến trúc

```
Trang web (YouTube/Drive/...)                   Trang ASR host (chrome-extension://.../src/asr/host.html)
┌──────────────────────────────────────┐        ┌─────────────────────────────────────────────┐
│ ContentController                    │        │ host.ts (iframe ẩn, 0×0)                     │
│  └ (bấm 🎧) import("./asr/asrMain")   │        │  ├ nhận MessagePort từ content               │
│      ├ AudioTap (per <video>, WeakMap)│ Float32│  ├ Segmenter (VAD năng lượng)               │
│      │  MediaElementSource ─┬→ dest  │ 16 kHz │  └ Worker: transformers.js Whisper          │
│      │                      └→ tap ──┼───────►│       WebGPU → nếu lỗi thì WASM 1 luồng      │
│      │   (downsample 16k mono,        │ +media │                                             │
│      │    gắn mediaTime cho mỗi chunk) │  time  │ ◄── {segments:[{start,end,text}]} ──────────┤
│      └ AsrSubtitleSource ◄───────────┼────────┤     (thời gian theo giây của VIDEO)         │
│           onCuesChanged → Session (đã có) → scheduler/dịch/overlay (đã có)                 │
└──────────────────────────────────────┘        └─────────────────────────────────────────────┘
```

**Vì sao chọn iframe extension thay vì background?**

- Service worker của Chrome không có Web Audio, WebGPU ổn định thì cũng không chắc chắn.
- Iframe là trang extension đầy đủ, chạy được WASM/WebGPU và **giống nhau trên cả 3 trình duyệt**.
- Phương án dự phòng **chỉ cho Firefox**, nếu A0 cho thấy page CSP chặn iframe `moz-extension://`: chạy host trong background event page của Firefox (vốn là trang có DOM). Phương án này **chỉ làm khi A0 chứng minh cần**.

**Thời gian**

- Mỗi chunk âm thanh mang theo `mediaTime` (chụp trực tiếp `video.currentTime` ở **callback đầu tiên** khi bắt đầu gom chunk) và `endMediaTime` (chụp `video.currentTime` lúc đóng chunk). **[BỔ SUNG]** Tuyệt đối **không** đếm tổng số mẫu hay trừ ngược độ dài buffer để suy ra thời gian, vì `playbackRate ≠ 1` hoặc `waiting`/buffering sẽ làm trôi hoặc lùi mốc thời gian.
- Segment = `[startMedia, endMedia]` lấy từ `mediaTime` đầu và `endMediaTime` cuối của các chunk trong segment. Cue luôn mang **thời gian thật của video**, để xuất file, cache và tua lại xem đều đúng.

**Độ trễ hiển thị ("live lag") & Hiển thị tức thì [BỔ SUNG]**

- Cue ASR luôn về **sau** thời điểm câu được nói (độ trễ gồm chờ hết câu + nhận dạng + dịch). Nếu chỉ tra theo `currentTime` thì cue không bao giờ được hiện.
- Cách xử lý: `SubtitleSource` có thêm trường **tùy chọn** `liveLagSec?: number`.
  - Chỉ khi trường này có giá trị, Session mới tra dòng hiện tại theo `currentTime - liveLagSec` nếu không có cue nào khớp `currentTime`.
  - Các nguồn hiện có không đặt trường này, nên hành vi **không đổi** (có test chứng minh).
- **[BỔ SUNG] Hiển thị tức thì & tách nhịp Cache trên Overlay/Session:**
  - `onCuesChanged` bắn **ngay lập tức** khi có kết quả tiếng Anh từ Worker để **Overlay hiển thị dòng tiếng Anh lập tức** (vùng tiếng Việt tạm trống/`…`); riêng bước ghi IndexedDB (`cache.saveTrack`) được **debounce tách biệt** (5–10 s hoặc khi `pause`/`stop`) để không cộng thêm độ trễ giả vào G2.
  - Để không dịch mảnh câu cụt: mảnh EN chưa kết thúc bằng dấu câu (`.`, `?`, `!`) vẫn hiển thị ngay trên Overlay ở trạng thái tạm (`pending`), và chỉ đẩy vào `Scheduler` dịch khi đã gộp đủ câu (hoặc đạt ngưỡng ~150 ký tự / timeout ~2 s), sau đó cập nhật bổ sung bản dịch VI vào đúng cue mà không làm nháy chữ gốc.
  - Ở chế độ nghe trực tiếp, tận dụng cơ chế `hybrid` sẵn có (Tier-1 ưu tiên **Google GTX / DeepL** cho tốc độ nhanh, nâng cấp nền bằng Gemini kèm 1–2 câu trước làm `[CONTEXT - KHÔNG DỊCH]`) mà không cần sửa sâu `router.ts`; nếu người dùng chủ động chọn mode `gemini` thuần thì giữ nguyên kèm ghi chú độ trễ cao hơn.

**Tua, tạm dừng, đổi tốc độ, buffering, tab ẩn [BỔ SUNG]**

- `seeking`: xóa ngay buffer chunk ở `AudioTap`, gửi `{ t: "reset" }` để xóa buffer `Segmenter`, và tăng bộ đếm `generationId` (hoặc `epoch`) để **hủy/bỏ qua mọi segment đang chạy dở** trong Worker từ vị trí cũ.
- `pause`: chốt segment đang dở (`flush`). Nếu tạm dừng quá lâu (> 5 phút), tự dừng ASR để giải phóng Worker/iframe.
- `waiting` / `stalled` (video đang buffering): tạm ngưng phát chunk hoặc không suy diễn thời gian trôi trong lúc đứng hình; ghi nhận kiểm chứng lệch đồng bộ ở A0.
- **[BỔ SUNG v3] Tab ẩn (`document.hidden` kéo dài):** Khi `document.hidden === true` kéo dài quá **30 s** _(mốc N = 30 s là đề xuất, cần xác minh và hiệu chỉnh ở A0 theo mức bóp iframe nền của từng trình duyệt)_, tạm dừng tap & ASR (`flush` rồi ngắt nhánh tap) để tránh dồn hàng đợi và lãng phí GPU/CPU, sau đó **tự động tiếp tục tap** khi người dùng quay lại tab (`visibilitychange`). Nếu tab tiếp tục ẩn quá 5 phút, gọi `stopAsr()` giải phóng Worker/iframe giống quy tắc `pause`. Trong khoảng < 30 s nếu trình duyệt bóp iframe gây rơi đoạn thì ghi nhận số đoạn rớt (`dropped`).
- `playbackRate ≠ 1`: vẫn tap bình thường vì đã bám `mediaTime`. **[BỔ SUNG]** Khi `playbackRate > 1.25`, hiện cảnh báo nhẹ trên `MiniToolbar`: _"Tốc độ > 1.25×, chất lượng nhận dạng có thể giảm"_.

**Model mặc định cho PoC (chỉ tiếng Anh)**

- WebGPU dùng `onnx-community/whisper-base.en` (tổ hợp `dtype` tối ưu sẽ chốt ở A0).
- WASM dùng `onnx-community/whisper-tiny.en`, lượng tử q8 (**chỉ giữ nhánh WASM nếu thời gian xử lý segment đạt ngưỡng G2 WASM ≤ 4.6 s trên máy yếu ở A0**; nếu không đạt sẽ bỏ nhánh WASM).
- Kích thước thật và revision chính xác chốt ở A0 rồi ghi vào `src/asr/models.ts` (không dùng số liệu ước lượng chưa đo).

---

## 3. Cổng go/no-go (đánh giá ở A5, tất cả là [T])

> **[BỔ SUNG] Máy tham chiếu tầm trung (cố định cho G2/G3/G7):** Laptop/PC Windows 10/11 phổ thông, RAM 16 GB, CPU 4–8 nhân đời trung (ví dụ Intel Core i5 gen 11–13 / AMD Ryzen 5), GPU tích hợp Intel Iris Xe / AMD Radeon hoặc GPU rời phổ thông (GTX 1650 / RTX 3050). Ngoài ra chạy thêm ma trận 4 nền tảng (Windows mạnh, Windows yếu, Mac Apple Silicon không quạt, Mac Intel) ở A0/A5.

| #   | Tiêu chí                                                                                                                                                             | Ngưỡng đạt                                                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Âm thanh video sau khi bật/tắt ASR                                                                                                                                   | Nghe như cũ; volume và mute vẫn hoạt động; không câm, không rè                                                                                                                                                                                                                                                                        |
| G2  | **[BỔ SUNG] Độ trễ toàn trình** (từ lúc người nói dứt câu đến lúc phụ đề xuất hiện)                                                                                  | Tách đo 3 phần: `T_vad` (chờ hết câu, ≈ 0.4 s) + `T_asr` (nhận dạng) + `T_trans` (dịch). Trung vị `T_vad + T_asr` (hiện chữ EN) ≤ 3 s (WebGPU ⇒ `T_asr ≤ 2.6 s`), ≤ 5 s (WASM nếu giữ nhánh WASM ⇒ `T_asr ≤ 4.6 s`); `T_trans` (hiện chữ VI qua GTX/DeepL) mục tiêu ≤ 1.5 s _(ước tính, cần đo ở A0/A5)_                              |
| G3  | **[BỔ SUNG] CPU, GPU & Rớt khung hình** khi xem video 1080p trên máy tham chiếu                                                                                      | CPU ≤ 50% tổng CPU; đo thêm `video.getVideoPlaybackQuality()` — tỷ lệ `droppedVideoFrames / totalVideoFrames` tăng thêm ≤ 2% so với lúc tắt ASR; theo dõi mức dùng GPU (Task Manager / Activity Monitor) không gây giật/khựng video                                                                                                   |
| G4  | **[BỔ SUNG] Độ đúng trên bộ mẫu đa dạng** (50–100 câu có đáp án chuẩn, gồm: giọng chuẩn, giọng vùng miền, nói nhanh, thuật ngữ chuyên ngành, có nhạc nền, bài giảng) | Đo WER tự động + chấm tay độ hiểu đúng ý: ≥ 85% câu hiểu đúng ý; đối chứng với YouTube Auto-CC trên cùng clip có CC để biết mức hơn/kém                                                                                                                                                                                               |
| G5  | Iframe host chạy được trên YouTube, Drive preview (kiểm **riêng**, vì đây là nền tảng khó nhất), 1 trang `<video>` thường                                            | Đạt trên Edge, Cốc Cốc, Firefox                                                                                                                                                                                                                                                                                                       |
| G6  | Không ảnh hưởng (L1)                                                                                                                                                 | Toàn bộ test cũ xanh; ma trận thủ công PLAN.md §8 chạy lại thấy không đổi                                                                                                                                                                                                                                                             |
| G7  | **[BỔ SUNG] Chạy liên tục 10 phút** (tab đang phát, iframe ẩn) + **Thermal throttling & RAM**                                                                        | Thời gian xử lý segment phút cuối ≤ 1.5 × phút đầu (đo riêng cả trên MacBook không quạt ở phút 1, 5, 10 để kiểm tra giảm xung); không rò bộ nhớ quá 300 MB. Ngưỡng RAM/tab (_ước tính, cần đo và hiệu chỉnh ở A0_): `tiny.en` ≤ 400 MB, `base.en` ≤ 800 MB (Windows đo bằng `Shift+Esc` Task Manager; macOS đo bằng Activity Monitor) |

Nếu G1, G5 hoặc G6 không đạt thì **NO-GO cứng**. Nếu chỉ G2, G3, G4 hoặc G7 không đạt thì ghi lại, thử đổi model hoặc tham số **một lần**, rồi quyết định. Áp dụng chính sách trình duyệt ở đầu tài liệu: Firefox trượt G2/G3/G4/G7 không kéo Chromium thành NO-GO.

**[BỔ SUNG v3] Đồng bộ ngưỡng thời gian xử lý segment & quy tắc nhánh WASM:**

- Whisper xử lý trên cửa sổ **30 s cố định** (đoạn ngắn hơn thường được đệm zero-padding — _giả định cần xác minh ở A0_), nên RTF đo trên clip 60 s không đại diện cho đoạn thực tế 3–8 s. Thay vào đó, chuẩn hóa bằng **thời gian xử lý thực của một segment (`T_proc`)** suy trực tiếp từ G2 sau khi trừ `T_vad ≈ 0.4 s`:
  - **WebGPU:** mức khuyến nghị (đạt G2) **`T_proc ≤ 2.6 s`**; mức tối thiểu (cho chạy nhưng hiện cảnh báo chậm) **`2.6 s < T_proc ≤ 4.0 s`** _(ngưỡng tối thiểu cần xác minh/hiệu chỉnh ở A0)_; **`> 4.0 s`** → chặn (`device-too-slow`).
  - **WASM (nếu giữ nhánh WASM):** mức khuyến nghị (đạt G2) **`T_proc ≤ 4.6 s`**; mức tối thiểu (cho chạy nhưng báo chậm) **`4.6 s < T_proc ≤ 6.0 s`** _(cần xác minh ở A0)_; **`> 6.0 s`** → chặn.
- **Quy tắc quyết định nhánh WASM:** Do iframe nhúng trong YouTube/Drive thường không có `crossOriginIsolated`, WASM chỉ chạy đơn luồng. Nếu ở A0, `whisper-tiny.en` (q8) qua WASM trên **Windows máy yếu** có thời gian xử lý thực của segment (3 s / 6 s / 8 s) **> 4.6 s** (không đạt ngưỡng khuyến nghị G2 cho WASM), PoC sẽ **loại bỏ nhánh WASM**; các máy không có WebGPU chỉ hiển thị thông báo _"Thiết bị chưa đủ mạnh (không có WebGPU)"_.

Nghi phạm đầu tiên khi trượt:

- **G3 (CPU, GPU tranh chấp giải mã video):** `ScriptProcessorNode` chạy trên main thread của trang hoặc WebGPU tranh queue với hardware video decoder. Hướng sửa ở Phase 10 đầy đủ: AudioWorklet qua Blob URL (nếu page CSP cho phép), hoặc `video.captureStream()` rồi xử lý trong host, hoặc hạ `dtype`/batch WebGPU.
- **G4 (độ đúng):** VAD năng lượng mở segment sai khi có nhạc nền hoặc tạp âm, gây ảo giác. Hướng sửa: Silero VAD (ONNX nhỏ, cần xác minh ở A0/A3).
- **G2/G7 trên WASM:** WASM đơn luồng (iframe không `crossOriginIsolated`). Theo quy tắc trên: không đạt `T_proc ≤ 4.6 s` trên máy yếu thì bỏ nhánh WASM.

---

## 4. Các phase

### A0. Spike khả thi (code bỏ đi, KHÔNG vào `dist/`)

**Mục tiêu:** chứng minh ba điều trước khi viết code sản phẩm: (1) transformers.js chạy được dưới CSP của extension trên 3 trình duyệt; (2) đo tốc độ; (3) iframe extension có bị page CSP chặn hay không.

**Việc làm**

- Tạo thư mục `dev/asr-spike/`, là một **extension riêng tối thiểu** với manifest riêng và vite config riêng. **Không** sửa `manifest.config.ts`, `vite.config.ts` hay `package.json` gốc. Dependency của spike để trong `dev/asr-spike/package.json`.
- Trang `spike.html`:
  - Nạp `@huggingface/transformers` (phiên bản v3 mới nhất, ghi rõ số version).
  - Đặt `env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("ort/")` (wasm copy vào gói) và `env.allowLocalModels = false`.
  - Chạy `pipeline("automatic-speech-recognition", model, { device })` trên file `dev/asr-spike/fixture-60s.wav` (16 kHz mono, tự thu 60 s tiếng Anh bài giảng; **không** lấy nhạc có bản quyền) **và [BỔ SUNG v3] cắt/chạy riêng các segment độ dài 3 s, 6 s, 8 s** (do giả định Whisper xử lý cửa sổ 30 s cố định nên RTF trên 60 s không đại diện cho đoạn 6–8 s — _giả định cần xác minh ở A0_).
  - In ra: thời gian tải model, thời gian nhận dạng `fixture-60s.wav` (RTF = thời_gian_xử_lý / 60), **thời gian xử lý thực `T_proc(3s)`, `T_proc(6s)`, `T_proc(8s)` (tính bằng giây)**, backend thực tế, và văn bản.
- Content script spike: chèn iframe `spike-frame.html` (web accessible) vào trang và nhận `postMessage("pong")`. Thử trên YouTube, trang Drive preview, và một trang `<video>` thường.
- Thử `createMediaElementSource` trên video YouTube: nối vào `destination`, kiểm âm thanh còn bình thường, và đọc RMS từ một `ScriptProcessorNode` để thấy có số liệu (khác 0).
- **Bài chạy dài 10 phút & đo tab ẩn:** iframe ẩn 0×0 trong tab YouTube đang phát video, nhận dạng lặp lại fixture (hoặc audio tap thật) liên tục. Ghi thời gian xử lý segment / RTF theo từng phút, bộ nhớ của tiến trình (Task Manager của trình duyệt) ở phút 1 và phút 10. Lặp lại khi **chuyển sang tab khác (`document.hidden = true`) trong 2 phút** để đo mức bóp iframe nền, số đoạn rớt và thời gian phục hồi khi quay lại (xác minh mốc tạm dừng N = 30 s).

**Kết quả [T] ghi vào NOTES.md, bảng theo trình duyệt (Edge, Cốc Cốc, Firefox; Safari ngoài phạm vi PoC) × 4 nhóm máy (Windows mạnh, Windows yếu, Mac Apple Silicon [ưu tiên máy không quạt], Mac Intel):**

- Version của trình duyệt, trạng thái WebGPU thực tế (đặc biệt trên Firefox bản đang nhắm).
- Model chạy được (`tiny.en`/`base.en`) × backend (`webgpu`/`wasm` đơn luồng) × tổ hợp `dtype`, kèm **`T_proc(3s)`, `T_proc(6s)`, `T_proc(8s)`** và RTF 60 s (bắt buộc đo WASM `tiny.en` q8 trên **Windows máy yếu** so với ngưỡng `≤ 4.6 s` để xét quy tắc giữ/bỏ nhánh WASM).
- Kích thước thực tế thư mục `ort/` (MB) và kích thước thực tế từng file model tải về.
- Iframe có chạy trên YouTube, Drive preview, trang thường hay không.
- Bài chạy dài 10 phút: thời gian xử lý segment / RTF phút 1 / phút 5 / phút 10 (đặc biệt trên MacBook không quạt để đo giảm xung nhiệt), bộ nhớ phút 1 / phút 10 (Windows: `Shift+Esc` Task Manager; macOS: Activity Monitor), và kết quả khi **tab ẩn 2 phút** (mức bóp iframe nền, số đoạn rớt, phục hồi khi quay lại).
- Khi xem video 1080p: mức dùng GPU và `video.getVideoPlaybackQuality().droppedVideoFrames` khi bật vs tắt ASR.
- Tap có số liệu khác 0, và âm thanh có bình thường hay không.

**[BỔ SUNG] Danh sách kiểm chứng thêm ở A0 (mục riêng, chưa được khẳng định trước khi đo):**

1. **CSP trang web:** Iframe `chrome-extension://` / `moz-extension://` có bị CSP của YouTube và Google Drive preview chặn không?
2. **Quyền tải model:** Tải file model từ `https://huggingface.co/` (kể cả các domain CDN redirect như `cdn-lfs` / `xethub`) trong extension page có cần khai báo thêm trong `host_permissions` không?
3. **Tổ hợp `dtype` WebGPU:** Tổ hợp `dtype` nào (ví dụ `fp16`, `q8`, `q4`, `fp32` cho encoder/decoder) chạy ổn định, không bị NaN/rác chữ và đủ chính xác trên WebGPU với phiên bản `@huggingface/transformers` v3 đang dùng?
4. **Dung lượng file model thật:** Đo dung lượng thực tế tải về của `whisper-tiny.en` và `whisper-base.en` (không dùng con số ước lượng như "39 MB" khi chưa kiểm chứng).
5. **WebGPU trên Firefox:** Trạng thái WebGPU thực tế trên Firefox ở phiên bản đang nhắm (Windows & macOS) có bật sẵn hay bị tắt/lỗi?
6. **Lệch đồng bộ khi buffering:** Đo mức độ lệch đồng bộ timestamp khi video bị `waiting`/buffering giữa chừng.
7. **[BỔ SUNG v3] Giả định cửa sổ 30 s của Whisper & hiệu chỉnh ngưỡng benchmark 2–3 s:** Xác minh chênh lệch giữa `T_proc(3s)`, `T_proc(6s)`, `T_proc(8s)` để chốt ngưỡng `T_bench` tương ứng cho clip 2–3 s ở Device Gate (A3).

**Điều kiện qua A0 (tách cổng bắt buộc và bổ sung theo thiết bị):**

- **Cổng bắt buộc để sang A1:** Đo đủ trên **máy chính/máy tham chiếu hiện có** với Edge và Cốc Cốc (ít nhất 1 tổ hợp model × backend đạt ngưỡng khuyến nghị G2 **`T_proc(3s/6s/8s) ≤ 2.6 s`** trên WebGPU, bài chạy dài 10 phút không suy giảm quá 1.5×), iframe chạy được trên YouTube ở cả 3 trình duyệt (Edge, Cốc Cốc, Firefox), và hoàn thành 7 mục kiểm chứng thêm ở trên.
- **Quyết định nhánh WASM:** Đo WASM `tiny.en` q8 trên **Windows máy yếu** (nếu đã có máy yếu tại A0); nếu `T_proc(3s/6s/8s) > 4.6 s` thì loại bỏ nhánh WASM theo §3. Nếu chưa có đủ cả 4 nhóm máy vật lý ngay lúc làm A0, các máy còn thiếu ghi rõ `CHƯA CÓ THIẾT BỊ` và bổ sung bắt buộc ở A5 trước khi chốt GO/NO-GO phát hành rộng.
- Firefox có `T_proc` vượt ngưỡng thì ghi lại và vẫn qua A0 (best-effort). Nếu Firefox bị chặn iframe, ghi lại rồi **hỏi** trước khi làm phương án background.

### A1. Khung build, manifest, cờ cài đặt

**Việc làm**

1. `package.json`: thêm dependency `@huggingface/transformers` (ghim đúng version đã dùng ở A0).
2. Tạo `src/asr/host.html`, `src/asr/host.ts` (hiện chỉ trả lời ping), `src/asr/worker.ts` (rỗng) và **[BỔ SUNG]** `src/asr/transcriber.ts` định nghĩa **interface `Transcriber`** (`init`, `transcribe`, `getCapabilities`, `dispose`) để tách lớp nhận dạng khỏi phần còn lại của hệ thống (chỉ định nghĩa interface ở bước này, không thêm provider mới ngoài Whisper cục bộ).
3. `manifest.config.ts`:
   - Thêm `content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }`.
   - Thêm vào `web_accessible_resources` mục `{ resources: ["src/asr/host.html", ...asset của host], matches: ["<all_urls>"] }`. Nếu CRXJS không tự gom asset của host thì liệt kê thủ công và ghi lý do.
   - _(Nếu A0 xác minh cần `host_permissions` cho `huggingface.co` / CDN tải model thì bổ sung tại đây và ghi rõ vào NOTES)._
4. Copy wasm của onnxruntime vào `public/ort/` bằng script `scripts/copy-ort.mjs` chạy trước build. **Chỉ copy** các file thật sự cần, theo danh sách A0 đo được.
5. `settings.ts`: thêm `asr: { enabled: false, model: "auto" }`. `"auto"` nghĩa là WebGPU → base.en, WASM → tiny.en. Options có toggle "Thử nghiệm: Nghe & dịch video không có phụ đề (chạy trên máy)" và **[BỔ SUNG v3]** nút **"Xóa model đã tải"** (xóa cache model Whisper trong Cache API của extension origin, hiển thị trạng thái đã xóa; đồng thời phục vụ luồng hỏi xác nhận lại ở lần tải sau). Giữ quy tắc reset/merge settings như hiện tại.
6. `verify-dist.mjs`: thêm các guard của L9. Cập nhật allowlist URL thêm `huggingface.co`.
7. Ghi kích thước `dist/` trước và sau vào NOTES.

**Test mới (`tests/asr-a1.test.ts`)**

- `DEFAULT_SETTINGS.asr.enabled === false`.
- Settings cũ thiếu khóa `asr` thì merge ra mặc định đúng.
- Guard trong verify-dist bắt được chuỗi `onnxruntime` nếu chuỗi đó bị cài vào bundle content. Test bằng fixture.
- **[BỔ SUNG v3]** Luồng nút **"Xóa model đã tải"** trong Options xóa đúng cache model trong Cache API (mock `caches`) và cập nhật trạng thái UI.

**[T]**

- Cài bản build lên Edge: mọi tính năng cũ chạy như trước.
- Mở `chrome-extension://<id>/src/asr/host.html` trực tiếp: trang tải được, không lỗi CSP trong console.
- Làm tương tự với gói Firefox (`pnpm zip`, nạp tạm qua `about:debugging`).

### A2. Audio tap phía content

**File:** `src/content/asr/audioTap.ts`. Đây là module nạp lười, không import từ `index.ts` theo kiểu tĩnh.

**API**

```ts
export type TapEligibility =
  | { ok: true }
  | { ok: false; reason: "cross-origin" | "no-audio-ctx" };
export function checkEligibility(
  video: HTMLVideoElement,
  pageOrigin: string,
): TapEligibility;
export interface AudioChunk {
  samples: Float32Array /*16 kHz mono*/;
  mediaTime: number;
  endMediaTime: number;
}
export function getOrCreateGraph(video: HTMLVideoElement): VideoGraph; // WeakMap, tạo 1 lần
export interface VideoGraph {
  ctx: AudioContext; // KHÔNG bao giờ close khi video còn sống (L3)
  startTap(onChunk: (c: AudioChunk) => void): () => void; // trả hàm stop: chỉ ngắt nhánh tap
}
export function downsampleTo16k(
  input: Float32Array,
  inRate: number,
  state: ResampleState,
): Float32Array;
```

**Quy tắc**

- `checkEligibility` trả về `ok` khi `currentSrc` bắt đầu bằng `blob:` (MSE, như YouTube và Drive), hoặc cùng origin với trang, hoặc khi `video.crossOrigin` đã được đặt. Mọi trường hợp khác trả `cross-origin`, và **không tạo** source node.
- Graph: `source → destination` (luôn có), cộng nhánh `source → ScriptProcessor(4096, 2, 1) → gain(0) → destination` khi tap. Ghi chú: có thể dùng AudioWorklet, nhưng `addModule` có thể bị page CSP chặn, nên PoC dùng ScriptProcessor.
- Downsample về mono 16 kHz bằng trung bình kênh rồi lọc thông thấp đơn giản và decimate tuyến tính. Gom thành chunk khoảng 0.5 s rồi mới gửi.
- **[BỔ SUNG] Gắn `mediaTime` & trạng thái phát:** Chụp trực tiếp `mediaTime = video.currentTime` ở **callback đầu tiên** khi bắt đầu gom chunk và `endMediaTime = video.currentTime` lúc đóng chunk — **không** cộng dồn theo số mẫu và **không** trừ ngược độ dài buffer (tránh lùi giờ khi buffering). Khi `seeking`, xóa ngay bộ đệm gom chunk. Khi video đang `waiting`/buffering hoặc `paused`, bỏ qua chunk rỗng và không suy diễn thời gian trôi.
- `ctx.state === "suspended"` thì gọi `resume()` trong handler của cú bấm.
- Phát hiện câm: video đang phát, không mute, `volume > 0`, mà 3 s liền RMS = 0 → báo `"silent-tap"` để controller dừng và hiện thông báo. Graph thì vẫn giữ nguyên vì L3.

**Test (`tests/asr-audioTap.test.ts`, dùng fake AudioContext)**

- Gọi `getOrCreateGraph` 2 lần trên cùng video thì `createMediaElementSource` chỉ được gọi 1 lần.
- `stop()` ngắt processor nhưng **không** ngắt `source → destination` và **không** gọi `close`.
- Ma trận `checkEligibility`: blob, cùng origin, khác origin, có `crossOrigin`.
- `downsampleTo16k`: 48k → 16k ra đúng độ dài, sóng sin 440 Hz giữ được tần số (kiểm qua số lần đổi dấu), và ghép nhiều buffer liên tiếp không bị hở.
- `mediaTime` của chunk tăng đơn điệu khi phát đều.
- **[BỔ SUNG]** Test `playbackRate = 1.25` và `1.5`, tua tới/tua lui (`seeking` xóa buffer gom chunk), `pause`, và trạng thái video đang buffering (`waiting`).

**[T]** Dùng trang harness dev (không vào dist), trên YouTube với cả 3 trình duyệt:

- Bật tap, tắt tap, bật lại: âm thanh vẫn bình thường; volume và mute hoạt động; không có tiếng vọng đôi.

### A3. ASR host: segmenter + Whisper

**File:** `src/asr/host.ts`, `src/asr/worker.ts`, `src/asr/segmenter.ts`, `src/asr/models.ts`, `src/asr/protocol.ts`, `src/asr/transcriber.ts` (implement `WhisperTransformersTranscriber`).

**Giao thức (`protocol.ts`, dùng chung với content)**

```ts
// content → host (qua MessagePort chuyển giao lúc khởi tạo)
type ToHost =
  | { t: "init"; model: "auto" | string; lang: "en" }
  | {
      t: "audio";
      samples: Float32Array;
      mediaTime: number;
      endMediaTime: number;
      gen: number;
    } // transfer samples.buffer
  | { t: "flush" } // pause: chốt segment đang dở
  | { t: "reset"; gen: number } // seeking: bỏ buffer và tăng generationId
  | { t: "stop" };
// host → content
type FromHost =
  | { t: "progress"; phase: "download" | "load"; pct: number }
  | {
      t: "ready";
      backend: "webgpu" | "wasm";
      model: string;
      benchMs?: number;
      perfTier?: "ok" | "slow";
    }
  | {
      t: "segments";
      items: Array<{ start: number; end: number; text: string }>;
      gen: number;
    }
  | { t: "dropped"; total: number } // số segment đã bỏ do quá tải (cộng dồn)
  | {
      t: "error";
      code:
        | "model-download"
        | "backend"
        | "no-webgpu"
        | "device-too-slow"
        | "oom"
        | "unknown";
      message: string;
    };
```

**Bắt tay**

- Content tạo iframe với `src = runtime.getURL("src/asr/host.html")` và style `position:fixed; width:0; height:0; border:0; opacity:0`.
- Khi iframe `load`, content gửi `postMessage({t:"hello"}, extOrigin, [port2])`.
- Host chỉ nhận port **đầu tiên**, và chỉ khi `event.source === window.parent`.
- Không dùng `chrome.runtime` trong host trừ `getURL`. Host không đọc storage (L8).

**Segmenter (VAD, cài trong `segmenter.ts`, logic thuần nên test được)**

- Cửa sổ 30 ms. Ngưỡng tính động theo noise floor (phân vị 20% của 3 s gần nhất) cộng biên.
- Mở segment khi có ≥ 150 ms tiếng nói. Đóng segment khi im lặng ≥ 400 ms.
- **[BỔ SUNG] Cắt thông minh trong khoảng 6–8 s:** Khi segment đạt 6 s mà chưa có khoảng lặng 400 ms, tìm điểm có **năng lượng RMS nhỏ nhất (yên tĩnh nhất)** trong cửa sổ `[6 s, 8 s]` để cắt; chỉ cắt cứng ở mốc **8 s** khi toàn bộ cửa sổ `[6 s, 8 s]` có năng lượng cao liên tục.
- Segment bị cắt trong `[6 s, 8 s]` hoặc cắt cứng 8 s thì segment kế tiếp bắt đầu sớm hơn **0.4 s** (chồng lấp) để không mất chữ ở biên. Phía worker bỏ phần trùng: so các từ cuối của text trước với các từ đầu của text sau (tối đa 4 từ, không phân biệt hoa thường và dấu câu), trùng thì cắt khỏi text sau.
- Bỏ segment ngắn hơn 0.4 s.
- Mỗi segment giữ `startMedia` và `endMedia` từ `mediaTime` của chunk.
- **[BỔ SUNG] Đánh giá VAD học máy nhỏ (Silero VAD):** VAD năng lượng yếu khi gặp nhạc nền hoặc tạp âm liên tục. Ghi nhận phương án thay thế/bổ trợ bằng **Silero VAD ONNX** (_dung lượng ước tính ~2 MB, cách đóng gói: nạp như asset ONNX cục bộ trong `dist/` hoặc cache cùng model; cần xác minh kích thước thật và tương thích `onnxruntime-web` ở A0/A3_).

**Worker & Device Gate [BỔ SUNG]**

- Worker chỉ giao tiếp qua interface `Transcriber` (`WhisperTransformersTranscriber` gọi `pipeline("automatic-speech-recognition", modelId, { device, dtype })` với `return_timestamps: true` để tách cue dài thành câu ngắn ≤ 2 dòng, ~7 s).
- **Device Gate (tự kiểm tra máy trước khi chạy):**
  1. _Tầng 1 (trước khi tải model):_ Kiểm tra WebGPU (`navigator.gpu?.requestAdapter()`). Nếu không có WebGPU và nhánh WASM đã bị bỏ theo §3 → trả ngay `{ t: "error", code: "no-webgpu" }` và dừng. Nếu còn nhánh WASM thì rơi về WASM `tiny.en`.
  2. _Tầng 2 (warm-up + benchmark tiếng nói thật sau khi nạp model) [BỔ SUNG v3]:_ Chạy 1 lượt **warm-up ngắn** (bỏ qua kết quả đo để loại chi phí compile shader WebGPU lần đầu), sau đó đo **thời gian xử lý thực `benchMs`** trên **1 clip tiếng nói tiếng Anh thật ngắn (~2–3 s, 16 kHz mono)** đóng gói gọn — **không** dùng im lặng/sóng sin (Whisper dừng sớm ở token đầu) và **không** dùng chung con số RTF của đoạn 8 s. So `benchMs` với **2 ngưỡng tương ứng với độ dài clip 2–3 s** (suy từ G2 sau khi trừ `T_vad ≈ 0.4 s`, hiệu chỉnh hệ số theo số đo `T_proc(3s)` vs `T_proc(8s)` ở A0):
     - **Mức Khuyến nghị (`perfTier: "ok"`):** `benchMs ≤ 2600 ms` (WebGPU) hoặc `≤ 4600 ms` (WASM nếu giữ) → cho chạy bình thường.
     - **Mức Tối thiểu (`perfTier: "slow"`):** `2600 ms < benchMs ≤ 4000 ms` (WebGPU) hoặc `4600 ms < benchMs ≤ 6000 ms` (WASM) _(ngưỡng tối thiểu cần xác minh ở A0)_ → vẫn cho chạy nhưng gửi `perfTier: "slow"` để UI hiện cảnh báo chậm.
     - **Dưới mức Tối thiểu (Chặn):** vượt ngưỡng tối thiểu → trả `{ t: "error", code: "device-too-slow" }`, giải phóng Worker và báo rõ cho người dùng.
- Hàng đợi: **tối đa 2 segment chờ**. Nếu đầy thì bỏ segment cũ nhất, gửi `{t:"dropped", total}` về content (UI hiện cảnh báo), và không để trễ tích lũy. Khi nhận `reset(gen)`, xóa sạch hàng đợi cũ và **bỏ qua kết quả** của segment đang chạy dở nếu `gen` không khớp hiện tại.
- Lọc ảo giác: bỏ text rỗng, text chỉ có dấu câu, các chuỗi lặp kiểu "Thank you." hay "[Music]" khi RMS của segment thấp, và text trùng hoàn toàn với segment ngay trước.

**Test**

- `tests/asr-segmenter.test.ts`: im lặng + tiếng nói tổng hợp (sin có biên độ) tạo đúng số segment và đúng mốc thời gian (sai số ≤ 60 ms); **[BỔ SUNG]** cắt thông minh tại điểm RMS nhỏ nhất trong `[6 s, 8 s]`; cắt cứng ở 8 s; segment sau cắt ở `[6 s, 8 s]`/cắt cứng bắt đầu sớm hơn 0.4 s; `reset` bỏ buffer; `flush` chốt segment.
- `tests/asr-protocol.test.ts`: host bỏ qua port thứ hai và bỏ qua message không đến từ parent; `gen` cũ bị drop khi `reset`.
- `tests/asr-filter.test.ts`: bộ lọc ảo giác, và **[BỔ SUNG]** test riêng cho loại trùng ở biên đoạn (trùng 1–4 từ, khác hoa thường/dấu câu, **không lặp từ và không mất từ**, không trùng thì giữ nguyên).
- **[BỔ SUNG]** `tests/asr-worker.test.ts`: mock interface `Transcriber` để kiểm tra hàng đợi max 2, cơ chế drop theo `gen`, và Device Gate (`no-webgpu`, `perfTier: "ok" | "slow"`, `device-too-slow`). Worker với model thật không test bằng unit vì quá nặng, kiểm bằng [T].

**[T]**

- Mở host trên YouTube trong cả 3 trình duyệt, lần đầu tải model: hiện % tải; tải lại trang thì dùng cache, không tải lại.
- Ghi backend thực tế, thời gian tải, `benchMs` và `T_proc`.

### A4. Ghép vào luồng hiện tại

**File:** `src/content/asr/asrMain.ts` (điểm nạp lười), `src/content/asr/asrSource.ts`, `src/content/asr/bridge.ts`, cùng các sửa **tối thiểu** ở `src/content/index.ts`, `MiniToolbar.tsx`, `store.ts`, `session.ts`, `adapters/types.ts`, và `src/background/messaging.ts` (chỉ thêm 2 message nhỏ `asr.claim`/`asr.yield` để khóa 1 tab; **không** sửa `router.ts`).

**AsrSubtitleSource implements SubtitleSource**

- `track`: `trackKey = "asr:" + platform + ":" + videoId + ":" + modelId`, **`kind: "asr"`** _(đã có sẵn trong `TrackKind` tại `src/shared/types.ts`)_, `lang: "en"`, title `"🎧 Nghe tự động (thử nghiệm)"`.
- `load()` trả `[]`. **[BỔ SUNG] Tách 2 nhịp UI và Cache:** `onCuesChanged` phát **ngay lập tức** khi có segment mới từ host để Overlay hiển thị chữ EN tức thì (không gom 3 s làm tăng trễ G2); riêng bước ghi IndexedDB (`cache.saveTrack`) được **debounce tách biệt 5–10 s** (và flush khi `pause`/`stop`).
- **[BỔ SUNG] Gộp câu đủ ý & chất lượng dịch:**
  - Mảnh EN chưa kết thúc bằng dấu kết câu (`.`, `?`, `!`) vẫn hiển thị ngay trên Overlay ở trạng thái tạm (`pending`), chưa đưa vào hàng đợi dịch; khi gộp đủ câu theo dấu câu (hoặc đạt ngưỡng ~150 ký tự / 2 dòng / timeout ~2 s) mới đẩy vào `Scheduler` để không dịch câu cụt. Khi có bản dịch VI thì cập nhật bổ sung vào đúng cue đó mà không làm nháy chữ gốc.
  - Ở chế độ nghe trực tiếp, tận dụng cơ chế `hybrid` sẵn có (Tier-1 đi **Google GTX / DeepL** cho tốc độ nhanh; nâng cấp Gemini kèm **1–2 câu đã nhận dạng ngay trước đó** làm `[CONTEXT - KHÔNG DỊCH]`). Không sửa sâu `router.ts`; nếu người dùng chọn mode `gemini` thuần thì giữ nguyên kèm ghi chú độ trễ cao hơn.
- `liveLagSec`: đặt bằng trung vị độ trễ đo được (kẹp trong khoảng 1–4 s, mặc định 2.5).
- Cue chồng nhau thì cắt `end` của cue trước về `start` của cue sau.

**Session (sửa có kiểm soát)**

- `adapters/types.ts`: thêm `readonly liveLagSec?: number`.
- Hàm tra dòng hiện tại: **chỉ khi** `source.liveLagSec` có giá trị **và** không có cue nào khớp `t` thì tra thêm `t - liveLagSec`. Không đổi gì khác.
- Test mới chứng minh: nguồn không có `liveLagSec` cho kết quả tra **giống hệt** trước khi sửa, kiểm trên một bảng thời gian cố định.

**ContentController**

- `sessionOrigin` thêm giá trị `"asr"`.
- **[BỔ SUNG] Khóa 1 tab & vòng đời:** Khi bấm bật ASR, gửi `asr.claim` qua Port `"subtrans"` lên Background SW; nếu tab khác đang giữ khóa, SW gửi `asr.yield` xuống Port của tab cũ để tab cũ tự gọi `stopAsr()` (và tự nhả khóa khi `port.onDisconnect`, không dùng `chrome.storage.session` phía content và không thêm quyền `tabs`). Bắt buộc gọi `stopAsr()` (terminate Worker + gỡ iframe, giữ `AudioContext`) khi: bấm dừng, nhận `asr.yield`, video `pause` quá 5 phút, tab ẩn quá 5 phút, đóng tab (`pagehide`), hoặc đổi video.
- **[BỔ SUNG v3] Tab ẩn (`document.hidden` kéo dài):** Nghe `visibilitychange`. Khi `document.hidden === true` kéo dài quá **30 s** _(mốc N = 30 s cần xác minh ở A0)_, tạm dừng tap & ASR (`flush` rồi ngắt tap, giữ host/Worker trong tối đa 5 phút) để tránh dồn hàng đợi; khi người dùng quay lại tab (`document.hidden === false`), tự động nối lại tap và tiếp tục nghe. Nếu có đoạn rớt trong thời gian ẩn, cập nhật `dropped` lên store.
- **[BỔ SUNG v3] Xác nhận tải model lần đầu:** Trước lần tải model đầu tiên (khi model chưa có trong Cache API), hiển thị hộp xác nhận nêu rõ dung lượng thật đo ở A0 và việc tải từ `huggingface.co`. Bấm Hủy → không tải model và không mở host; bấm Đồng ý → tiến hành tải và hiện `%`.
- `trySetup`: hiện tại `return` sớm nếu `this.session` đã có. Sửa thành: nếu `sessionOrigin === "asr"` thì **vẫn** gọi `listSources`; có nguồn thật thì gọi `stopAsr()` rồi `startSession(..., "adapter")` (L4). Origin khác thì giữ nguyên logic cũ.
- `trySidecar` có kết quả trong lúc đang ASR, hoặc người dùng nhập file: cũng gọi `stopAsr()` trước, rồi làm như hiện nay.
- `stopAsr()`: dừng tap, gửi `stop`, terminate Worker, gỡ iframe, dispose source và session. Graph audio **giữ nguyên** (L3).
- Đổi video hoặc teardown: gọi `stopAsr()`. Bỏ được cả iframe.
- Nút chỉ hiện khi đủ cả 4 điều kiện: `settings.asr.enabled && !hasTrack && video có audio && checkEligibility().ok`. Nếu `cross-origin` thì không hiện nút. Có thể có tooltip giải thích khi rê chuột vào vùng nút, nhưng không bắt buộc.

**MiniToolbar và store**

- Store thêm `asr: { state: "off" | "confirm" | "loading" | "listening" | "paused_hidden" | "error"; pct?: number; backend?: string; perfTier?: "ok" | "slow"; note?: string; dropped?: number }`. Mặc định `off`.
- Khi `dropped > 0`: hiện "⚠ Máy quá tải, đã bỏ qua N đoạn". Nếu backend là WASM, gợi ý thêm "trình duyệt chưa có WebGPU, nhận dạng sẽ chậm".
- **[BỔ SUNG]** Cảnh báo tốc độ: khi `playbackRate > 1.25`, hiện note _"Tốc độ > 1.25×, chất lượng nghe giảm"_.
- Nút "🎧 Nghe & dịch" chỉ render khi controller cho phép (prop `asrAvailable`), **[BỔ SUNG v3]** kèm nhãn hoặc tooltip rõ **"Chỉ nhận dạng tiếng Anh"**. Bấm lần đầu khi chưa có cache model → hiện hộp xác nhận (ghi dung lượng thật đo ở A0 và nguồn `huggingface.co`); sau khi đồng ý hiện "Đang tải model 37%…", sau đó "🎧 Đang nghe (WebGPU)". Bấm lại thì dừng.
- **[BỔ SUNG]** Thông báo Device Gate & lỗi ngắn: không có WebGPU (_"Thiết bị chưa đủ mạnh (không có WebGPU)"_); mức tối thiểu `perfTier === "slow"` (_"Máy hơi chậm, phụ đề có thể trễ và bỏ bớt đoạn"_); dưới mức tối thiểu (_"Máy chưa đủ nhanh cho nhận dạng thời gian thực"_); model không tải được; tap câm (`silent-tap`); trình duyệt không hỗ trợ.

**Test mới (`tests/asr-integration.test.ts`, jsdom)**

- `asr.enabled = false`: không render nút, và `import("./asr/asrMain")` **không bao giờ** được gọi. Kiểm bằng spy hoặc mock của dynamic import.
- `enabled = true` nhưng có nguồn thật: không có nút.
- `enabled = true`, không nguồn: có nút (có nhãn/tooltip _"Chỉ nhận dạng tiếng Anh"_). Bấm (sau xác nhận lần đầu) thì `sessionOrigin === "asr"`.
- Đang ASR mà `addtrack` hoặc `playing` làm `listSources` trả nguồn thật: ASR dừng, session mới có origin `"adapter"`.
- Đang ASR mà người dùng nhập file: ASR dừng.
- Đang ASR mà sidecar trả về: ASR dừng.
- `stopAsr` không gọi `ctx.close()`, có gỡ iframe.
- `liveLagSec`: cue `[10, 12]`, `currentTime = 13`, lag 2.5 thì hiện cue đó; nguồn thường cùng thời điểm thì không hiện.
- **[BỔ SUNG]** Test gộp câu theo dấu câu trước khi dịch; hiển thị EN trước khi có VI; cảnh báo khi `playbackRate = 1.5`; khóa 1 tab (bật tab 2 dừng tab 1) và tự dừng khi `pause` quá hạn.
- **[BỔ SUNG v3]** Test hộp xác nhận tải model lần đầu (Hủy → không tải/không mở host; Đồng ý → bắt đầu tải); test tab ẩn (`document.hidden` > 30 s → tạm dừng tap, quay lại → tự tiếp tục; ẩn > 5 phút → `stopAsr`); test `perfTier === "slow"` hiện cảnh báo chậm.

**[T]** Kiểm trên Edge, Cốc Cốc, Firefox:

- Một video YouTube **không có CC**: bật toggle, bấm nút, có chữ gốc rồi có bản dịch.
- Một video YouTube **có CC**: không thấy nút.

### A5. Đo đạc và quyết định go/no-go

- Chạy bảng §3 trên **4 nhóm máy** (Windows mạnh, Windows yếu, Mac Apple Silicon [ưu tiên máy không quạt], Mac Intel) × **3 trình duyệt** (Edge, Cốc Cốc, Firefox; Safari ngoài phạm vi PoC), ghi số liệu thật vào `NOTES.md` dạng bảng.
- **[BỔ SUNG] G2 (độ trễ):** Ghi tách riêng 3 chặng `T_vad`, `T_asr`, `T_trans` (từ log DEV-only) và xác nhận chữ EN hiện ngay trước khi có bản dịch VI.
- **[BỔ SUNG] G3 (tài nguyên 1080p):** Ghi `% CPU`, mức dùng GPU, và số khung hình rớt từ `video.getVideoPlaybackQuality()` (bật vs tắt ASR) trên máy tham chiếu tầm trung.
- G5: kiểm **riêng** Drive preview (video trong iframe `youtube.googleapis.com/embed`), ghi `currentSrc` có phải `blob:` không và nút có hiện không.
- G7: chạy 10 phút với audio thật, ghi thời gian xử lý segment / RTF (phút 1, 5, 10 — đặc biệt trên MacBook không quạt để đo giảm xung), RAM đầu/cuối (Windows: `Shift+Esc` Task Manager; macOS: Activity Monitor), và **[BỔ SUNG v3] đo hành vi khi ẩn tab (`document.hidden = true` kéo dài 2 phút: tạm dừng sau N s, số đoạn rớt, tự phục hồi khi quay lại)**.
- **[BỔ SUNG] G4 (độ chính xác):** Dùng bộ mẫu đa dạng 50–100 câu (giọng chuẩn, giọng vùng miền, nói nhanh, thuật ngữ chuyên ngành, có nhạc nền, bài giảng), tính WER tự động + chấm tay theo đáp án chuẩn, và đối chứng trực tiếp với YouTube Auto-CC trên các clip có CC.
- Chạy lại ma trận thủ công PLAN.md §8, ghi "không đổi" hoặc liệt kê khác biệt.
- Cập nhật `README.md` (mục "Video không có phụ đề", ghi rõ là thử nghiệm, chỉ nhận dạng tiếng Anh, lần đầu tải model khoảng X MB theo số đo thật từ `huggingface.co`, có nút xóa model trong Options) và `PRIVACY_POLICY.md` (**[BỔ SUNG v3] ghi rõ hai vế: âm thanh xử lý 100% trên máy và không bao giờ rời máy, nhưng văn bản đã nhận dạng sẽ được gửi tới dịch vụ dịch người dùng chọn — Google Translate / DeepL / Gemini — giống phụ đề thông thường; model tải từ `huggingface.co`**).
- Ghi kết luận vào NOTES.md: **GO** (giữ toggle, kèm danh sách việc cho Phase 10 đầy đủ: Silero VAD, dùng lại cue ASR đã cache khi xem lại, đa ngôn ngữ, tùy chọn model) hoặc **NO-GO** (giữ `enabled: false` và ẩn toggle, hoặc gỡ code; quyết định cùng người dùng).

---

## 5. Rủi ro đã biết

| Rủi ro                                                                                  | Cách xử lý trong PoC                                                                                                                                                               |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMediaElementSource` trên video khác origin làm video câm vĩnh viễn               | `checkEligibility` chặn trước (L3); phát hiện tap câm để báo lỗi                                                                                                                   |
| Page CSP chặn iframe extension (nhất là Firefox)                                        | Kiểm ở A0; Firefox có phương án background, chỉ làm khi cần                                                                                                                        |
| WASM không có đa luồng (iframe không `crossOriginIsolated`)                             | **[BỔ SUNG v3]** Đo `T_proc(3s/6s/8s)` của `tiny.en` q8 trên Windows máy yếu ở A0; nếu `> 4.6 s` (không đạt ngưỡng G2 WASM) thì **bỏ nhánh WASM** và chỉ báo thiết bị chưa đủ mạnh |
| Trạng thái WebGPU trên Firefox chưa xác minh theo phiên bản/OS                          | **[BỔ SUNG]** Kiểm chứng thực tế ở A0 (Windows & macOS); không có WebGPU thì xử lý theo quy tắc nhánh WASM & Device Gate                                                           |
| **[BỔ SUNG]** WebGPU tranh tài nguyên với giải mã video 1080p                           | Đo `video.getVideoPlaybackQuality()` (drop frames) + mức dùng GPU ở A0/A5 (G3) trên máy tham chiếu                                                                                 |
| **[BỔ SUNG]** Mở ASR nhiều tab gây ngốn RAM/VRAM (OOM)                                  | Khóa 1 tab qua Port `"subtrans"` (`asr.claim`/`asr.yield`); terminate Worker + gỡ iframe khi dừng / `pause` > 5 phút / đóng tab                                                    |
| Whisper "ảo giác" khi im lặng hoặc có nhạc                                              | VAD (cắt thông minh `[6 s, 8 s]`, đánh giá Silero VAD) + bộ lọc ở A3                                                                                                               |
| Bản Firefox đang khai `strict_min_version 115` nhưng content script MAIN world cần 128+ | Ngoài phạm vi; chỉ ghi chú cho Phase F                                                                                                                                             |
| `handleCuesChanged` lưu lại cả track mỗi lần đổi                                        | **[BỔ SUNG]** Tách nhịp: `onCuesChanged` bắn tức thì cho UI, `cache.saveTrack` debounce riêng 5–10 s (và flush khi `pause`/`stop`)                                                 |
| Kích thước extension tăng (wasm)                                                        | Chỉ copy file wasm cần thiết; ghi số MB thật vào NOTES                                                                                                                             |

---

## 6. Prompt cho từng phase (copy nguyên khối gửi AI code)

### Prompt A0

```
Bạn làm Phase 10-PoC A0 của dự án extension SubTrans (thư mục extension/, nhánh feat/extension).
Đọc PLAN.md §3 và extension/PLAN-asr.md (toàn bộ, nhất là §1 Luật L1–L9 và §4 A0).
Nhiệm vụ: tạo spike KHẢ THI trong extension/dev/asr-spike/, là extension tối thiểu RIÊNG (manifest, vite config, package.json riêng).
TUYỆT ĐỐI không sửa manifest.config.ts, vite.config.ts, package.json, src/ hoặc tests/ của extension chính.
Spike gồm:
(1) spike.html chạy transformers.js v3 (ghi rõ version) với wasm onnxruntime copy vào gói (env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("ort/")), CSP extension_pages có 'wasm-unsafe-eval'; nhận dạng fixture-60s.wav VÀ chạy riêng các segment 3 s, 6 s, 8 s bằng whisper-tiny.en và whisper-base.en, thử device webgpu (nhiều tổ hợp dtype: fp16/q8/q4/fp32) và wasm đơn luồng (tiny.en q8); in thời gian tải, dung lượng model thật, RTF 60 s, thời gian xử lý thực T_proc(3s), T_proc(6s), T_proc(8s) (tính bằng giây, để đối chiếu ngưỡng G2 ≤ 2.6 s WebGPU / ≤ 4.6 s WASM và kiểm chứng giả định cửa sổ 30 s của Whisper), backend, văn bản.
(2) content script chèn iframe web-accessible spike-frame.html vào trang và nhận postMessage "pong"; log kết quả (kiểm tra CSP trên YouTube, Drive preview, trang thường).
(3) nút trong content script tạo AudioContext + createMediaElementSource(video) → destination, cộng ScriptProcessor đo RMS, đồng thời log video.getVideoPlaybackQuality() (droppedVideoFrames/totalVideoFrames) và kiểm tra lệch đồng bộ khi buffering (waiting).
(4) chế độ "chạy dài 10 phút" trong iframe ẩn: nhận dạng lặp liên tục, log T_proc/RTF mỗi phút (phút 1, 5, 10) và performance.memory nếu có; kèm kịch bản ẩn tab (document.hidden = true trong 2 phút) đo mức bóp iframe nền, số đoạn rớt và phục hồi khi quay lại; tôi sẽ đo thêm bộ nhớ (Shift+Esc / Activity Monitor) và GPU.
Viết README ngắn trong dev/asr-spike/ hướng dẫn build và nạp lên Edge, Cốc Cốc, Firefox (about:debugging).
Thêm vào NOTES.md mục "## Phase 10-PoC A0" chứa bảng kết quả [T] theo ma trận 4 nhóm máy × 3 trình duyệt (Edge, Cốc Cốc, Firefox) — có cột T_proc(3s/6s/8s) và tab ẩn — và bảng 7 mục kiểm chứng thêm (CSP, host_permissions huggingface.co/CDN, dtype WebGPU, dung lượng model thật, WebGPU Firefox, sync drift khi buffering, giả định cửa sổ 30 s Whisper & hiệu chỉnh ngưỡng benchmark 2–3 s) — để TRỐNG (ghi CHƯA KIỂM). Không tự điền số liệu.
Nếu thư viện hoặc API khác với plan, dừng lại, ghi vào NOTES và hỏi tôi.
Không commit. Cuối cùng liệt kê file đã tạo.
```

### Prompt A1

```
Làm Phase 10-PoC A1 theo extension/PLAN-asr.md §4 A1. Đọc kỹ §1 (L1, L5, L6, L7, L9) trước.
Dùng đúng version @huggingface/transformers và danh sách file wasm onnxruntime đã ghi ở NOTES.md mục A0.
Việc cần làm: thêm dependency; tạo src/asr/host.html, host.ts (chỉ trả ping), worker.ts (rỗng), và src/asr/transcriber.ts định nghĩa interface Transcriber (init, transcribe, getCapabilities, dispose — chỉ định nghĩa interface, không thêm provider ngoài Whisper cục bộ); sửa manifest.config.ts (CSP extension_pages có 'wasm-unsafe-eval', web_accessible_resources cho host, và host_permissions cho huggingface.co/CDN nếu A0 chứng minh cần); viết scripts/copy-ort.mjs copy wasm cần thiết vào public/ort/; thêm settings.asr = { enabled:false, model:"auto" } theo đúng cách merge/reset hiện có; thêm toggle trong Options; thêm guard trong verify-dist.mjs (content bundle không có onnxruntime/transformers/InferenceSession; allowlist URL thêm huggingface.co).
Thêm tests/asr-a1.test.ts như plan mô tả.
KHÔNG sửa test cũ. KHÔNG đụng frontend/wailsjs, root package.json hay scripts/zip.mjs (ngoại trừ khi bắt buộc để gói Firefox có file host; nếu cần thì hỏi trước).
Chạy pnpm typecheck, pnpm test, pnpm build, đều phải xanh. Ghi kích thước dist trước/sau và danh sách khóa mới trong manifest vào NOTES.md "## Phase 10-PoC A1". Các mục [T] ghi CHƯA KIỂM.
```

### Prompt A2

```
Làm Phase 10-PoC A2 theo extension/PLAN-asr.md §4 A2. Luật L3 là quan trọng nhất: không bao giờ close AudioContext khi video còn sống; source luôn nối destination; mỗi video 1 graph trong WeakMap; video khác origin không CORS thì không tạo source node.
Tạo src/content/asr/audioTap.ts đúng API trong plan (checkEligibility, getOrCreateGraph, VideoGraph.startTap, downsampleTo16k, phát hiện silent-tap). Dùng ScriptProcessorNode(4096) + gain(0) cho nhánh tap. Gom chunk khoảng 0.5 s; chụp trực tiếp mediaTime = video.currentTime ở đầu chunk và endMediaTime ở cuối chunk (KHÔNG đếm mẫu hay trừ ngược buffer); xóa bộ đệm gom chunk khi seeking; bỏ qua chunk rỗng khi paused/waiting.
File này KHÔNG được import tĩnh từ src/content/index.ts (sẽ nạp lười ở A4).
Viết tests/asr-audioTap.test.ts với fake AudioContext, phủ đủ các ca trong plan gồm cả playbackRate 1.25×/1.5×, seeking tới/lui, pause, và waiting (buffering).
Thêm trang harness dev (ngoài dist) để tôi kiểm [T] trên YouTube.
Test cũ giữ nguyên. Chạy typecheck, test, build. Ghi NOTES "## Phase 10-PoC A2", [T] để CHƯA KIỂM.
```

### Prompt A3

```
Làm Phase 10-PoC A3 theo extension/PLAN-asr.md §4 A3.
Tạo src/asr/protocol.ts (đúng kiểu ToHost/FromHost trong plan, có gen, endMediaTime, ready trả benchMs và perfTier), segmenter.ts (VAD năng lượng thuần, cắt thông minh tại điểm RMS thấp nhất trong [6 s, 8 s] trước khi cắt cứng 8 s, chồng lấp 0.4 s sau cắt trong [6 s, 8 s] hoặc cắt cứng), models.ts (model id + dtype + revision ghim từ A0), transcriber.ts (implement WhisperTransformersTranscriber), host.ts (bắt tay MessagePort: chỉ nhận port đầu tiên và chỉ từ window.parent; không đọc chrome.storage), worker.ts (giao tiếp qua interface Transcriber; Device Gate 2 tầng: kiểm tra WebGPU theo quy tắc WASM của A0 + warm-up rồi benchmark clip tiếng nói ngắn thật ~2–3 s đo thời gian xử lý thực benchMs so với 2 mức ngưỡng Khuyến nghị/Tối thiểu hiệu chỉnh từ A0 ứng với độ dài clip 2–3 s — KHÔNG dùng chung con số RTF của đoạn 8 s — trả perfTier "ok"/"slow" hoặc lỗi device-too-slow; hàng đợi tối đa 2 segment, drop kết quả nếu gen cũ sau reset; lọc ảo giác; bỏ từ trùng ở biên 1–4 từ không lặp không mất từ; gửi progress).
Thời gian segment phải là thời gian video (startMedia/endMedia từ mediaTime/endMediaTime), không phải thời gian đồng hồ.
Viết tests/asr-segmenter.test.ts, asr-protocol.test.ts, asr-filter.test.ts, asr-worker.test.ts (mock Transcriber cho queue, gen, Device Gate 2 mức ngưỡng ok/slow/device-too-slow) như plan.
Không có remote code: mọi JS/WASM nằm trong dist; chỉ dữ liệu model tải từ huggingface.co với revision ghim.
Test cũ giữ nguyên. Chạy typecheck, test, build (verify-dist phải xanh). Ghi NOTES "## Phase 10-PoC A3", [T] để CHƯA KIỂM.
```

### Prompt A4

```
Làm Phase 10-PoC A4 theo extension/PLAN-asr.md §4 A4. Đây là phase duy nhất được sửa code đang chạy. Chỉ sửa đúng các điểm plan liệt kê, ở mức tối thiểu (KHÔNG sửa router.ts).
1) adapters/types.ts: thêm readonly liveLagSec?: number. Session chỉ dùng trường này khi có giá trị và không có cue khớp t. Viết test chứng minh nguồn không có liveLagSec cho kết quả tra giống hệt trước.
2) Tạo src/content/asr/asrMain.ts (điểm nạp lười, chỉ được gọi bằng import() động), bridge.ts (iframe ẩn + MessagePort + gen), asrSource.ts (AsrSubtitleSource: trackKey "asr:...", phát onCuesChanged NGAY LẬP TỨC để hiện EN tức thì, debounce riêng cache.saveTrack 5–10 s; gộp mảnh chưa đủ dấu câu trước khi đẩy Scheduler dịch nhưng vẫn hiện mảnh EN tạm ngay; tận dụng cơ chế hybrid/context sẵn có; cắt chồng cue; liveLagSec).
3) Khóa 1 tab & vòng đời: thêm 2 message nhỏ asr.claim / asr.yield trong src/background/messaging.ts (tự nhả khi port.onDisconnect, KHÔNG dùng chrome.storage.session từ content script, KHÔNG thêm quyền tabs). Trong ContentController: sessionOrigin thêm "asr"; trySetup vẫn dò nguồn khi đang ASR và ưu tiên nguồn thật (L4); trySidecar/import file thì stopAsr trước; đổi video/teardown/pause > 5 phút/nhận asr.yield thì stopAsr (terminate Worker + gỡ iframe, KHÔNG bao giờ close AudioContext).
4) Store + MiniToolbar: trạng thái asr (có dropped, cảnh báo quá tải, cảnh báo khi playbackRate > 1.25×, thông báo Device Gate no-webgpu / device-too-slow) và nút "🎧 Nghe & dịch" chỉ khi settings.asr.enabled && !hasTrack && checkEligibility ok.
Viết tests/asr-integration.test.ts phủ đủ các ca trong plan, nhất là: enabled=false không render nút và không gọi import ASR; hiện EN tức thì trước VI; gộp câu theo dấu câu; cảnh báo 1.5×; khóa 1 tab (tab 2 dừng tab 1); tự dừng khi pause > 5 phút.
KHÔNG sửa bất kỳ test cũ nào. Toàn bộ test cũ phải xanh. Chạy typecheck, test, build. Ghi NOTES "## Phase 10-PoC A4" kèm danh sách chính xác các dòng đã sửa trong file cũ. [T] để CHƯA KIỂM.
```

### Prompt A5

```
Làm Phase 10-PoC A5 theo extension/PLAN-asr.md §4 A5 và §3.
Chuẩn bị trong NOTES.md bảng đo G1–G7 (đúng thứ tự G6 trước G7; G5 có dòng riêng cho Drive preview) theo ma trận 4 nhóm máy (Windows mạnh, Windows yếu, Mac Apple Silicon [ưu tiên không quạt đo thermal throttling ở phút 1/5/10 cho G7], Mac Intel) × 3 trình duyệt (Edge, Cốc Cốc, Firefox) — để trống, tôi sẽ điền — kèm hướng dẫn đo từng tiêu chí: tách 3 chặng độ trễ G2 (T_vad, T_asr, T_trans, đối chiếu T_asr ≤ 2.6 s WebGPU / ≤ 4.6 s WASM), đo % CPU + GPU + video.getVideoPlaybackQuality() cho G3, đo RAM (Shift+Esc / Activity Monitor) + hành vi tab ẩn (document.hidden kéo dài 2 phút: tạm dừng sau N s, số đoạn rớt, phục hồi khi quay lại) cho G7, chấm WER + hiểu đúng ý trên bộ mẫu đa dạng 6 thể loại + đối chứng YouTube Auto-CC cho G4.
Thêm log DEV-only trong asrSource để đo 3 chặng độ trễ; build production không có log này.
Cập nhật README.md (mục Video không có phụ đề, thử nghiệm, chỉ nhận dạng tiếng Anh, dung lượng thật đo từ A0, có hộp xác nhận tải lần đầu và nút xóa model trong Options) và PRIVACY_POLICY.md (nêu rõ hai vế: âm thanh xử lý 100% trên máy và không rời máy, nhưng văn bản nhận dạng được gửi tới dịch vụ dịch người dùng chọn như Google Translate / DeepL / Gemini; model tải từ huggingface.co).
KHÔNG tự điền kết quả đo và KHÔNG tự kết luận GO/NO-GO.
Chạy typecheck, test, build.
```

---

## 7. Changelog (Rà soát & bổ sung kế hoạch)

1. **Tốc độ phát và tua video:** Quy định chụp trực tiếp `mediaTime` ở đầu chunk và `endMediaTime` ở cuối chunk từ `video.currentTime` (cấm đếm mẫu hay trừ ngược buffer để không bị lùi mốc thời gian khi buffering); cảnh báo UI khi `playbackRate > 1.25×`; xóa buffer + reset `Segmenter` + tăng `generationId` (`gen`) để hủy segment đang xử lý khi `seeking`; bổ sung test `pause`, tua tới/lui, `1.25×`/`1.5×`, và `waiting`/buffering.
2. **RAM và nhiều tab:** Quy định mỗi lần chỉ 1 tab chạy ASR bằng cơ chế `asr.claim` / `asr.yield` qua Port `"subtrans"` của Background SW (tự nhả khóa qua `port.onDisconnect`, không dùng `chrome.storage.session` từ content script và không cần quyền `tabs`); bắt buộc terminate Worker và gỡ iframe khi dừng, `pause` > 5 phút, hoặc đóng tab/chuyển video; bổ sung cách đo RAM (`Shift+Esc` trên Windows, Activity Monitor trên macOS) và ngưỡng RAM ước tính cho `tiny.en`/`base.en` (cần đo ở A0).
3. **WebGPU tranh tài nguyên giải mã video:** Mở rộng G3 đo thêm `video.getVideoPlaybackQuality().droppedVideoFrames` và mức dùng GPU bên cạnh `% CPU`; cố định cấu hình "máy tham chiếu tầm trung" để đo.
4. **Định nghĩa lại cách đo độ trễ (G2):** Tách độ trễ toàn trình thành 3 chặng (`T_vad`, `T_asr`, `T_trans`); tách nhịp `onCuesChanged` (bắn ngay lập tức để hiện EN tức thì lên Overlay, không gom 3 s gây trễ giả) và `cache.saveTrack` (debounce riêng 5–10 s), sau đó cập nhật bổ sung bản dịch VI.
5. **Bộ cắt câu (Segmenter):** Ghi nhận đánh giá Silero VAD ONNX (_ước tính ~2 MB, cần xác minh_); thêm cơ chế cắt thông minh tại điểm RMS nhỏ nhất trong cửa sổ `[6 s, 8 s]` trước khi cắt cứng 8 s; thêm test riêng cho loại trùng ở biên đoạn (không lặp từ, không mất từ).
6. **Nhánh WASM:** Bổ sung phép đo `T_proc(3s/6s/8s)` của `whisper-tiny.en` q8 (đơn luồng) trên Windows máy yếu ở A0; đặt quy tắc quyết định cứng nếu không đạt ngưỡng G2 WASM (`≤ 4.6 s`) sẽ bỏ nhánh WASM và chỉ báo _"Thiết bị chưa đủ mạnh (không có WebGPU)"_.
7. **Tự kiểm tra máy trước khi bật (Device Gate):** Thiết kế bước kiểm tra 2 tầng trong A3/A4: kiểm tra WebGPU + chạy 1 lượt warm-up ngắn rồi benchmark trên clip tiếng nói tiếng Anh thật (~2–3 s, không dùng sóng sin/im lặng) đo `benchMs`; trả `perfTier: "ok" | "slow"` hoặc mã lỗi `no-webgpu` / `device-too-slow` lên `MiniToolbar`.
8. **Bảng thử nghiệm theo nền tảng (A0 & A5):** Chuẩn hóa ma trận 4 nhóm máy (Windows mạnh, Windows yếu, Mac Apple Silicon [ưu tiên máy không quạt để đo thermal throttling gắn vào G7], Mac Intel) × 3 trình duyệt (Edge, Cốc Cốc bắt buộc; Firefox best-effort; Safari ngoài phạm vi PoC); tách cổng bắt buộc của A0 (máy chính + checklist) với phần bổ sung thiết bị ở A5 để tránh nghẽn tiến độ.
9. **Định nghĩa rõ G4 (độ chính xác):** Quy định đo bằng WER tự động + chấm tay theo đáp án chuẩn trên bộ mẫu đa dạng 6 thể loại (giọng chuẩn, vùng miền, nói nhanh, thuật ngữ chuyên ngành, nhạc nền, bài giảng), kèm đối chứng trực tiếp với YouTube Auto-CC.
10. **Chất lượng dịch:** Bổ sung cơ chế giữ mảnh EN chưa đủ dấu câu hiển thị tạm (`pending`), gộp đủ câu theo dấu câu của Whisper (hoặc ngưỡng độ dài/timeout ~2 s) trước khi đẩy vào `Scheduler` dịch; tận dụng luồng `hybrid` sẵn có (ưu tiên Google GTX / DeepL cho Tier-1, nâng cấp Gemini kèm 1–2 câu `[CONTEXT - KHÔNG DỊCH]`) mà không sửa sâu `router.ts`.
11. **Interface `Transcriber`:** Định nghĩa interface `Transcriber` (`src/asr/transcriber.ts`) ngay từ A1 để tách `worker.ts` khỏi thư viện nhận dạng cụ thể, chỉ implement Whisper cục bộ trong PoC và mock được trong unit test (`tests/asr-worker.test.ts`).
12. **Danh sách kiểm chứng thêm ở A0 & đồng bộ tài liệu:** Tách thành mục riêng các điểm chưa xác minh (CSP YouTube/Drive với iframe extension, nhu cầu `host_permissions` cho `huggingface.co`/CDN, tổ hợp `dtype` WebGPU ổn định, dung lượng model thật, trạng thái WebGPU thực tế trên Firefox, và lệch đồng bộ khi buffering); đồng bộ lại toàn bộ §5 (Bảng rủi ro) và §6 (Prompt A0–A5) khớp với đặc tả mới.
13. **[v3] Cách đo tốc độ segment thực (A0, A3 Device Gate, §3):** Bổ sung đo thời gian xử lý thực `T_proc(3s)`, `T_proc(6s)`, `T_proc(8s)` vào bảng A0 kèm ghi chú giả định cửa sổ 30 s của Whisper (_cần xác minh ở A0_), do RTF trên 60 s không đại diện cho đoạn 6–8 s; Device Gate benchmark trên clip 2–3 s so với ngưỡng `benchMs` tương ứng độ dài clip 2–3 s (không dùng chung con số RTF với đoạn 8 s).
14. **[v3] Đồng bộ hệ ngưỡng suy từ G2:** Quy chuẩn ngưỡng thời gian xử lý cho phép của một segment từ G2 sau khi trừ `T_vad ≈ 0.4 s` (WebGPU ≤ 2.6 s; WASM ≤ 4.6 s) dùng chung cho điều kiện qua A0, quy tắc giữ/bỏ nhánh WASM (§3) và Device Gate (A3); định nghĩa rõ 2 mức ngưỡng Khuyến nghị (`ok`) / Tối thiểu (`slow`, cho chạy nhưng báo chậm — _ngưỡng tối thiểu cần xác minh ở A0_) cùng thông báo UI tương ứng.
15. **[v3] Cập nhật L6:** Bổ sung mục (d) vào danh sách khóa manifest được phép thêm: `host_permissions` cho `https://huggingface.co/*` và CDN tải model, chỉ khi A0 xác nhận cần.
16. **[v3] Xác nhận tải model lần đầu & xóa model (L7, A1, A4):** Thêm hộp xác nhận trước lần tải model đầu (ghi dung lượng thật đo ở A0 và nguồn `huggingface.co`), nút **"Xóa model đã tải"** trong Options (xóa Cache API), và bổ sung unit/integration test cho cả hai luồng.
17. **[v3] Nhãn ngôn ngữ trên MiniToolbar (A4):** Bổ sung hiển thị rõ nhãn/tooltip **"Chỉ nhận dạng tiếng Anh"** trên nút `🎧 Nghe & dịch`.
18. **[v3] Hành vi khi tab ẩn (`document.hidden` kéo dài):** Định nghĩa tự tạm dừng tap & ASR sau 30 s ẩn tab (_mốc N = 30 s cần xác minh ở A0_), tự tiếp tục khi quay lại, gọi `stopAsr` nếu ẩn > 5 phút, ghi nhận `dropped`; bổ sung test ở A4 và mục đo ở A0/A5.
19. **[v3] Làm rõ quyền riêng tư, thứ tự bảng G & `kind` của `AsrSubtitleSource`:** Nêu rõ trong `README`/`PRIVACY_POLICY` hai vế (âm thanh không rời máy, nhưng văn bản nhận dạng gửi tới dịch vụ dịch người dùng chọn); sắp lại thứ tự bảng §3 để G6 đứng trước G7; chốt rõ `kind: "asr"` (đã có trong `TrackKind` tại `src/shared/types.ts`).
20. Thông lượng khi đoạn đến liên tục:
    - A0: thêm phép đo "stream test": đưa vào host một chuỗi segment 1–2 s liên tiếp (mô phỏng nói tự nhiên có ngắt 0.4–0.7 s), ghi số segment bị drop, độ trễ tăng dần và T_proc từng đoạn. Ghi rõ hệ quả của giả định cửa sổ 30 s (nếu đúng thì chi phí mỗi đoạn gần cố định, bất kể độ dài).
    - Segmenter (A3): thêm gộp đoạn liền kề có khoảng cách < G giây (khởi điểm G=0.8, hiệu chỉnh ở A0) cho tới tối đa 6 s; ghi rõ đánh đổi với độ trễ G2.
    - Hàng đợi (A3): khi đầy, gộp các segment đang chờ thay vì bỏ segment cũ nhất; chỉ bỏ khi tổng độ dài gộp > 8 s.
    - Thêm test ở asr-segmenter.test.ts (gộp đoạn ngắn) và asr-worker.test.ts (gộp khi đầy hàng đợi). Thêm tiêu chí vào G2 hoặc G3: "tỷ lệ đoạn bị bỏ ≤ X% trong stream test" (X chốt ở A0).
21. G1: thêm kiểm tra lệch tiếng-hình (A/V sync) có và không có ASR, trên loa ngoài và tai nghe Bluetooth; ghi chú đây là rủi ro chưa xác minh, cần đo ở A0 và A5.
22. A0: thêm cổng chất lượng sớm: chạy tiny.en và base.en trên ~10 câu đại diện nội dung người dùng hay xem (gồm giọng khó, có nhạc nền), chấm tay sơ bộ, ghi vào NOTES. Nếu quá kém thì dừng và hỏi trước khi sang A1.
23. A3/models.ts: đưa các ngưỡng Device Gate (khuyến nghị/tối thiểu, WebGPU/WASM) và ngưỡng gộp đoạn thành hằng số cấu hình; ghi rõ giá trị hiện tại là tạm, sẽ được A0 điền.
24. G5 / A0: xác nhận content script chạy trong iframe Drive preview (all_frames hoặc match pattern phù hợp) và host iframe tạo được trong frame đó; thêm vào danh sách kiểm chứng ở A0.
