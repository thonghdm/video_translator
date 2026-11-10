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

**L4. Thực tế phụ đề ưu tiên hơn ASR**
- Đang chạy ASR mà xuất hiện nguồn thật (track mới, CC nạp muộn, sidecar về muộn, người dùng nhập file): **dừng ASR** và chuyển sang nguồn thật.

**L5. Tách module, nạp lười**
- Code nhận dạng (`@huggingface/transformers`, onnxruntime) **chỉ** nằm trong trang ASR host của extension.
- Content script **không bao giờ** import thư viện đó.
- Phần ASR phía content (audio tap, bridge, source) được nạp bằng `import()` động, chỉ khi bấm nút.

**L6. Không thêm quyền nhạy cảm**
- Không dùng `tabCapture`, `offscreen`, `scripting`, `tabs`.
- Manifest chỉ được thêm ba thứ: (a) trang `src/asr/host.html` cùng tài nguyên của nó trong `web_accessible_resources`; (b) `content_security_policy.extension_pages` có `'wasm-unsafe-eval'`; (c) các file wasm của onnxruntime **đóng gói sẵn trong extension**.
- CSP của trang web người dùng xem không bị đụng tới.

**L7. Không có remote code**
- Mọi file JS và WASM phải nằm trong `dist/`.
- Chỉ **dữ liệu model** (`.onnx`, `.json`) được tải lúc chạy, từ `https://huggingface.co/` với **revision ghim cố định**, rồi cache trong origin của extension (Cache API).
- Lần đầu dùng phải hiện % tải. Không dùng tính năng thì không tải gì.

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
- Mỗi chunk âm thanh mang theo `mediaTime` = `video.currentTime` tại mẫu đầu tiên, ước lượng bằng `currentTime` lúc callback trừ đi độ dài buffer.
- Segment = `[mediaTime đầu, mediaTime cuối]`. Cue luôn mang **thời gian thật của video**, để xuất file, cache và tua lại xem đều đúng.

**Độ trễ hiển thị ("live lag")**
- Cue ASR luôn về **sau** thời điểm câu được nói (độ trễ khoảng 1–3 s). Nếu chỉ tra theo `currentTime` thì cue không bao giờ được hiện.
- Cách xử lý: `SubtitleSource` có thêm trường **tùy chọn** `liveLagSec?: number`.
  - Chỉ khi trường này có giá trị, Session mới tra dòng hiện tại theo `currentTime - liveLagSec` nếu không có cue nào khớp `currentTime`.
  - Các nguồn hiện có không đặt trường này, nên hành vi **không đổi** (có test chứng minh).

**Tua, tạm dừng, đổi tốc độ**
- `seeking`: bỏ buffer chưa nhận dạng và reset segmenter.
- `pause`: chốt segment đang dở.
- `playbackRate ≠ 1`: vẫn tap bình thường vì `mediaTime` đã đúng. Chất lượng nhận dạng ở tốc độ >1.25× chỉ ghi nhận, không đảm bảo.

**Model mặc định cho PoC (chỉ tiếng Anh)**
- WebGPU dùng `onnx-community/whisper-base.en`.
- WASM dùng `onnx-community/whisper-tiny.en`, lượng tử q8.
- Kích thước và revision chính xác chốt ở A0 rồi ghi vào `src/asr/models.ts`.

---

## 3. Cổng go/no-go (đánh giá ở A5, tất cả là [T])

| # | Tiêu chí | Ngưỡng đạt |
|---|---|---|
| G1 | Âm thanh video sau khi bật/tắt ASR | Nghe như cũ; volume và mute vẫn hoạt động; không câm, không rè |
| G2 | Độ trễ từ lúc nói xong câu đến lúc hiện chữ gốc | Trung vị ≤ 3 s (WebGPU), ≤ 5 s (WASM) |
| G3 | CPU trong lúc nghe, video 1080p | ≤ 50% tổng CPU, video không giật |
| G4 | Độ đúng: 50 câu tiếng Anh rõ (bài giảng) | ≥ 85% câu hiểu đúng ý |
| G5 | Iframe host chạy được trên YouTube, Drive preview (kiểm **riêng**, vì đây là nền tảng khó nhất), 1 trang `<video>` thường | Đạt trên Edge, Cốc Cốc, Firefox |
| G7 | Chạy liên tục 10 phút (tab đang phát, iframe ẩn) | RTF phút cuối ≤ 1.5 × RTF phút đầu; không rò bộ nhớ quá 300 MB |
| G6 | Không ảnh hưởng (L1) | Toàn bộ test cũ xanh; ma trận thủ công PLAN.md §8 chạy lại thấy không đổi |

Nếu G1, G5 hoặc G6 không đạt thì **NO-GO cứng**. Nếu chỉ G2, G3, G4 hoặc G7 không đạt thì ghi lại, thử đổi model hoặc tham số **một lần**, rồi quyết định. Áp dụng chính sách trình duyệt ở đầu tài liệu: Firefox trượt G2/G3/G4/G7 không kéo Chromium thành NO-GO.

Nghi phạm đầu tiên khi trượt:
- **G3 (CPU, giật video):** `ScriptProcessorNode` chạy trên main thread của trang. Hướng sửa ở Phase 10 đầy đủ: AudioWorklet qua Blob URL (nếu page CSP cho phép), hoặc `video.captureStream()` rồi xử lý trong host.
- **G4 (độ đúng):** VAD năng lượng mở segment sai khi có nhạc nền hoặc tạp âm, gây ảo giác. Hướng sửa: Silero VAD.
- **G2/G7 trên WASM:** WASM đơn luồng (iframe không `crossOriginIsolated`). Không có cách sửa nhanh; chấp nhận theo chính sách trình duyệt.

---

## 4. Các phase

### A0. Spike khả thi (code bỏ đi, KHÔNG vào `dist/`)

**Mục tiêu:** chứng minh ba điều trước khi viết code sản phẩm: (1) transformers.js chạy được dưới CSP của extension trên 3 trình duyệt; (2) đo tốc độ; (3) iframe extension có bị page CSP chặn hay không.

**Việc làm**
- Tạo thư mục `dev/asr-spike/`, là một **extension riêng tối thiểu** với manifest riêng và vite config riêng. **Không** sửa `manifest.config.ts`, `vite.config.ts` hay `package.json` gốc. Dependency của spike để trong `dev/asr-spike/package.json`.
- Trang `spike.html`:
  - Nạp `@huggingface/transformers` (phiên bản v3 mới nhất, ghi rõ số version).
  - Đặt `env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("ort/")` (wasm copy vào gói) và `env.allowLocalModels = false`.
  - Chạy `pipeline("automatic-speech-recognition", model, { device })` trên file `dev/asr-spike/fixture-60s.wav` (16 kHz mono, tự thu 60 s tiếng Anh bài giảng; **không** lấy nhạc có bản quyền).
  - In ra: thời gian tải model, thời gian nhận dạng, RTF = thời_gian_xử_lý / 60, backend thực tế, và văn bản.
- Content script spike: chèn iframe `spike-frame.html` (web accessible) vào trang và nhận `postMessage("pong")`. Thử trên YouTube, trang Drive preview, và một trang `<video>` thường.
- Thử `createMediaElementSource` trên video YouTube: nối vào `destination`, kiểm âm thanh còn bình thường, và đọc RMS từ một `ScriptProcessorNode` để thấy có số liệu (khác 0).
- **Bài chạy dài 10 phút:** iframe ẩn 0×0 trong tab YouTube đang phát video, nhận dạng lặp lại fixture (hoặc audio tap thật) liên tục. Ghi RTF theo từng phút, bộ nhớ của tiến trình (Task Manager của trình duyệt) ở phút 1 và phút 10. Lặp lại khi chuyển sang tab khác trong 2 phút để xem trình duyệt có bóp iframe nền không.

**Kết quả [T] ghi vào NOTES.md, bảng theo trình duyệt (Edge, Cốc Cốc, Firefox):**
- Version của trình duyệt, có WebGPU hay không.
- Model chạy được (tiny.en/base.en) × backend, kèm RTF.
- Kích thước thư mục `ort/` (MB).
- Iframe có chạy trên YouTube, Drive preview, trang thường hay không.
- Bài chạy dài: RTF phút 1 / phút 10, bộ nhớ phút 1 / phút 10, RTF khi tab ở nền.
- Tap có số liệu khác 0, và âm thanh có bình thường hay không.

**Điều kiện qua A0:** trên **Edge và Cốc Cốc**, ít nhất một tổ hợp model × backend có RTF ≤ 0.5, và bài chạy dài không suy giảm quá 1.5×. Iframe phải chạy được trên YouTube ở **cả 3** trình duyệt. Firefox có RTF > 0.5 thì ghi lại và vẫn qua A0 (best-effort). Nếu Firefox bị chặn iframe, ghi lại rồi **hỏi** trước khi làm phương án background.

### A1. Khung build, manifest, cờ cài đặt

**Việc làm**
1. `package.json`: thêm dependency `@huggingface/transformers` (ghim đúng version đã dùng ở A0).
2. Tạo `src/asr/host.html`, `src/asr/host.ts` (hiện chỉ trả lời ping) và `src/asr/worker.ts` (rỗng).
3. `manifest.config.ts`:
   - Thêm `content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }`.
   - Thêm vào `web_accessible_resources` mục `{ resources: ["src/asr/host.html", ...asset của host], matches: ["<all_urls>"] }`. Nếu CRXJS không tự gom asset của host thì liệt kê thủ công và ghi lý do.
4. Copy wasm của onnxruntime vào `public/ort/` bằng script `scripts/copy-ort.mjs` chạy trước build. **Chỉ copy** các file thật sự cần, theo danh sách A0 đo được.
5. `settings.ts`: thêm `asr: { enabled: false, model: "auto" }`. `"auto"` nghĩa là WebGPU → base.en, WASM → tiny.en. Options có toggle "Thử nghiệm: Nghe & dịch video không có phụ đề (chạy trên máy)". Giữ quy tắc reset/merge settings như hiện tại.
6. `verify-dist.mjs`: thêm các guard của L9. Cập nhật allowlist URL thêm `huggingface.co`.
7. Ghi kích thước `dist/` trước và sau vào NOTES.

**Test mới (`tests/asr-a1.test.ts`)**
- `DEFAULT_SETTINGS.asr.enabled === false`.
- Settings cũ thiếu khóa `asr` thì merge ra mặc định đúng.
- Guard trong verify-dist bắt được chuỗi `onnxruntime` nếu chuỗi đó bị cài vào bundle content. Test bằng fixture.

**[T]**
- Cài bản build lên Edge: mọi tính năng cũ chạy như trước.
- Mở `chrome-extension://<id>/src/asr/host.html` trực tiếp: trang tải được, không lỗi CSP trong console.
- Làm tương tự với gói Firefox (`pnpm zip`, nạp tạm qua `about:debugging`).

### A2. Audio tap phía content

**File:** `src/content/asr/audioTap.ts`. Đây là module nạp lười, không import từ `index.ts` theo kiểu tĩnh.

**API**
```ts
export type TapEligibility = { ok: true } | { ok: false; reason: "cross-origin" | "no-audio-ctx" };
export function checkEligibility(video: HTMLVideoElement, pageOrigin: string): TapEligibility;
export interface AudioChunk { samples: Float32Array /*16 kHz mono*/; mediaTime: number; }
export function getOrCreateGraph(video: HTMLVideoElement): VideoGraph; // WeakMap, tạo 1 lần
export interface VideoGraph {
  ctx: AudioContext;                  // KHÔNG bao giờ close khi video còn sống (L3)
  startTap(onChunk: (c: AudioChunk) => void): () => void; // trả hàm stop: chỉ ngắt nhánh tap
}
export function downsampleTo16k(input: Float32Array, inRate: number, state: ResampleState): Float32Array;
```

**Quy tắc**
- `checkEligibility` trả về `ok` khi `currentSrc` bắt đầu bằng `blob:` (MSE, như YouTube và Drive), hoặc cùng origin với trang, hoặc khi `video.crossOrigin` đã được đặt. Mọi trường hợp khác trả `cross-origin`, và **không tạo** source node.
- Graph: `source → destination` (luôn có), cộng nhánh `source → ScriptProcessor(4096, 2, 1) → gain(0) → destination` khi tap. Ghi chú: có thể dùng AudioWorklet, nhưng `addModule` có thể bị page CSP chặn, nên PoC dùng ScriptProcessor.
- Downsample về mono 16 kHz bằng trung bình kênh rồi lọc thông thấp đơn giản và decimate tuyến tính. Gom thành chunk khoảng 0.5 s rồi mới gửi.
- `ctx.state === "suspended"` thì gọi `resume()` trong handler của cú bấm.
- Phát hiện câm: video đang phát, không mute, `volume > 0`, mà 3 s liền RMS = 0 → báo `"silent-tap"` để controller dừng và hiện thông báo. Graph thì vẫn giữ nguyên vì L3.

**Test (`tests/asr-audioTap.test.ts`, dùng fake AudioContext)**
- Gọi `getOrCreateGraph` 2 lần trên cùng video thì `createMediaElementSource` chỉ được gọi 1 lần.
- `stop()` ngắt processor nhưng **không** ngắt `source → destination` và **không** gọi `close`.
- Ma trận `checkEligibility`: blob, cùng origin, khác origin, có `crossOrigin`.
- `downsampleTo16k`: 48k → 16k ra đúng độ dài, sóng sin 440 Hz giữ được tần số (kiểm qua số lần đổi dấu), và ghép nhiều buffer liên tiếp không bị hở.
- `mediaTime` của chunk tăng đơn điệu khi phát đều.

**[T]** Dùng trang harness dev (không vào dist), trên YouTube với cả 3 trình duyệt:
- Bật tap, tắt tap, bật lại: âm thanh vẫn bình thường; volume và mute hoạt động; không có tiếng vọng đôi.

### A3. ASR host: segmenter + Whisper

**File:** `src/asr/host.ts`, `src/asr/worker.ts`, `src/asr/segmenter.ts`, `src/asr/models.ts`, `src/asr/protocol.ts`.

**Giao thức (`protocol.ts`, dùng chung với content)**
```ts
// content → host (qua MessagePort chuyển giao lúc khởi tạo)
type ToHost =
  | { t: "init"; model: "auto" | string; lang: "en" }
  | { t: "audio"; samples: Float32Array; mediaTime: number }   // transfer samples.buffer
  | { t: "flush" }            // pause: chốt segment đang dở
  | { t: "reset" }            // seeking: bỏ buffer
  | { t: "stop" };
// host → content
type FromHost =
  | { t: "progress"; phase: "download" | "load"; pct: number }
  | { t: "ready"; backend: "webgpu" | "wasm"; model: string }
  | { t: "segments"; items: Array<{ start: number; end: number; text: string }> }
  | { t: "dropped"; total: number }   // số segment đã bỏ do quá tải (cộng dồn)
  | { t: "error"; code: "model-download" | "backend" | "oom" | "unknown"; message: string };
```

**Bắt tay**
- Content tạo iframe với `src = runtime.getURL("src/asr/host.html")` và style `position:fixed; width:0; height:0; border:0; opacity:0`.
- Khi iframe `load`, content gửi `postMessage({t:"hello"}, extOrigin, [port2])`.
- Host chỉ nhận port **đầu tiên**, và chỉ khi `event.source === window.parent`.
- Không dùng `chrome.runtime` trong host trừ `getURL`. Host không đọc storage (L8).

**Segmenter (VAD năng lượng, cài trong `segmenter.ts`, logic thuần nên test được)**
- Cửa sổ 30 ms. Ngưỡng tính động theo noise floor (phân vị 20% của 3 s gần nhất) cộng biên.
- Mở segment khi có ≥ 150 ms tiếng nói. Đóng segment khi im lặng ≥ 400 ms, hoặc khi segment đạt **8 s** (cắt cứng).
- Segment bị **cắt cứng** thì segment kế tiếp bắt đầu sớm hơn **0.4 s** (chồng lấp) để không mất chữ ở biên. Phía worker bỏ phần trùng: so các từ cuối của text trước với các từ đầu của text sau (tối đa 4 từ, không phân biệt hoa thường và dấu câu), trùng thì cắt khỏi text sau.
- Bỏ segment ngắn hơn 0.4 s.
- Mỗi segment giữ `startMedia` và `endMedia` từ `mediaTime` của chunk.

**Worker**
- Gọi `pipeline("automatic-speech-recognition", modelId, { device, dtype })` với `return_timestamps: true` để tách cue dài thành câu ngắn (≤ 2 dòng, khoảng ≤ 7 s).
- Thử WebGPU trước. Nếu lỗi thì chuyển sang WASM với model tiny.en, và báo `ready.backend`.
- Hàng đợi: **tối đa 2 segment chờ**. Nếu đầy thì bỏ segment cũ nhất, gửi `{t:"dropped", total}` về content (UI hiện cảnh báo), và không để trễ tích lũy.
- Lọc ảo giác: bỏ text rỗng, text chỉ có dấu câu, các chuỗi lặp kiểu "Thank you." hay "[Music]" khi RMS của segment thấp, và text trùng hoàn toàn với segment ngay trước.

**Test**
- `tests/asr-segmenter.test.ts`: im lặng + tiếng nói tổng hợp (sin có biên độ) tạo đúng số segment và đúng mốc thời gian (sai số ≤ 60 ms); cắt cứng ở 8 s; `reset` bỏ buffer; `flush` chốt segment.
- `tests/asr-protocol.test.ts`: host bỏ qua port thứ hai và bỏ qua message không đến từ parent.
- `tests/asr-filter.test.ts`: bộ lọc ảo giác, và hàm bỏ phần trùng ở biên segment cắt cứng (trùng 1–4 từ, khác hoa thường/dấu câu, không trùng thì giữ nguyên).
- `tests/asr-segmenter.test.ts` thêm: segment sau một lần cắt cứng bắt đầu sớm hơn 0.4 s.
- Worker và model **không** test bằng unit vì quá nặng. Kiểm bằng [T].

**[T]**
- Mở host trên YouTube trong cả 3 trình duyệt, lần đầu tải model: hiện % tải; tải lại trang thì dùng cache, không tải lại.
- Ghi backend thực tế, thời gian tải, RTF.

### A4. Ghép vào luồng hiện tại

**File:** `src/content/asr/asrMain.ts` (điểm nạp lười), `src/content/asr/asrSource.ts`, `src/content/asr/bridge.ts`, cùng các sửa **tối thiểu** ở `src/content/index.ts`, `MiniToolbar.tsx`, `store.ts`, `session.ts`, `adapters/types.ts`.

**AsrSubtitleSource implements SubtitleSource**
- `track`: `trackKey = "asr:" + platform + ":" + videoId + ":" + modelId`, `kind` = loại hiện có gần nhất (ghi rõ trong NOTES), `lang: "en"`, title `"🎧 Nghe tự động (thử nghiệm)"`.
- `load()` trả `[]`. `onCuesChanged` phát **toàn bộ** danh sách cue đã sắp xếp, **gom tối thiểu 3 s một lần** để tránh `cache.saveTrack` liên tục.
- `liveLagSec`: đặt bằng trung vị độ trễ đo được (kẹp trong khoảng 1–4 s, mặc định 2.5).
- Cue chồng nhau thì cắt `end` của cue trước về `start` của cue sau.

**Session (sửa có kiểm soát)**
- `adapters/types.ts`: thêm `readonly liveLagSec?: number`.
- Hàm tra dòng hiện tại: **chỉ khi** `source.liveLagSec` có giá trị **và** không có cue nào khớp `t` thì tra thêm `t - liveLagSec`. Không đổi gì khác.
- Test mới chứng minh: nguồn không có `liveLagSec` cho kết quả tra **giống hệt** trước khi sửa, kiểm trên một bảng thời gian cố định.

**ContentController**
- `sessionOrigin` thêm giá trị `"asr"`.
- `trySetup`: hiện tại `return` sớm nếu `this.session` đã có. Sửa thành: nếu `sessionOrigin === "asr"` thì **vẫn** gọi `listSources`; có nguồn thật thì gọi `stopAsr()` rồi `startSession(..., "adapter")` (L4). Origin khác thì giữ nguyên logic cũ.
- `trySidecar` có kết quả trong lúc đang ASR, hoặc người dùng nhập file: cũng gọi `stopAsr()` trước, rồi làm như hiện nay.
- `stopAsr()`: dừng tap, gửi `stop`, gỡ iframe, dispose source và session. Graph audio **giữ nguyên** (L3).
- Đổi video hoặc teardown: gọi `stopAsr()`. Bỏ được cả iframe.
- Nút chỉ hiện khi đủ cả 4 điều kiện: `settings.asr.enabled && !hasTrack && video có audio && checkEligibility().ok`. Nếu `cross-origin` thì không hiện nút. Có thể có tooltip giải thích khi rê chuột vào vùng nút, nhưng không bắt buộc.

**MiniToolbar và store**
- Store thêm `asr: { state: "off" | "loading" | "listening" | "error"; pct?: number; backend?: string; note?: string; dropped?: number }`. Mặc định `off`.
- Khi `dropped > 0`: hiện "⚠ Máy quá tải, đã bỏ qua N đoạn". Nếu backend là WASM, gợi ý thêm "trình duyệt chưa có WebGPU, nhận dạng sẽ chậm".
- Nút "🎧 Nghe & dịch" chỉ render khi controller cho phép (prop `asrAvailable`). Bấm thì hiện "Đang tải model 37%…", sau đó "🎧 Đang nghe (WebGPU)". Bấm lại thì dừng.
- Thông báo lỗi ngắn: model không tải được; tap câm (`silent-tap`); trình duyệt không hỗ trợ.

**Test mới (`tests/asr-integration.test.ts`, jsdom)**
- `asr.enabled = false`: không render nút, và `import("./asr/asrMain")` **không bao giờ** được gọi. Kiểm bằng spy hoặc mock của dynamic import.
- `enabled = true` nhưng có nguồn thật: không có nút.
- `enabled = true`, không nguồn: có nút. Bấm thì `sessionOrigin === "asr"`.
- Đang ASR mà `addtrack` hoặc `playing` làm `listSources` trả nguồn thật: ASR dừng, session mới có origin `"adapter"`.
- Đang ASR mà người dùng nhập file: ASR dừng.
- Đang ASR mà sidecar trả về: ASR dừng.
- `stopAsr` không gọi `ctx.close()`.
- `liveLagSec`: cue `[10, 12]`, `currentTime = 13`, lag 2.5 thì hiện cue đó; nguồn thường cùng thời điểm thì không hiện.

**[T]** Kiểm trên Edge, Cốc Cốc, Firefox:
- Một video YouTube **không có CC**: bật toggle, bấm nút, có chữ gốc rồi có bản dịch.
- Một video YouTube **có CC**: không thấy nút.

### A5. Đo đạc và quyết định go/no-go

- Chạy bảng §3 trên cả 3 trình duyệt, ghi số liệu thật vào NOTES.md, dạng bảng.
- G5: kiểm **riêng** Drive preview (video trong iframe `youtube.googleapis.com/embed`), ghi `currentSrc` có phải `blob:` không và nút có hiện không.
- G7: chạy 10 phút với audio thật, ghi RTF và bộ nhớ đầu/cuối.
- G4: dùng một video bài giảng tiếng Anh có CC thật, tạm ẩn CC bằng cách test trên bản tải về hoặc trên trang `<video>` thường, rồi so ASR với CC của 50 câu.
- Chạy lại ma trận thủ công PLAN.md §8, ghi "không đổi" hoặc liệt kê khác biệt.
- Cập nhật `README.md` (mục "Video không có phụ đề", ghi rõ là thử nghiệm, lần đầu tải model khoảng X MB) và `PRIVACY_POLICY.md` (âm thanh xử lý trên máy; model tải từ huggingface.co).
- Ghi kết luận vào NOTES.md: **GO** (giữ toggle, kèm danh sách việc cho Phase 10 đầy đủ: Silero VAD, dùng lại cue ASR đã cache khi xem lại, đa ngôn ngữ, tùy chọn model) hoặc **NO-GO** (giữ `enabled: false` và ẩn toggle, hoặc gỡ code; quyết định cùng người dùng).

---

## 5. Rủi ro đã biết

| Rủi ro | Cách xử lý trong PoC |
|---|---|
| `createMediaElementSource` trên video khác origin làm video câm vĩnh viễn | `checkEligibility` chặn trước (L3); phát hiện tap câm để báo lỗi |
| Page CSP chặn iframe extension (nhất là Firefox) | Kiểm ở A0; Firefox có phương án background, chỉ làm khi cần |
| WASM không có đa luồng (iframe không `crossOriginIsolated`) | Chấp nhận; WASM dùng tiny.en; ưu tiên WebGPU |
| Firefox WebGPU chỉ có trên Windows từ bản 141 | Ghi version vào [T]; trên bản cũ hơn thì chạy WASM |
| Whisper "ảo giác" khi im lặng hoặc có nhạc | VAD + bộ lọc ở A3 |
| Bản Firefox đang khai `strict_min_version 115` nhưng content script MAIN world cần 128+ | Ngoài phạm vi; chỉ ghi chú cho Phase F |
| `handleCuesChanged` lưu lại cả track mỗi lần đổi | Gom cập nhật ≥ 3 s; đo trong [T] |
| Kích thước extension tăng (wasm) | Chỉ copy file wasm cần thiết; ghi số MB vào NOTES |

---

## 6. Prompt cho từng phase (copy nguyên khối gửi AI code)

### Prompt A0
```
Bạn làm Phase 10-PoC A0 của dự án extension SubTrans (thư mục extension/, nhánh feat/extension).
Đọc PLAN.md §3 và extension/PLAN-asr.md (toàn bộ, nhất là §1 Luật L1–L9 và §4 A0).
Nhiệm vụ: tạo spike KHẢ THI trong extension/dev/asr-spike/, là extension tối thiểu RIÊNG (manifest, vite config, package.json riêng).
TUYỆT ĐỐI không sửa manifest.config.ts, vite.config.ts, package.json, src/ hoặc tests/ của extension chính.
Spike gồm:
(1) spike.html chạy transformers.js v3 (ghi rõ version) với wasm onnxruntime copy vào gói (env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("ort/")), CSP extension_pages có 'wasm-unsafe-eval'; nhận dạng fixture-60s.wav bằng whisper-tiny.en và whisper-base.en, thử device webgpu và wasm; in thời gian tải, RTF, backend, văn bản.
(2) content script chèn iframe web-accessible spike-frame.html vào trang và nhận postMessage "pong"; log kết quả.
(3) nút trong content script tạo AudioContext + createMediaElementSource(video) → destination, cộng ScriptProcessor đo RMS; log RMS.
(4) chế độ "chạy dài 10 phút" trong iframe ẩn: nhận dạng lặp liên tục, log RTF mỗi phút và performance.memory nếu có; tôi sẽ đo thêm bộ nhớ bằng Task Manager.
Viết README ngắn trong dev/asr-spike/ hướng dẫn build và nạp lên Edge, Cốc Cốc, Firefox (about:debugging).
Thêm vào NOTES.md mục "## Phase 10-PoC A0" chứa bảng kết quả [T] để TRỐNG (ghi CHƯA KIỂM). Không tự điền số liệu.
Nếu thư viện hoặc API khác với plan, dừng lại, ghi vào NOTES và hỏi tôi.
Không commit. Cuối cùng liệt kê file đã tạo.
```

### Prompt A1
```
Làm Phase 10-PoC A1 theo extension/PLAN-asr.md §4 A1. Đọc kỹ §1 (L1, L5, L6, L7, L9) trước.
Dùng đúng version @huggingface/transformers và danh sách file wasm onnxruntime đã ghi ở NOTES.md mục A0.
Việc cần làm: thêm dependency; tạo src/asr/host.html, host.ts (chỉ trả ping), worker.ts (rỗng); sửa manifest.config.ts (CSP extension_pages có 'wasm-unsafe-eval', web_accessible_resources cho host); viết scripts/copy-ort.mjs copy wasm cần thiết vào public/ort/; thêm settings.asr = { enabled:false, model:"auto" } theo đúng cách merge/reset hiện có; thêm toggle trong Options; thêm guard trong verify-dist.mjs (content bundle không có onnxruntime/transformers/InferenceSession; allowlist URL thêm huggingface.co).
Thêm tests/asr-a1.test.ts như plan mô tả.
KHÔNG sửa test cũ. KHÔNG đụng frontend/wailsjs, root package.json hay scripts/zip.mjs (ngoại trừ khi bắt buộc để gói Firefox có file host; nếu cần thì hỏi trước).
Chạy pnpm typecheck, pnpm test, pnpm build, đều phải xanh. Ghi kích thước dist trước/sau và danh sách khóa mới trong manifest vào NOTES.md "## Phase 10-PoC A1". Các mục [T] ghi CHƯA KIỂM.
```

### Prompt A2
```
Làm Phase 10-PoC A2 theo extension/PLAN-asr.md §4 A2. Luật L3 là quan trọng nhất: không bao giờ close AudioContext khi video còn sống; source luôn nối destination; mỗi video 1 graph trong WeakMap; video khác origin không CORS thì không tạo source node.
Tạo src/content/asr/audioTap.ts đúng API trong plan (checkEligibility, getOrCreateGraph, VideoGraph.startTap, downsampleTo16k, phát hiện silent-tap). Dùng ScriptProcessorNode(4096) + gain(0) cho nhánh tap. Gom chunk khoảng 0.5 s, mediaTime ước lượng như §2.
File này KHÔNG được import tĩnh từ src/content/index.ts (sẽ nạp lười ở A4).
Viết tests/asr-audioTap.test.ts với fake AudioContext, phủ đủ các ca trong plan.
Thêm trang harness dev (ngoài dist) để tôi kiểm [T] trên YouTube.
Test cũ giữ nguyên. Chạy typecheck, test, build. Ghi NOTES "## Phase 10-PoC A2", [T] để CHƯA KIỂM.
```

### Prompt A3
```
Làm Phase 10-PoC A3 theo extension/PLAN-asr.md §4 A3.
Tạo src/asr/protocol.ts (đúng kiểu ToHost/FromHost trong plan), segmenter.ts (VAD năng lượng thuần, test được), models.ts (model id + revision ghim từ A0), host.ts (bắt tay MessagePort: chỉ nhận port đầu tiên và chỉ từ window.parent; không đọc chrome.storage), worker.ts (transformers.js pipeline ASR, return_timestamps, thử webgpu rồi fallback wasm tiny.en, hàng đợi tối đa 2 segment, lọc ảo giác, gửi progress).
Thời gian segment phải là thời gian video (mediaTime), không phải thời gian đồng hồ.
Viết tests/asr-segmenter.test.ts, asr-protocol.test.ts, asr-filter.test.ts như plan. Nhớ phần chồng lấp 0.4 s sau cắt cứng + bỏ từ trùng ở biên, và message {t:"dropped", total} khi hàng đợi đầy.
Không có remote code: mọi JS/WASM nằm trong dist; chỉ dữ liệu model tải từ huggingface.co với revision ghim.
Test cũ giữ nguyên. Chạy typecheck, test, build (verify-dist phải xanh). Ghi NOTES "## Phase 10-PoC A3", [T] để CHƯA KIỂM.
```

### Prompt A4
```
Làm Phase 10-PoC A4 theo extension/PLAN-asr.md §4 A4. Đây là phase duy nhất được sửa code đang chạy. Chỉ sửa đúng các điểm plan liệt kê, ở mức tối thiểu.
1) adapters/types.ts: thêm readonly liveLagSec?: number. Session chỉ dùng trường này khi có giá trị và không có cue khớp t. Viết test chứng minh nguồn không có liveLagSec cho kết quả tra giống hệt trước.
2) Tạo src/content/asr/asrMain.ts (điểm nạp lười, chỉ được gọi bằng import() động), bridge.ts (iframe ẩn + MessagePort), asrSource.ts (AsrSubtitleSource: trackKey "asr:...", gom onCuesChanged tối thiểu 3 s, cắt chồng cue, liveLagSec).
3) ContentController: sessionOrigin thêm "asr"; trySetup vẫn dò nguồn khi đang ASR và ưu tiên nguồn thật (L4); trySidecar/import file thì stopAsr trước; đổi video/teardown thì stopAsr; stopAsr không bao giờ close AudioContext.
4) Store + MiniToolbar: trạng thái asr (có dropped, hiện cảnh báo quá tải và gợi ý khi chạy WASM) và nút "🎧 Nghe & dịch" chỉ khi settings.asr.enabled && !hasTrack && checkEligibility ok.
Viết tests/asr-integration.test.ts phủ đủ các ca trong plan, nhất là: enabled=false thì không render nút và không bao giờ gọi import ASR.
KHÔNG sửa bất kỳ test cũ nào. Toàn bộ test cũ phải xanh. Chạy typecheck, test, build. Ghi NOTES "## Phase 10-PoC A4" kèm danh sách chính xác các dòng đã sửa trong file cũ. [T] để CHƯA KIỂM.
```

### Prompt A5
```
Làm Phase 10-PoC A5 theo extension/PLAN-asr.md §4 A5 và §3.
Chuẩn bị trong NOTES.md bảng đo G1–G7 (G5 có dòng riêng cho Drive preview) cho Edge, Cốc Cốc, Firefox (để trống, tôi sẽ điền), kèm hướng dẫn đo từng tiêu chí: cách đo trễ (log thời điểm segment end so với thời điểm cue hiện), cách đo CPU (Task Manager của trình duyệt), cách chấm 50 câu.
Thêm log DEV-only trong asrSource để đo độ trễ; build production không có log này.
Cập nhật README.md (mục Video không có phụ đề, thử nghiệm) và PRIVACY_POLICY.md (âm thanh xử lý trên máy, model tải từ huggingface.co).
KHÔNG tự điền kết quả đo và KHÔNG tự kết luận GO/NO-GO.
Chạy typecheck, test, build.
```
