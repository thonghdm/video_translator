# SubTrans Chrome Extension — Kế hoạch triển khai chi tiết (v2)

> Tài liệu này viết cho **AI coding agent** (và lập trình viên) đọc và code theo từng phase.
> Plan dựa trên mã nguồn Desktop hiện tại (branch `diag/playback-perf`, commit `b9a08b6`).
> Mỗi phase có: mục tiêu, file cần tạo, đặc tả chi tiết, tiêu chí hoàn thành, kiểm thử, và những việc **không được làm**.

---

## 0. Cách dùng tài liệu này (đọc trước khi code)

1. **Làm đúng một phase mỗi lần.** Không làm trước phase sau. Phase sau giả định phase trước đã đạt hết tiêu chí hoàn thành.
2. Đầu mỗi phase: đọc lại **Mục 3 (Quy tắc bất biến)** và **Mục 6 (Hợp đồng dữ liệu)**.
3. Khi phase yêu cầu "port từ Go", **mở file Go gốc và đọc kỹ** trước khi viết TypeScript. Giữ nguyên hành vi, hằng số và thứ tự xử lý. Chỉ đổi những chỗ mà trình duyệt bắt buộc phải khác (ghi rõ trong đặc tả).
4. Cuối mỗi phase: chạy **toàn bộ lệnh kiểm tra ở Mục 3.3**, rồi tự đối chiếu từng tiêu chí hoàn thành. Có tiêu chí nào chưa đạt thì phase đó **chưa xong**.
5. Commit theo phase. Message dạng `feat(extension): phase N - <mô tả>`. Không gộp nhiều phase vào một commit.
6. Gặp chỗ plan ghi **"cần thử nghiệm"** thì làm thử nghiệm nhỏ, ghi kết quả vào `extension/NOTES.md`, rồi mới chọn cách làm. Không được bịa API.
7. Comment trong code viết bằng **tiếng Việt**, giống phong cách của bản Desktop.

---

## 1. Hiện trạng bản Desktop (đã đọc mã nguồn) và những gì tái sử dụng

Bản Desktop là ứng dụng Go + Wails v2 + React 18 + TS + Tailwind 3.4. Dịch phụ đề qua 3 tầng: `api` (Google GTX), `cloud` (Gemini), `local_ai` (Qwen). Extension **chỉ dùng 2 tầng đầu**.

### 1.1. Bảng ánh xạ Go/TS → Extension

| Nguồn Desktop | Nội dung | Đích trong Extension | Cách làm |
|---|---|---|---|
| `translator.go` → `translateFastGTX` | GET `translate_a/single?client=gtx&sl=..&tl=vi&dt=t&q=..`, ghép `raw[0][i][0]`. 429/403/503 hoặc trả về không phải JSON thì coi là rate limit | `src/background/engines/gtx.ts` | Port 1:1. Trình duyệt không cho đặt header `User-Agent`, nên bỏ dòng đó |
| `translator.go` → `googleBatchOrPerLine` | Nối các dòng bằng `\n`. Nếu số dòng trả về lệch thì dịch từng dòng, nghỉ `60ms ± jitter`, dòng nào có cache thì bỏ qua | `gtx.ts` | Port 1:1 |
| `translator.go` → `translateWithTiers`, `classifyErr`, `isIgnoredSubtitle` | Thứ tự các tầng, `fillGaps`, `skipCloud` khi GTX lỗi mạng, cache cụm từ | `src/background/router.ts`, `src/shared/text.ts` | Port. Bỏ tầng `local_ai` |
| `translator.go` → `SplitLinesIntoControlledBatches` | Chia batch theo số dòng và số ký tự | `src/shared/batching.ts` | Port 1:1 |
| `pipeline.go` → `inPlayWindow`, phần chia tier ở dòng ~1670–1703 | Tier-1 = cửa sổ `[t-1s, t+15s]`, batch 3 dòng/240 ký tự. Tier-2 = phía trước rồi phía sau, batch 5 dòng/400 ký tự | `src/content/scheduler.ts` | Port logic |
| `gemini.go` (toàn bộ) | Prompt hệ thống, JSON Schema `[{id,vi}]`, kiểm tra ID, retry đúng 1 lần cho các ID thiếu, `cleanJSONText`, `parseRetryAfter`, `parseRetryDelayFromBody`, kiểm tra `finishReason`, che API key, token bucket (Tier-1 cần ≥1 token, Tier-2 cần ≥3 token) | `src/background/engines/gemini.ts`, `src/shared/tokenBucket.ts` | Port 1:1. Prompt giữ **nguyên văn** (Phụ lục A) |
| `breaker.go` | Circuit breaker: backoff lũy thừa 1m→10m, probe ở trạng thái half-open, Retry-After có sàn 15s, 3 lỗi mạng liên tiếp thì khóa 2m | `src/shared/breaker.ts` | Port 1:1. Lưu trạng thái vào `chrome.storage.session` (lý do ở 4.3) |
| `lru_cache.go` | LRU 8000 cụm từ | `src/shared/lru.ts` | Port. Dùng `Map` để giữ thứ tự |
| `sub_extractor.go` → `ParseSRTorVTT`, `srtTimestampLineRe`, `htmlTagRe` | Parse SRT/VTT: bỏ BOM, chuẩn hóa CRLF, bỏ thẻ HTML, bỏ cue có `end <= start` | `src/shared/subtitleFormat.ts` | Port 1:1. **Không** port `IsHallucination` vì đó là bộ lọc cho Whisper |
| `app.go` → `BuildSubtitleContent`, `FormatSRTTime`, `FormatVTTTime` | Xuất SRT/VTT theo 3 chế độ `source`/`target`/`bilingual` | `subtitleFormat.ts` | Port 1:1 |
| `frontend/src/lib/subtitles.ts` | `SubtitleItem`, `upsertSubtitles`, `findSubtitleAtTime` (tìm nhị phân) | `src/shared/subtitles.ts` | **Copy** file và thêm field (xem 6.1). Không import chéo sang `frontend/` |
| `frontend/src/App.tsx` dòng ~1133–1268 | Kéo thả phụ đề: lưu `{xPct,yPct}` theo %, clamp trong player, ngưỡng 3px mới tính là kéo, `setPointerCapture`, nhấp đúp để reset | `src/content/overlay/useDraggable.ts` | Port thuật toán |
| `frontend/src/App.tsx` dòng ~2773–2860 | Giao diện overlay: class Tailwind, chấm chỉ báo engine (emerald = API, cyan = Cloud), 4 chế độ phụ đề, phím `V` đổi chế độ, `G`/`H` chỉnh lệch ±0.1s | `src/content/overlay/SubtitleOverlay.tsx` | Port giao diện, bỏ nhánh `local_ai` |
| `gemini.go` → `DefaultGeminiConfig` | Model `gemini-3.5-flash-lite`, RPM 12, timeout 3500ms (Tier-1) / 8000ms (Tier-2), tối đa 10 câu/lần gọi | `src/shared/settings.ts` | Giữ nguyên các giá trị mặc định |

> **Sửa so với plan cũ:** plan cũ ghi model `gemini-2.5-flash-lite` / `gemini-1.5-flash`. Dòng 1.5 đã bị Google ngừng. Mặc định phải giống bản Desktop (`gemini-3.5-flash-lite`), và người dùng có thể nhập model khác hoặc chọn từ danh sách lấy bằng `ListModels` (Phase 7).

### 1.2. Những thứ của Desktop **không** đưa sang Extension
Không đưa: ffmpeg/ffprobe, whisper.cpp, llama.cpp/Qwen, yt-dlp/QuickJS, `pipeline.go` (cắt audio), `media.go`/`spool_serve.go` (loopback server), `drive_manager.go`/OAuth, `blockstore.go` (cache trên đĩa), `updater.go`, `model_downloader.go`, `telemetry.go`.

---

## 2. Phạm vi

### 2.1. Trong phạm vi (MVP: Phase 0–8)
- Chrome, Edge, Brave, Cốc Cốc (Chromium ≥ 116), Manifest V3.
- **YouTube** (trang `watch`) với phụ đề có sẵn: CC thủ công hoặc auto-generated (ASR).
- **Mọi trang có `<video>` HTML5 kèm `<track>`** (subtitles/captions).
- **Nhập file .srt/.vtt** cho video không có phụ đề, kể cả file song ngữ do bản Desktop xuất.
- **Xuất .srt/.vtt** theo 3 chế độ, giống bản Desktop.
- 3 chế độ dịch: `google`, `gemini`, `hybrid`.
- Cache trong IndexedDB, tự dọn cũ.
- Overlay Shadow DOM, kéo thả được, hoạt động khi fullscreen.

### 2.2. Ngoài phạm vi MVP
- Web Speech API: **loại hẳn**. API này chỉ nghe micro, không nghe được âm thanh của tab.
- YouTube Shorts, livestream, video có DRM (Netflix…): không lấy phụ đề. Riêng tính năng nhập SRT vẫn cho phép.
- Google Drive, Udemy, Coursera: làm theo kiểu best-effort ở **Phase 9**.
- Thu âm tab rồi gửi Gemini: **Phase 10, thử nghiệm**, không bắt buộc.
- Đưa lên Chrome Web Store: không làm trong MVP. Chỉ build `.zip` và Load unpacked.

---

## 3. Quy tắc bất biến (bắt buộc ở mọi phase)

### 3.1. Bảo toàn bản Desktop
1. **Chỉ tạo/sửa file bên trong `extension/`.** Không sửa bất kỳ file nào ngoài thư mục này. Cụ thể là không sửa `*.go`, `go.mod`, `go.sum`, `wails.json`, `frontend/**`, `.github/**`, `.gitignore` ở thư mục gốc, `scripts/**`, `README.md` gốc.
2. Lúc lập plan, 3 file `frontend/wailsjs/go/main/App.d.ts`, `App.js`, `models.ts` **đang được chủ dự án sửa dở** (chưa commit). **Không đụng vào, không revert, không commit giúp.** Khi commit chỉ `git add extension/`.
3. **Không tạo** `package.json`, `pnpm-workspace.yaml`, `tsconfig.json` ở thư mục gốc. Lý do: CI (`.github/workflows/deploy-pages.yml`) chạy `cd frontend && pnpm install --frozen-lockfile`. Nếu có workspace ở gốc, pnpm sẽ coi `frontend` là thành viên workspace và có thể làm hỏng lockfile.
4. Không import code từ `frontend/` sang. Muốn tái sử dụng thì **copy** file và ghi chú nguồn ở đầu file.

### 3.2. Lưu ý về `.gitignore` gốc (đã kiểm tra)
`.gitignore` gốc chỉ bỏ qua `frontend/node_modules/`, chứ **không** bỏ qua `extension/node_modules/`. Nó cũng bỏ qua toàn cục `dist/`, `*.srt`, `*.vtt`, `*.log`. Vì vậy:
- **Bắt buộc** tạo `extension/.gitignore` gồm: `node_modules/`, `dist/`, `release/`, `*.zip`, `coverage/`.
- Không đặt fixture test dạng `.srt`/`.vtt` (sẽ bị git bỏ qua). Viết fixture thành **chuỗi trong file `.ts`** (`tests/fixtures/*.ts`).

### 3.3. Lệnh kiểm tra cuối mỗi phase (PowerShell trên Windows)
```powershell
# 1) Chỉ extension/ thay đổi (ngoài 3 file wailsjs đã sửa dở từ trước)
git status --porcelain | Where-Object { $_ -notmatch 'extension/' -and $_ -notmatch 'frontend/wailsjs/go/' }
#    -> kết quả phải RỖNG

# 2) Go không quét vào extension/
go list ./... | Select-String extension     # phải RỖNG
go vet ./...
go test ./...                               # phải PASS như trước khi bắt đầu

# 3) Frontend Desktop vẫn build được
cd frontend; pnpm run build; cd ..

# 4) Extension
cd extension; pnpm install; pnpm run typecheck; pnpm run test; pnpm run build; cd ..
```
> Nếu bước 2 thấy gói Go nằm trong `extension/node_modules`, tạo file `extension/go.mod` với nội dung `module subtrans_extension_ignore` để Go coi đây là module riêng và loại khỏi `./...` của module gốc. Ghi lại vào `NOTES.md`.

### 3.4. Bảo mật
- Gemini API key chỉ lưu trong `chrome.storage.local`. **Không** lưu vào `storage.sync`, không ghi log, không gửi cho content script, không đặt trên URL. Chỉ gửi qua header `x-goog-api-key`, giống `gemini.go`.
- Mọi thông báo lỗi trả về UI phải che key (port hàm `sanitize`).
- Content script chạy trong isolated world. Không dùng `eval` và không dùng `innerHTML` với dữ liệu phụ đề. React tự escape, nên chỉ render text qua React.
- **Mọi `fetch` gọi API dịch (GTX, Gemini) bắt buộc phải có `credentials: "omit"`, `cache: "no-store"` và `referrerPolicy: "no-referrer"`.** Mục đích là không gửi kèm cookie đăng nhập Google của người dùng. Nếu gửi kèm, Google có thể gắn hành vi gọi tự động vào tài khoản chính của người dùng, khiến họ bị bắt giải CAPTCHA khi tìm kiếm Google bình thường. Gom việc này vào một helper `apiFetch()` trong `engines/http.ts`. **Không** gọi `fetch` trực tiếp trong các engine. Có unit test kiểm tra mọi request đều có `credentials: "omit"`.
- Riêng `fetchText` (đọc file track) cũng dùng `credentials: "omit"`. Nếu file đòi cookie mới tải được (403) thì content script tự đọc qua `textTracks` của trang (Phase 4.4) thay vì gửi kèm cookie.

---

## 4. Kiến trúc

### 4.1. Sơ đồ
```
┌──────────────────── Tab (trang web) ─────────────────────────────────┐
│  [MAIN world] yt-hook.ts  ── patch fetch/XHR, bắt /api/timedtext ──┐ │
│                                    window.postMessage               │ │
│  [ISOLATED] content/index.ts                                        ▼ │
│     ├─ adapters/youtube.ts | adapters/html5.ts | adapters/imported  │
│     ├─ pipeline/session.ts  (một video = một session)               │
│     ├─ scheduler.ts  (Tier-1 quanh playhead, Tier-2 toàn track)     │
│     └─ overlay/ (Shadow DOM + React: SubtitleOverlay, MiniToolbar)  │
└────────────────────────────┬─────────────────────────────────────────┘
                             │ chrome.runtime Port "subtrans"
┌────────────────────────────▼──────── Service Worker ────────────────┐
│ background/index.ts → messaging.ts                                  │
│   ├─ router.ts (port translateWithTiers) ── engines/gtx.ts          │
│   │                                     └─ engines/gemini.ts        │
│   ├─ breaker (api, cloud) + tokenBucket → state: storage.session    │
│   ├─ phrase LRU (RAM)                                               │
│   └─ cache/db.ts (IndexedDB của extension origin)                   │
└─────────────────────────────────────────────────────────────────────┘
   popup/ (React)  ── chrome.runtime.sendMessage / chrome.tabs.sendMessage
   options/ (React) ── quản lý cache, cài đặt nâng cao
```

### 4.2. Phân chia trách nhiệm (vì sao chia như vậy)
- **Background** giữ mọi thứ cần quyền extension: gọi API (không bị CORS nhờ `host_permissions`), đọc API key, và **IndexedDB**.
  > Quan trọng: IndexedDB mở trong content script thuộc về **origin của trang web** (ví dụ youtube.com), không phải của extension. Vì vậy cache **bắt buộc** nằm ở background.
- **Content script** giữ trạng thái gắn với video: danh sách cue, `currentTime`, scheduler. Content sống cùng trang, nên không bị ảnh hưởng khi service worker bị tắt.
- **Background gần như không giữ trạng thái**, vì MV3 tắt service worker sau ~30s không hoạt động. Trạng thái nào cần sống sót qua lần restart (breaker, token bucket) thì lưu vào `chrome.storage.session`.

### 4.3. Vòng đời service worker
- Content mở Port `chrome.runtime.connect({name: "subtrans"})`. Mỗi message gửi qua port sẽ reset bộ đếm idle.
- Khi `port.onDisconnect` (SW restart hoặc tab chuyển trang), content **tự kết nối lại**, đợi lần lượt 250ms → 1s → 3s, và **gửi lại** các request chưa có kết quả (giữ `reqId`).
- Background khi port ngắt: hủy (`AbortController`) các request đang chạy của port đó.

---

## 5. Cấu trúc thư mục

```
extension/
├── PLAN.md                     # tài liệu này
├── NOTES.md                    # ghi kết quả các thử nghiệm "cần thử nghiệm"
├── README.md                   # hướng dẫn build và Load unpacked (Phase 11)
├── .gitignore
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
├── tailwind.config.js
├── postcss.config.js           # gồm plugin rem→px tự viết (Phase 4)
├── manifest.config.ts          # manifest định nghĩa bằng TS (CRXJS)
├── public/icons/               # icon-16/32/48/128.png
├── dev/
│   └── test-page.html          # trang thử <video> + <track> (Phase 4)
├── src/
│   ├── shared/
│   │   ├── types.ts            # hợp đồng dữ liệu (Mục 6)
│   │   ├── messages.ts         # kiểu message giữa các context
│   │   ├── settings.ts         # schema, mặc định, load/save, onChanged
│   │   ├── subtitles.ts        # copy từ frontend/src/lib/subtitles.ts và mở rộng
│   │   ├── subtitleFormat.ts   # parse/build SRT/VTT (port Go)
│   │   ├── text.ts             # isIgnoredSubtitle, normalize, isVietnamese
│   │   ├── batching.ts         # SplitLinesIntoControlledBatches
│   │   ├── sentenceMerge.ts    # gộp cue ASR thành câu
│   │   ├── breaker.ts
│   │   ├── tokenBucket.ts
│   │   ├── lru.ts
│   │   ├── hash.ts             # fnv1a32
│   │   └── disposer.ts         # gom cleanup (Phase 6)
│   ├── background/
│   │   ├── index.ts
│   │   ├── messaging.ts
│   │   ├── router.ts
│   │   ├── engines/gtx.ts
│   │   ├── engines/gemini.ts
│   │   ├── engines/errors.ts
│   │   ├── engines/http.ts     # apiFetch(): credentials omit
│   │   ├── state.ts            # lưu/khôi phục breaker và bucket từ storage.session
│   │   └── cache/db.ts
│   ├── content/
│   │   ├── index.ts            # điểm vào: chọn adapter, tạo session
│   │   ├── yt-hook.ts          # MAIN world, document_start
│   │   ├── port.ts             # Port có tự kết nối lại + gửi lại
│   │   ├── videoDetector.ts
│   │   ├── adapters/types.ts
│   │   ├── adapters/youtube.ts
│   │   ├── adapters/html5.ts
│   │   ├── adapters/imported.ts
│   │   ├── pipeline/session.ts
│   │   ├── scheduler.ts
│   │   └── overlay/
│   │       ├── mount.ts        # tạo host + shadow root, theo dõi fullscreen
│   │       ├── OverlayApp.tsx
│   │       ├── SubtitleOverlay.tsx
│   │       ├── MiniToolbar.tsx
│   │       ├── useDraggable.ts
│   │       ├── nativeTrackFallback.ts
│   │       └── overlay.css     # @tailwind base/components/utilities
│   ├── popup/ (index.html, main.tsx, Popup.tsx)
│   └── options/ (index.html, main.tsx, Options.tsx)
└── tests/
    ├── fixtures/*.ts
    └── *.test.ts
```

---

## 6. Hợp đồng dữ liệu (dùng chung cho mọi phase)

### 6.1. `src/shared/types.ts`
```ts
export type EngineId = "api" | "cloud";            // giống translator_mode của Desktop (bỏ local_ai)
export type TranslateMode = "google" | "gemini" | "hybrid";
export type SubtitleMode = "bilingual" | "vi" | "en" | "off";  // giống App.tsx
export type Priority = "tier1" | "tier2" | "upgrade";

export interface Cue {            // phụ đề gốc sau khi chuẩn hóa
  start: number;                  // giây
  end: number;
  text: string;                   // đã gộp dòng, đã bỏ thẻ HTML
}

// Mở rộng từ SubtitleItem của Desktop (giữ tên field snake_case để tương thích)
export interface SubtitleItem {
  id: number;                     // = chỉ số cue (ổn định trong một track)
  block: number;                  // luôn 0 (giữ để tương thích với hàm copy)
  start_sec: number;
  end_sec: number;
  source_text: string;
  target_text: string;            // "" khi chưa dịch
  translated: boolean;
  engine: EngineId | null;        // engine đã dịch dòng này (MỚI)
  ignored?: boolean;              // true nếu isIgnoredSubtitle (MỚI)
}

export type TrackKind = "manual" | "asr" | "html5" | "imported";

export interface TrackRef {
  trackKey: string;               // xem 6.4
  platform: "youtube" | "web" | "file";
  videoId: string;                // YouTube id | origin+pathname | tên file
  title: string;
  lang: string;                   // "en", "en-US", "und"...
  kind: TrackKind;
}

export interface LineResult { text: string; engine: EngineId | null; }

export type ErrKind = "canceled" | "blocked" | "network" | "disabled" | "other";
export interface EngineError { kind: ErrKind; message: string; retryAfterMs?: number; }
```

### 6.2. `src/shared/messages.ts`
```ts
// Content -> Background (qua Port "subtrans")
export type C2B =
  | { type: "translate"; reqId: string; trackKey: string; srcLang: string;
      lines: string[]; priority: Priority; prefer?: EngineId }
  | { type: "cancel"; reqId: string }
  | { type: "cache.load"; reqId: string; trackKey: string; sourceHash: string }
  | { type: "cache.saveTrack"; track: TrackRef; cues: Cue[]; sourceHash: string }
  | { type: "cache.saveLines"; trackKey: string; engineKey: string;
      sourceHash: string; total: number; updates: Array<[number, string]> }
  | { type: "fetchText"; reqId: string; url: string };   // chỉ http(s), tối đa 2MB

// Background -> Content
export type B2C =
  | { type: "translate.result"; reqId: string; results: LineResult[]; error?: EngineError }
  | { type: "cache.loaded"; reqId: string; hit: boolean;
      cues?: Cue[]; lines?: Record<string /*engineKey*/, (string | null)[]> }
  | { type: "fetchText.result"; reqId: string; ok: boolean; text?: string; error?: string }
  | { type: "status"; breakers: { api: BreakerView; cloud: BreakerView }; geminiReady: boolean };

export interface BreakerView { blocked: boolean; until: number /* epoch ms, 0 nếu không khóa */ }

// Popup/Options -> Background (chrome.runtime.sendMessage, có trả lời)
export type UiReq =
  | { type: "gemini.test"; apiKey: string; model: string }      // trả { ok, latencyMs, error? }
  | { type: "gemini.listModels"; apiKey: string }               // trả { ok, models: string[] }
  | { type: "cache.stats" }                                     // trả { tracks, bytesApprox }
  | { type: "cache.clear"; trackKey?: string };

// Popup -> Content của tab đang mở (chrome.tabs.sendMessage)
export type PopupToTab = { type: "tab.status" } | { type: "tab.export"; format: "srt" | "vtt"; mode: "source" | "target" | "bilingual" };
export interface TabStatus { active: boolean; platform?: string; title?: string; total: number;
  translated: number; byEngine: { api: number; cloud: number }; message?: string; }
```

### 6.3. `src/shared/settings.ts`: schema và giá trị mặc định
```ts
export interface Settings {
  enabled: boolean;                 // true
  disabledHosts: string[];          // []
  mode: TranslateMode;              // "google"
  subtitleMode: SubtitleMode;       // "bilingual"
  targetLang: "vi";                 // cố định trong MVP
  gemini: {
    apiKey: string;                 // ""
    model: string;                  // "gemini-3.5-flash-lite"  (= DefaultGeminiModel)
    endpoint: string;               // "https://generativelanguage.googleapis.com/v1beta/models"
    rpm: number;                    // 12
    timeoutTier1Ms: number;         // 3500
    timeoutTier2Ms: number;         // 8000
    maxItemsTier1: number;          // 10   (= MaxItemsPerCall)
    maxItemsTier2: number;          // 20   (lớn hơn để giảm số request; xem 9.R4)
  };
  gtx: { concurrency: number /*2*/; gapMs: number /*150*/; timeoutMs: number /*5000*/ };
  style: { fontScale: number /*1.0, 0.8–1.8*/; viColor: string /*"#fcd34d" = amber-300*/;
           enColor: string /*"#d4d4d4" = neutral-300*/; bgOpacity: number /*0.8*/ };
  youtube: { hideNativeCaptions: boolean /*true*/; preferManual: boolean /*true*/ };
  pretranslateWholeTrack: boolean;  // true
  cache: { maxTracks: number /*200*/; maxAgeDays: number /*30*/ };
  shortcuts: { enabled: boolean /*true*/ };   // V, G, H như Desktop
}
```
- Lưu trong `chrome.storage.local` ở key `settings`. API key lưu riêng ở key `geminiApiKey` để content script không cần đọc. Popup ghép lại khi hiển thị.
- `loadSettings()` phải deep-merge với giá trị mặc định, để bản cũ thiếu field vẫn chạy.
- `onSettingsChanged(cb)` bọc quanh `chrome.storage.onChanged`.

### 6.4. Khóa cache
- `trackKey`:
  - YouTube: `yt:${videoId}:${lang}:${kind}`
  - HTML5: `web:${origin}${pathname}:${trackLabel || trackSrc || "track0"}:${Math.round(duration)}`
  - Nhập file: `file:${fileName}:${fnv1a(content)}`
- `engineKey`: `"api"` hoặc `` `cloud:${model}` ``.
- `sourceHash = fnv1a32(cues.map(c => c.text).join("\n"))`. Nếu hash khác thì toàn bộ bản dịch của track đó coi như không còn hợp lệ.

### 6.5. IndexedDB (`src/background/cache/db.ts`, dùng thư viện `idb`)
- DB `subtrans`, version 1.
  - Store `tracks` (keyPath `trackKey`): `{ ...TrackRef, sourceHash, cues: Cue[], createdAt, lastOpenedAt, bytesApprox }`. Có index `lastOpenedAt`.
  - Store `lines` (keyPath `["trackKey","engineKey"]`): `{ trackKey, engineKey, sourceHash, lines: (string|null)[], updatedAt }`.
- API cần có: `getTrack`, `putTrack`, `touchTrack`, `getLines(trackKey)` (trả mọi engineKey), `mergeLines(trackKey, engineKey, sourceHash, total, updates)`, `stats()`, `clear(trackKey?)`, `evict({maxTracks, maxAgeDays})`.
- `evict` chạy khi SW khởi động và sau mỗi `putTrack`. Xóa track cũ nhất theo `lastOpenedAt` khi số track vượt `maxTracks`, hoặc khi quá `maxAgeDays`. Xóa track thì xóa luôn các bản ghi `lines` của track đó.
- Quyền: `unlimitedStorage`.

---

## 7. Các Phase

> Ký hiệu: **[P]** = port từ Go/TS Desktop, phải đọc file gốc trước. **[T]** = cần thử nghiệm.

---

### Phase 0: Dựng khung dự án và hàng rào bảo vệ
**Mục tiêu:** `extension/` build được ra `dist/`, Load unpacked chạy được, popup hiển thị "SubTrans". Bản Desktop không bị ảnh hưởng.

**Việc cần làm**
1. `extension/package.json` (dùng pnpm):
   - dependencies: `react@^18.3.1`, `react-dom@^18.3.1`, `clsx`, `lucide-react` (cùng phiên bản với `frontend/package.json`), `idb@^8`.
   - devDependencies: `typescript@^5.6`, `vite@^5.4`, `@vitejs/plugin-react@^4.3`, `@crxjs/vite-plugin@^2` [T], `tailwindcss@^3.4.14`, `postcss`, `autoprefixer`, `vitest@^2.1`, `jsdom`, `fake-indexeddb`, `@types/chrome`, `@types/react`, `@types/react-dom`.
   - scripts: `dev`, `build` (`tsc --noEmit && vite build`), `typecheck`, `test` (`vitest run`), `zip` (Phase 11).
2. `tsconfig.json`: dựa theo `frontend/tsconfig.json` (strict, `jsx: react-jsx`, `moduleResolution: bundler`), thêm `"types": ["chrome", "vite/client"]`, `include: ["src", "tests", "manifest.config.ts"]`.
3. `manifest.config.ts` (CRXJS `defineManifest`):
   ```ts
   {
     manifest_version: 3,
     name: "SubTrans – Phụ đề song ngữ",
     version: pkg.version,
     minimum_chrome_version: "116",
     permissions: ["storage", "unlimitedStorage"],
     host_permissions: [
       "https://translate.googleapis.com/*",
       "https://generativelanguage.googleapis.com/*",
       "<all_urls>"            // để fetchText đọc được file track khác origin; xem 9.R6
     ],
     background: { service_worker: "src/background/index.ts", type: "module" },
     content_scripts: [
       { matches: ["https://www.youtube.com/*"], js: ["src/content/yt-hook.ts"],
         run_at: "document_start", world: "MAIN" },
       { matches: ["<all_urls>"], js: ["src/content/index.ts"],
         run_at: "document_idle", all_frames: true }
     ],
     action: { default_popup: "src/popup/index.html", default_icon: {...} },
     options_page: "src/options/index.html",
     icons: {...}
   }
   ```
4. File stub (chỉ cần chạy được): `background/index.ts` log "SW ready"; `content/index.ts` log khi phát hiện `<video>`; `yt-hook.ts` để trống; popup/options React in ra "SubTrans".
5. `extension/.gitignore` (Mục 3.2), `NOTES.md` (rỗng, có tiêu đề).

**[T] Thử nghiệm bắt buộc:** CRXJS có build được content script có `world: "MAIN"` không. Nếu **không**, dùng cách dự phòng: build `yt-hook.ts` riêng dạng IIFE (thêm một `vite build --config vite.hook.config.ts` với `build.lib`, `formats: ["iife"]`) ra `dist/yt-hook.js`, và khai báo đường dẫn đã build trong manifest. Ghi kết quả vào `NOTES.md`.

**Tiêu chí hoàn thành**
- `pnpm run build` tạo ra `dist/manifest.json` hợp lệ. Load unpacked không báo lỗi. Bấm icon thì thấy popup.
- Mở YouTube, console của trang có log từ content script. Console của SW có "SW ready".
- Toàn bộ lệnh ở Mục 3.3 đều đạt.

**Không làm:** chưa viết logic dịch, chưa làm UI thật.

---

### Phase 1: Thư viện dùng chung (TypeScript thuần, có unit test)
**Mục tiêu:** toàn bộ logic không phụ thuộc trình duyệt được port xong và có test.

| File | Đặc tả |
|---|---|
| `shared/types.ts`, `shared/messages.ts` | Đúng như Mục 6 |
| `shared/subtitles.ts` [P] | Copy `frontend/src/lib/subtitles.ts`, giữ nguyên `upsertSubtitles`, `tryReplaceInPlace`, `findSubtitleAtTime`. Thêm `engine`, `ignored` vào `SubtitleItem`. Thêm `cuesToItems(cues): SubtitleItem[]` |
| `shared/subtitleFormat.ts` [P] | `parseSrtOrVtt(content): Cue[]` port `ParseSRTorVTT`: regex timestamp y hệt `srtTimestampLineRe` ở `sub_extractor.go:12`, bỏ BOM, `\r\n`→`\n`, tách block theo `\n\n`, bỏ thẻ `<...>`, ghép các dòng bằng dấu cách, bỏ cue có `end <= start`. **Thêm** `parseSrtOrVttBilingual(content)`: nếu một cue có ≥2 dòng và dòng cuối `isVietnamese()` thì tách thành `{source, target}` (để đọc được file `_bilingual.srt` do Desktop xuất). `buildSubtitleContent(items, "srt"\|"vtt", "source"\|"target"\|"bilingual")` port `BuildSubtitleContent` (`app.go:831`), kể cả quy tắc "target rỗng thì dùng source". Port `FormatSRTTime` (`HH:MM:SS,mmm`) và `FormatVTTTime` (`HH:MM:SS.mmm`). Mở `app.go` để xem cách làm tròn |
| `shared/text.ts` [P] | `isIgnoredSubtitle` port 1:1 (dòng bọc trong `[...]` hoặc `(...)`, hoặc chỉ gồm `♪ -_`). `normalizeLine(s) = s.split(/\s+/).filter(Boolean).join(" ")` (giống `strings.Fields`). `isVietnamese(s)` dùng regex các ký tự có dấu tiếng Việt và `đ`. `decodeHtmlEntities` cho `&amp; &#39; &quot; &lt; &gt;` (json3 của YouTube có entity) |
| `shared/batching.ts` [P] | `splitLinesIntoControlledBatches(lines, maxLines=8, maxChars=600): number[][]`. Port 1:1, kể cả cách tính `len` theo **byte UTF-8** như Go (`new TextEncoder().encode(line).length`) |
| `shared/sentenceMerge.ts` | `mergeAsrCues(cues, opts={maxGapSec:1.2, maxDurSec:7, maxChars:120}): Cue[]`. Gộp các cue liên tiếp, ngắt khi: gặp dấu kết câu `. ? !` (hoặc `…`) ở cuối, khoảng trống > maxGap, độ dài vượt maxDur hoặc maxChars. Cue gộp có `start` = start đầu, `end` = end cuối |
| `shared/breaker.ts` [P] | Port **toàn bộ** `breaker.go`: `BreakerConfig`, `DEFAULT_BREAKER_CONFIG` (1m, 10m, 1m, 2m, 3, 6), `allow(): {allowed, isProbe}`, `report(err, isProbe)`, `blocked()`. Thêm `snapshot()` và `restore(s)` để lưu/khôi phục `{blockedUntil, fails, backoffStep}`. Không lưu `probing`. Dùng `now()` có thể inject để test |
| `shared/tokenBucket.ts` [P] | Port `TokenBucket`: `tryAcquire(isTier1)` (Tier-2 cần ≥3 token), `acquire(isTier1, waitMs, signal)` (poll mỗi 40ms), `hasTokens()`, `snapshot()`/`restore()` |
| `shared/lru.ts` [P] | `LRUCache<string,string>(8000)` với `get`, `set`, `stats()` |
| `shared/hash.ts` | `fnv1a32(str): string` (hex) |
| `shared/settings.ts` | Mục 6.3: `DEFAULT_SETTINGS`, `loadSettings`, `saveSettings(partial)`, `onSettingsChanged`, `getApiKey()`, `setApiKey()` |

**Kiểm thử (`tests/*.test.ts`)**
- `subtitles.test.ts`: chép các case từ `frontend/src/lib/subtitles.test.ts`.
- `subtitleFormat.test.ts`: SRT có BOM và CRLF, VTT có header `WEBVTT` và giờ dạng `MM:SS.mmm`, thẻ `<i>`, cue lỗi, round-trip parse→build. Mở `sub_extractor_index_test.go` và các test ExportSRT trong `app_test.go` để lấy thêm case.
- `batching.test.ts`, `text.test.ts`.
- `breaker.test.ts`: **port các case trong `breaker_test.go`** (đọc file, chuyển từng `t.Run` sang `it`).
- `tokenBucket.test.ts`: port các case liên quan trong `gemini_test.go`.
- `sentenceMerge.test.ts`.

**Tiêu chí hoàn thành:** `pnpm test` đạt 100%. Không file nào trong `shared/` gọi `chrome.*`, trừ `settings.ts`, và trong test thì `settings.ts` dùng mock.

---

### Phase 2: Engine dịch trong background
**Mục tiêu:** background nhận message `translate` và trả kết quả, có breaker, có fallback, hành vi giống `FastHybridTranslator`.

**`engines/errors.ts`**
- Các lớp lỗi: `RateLimitedError` (có `retryAfterMs`), `NetworkError`, `CanceledError`, `DisabledError`, `EmptyTranslationError`, `InvalidResponseIdsError`.
- `classifyErr(e): ErrKind` port từ `classifyErr`. Quy tắc:
  - Hủy bởi người dùng (signal của request bị abort) → `canceled`.
  - Hết timeout → `other`, giống Go coi `DeadlineExceeded` là `other`. **Bắt buộc** tạo timeout bằng `AbortSignal.timeout(ms)` gộp với signal hủy qua `AbortSignal.any([cancelSignal, AbortSignal.timeout(ms)])`. Timeout sẽ ném lỗi `TimeoutError`, còn hủy ném `AbortError`, nhờ vậy phân biệt được hai trường hợp. Không tự viết timeout bằng `AbortController.abort()`, vì khi đó timeout cũng ra `AbortError` và breaker sẽ bỏ qua nó.
  - `TypeError` của `fetch` (mất mạng/DNS) → `network`.
- `toBreakerOutcome(e): BreakerOutcome` (kiểu nằm ở `shared/breaker.ts`): `RateLimitedError` → `{kind:"blocked", retryAfterMs}`; `EmptyTranslationError` → `{kind:"empty"}`; `canceled` → `{kind:"canceled"}`; `network` → `{kind:"network"}`; còn lại → `{kind:"other"}`. **Breaker không nhận `Error` thô** và không dò chuỗi message.
- `TokenBucket.acquire()` trả về `"ok" | "timeout" | "aborted"`. `"timeout"` → `ErrRateLimitedLocal`: chuyển tầng, **không** report cho breaker. `"aborted"` → `canceled`: dừng, không chuyển tầng.

**`engines/gtx.ts`** [P]
- Mọi request đi qua `apiFetch()` (Mục 3.4, `credentials: "omit"`).
- `translateFastGtx(text, srcLang, signal)`:
  - URL `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${srcLang||"auto"}&tl=vi&dt=t&q=${encodeURIComponent(text)}`.
  - Timeout 5s.
  - Status 429/403/503 hoặc body không parse được JSON → `RateLimitedError`.
  - Ghép `raw[0][i][0]` rồi trim.
- `googleBatchOrPerLine(lines, srcLang, signal, phraseCache)` port 1:1, gồm cả `perLinePause = 60ms` có jitter, bỏ qua dòng đã có cache, và lưu cache từng dòng.
- `viaGoogle(lines)`: hỏi breaker `api` (`allow`), gọi hàm trên, `report` kết quả, kiểm tra số dòng trả về khớp.
- Bộ giới hạn đồng thời: tối đa `gtx.concurrency` request GTX chạy cùng lúc trên toàn SW, cách nhau ít nhất `gtx.gapMs`. Tier-1 được chen lên đầu hàng đợi.

**`engines/gemini.ts`** [P]: port `gemini.go`
- Body request **y hệt** `doRequest`: `system_instruction` (Phụ lục A), `contents[{role:"user", parts:[{text: prompt}]}]`, `generation_config: { response_mime_type: "application/json", response_schema: {type:"ARRAY", items:{type:"OBJECT", properties:{id:{type:"INTEGER"}, vi:{type:"STRING"}}, required:["id","vi"]}} }`.
- Prompt: mỗi dòng ngữ cảnh viết `[CONTEXT - KHÔNG DỊCH] ...`, sau đó `Dưới đây là các câu cần dịch dạng JSON:\n` + `JSON.stringify(items)`.
- URL `${endpoint}/${model}:generateContent`, header `x-goog-api-key`. **Không** đặt key trên URL. Gọi qua `apiFetch()` (`credentials: "omit"`).
- Xử lý 429: đọc `Retry-After`, nếu không có thì đọc `retryDelay` trong body. Status khác 200 → lỗi, nhớ che key. Kiểm tra `finishReason` khác `STOP` → lỗi. Port `cleanJSONText`. Kiểm tra ID: ID lạ hoặc trùng → `InvalidResponseIdsError`. Thiếu ID thì retry 1 lần riêng các ID thiếu, và chỉ retry khi `tryAcquire` lấy được token.
- `translateLines(lines, contextLines, isTier1)`: chia chunk theo `maxItemsTier1/Tier2`. Từ chunk thứ 2 trở đi, ngữ cảnh là 2 dòng ngay trước chunk. Chunk lỗi thì để các dòng rỗng. Nếu không dịch được dòng nào **và** có lỗi thì throw.
- Breaker riêng cho `cloud` (cấu hình như `NewGeminiClient`) và token bucket theo `rpm`.
- `listModels(apiKey)`: GET `${endpoint}` (bỏ `/models` thừa nếu có) với header key. Lọc model có `supportedGenerationMethods` chứa `generateContent`, rồi bỏ tiền tố `models/`.
- `testConnection(apiKey, model)`: dịch thử 1 câu "Hello world", đo độ trễ.

**`router.ts`** [P]: port `translateWithTiers`
- Đầu vào: `{lines, srcLang, priority, prefer?, signal}`. Đầu ra: `LineResult[]` cùng độ dài.
- Tiền xử lý: `normalizeLine`. Dòng `isIgnoredSubtitle` → `{text:"", engine:null}` và không gửi đi dịch. Tra phrase LRU (khóa = `engineKey|line`, để cache của GTX và Gemini không lẫn vào nhau).
- Thứ tự tầng theo `mode` (đọc từ settings) và `priority`:

  | mode | tier1 / tier2 | upgrade |
  |---|---|---|
  | `google` | `[api(fillGaps:false), cloud(fillGaps:true)*]` | không dùng |
  | `gemini` | `[cloud(fillGaps:true), api(fillGaps:false)]` | không dùng |
  | `hybrid` | tier1: như `google`; tier2: như `gemini` | `[cloud]` |

  `*` chỉ thêm `cloud` khi đã có key. Tầng `cloud` bị bỏ qua nếu thiếu key (`DisabledError`).
- Giữ nguyên quy tắc của Go:
  - Tầng lỗi → ghi `lastError`, chuyển sang tầng tiếp theo.
  - **GTX lỗi kiểu `network` → bỏ qua `cloud`** (vì cả hai đều cần mạng). Trong extension không còn tầng nào sau đó, nên trả lỗi `network` ngay.
  - Tầng có `fillGaps:false` mà chạy thành công → dừng, không xuống tầng sau.
  - Bị `canceled` → dừng ngay, không chuyển tầng.
- Ghi `engine` cho từng dòng theo tầng đã dịch dòng đó.

**`state.ts`:** sau mỗi lần `report` hoặc `acquire`, lưu `snapshot()` của 2 breaker và bucket vào `chrome.storage.session` (debounce 500ms). Khi SW khởi động thì `restore`.

**`messaging.ts`:**
- `chrome.runtime.onConnect` với name `subtrans`. Mỗi port giữ `Map<reqId, AbortController>`.
- Xử lý `translate`, `cancel`. Khi `onDisconnect` thì abort tất cả request của port.
- Phát `status` cho mọi port khi trạng thái breaker thay đổi.
- `chrome.runtime.onMessage` xử lý các `UiReq`, nhớ `return true` để trả lời bất đồng bộ.
- `fetchText`: chỉ nhận `http:`/`https:`, đọc tối đa 2MB, timeout 10s.

**Kiểm thử (mock `fetch`)**
- `gtx.test.ts`: parse response mẫu. Batch lệch dòng thì chuyển sang dịch từng dòng. 429 làm breaker mở.
- `gemini.test.ts`: **port các case trong `gemini_test.go`**: ID lạ, ID trùng, retry ID thiếu, 429 kèm `retryDelay`, `finishReason` khác `STOP`, JSON bọc trong ```json, che key trong lỗi, chia chunk.
- `router.test.ts`: **port các case trong `translator_mock_test.go`** (bỏ case Qwen). Thêm: GTX 429 → Gemini dịch hết; GTX lỗi mạng → không gọi Gemini; mode `gemini` mà Gemini trả thiếu dòng → GTX bù; hủy giữa chừng → không chuyển tầng.

**Tiêu chí hoàn thành:** test đạt. Thử tay: từ console của SW gọi hàm debug `__subtransDebugTranslate(["Hello world"])` (chỉ có trong `import.meta.env.DEV`) và nhận được tiếng Việt.

**Không làm:** chưa làm cache IndexedDB, chưa làm UI.

---

### Phase 3: Cache IndexedDB
**Mục tiêu:** mở lại video đã dịch thì có phụ đề ngay, không gọi API.

- `cache/db.ts` theo Mục 6.5.
- `messaging.ts` xử lý thêm:
  - `cache.load`: nếu `sourceHash` khớp thì trả về `cues` và toàn bộ `lines`, đồng thời `touchTrack`.
  - `cache.saveTrack`: lưu track.
  - `cache.saveLines`: gộp các dòng mới vào bản đã lưu.
  - `cache.stats`, `cache.clear` cho UI.
- Content script sẽ gom các bản ghi `saveLines` và gửi theo đợt (debounce 2s, xem Phase 6).
- Các bước ghi phải gom trong một transaction.

**Kiểm thử:** `cache.test.ts` dùng `fake-indexeddb/auto`: lưu rồi đọc lại; hash khác → không trả về dữ liệu; `evict` theo số lượng và theo tuổi; `clear` một track thì xóa luôn `lines` của nó; `mergeLines` không ghi đè dòng đã có bằng `null`.

**Tiêu chí hoàn thành:** test đạt. Ghi được 2 track rồi xem trong DevTools của SW (Application → IndexedDB) thấy đúng dữ liệu.

---

### Phase 4: Overlay và adapter HTML5 `<track>`
**Mục tiêu:** trên một trang có `<video><track>`, phụ đề song ngữ hiện đè lên video, kéo thả được, và vẫn hiện khi fullscreen.

**4.1. `dev/test-page.html`:** một `<video controls>` (người dùng tự chọn file mp4 qua `<input type=file>`, gán bằng `URL.createObjectURL`) và một `<track kind="subtitles" srclang="en">` có nội dung VTT nhúng sẵn dạng `data:` URL (khoảng 20 cue tiếng Anh). Dùng để chạy `pnpm dev` hoặc mở file trực tiếp (bật "Allow access to file URLs" cho extension).

**4.2. `content/videoDetector.ts`**
- Tìm `<video>` có diện tích hiển thị lớn nhất (≥ 200×120 px, `readyState ≥ 1` hoặc đã có `src`).
- Dùng `MutationObserver` (debounce 500ms) để phát hiện video mới hoặc video bị gỡ.
- Phát sự kiện `video-changed`.

**4.3. `adapters/types.ts`**
```ts
export interface SubtitleSource {
  readonly track: TrackRef;
  load(): Promise<Cue[]>;                         // toàn bộ cue nếu lấy được
  onCuesChanged?(cb: (cues: Cue[]) => void): () => void;  // khi track tải thêm cue
  dispose(): void;
}
export interface SiteAdapter {
  matches(location: Location): boolean;
  getVideo(): HTMLVideoElement | null;
  getOverlayContainer(video: HTMLVideoElement): HTMLElement | null; // null = dùng chế độ fixed
  listSources(video: HTMLVideoElement): Promise<SubtitleSource[]>;
  isAdPlaying?(): boolean;
  onNavigate?(cb: () => void): () => void;
}
```

**4.4. `adapters/html5.ts`**
- Duyệt `video.textTracks`. Ưu tiên track `kind` là `subtitles`/`captions` có `language` bắt đầu bằng `en`. Nếu không có thì lấy track đầu tiên.
- Đặt `track.mode = "hidden"` để nhận được cue mà trình duyệt không tự vẽ phụ đề gốc.
- Đọc `track.cues` (có thể là `null` lúc đầu). Lắng nghe sự kiện `load` của phần tử `<track>` hoặc poll mỗi 500ms trong tối đa 10s.
- Mỗi `VTTCue` chuyển thành `Cue` (bỏ thẻ HTML bằng `cue.getCueAsHTML().textContent`, hoặc regex nếu không có).
- Nếu `cues` vẫn rỗng mà `<track src>` khác origin: gửi `fetchText` cho background, rồi `parseSrtOrVtt`.
- Nếu video không có track nào: không có nguồn, MiniToolbar hiện nút "Nhập .srt/.vtt" (làm ở Phase 8).

**4.5. `overlay/mount.ts`**
- Tạo host `<div data-subtrans-host>`, gắn `attachShadow({mode:"open"})`.
- Nạp CSS: `import css from "./overlay.css?inline"`, rồi chèn `<style>` vào shadow root.
- Có 2 chế độ đặt vị trí:
  1. **container** (adapter trả về một container đã có `position` khác `static`, ví dụ `#movie_player`): host đặt `position:absolute; inset:0; pointer-events:none; z-index: 60`.
  2. **fixed** (generic): host đặt `position:fixed`, đồng bộ theo `video.getBoundingClientRect()` bằng `ResizeObserver`, sự kiện `scroll` và `resize` (gom qua rAF).
- **Fullscreen:** lắng nghe `fullscreenchange`.
  - Nếu `document.fullscreenElement` **chứa** video → chuyển host vào bên trong `fullscreenElement`.
  - Nếu `fullscreenElement === video` (chính thẻ video fullscreen, không chứa con được) → bật `nativeTrackFallback`.
  - Khi thoát fullscreen → trả host về chỗ cũ.
- Container phải có kích thước để tính % khi kéo thả. Ở chế độ fixed, kích thước lấy từ rect của host.

**4.6. `overlay/nativeTrackFallback.ts`**
- `video.addTextTrack("subtitles", "SubTrans", "vi")`, `mode = "showing"`. Thêm `VTTCue` theo `subtitleMode`: song ngữ thì text là `en + "\n" + vi`.
- Cập nhật cue khi có bản dịch mới. Khi thoát fullscreen thì đặt `mode = "disabled"`.
- Chế độ này không kéo thả được, ghi rõ trong tooltip.

**4.7. `overlay/SubtitleOverlay.tsx`** [P]: port JSX từ `App.tsx` dòng ~2773–2860
- Giữ class gốc: `bg-black/80 hover:bg-black/90 px-5 py-2.5 rounded-xl text-center shadow-2xl backdrop-blur-md border border-white/10 hover:border-amber-400/40 cursor-grab active:cursor-grabbing select-none pointer-events-auto touch-none space-y-1`. Dòng EN: `text-neutral-300 text-sm md:text-base font-medium`. Dòng VI: `text-amber-300 text-base md:text-lg font-bold`.
- Màu nền, màu chữ và cỡ chữ lấy từ `settings.style` qua CSS variable. `fontScale` nhân vào `font-size` của box.
- Tooltip khi hover: "Kéo thả vị trí • Nhấp đúp đặt lại".
- Chấm chỉ báo engine **theo dòng hiện tại** (`item.engine`): `api` → emerald + chữ "API"; `cloud` → cyan + chữ "Cloud"; `null` (chưa dịch) → không hiện chấm.
- Chế độ `vi` mà dòng chưa dịch: hiện EN in nghiêng, kèm chấm amber nhấp nháy, giống Desktop.
- `maxWidth: min(48rem, calc(100% - 2rem))`. Lưu ý quy đổi px, xem 4.9.

**4.8. `overlay/useDraggable.ts`** [P]: port `handleSubPointerDown/Move/Up/DoubleClick`
- Giữ nguyên ngưỡng 3px, cách clamp, làm tròn `xPct`/`yPct` tới 0.1, và `setPointerCapture`.
- Vị trí lưu vào `chrome.storage.local` với key `overlayPos:${location.hostname}`, **không** dùng `localStorage` của trang.
- Nhấp đúp → xóa vị trí đã lưu → về mặc định (giữa, cách đáy 4rem) → hiện toast "Đã đưa vị trí phụ đề về mặc định (dưới cùng)".
- `stopPropagation` ở pointer event để click lên phụ đề không làm video pause.

**4.9. Tailwind trong Shadow DOM và đơn vị rem** (bắt buộc)
- YouTube đặt `html { font-size: 10px }`, nên mọi kích thước Tailwind tính bằng `rem` sẽ bị nhỏ lại.
- Cách xử lý: viết plugin PostCSS nhỏ ngay trong `postcss.config.js`, đổi mọi giá trị `(\d*\.?\d+)rem` thành `px` (×16) cho CSS của overlay. Không cài package ngoài cho việc này.
- `tailwind.config.js`: `content: ["./src/**/*.{ts,tsx,html}"]`. Copy `theme.extend.colors.player` từ `frontend/tailwind.config.js`. Thêm `important: ":host"` [T] hoặc dùng preflight bình thường trong shadow root; chọn cách nào cũng được, miễn không làm vỡ trang ngoài.
- Popup/options là trang riêng, không cần đổi rem.

**4.10. `pipeline/session.ts` (bản tối thiểu ở phase này):** nhận `SubtitleSource` → `load()` → `cuesToItems` → hiển thị phụ đề EN theo `currentTime`. Dùng `findSubtitleAtTime(items, video.currentTime + offset)` trong vòng `requestAnimationFrame` khi video đang chạy, và cập nhật khi `seeked`/`pause`. Chỉ re-render khi `id` của dòng hiện tại đổi. Chưa gọi dịch ở phase này.

**4.11. `content/index.ts`:** chọn adapter (YouTube ở Phase 5, còn lại `html5`), dò video, tạo session và mount overlay. Kiểm tra `settings.enabled` và `disabledHosts` trước khi chạy.

**Kiểm thử**
- `useDraggable.test.ts` (jsdom): clamp, ngưỡng 3px.
- Thủ công trên `dev/test-page.html`: EN hiện đúng thời điểm; kéo thả; nhấp đúp; fullscreen của container; fullscreen của chính thẻ video (dùng fallback); trang có CSS cực đoan (`* { all: unset }` trong test page) mà overlay không bị vỡ.

**Tiêu chí hoàn thành:** tất cả mục thủ công ở trên đạt; trang không bị lỗi console nào do extension gây ra.

---

### Phase 5: Adapter YouTube
**Mục tiêu:** trên `youtube.com/watch` có phụ đề EN (thủ công hoặc ASR), extension lấy được **toàn bộ track kèm timeline**.

**5.1. `content/yt-hook.ts`** (MAIN world, `document_start`) [T]
- Patch `window.fetch` và `XMLHttpRequest.prototype.open/send`. Khi URL chứa `/api/timedtext`: clone response, đọc text, rồi `window.postMessage({source:"subtrans-yt", kind:"timedtext", url, body}, location.origin)`.
- Bản patch phải trong suốt: không đổi response, không throw. Bọc mọi thứ trong `try/catch`.
- Lắng nghe `message` từ content `{source:"subtrans-cs", kind:"getPlayerResponse"}`. Trả lời bằng `document.getElementById("movie_player")?.getPlayerResponse?.()` và chỉ lấy `videoDetails.videoId`, `videoDetails.title` và `captions.playerCaptionsTracklistRenderer.captionTracks` (`baseUrl`, `languageCode`, `kind`, `name`).
- Content script chỉ chấp nhận message có `event.source === window` và đúng `source`.

**5.2. `adapters/youtube.ts`**
- `videoId` lấy từ `URL.searchParams.get("v")`. Bỏ qua `/shorts/` và livestream (`videoDetails.isLiveContent` cộng với video đang live).
- Chọn track: lọc `languageCode` bắt đầu bằng `en`. Nếu `preferManual` thì ưu tiên track không có `kind`, sau đó tới `kind === "asr"`.
- **Lấy nội dung track, theo thứ tự:**
  1. Nếu hook đã bắt được timedtext của đúng `videoId` (đối chiếu tham số `v=` trong URL) và đúng `lang` → dùng luôn.
  2. Ngược lại [T]: thử fetch `baseUrl + "&fmt=json3"` **trong MAIN world** (gửi lệnh cho hook để fetch giúp, vì cùng cookie và context của trang). Nếu trả về rỗng hoặc 4xx (do YouTube đòi token `pot`) → bước 3.
  3. Hiện thông báo trên MiniToolbar: "Bật phụ đề CC của YouTube (phím C) để SubTrans lấy phụ đề". Khi hook bắt được timedtext thì tự chạy tiếp.
  - Ghi vào `NOTES.md` cách nào chạy được ở thời điểm test.
- **Parse json3:** `events[]` có `tStartMs`, `dDurationMs`, `segs[].utf8`. Bỏ event không có `segs` hoặc chỉ có `"\n"`. Text = nối các `utf8`, `decodeHtmlEntities`, rồi `normalizeLine`. Track ASR thì chạy qua `mergeAsrCues`. Track thủ công vẫn chạy `mergeAsrCues` nhưng với `maxGapSec = 0` (chỉ gộp cue bị cắt giữa câu, không gộp qua khoảng lặng). [T] Ghi lại kết quả thử nghiệm.
  - Nếu response là XML hoặc VTT (khi không có `fmt=json3`) → dùng `parseSrtOrVtt` cho VTT, và một parser XML `<text start dur>` đơn giản bằng `DOMParser`.
- `getOverlayContainer` = `#movie_player`. `getVideo` = `#movie_player video.html5-main-video`.
- **Fullscreen trên YouTube:** khi bấm `F`, YouTube đưa một phần tử bọc ngoài video vào fullscreen, không phải chính thẻ `<video>`. Host nằm trong `#movie_player` nên tự phóng to theo, **không** dùng `nativeTrackFallback`. [T] Kiểm tra `document.fullscreenElement.contains(host) === true` khi fullscreen, ghi kết quả vào `NOTES.md`. Nếu sai thì để logic chung ở 4.5 (chuyển host vào `fullscreenElement`) xử lý.
- `isAdPlaying` = `#movie_player.classList.contains("ad-showing")`. Khi đang có quảng cáo thì ẩn overlay và tạm dừng scheduler tier1.
- `onNavigate`: lắng nghe `document` event `yt-navigate-finish`, kèm dự phòng kiểm tra `location.href` mỗi 1s. Khi `videoId` đổi: dispose session cũ, xóa danh sách timedtext đã bắt của video cũ, tạo session mới.
- **Ẩn phụ đề gốc:** khi `hideNativeCaptions` bật và session đã có cue thì chèn `<style id="subtrans-hide-cc">.ytp-caption-window-container{display:none!important}</style>` vào `document.head`. Gỡ style khi tắt extension hoặc khi `subtitleMode === "off"`.

**Kiểm thử**
- `ytJson3.test.ts` với fixture json3 mẫu (viết tay khoảng 30 event, gồm cả kiểu ASR có `aAppend` và `"\n"`).
- Thủ công:
  - Một video có CC thủ công.
  - Một video chỉ có auto-CC.
  - Chuyển sang video khác qua gợi ý (kiểm tra SPA navigation).
  - Video có quảng cáo.
  - Chế độ theater và fullscreen.

**Tiêu chí hoàn thành:** hiện đủ phụ đề EN từ đầu tới cuối video và đúng thời gian (lệch ≤ 0.3s so với CC gốc); chuyển video không bị dính phụ đề của video cũ.

---

### Phase 6: Scheduler và luồng dịch hoàn chỉnh
**Mục tiêu:** phụ đề tiếng Việt xuất hiện gần như ngay ở vị trí đang xem, và toàn bộ track được dịch trước ở chế độ nền.

**`content/port.ts`:** bọc Port có tự kết nối lại (Mục 4.3). Hàm `request<T>(msg): Promise<T>` dựa trên `reqId` (`crypto.randomUUID()`), có timeout 30s.

**`content/scheduler.ts`** [P]: dựa theo `pipeline.go` dòng ~1644–1703
- Trạng thái: `items[]`, `pending: Set<id>`, `inflight: Map<reqId, ids[]>`.
- `plan(playheadSec)`:
  - `tier1` = các item chưa dịch, không `ignored`, nằm trong `inPlayWindow`: `end >= t-1 && start <= t+15`.
  - `ahead` = các item `start > t+15`.
  - `behind` = các item `end < t-1`.
  - Thứ tự: tier1 → ahead (tăng dần) → behind.
- Đóng batch bằng `splitLinesIntoControlledBatches`:
  - tier1: 3 dòng/240 ký tự.
  - tier2: 5 dòng/400 ký tự nếu engine dự kiến là GTX; `maxItemsTier2` dòng/2000 ký tự nếu engine dự kiến là Gemini (mode `gemini`, hoặc `hybrid` ở tier2).
- **Hàng đợi:** tối đa 2 batch đang chạy cùng lúc mỗi session. Tier-1 luôn được lấy trước.
- Khi `seeked`, hoặc mỗi 2s trong lúc phát: chạy lại `plan` với playhead mới. Batch đang chạy không hủy (kết quả vẫn hữu ích), chỉ sắp xếp lại hàng đợi.
- `pretranslateWholeTrack = false` thì chỉ dịch tier1 và 60s phía trước.
- Nhận kết quả: `upsertSubtitles` với `target_text`, `translated: true`, `engine`. Dòng trả về rỗng thì đưa lại vào `pending` với số lần thử +1 (tối đa 3).
- Lỗi `blocked`/`network`: tạm dừng scheduler theo `retryAfterMs` hoặc `until` của breaker (lấy từ message `status`), rồi chạy tiếp. MiniToolbar hiện "Đang tạm nghỉ do giới hạn API… (mm:ss)".
- **Hybrid upgrade:** khi mọi dòng đã có bản dịch và Gemini sẵn sàng, đưa các dòng có `engine === "api"` vào hàng đợi `upgrade` (ưu tiên thấp nhất, batch `maxItemsTier2`). Bản dịch Gemini về thì thay vào và chấm chỉ báo đổi sang cyan.
- Ngữ cảnh cho Gemini: background tự lấy 2 dòng trước (Phase 2). Scheduler gửi lines theo thứ tự thời gian **liền nhau** trong cùng batch. Không trộn các đoạn xa nhau vào một batch, trừ batch tier1.

**`pipeline/session.ts` (bản đầy đủ)**
1. Có `track` + `cues` → tính `sourceHash` → gửi `cache.load`.
2. Có cache: dựng `items` từ `cues`. Với mỗi dòng chọn bản dịch theo mode: `gemini`/`hybrid` ưu tiên `cloud:${model}` rồi tới `api`; `google` ưu tiên `api` rồi tới `cloud:*`. Đánh dấu `engine` tương ứng.
3. Gửi `cache.saveTrack` (nếu chưa có), rồi khởi động scheduler cho các dòng còn thiếu.
4. Mỗi lần nhận kết quả: gom vào buffer, debounce 2s rồi gửi `cache.saveLines` theo từng `engineKey`.
5. Khi `dispose()`: gửi ngay phần buffer còn lại, hủy các request đang chạy (`cancel`), gỡ overlay.
- Cài đặt thay đổi (mode, model): mode đổi → chạy lại bước 2 (lấy lại bản dịch từ cache), rồi lên lịch dịch tiếp.

**Quy tắc dọn dẹp tài nguyên (chống rò rỉ bộ nhớ, bắt buộc)**
- Mỗi `Session`, adapter và overlay tạo một `AbortController` riêng. **Mọi** `addEventListener` (trên `video`, `document`, `window`) phải truyền `{ signal }` của controller đó. `dispose()` gọi `abort()`, nên toàn bộ listener được gỡ trong một lệnh.
- Mọi `MutationObserver`, `ResizeObserver`, `setInterval`, `setTimeout` và rAF đều đăng ký vào một `Disposer` (`src/shared/disposer.ts`: `add(fn)`, `disposeAll()`). `dispose()` gọi `disposeAll()`.
- **Không dùng sự kiện `timeupdate` để vẽ phụ đề.** Chỉ chạy vòng rAF khi video đang `playing`. Khi `pause`, `ended` hoặc tab ẩn (`visibilitychange`) thì dừng rAF. React chỉ re-render khi `id` của dòng hiện tại đổi, tức khoảng 1 lần mỗi 2–5s, không phải 60 lần/giây.
- `MutationObserver` chỉ dùng trong `videoDetector`: quan sát với `childList + subtree`, debounce 500ms. **Khi đã tìm thấy video thì ngắt hẳn observer**, chỉ bật lại khi video bị gỡ khỏi DOM hoặc khi chuyển trang SPA.
- `items[]` của session cũ phải được giải phóng: chuyển video thì xóa mọi tham chiếu tới session cũ.
- Content script **không bao giờ** sửa node DOM của trang, kể cả phụ đề gốc. Ngoại lệ duy nhất là thẻ `<style id="subtrans-hide-cc">` ở Phase 5 và host của Shadow DOM.

**Kiểm thử**
- **Kiểm thử rò rỉ (thủ công, bắt buộc):** trên YouTube, chuyển liên tiếp 20 video qua gợi ý, mỗi video phát 30s. Chụp heap snapshot (DevTools → Memory) sau video thứ 1 và sau video thứ 20. Heap của content script không được tăng quá 15MB. Khi tìm theo `Session`, số instance phải ≤ 1. Xem 1 video 2 tiếng ở tốc độ 2x: không có long task > 50ms do extension gây ra.
- `scheduler.test.ts` (fake timers, port giả):
  - Thứ tự tier1 → ahead → behind.
  - Seek làm đổi thứ tự hàng đợi.
  - Không vượt quá 2 batch chạy cùng lúc.
  - Retry dòng rỗng tối đa 3 lần.
  - Hybrid upgrade chỉ chạy sau khi đã dịch đủ.
  - Lỗi blocked thì tạm dừng.
- Thủ công: video YouTube 20 phút:
  - (a) Phụ đề VI đầu tiên hiện ≤ 2s với `google`, ≤ 5s với `gemini`.
  - (b) Tua giữa video thì VI hiện ≤ 2s (`google`).
  - (c) F5 trang thì VI hiện ngay, tab Network không có request dịch nào.
  - (d) Rút mạng giữa chừng: không crash; có mạng lại thì tự chạy tiếp.

**Tiêu chí hoàn thành:** (a)–(d) đạt; dịch xong toàn bộ video 20 phút với mode `google` mà không bị 429 khi dùng cấu hình mặc định.

---

### Phase 7: Popup và trang Options
**Mục tiêu:** người dùng tự cấu hình mọi thứ, không cần đụng code.

**Popup (`popup/Popup.tsx`)**: rộng khoảng 360px, theme tối giống Desktop (màu `player.*`, nhấn amber). Gồm:
1. Header: logo, nút bật/tắt toàn cục, nút "Tắt trên trang này" (thêm hoặc bỏ hostname khỏi `disabledHosts`).
2. **Trạng thái tab:** gọi `chrome.tabs.sendMessage(tabId, {type:"tab.status"})`. Hiện nền tảng, tên video, thanh tiến độ `translated/total`, số dòng theo engine (chấm emerald/cyan), và trạng thái breaker. Nếu không có content script trả lời → hiện "Trang này chưa có video được hỗ trợ".
3. **Chế độ dịch:** 3 nút `Google (Siêu tốc)` / `Gemini (Thông minh)` / `Tự động (Hybrid)`. Chọn Gemini/Hybrid mà chưa có key → hiện cảnh báo và link tới phần nhập key.
4. **Gemini:** ô nhập key dạng password (có nút hiện/ẩn); ô model là `<input list>` với `<datalist>` lấy từ `gemini.listModels` (nút ↻ để tải lại); nút **"Kiểm tra"** gọi `gemini.test` và hiện ✓ kèm độ trễ hoặc lỗi đã che key. Link "Lấy API key" mở `https://aistudio.google.com/apikey`.
5. **Hiển thị:** 4 chế độ phụ đề (đồng bộ với phím `V`), slider cỡ chữ 0.8–1.8, chọn màu VI, độ mờ nền.
6. **Xuất phụ đề:** 6 nút `SRT/VTT × EN/VI/Song ngữ` gửi `tab.export` cho tab. Đặt tên file giống Desktop: `${title}.${en|vi|bilingual}.${ext}`.
7. Footer: link mở Options.

**Options (`options/Options.tsx`):**
- Cài đặt nâng cao: RPM, các timeout, `maxItemsTier2`, `gtx.concurrency`, `gtx.gapMs`, `pretranslateWholeTrack`, `hideNativeCaptions`, `preferManual`, `shortcuts.enabled`, `cache.maxTracks`, `cache.maxAgeDays`.
- Cache: hiện số track và dung lượng ước tính; nút xóa toàn bộ; danh sách 50 track gần nhất (tên, ngày, nút xóa từng track).
- Nút "Khôi phục mặc định".

**Ghi chú:** mọi thay đổi lưu ngay (debounce 300ms). Content script nhận `onSettingsChanged` và áp dụng luôn, không cần F5.

**Tiêu chí hoàn thành:** đổi mode/model/cỡ chữ trong lúc video đang chạy thì có tác dụng ngay; key sai thì nút "Kiểm tra" báo lỗi rõ ràng và lỗi không chứa key.

---

### Phase 8: Nhập/xuất phụ đề, chỉnh lệch, phím tắt
**Mục tiêu:** dùng được với video không có phụ đề, và trao đổi được file với bản Desktop.

- **`overlay/MiniToolbar.tsx`:** thanh nhỏ ở góc trên phải của video, chỉ hiện khi hover vào video hoặc khi có thông báo.
  - Có: nút "Nhập .srt/.vtt", nút xuất (menu giống popup), hiển thị độ lệch (`±x.xs`), và vùng thông báo (ví dụ "Bật CC…", "Đang tạm nghỉ…").
  - Nút nhập dùng `<input type=file accept=".srt,.vtt">` **bên trong shadow root của trang**. Không đặt ở popup, vì popup tự đóng khi mở hộp chọn file trên một số hệ điều hành.
- **`adapters/imported.ts`:** đọc file bằng `File.text()` → `parseSrtOrVttBilingual`.
  - Nếu file đã song ngữ (xuất từ Desktop) → điền sẵn `target_text`, `engine = null`, `translated = true`. Hiện chấm xám "File" (thêm biến thể này vào chỉ báo).
  - Nếu file chỉ có EN → dịch như bình thường.
  - `trackKey` theo 6.4. Track nhập thay thế track tự động của video hiện tại cho tới khi chuyển video.
- **Xuất:** dùng `buildSubtitleContent`, tạo Blob, rồi tạo thẻ `<a download>` ngay trong content script. Không cần quyền `downloads`.
- **Chỉnh lệch:** giống Desktop. `G` = −0.1s, `H` = +0.1s, làm tròn 0.1 (`Math.round((o ± 0.1) * 10) / 10`), có toast. Lưu theo `trackKey` trong `chrome.storage.local` (`offset:${trackKey}`).
- **Phím tắt:** `V` xoay vòng `bilingual → vi → en → off` (giống `App.tsx`), kèm toast `Chế độ phụ đề: XX`. Gắn listener `keydown` ở `window` capture phase, **bỏ qua** khi focus đang ở `input`, `textarea`, `[contenteditable]`, hoặc có Ctrl/Alt/Meta. `V`/`G`/`H` không trùng phím tắt mặc định của YouTube. Ghi danh sách phím trong tooltip của MiniToolbar.

**Kiểm thử:**
- Tự động: round-trip xuất→nhập cho ra cùng nội dung; đọc được file `_bilingual.srt` mẫu (fixture viết tay đúng định dạng `BuildSubtitleContent`).
- Thủ công: video không có track + nhập SRT; xuất 6 loại file rồi mở bằng bản Desktop.

**Tiêu chí hoàn thành:** file do extension xuất được bản Desktop mở đúng, và ngược lại.

---

### Phase 9 (best-effort): Google Drive và trang khóa học
- **Google Drive:** player nằm trong iframe `youtube.googleapis.com/embed/...` hoặc `drive.google.com/.../preview`. Vì `all_frames: true`, content script chạy được trong iframe.
  - [T] Kiểm tra trong iframe có `<video>` và textTracks hay có timedtext không. Nếu iframe là player YouTube embed thì cho hook chạy trong cả `https://*.youtube.com/*` và `https://youtube.googleapis.com/*` (bổ sung `matches`, `all_frames: true`).
  - Ghi kết quả vào `NOTES.md`.
- **Udemy / Coursera / edX:** thường dùng `<video>` cùng `<track>` hoặc VTT tải qua mạng. Thử adapter `html5` trước. Nếu không đủ thì viết adapter riêng `adapters/udemy.ts`... bằng cách bắt request `.vtt` (thêm hook MAIN world tổng quát, chỉ bật trên các domain này).
- Mỗi adapter mới phải **tự cô lập**: lỗi ở adapter không được làm hỏng adapter `html5`.

---

### Phase 10 (thử nghiệm, không bắt buộc): Video không có phụ đề → thu âm tab gửi Gemini
- Quyền thêm: `tabCapture`, `offscreen`.
- Luồng xử lý:
  1. Người dùng bấm nút "Nghe & dịch" trong popup (cần user gesture). Gọi `chrome.tabCapture.getMediaStreamId({targetTabId})`.
  2. Background tạo offscreen document (`reasons: ["USER_MEDIA"]`).
  3. Offscreen gọi `getUserMedia({audio:{mandatory:{chromeMediaSource:"tab", chromeMediaSourceId}}})`. **Phải nối lại vào `AudioContext.destination`**, vì khi capture thì tab bị tắt tiếng.
  4. `MediaRecorder` (`audio/webm;codecs=opus`) cắt đoạn 15s, gửi kèm `inline_data` (base64) lên Gemini, yêu cầu trả JSON `[{start,end,en,vi}]` tính tương đối trong đoạn.
  5. Cộng offset theo `video.currentTime` lúc bắt đầu đoạn.
- Giới hạn cần ghi rõ trong UI: trễ 15–20s, tốn quota, không tua trước được.
- Làm trong branch riêng. Không được ảnh hưởng tới các luồng của Phase 0–8.

---

### Phase 11: Hoàn thiện, đóng gói, tài liệu
- `pnpm run zip`: build rồi nén `dist/` thành `release/subtrans-extension-v${version}.zip` (dùng gói `zip-a-folder` hoặc script Node có sẵn `node:zlib`. Chọn cách không cần công cụ hệ thống).
- `extension/README.md`: yêu cầu môi trường (Node ≥ 18, pnpm), cách build, Load unpacked, nhập key, bảng phím tắt, giới hạn đã biết, so sánh ngắn với bản Desktop.
- Rà soát:
  - Không còn `console.log` thừa (giữ lại log có tiền tố `[SubTrans]` ở mức debug, và tắt khi build production).
  - Không có `any` thừa.
  - `pnpm typecheck` không có cảnh báo.
- Đo hiệu năng: RAM của content script trên YouTube < 50MB (đo bằng Task Manager của Chrome); overlay không gây long task > 50ms (kiểm tra tab Performance).
- Chạy lại **toàn bộ Mục 3.3** và **Mục 8**.

---

## 8. Ma trận kiểm thử thủ công (chạy trước khi coi MVP là xong)

| # | Kịch bản | Kết quả mong đợi |
|---|---|---|
| 1 | YouTube có CC thủ công, mode `google` | VI hiện ≤ 2s, chấm emerald |
| 2 | YouTube chỉ có auto-CC | Câu được gộp hợp lý, không bị vỡ từng từ |
| 3 | Mode `gemini` có key hợp lệ | Chấm cyan, thuật ngữ lập trình giữ nguyên |
| 4 | Mode `gemini` với key sai | Tự fallback sang GTX (chấm emerald), popup báo lỗi key |
| 5 | Mode `hybrid` | Ban đầu emerald, sau đó dần chuyển cyan |
| 6 | F5 lại video đã dịch | Hiện ngay, 0 request dịch |
| 7 | Chuyển video qua gợi ý YouTube | Không dính phụ đề của video cũ |
| 8 | Fullscreen YouTube, kéo thả, nhấp đúp | Hoạt động bình thường, vị trí được lưu |
| 9 | Có quảng cáo | Overlay ẩn trong lúc quảng cáo |
| 10 | Trang HTML5 có `<track>` (`dev/test-page.html`) | Hoạt động; fullscreen của chính thẻ video dùng native fallback |
| 11 | Video không có phụ đề + nhập SRT | Hoạt động, dịch được |
| 12 | Nhập `_bilingual.srt` từ Desktop | Hiện song ngữ ngay, không gọi API |
| 13 | Xuất 6 loại file | Bản Desktop mở đúng |
| 14 | Mất mạng giữa chừng rồi có lại | Không crash, tự chạy tiếp |
| 15 | Chạy song song bản Desktop (`run-dev.bat`) | Cả hai hoạt động độc lập |
| 16 | Edge và Cốc Cốc | Như Chrome |

---

## 9. Rủi ro và cách xử lý

| Mã | Rủi ro | Cách xử lý |
|---|---|---|
| R1 | YouTube đổi cơ chế timedtext hoặc token `pot` | Có 3 tầng lấy phụ đề (5.2); mọi bước ghi log `[SubTrans][yt]`; parser tách riêng để dễ sửa |
| R2 | GTX là endpoint không chính thức, có thể bị chặn | Breaker, giới hạn concurrency/gap, fallback Gemini; cache rất mạnh |
| R3 | Service worker bị tắt giữa chừng | Port tự kết nối lại và gửi lại; trạng thái lưu ở storage.session; scheduler nằm ở content |
| R4 | Quota Gemini free (RPM thấp) | RPM 12 như Desktop; batch Tier-2 lớn (20 câu); hybrid chỉ dùng Gemini cho tier2/upgrade. Ước tính: video 1 giờ khoảng 800 câu, cần khoảng 40 lần gọi, mất khoảng 3,5 phút để upgrade toàn bộ |
| R5 | CSS của trang làm vỡ overlay; YouTube dùng rem = 10px | Shadow DOM, đổi rem→px (4.9) |
| R6 | `<all_urls>` khiến Chrome cảnh báo quyền rộng | Chấp nhận cho bản dùng cá nhân. Nếu đưa lên Store sau này: chuyển sang `optional_host_permissions` và xin quyền theo từng site |
| R7 | Fullscreen trên chính thẻ `<video>` | Native TextTrack fallback (4.6) |
| R8 | Ảnh hưởng bản Desktop | Quy tắc Mục 3 và lệnh kiểm tra ở mỗi phase |
| R9 | Chrome Web Store từ chối bản dùng endpoint GTX không chính thức, cộng với quyền `<all_urls>` | MVP chỉ **dùng cá nhân (Load unpacked)**, không đưa lên Store. Nếu sau này muốn publish: (1) bỏ GTX và thay bằng Cloud Translation API chính thức (người dùng tự nhập key) hoặc chỉ dùng Gemini; (2) chuyển sang `optional_host_permissions` + `activeTab`; (3) viết privacy policy. Kiến trúc engine dạng plugin (`engines/*.ts`) cho phép thay engine mà không phải sửa router |
| R10 | YouTube đổi class CSS (`.ytp-caption-segment`…) | Luồng chính **không đọc DOM phụ đề**: dữ liệu lấy từ network (timedtext) và `textTracks`. Phụ thuộc DOM chỉ còn `#movie_player`, `video.html5-main-video`, `.ad-showing` và `.ytp-caption-window-container`. Gom các selector này vào một hằng `YT_SELECTORS` duy nhất. Thiếu selector nào thì chỉ tắt tính năng đó (ẩn CC gốc, phát hiện quảng cáo) và ghi log, không làm hỏng cả extension |
| R11 | Service worker bị tắt giữa lúc đang dịch | Đã xử lý ở 4.3: scheduler nằm ở content, breaker và bucket lưu ở `storage.session`, Port tự kết nối lại và gửi lại request. **Không** dùng ping keep-alive để giữ SW sống mãi (Chrome không khuyến khích và có thể bị kill). Mỗi request dịch ngắn (< 10s), nên SW tắt giữa chừng thì chỉ mất 1 batch và batch đó được gửi lại |
| R12 | Lộ API key và prompt | Không có key nào được hardcode; key là của người dùng, lưu ở `storage.local` trên máy họ. Prompt bị lộ cũng không sao (bản Desktop cũng vậy). Không bao giờ nhúng key của tác giả vào bản build |

---

## 10. Definition of Done (MVP)
- [ ] Phase 0–8 đạt hết tiêu chí hoàn thành.
- [ ] `pnpm test` đạt; các test port từ `breaker_test.go`, `gemini_test.go`, `translator_mock_test.go` có mặt.
- [ ] Ma trận Mục 8, từ #1 đến #15, đạt.
- [ ] Mục 3.3 đạt: `git status` chỉ có `extension/`; `go test ./...` và `frontend` build vẫn đạt.
- [ ] `NOTES.md` ghi đủ kết quả của các thử nghiệm [T].

---

## Phụ lục A: System instruction của Gemini (NGUYÊN VĂN từ `gemini.go`, không sửa)
```
Bạn là chuyên gia dịch phụ đề khóa học lập trình. Dịch các câu tiếng Anh sang tiếng Việt, giữ nguyên các thuật ngữ kỹ thuật trong ngành lập trình, không thêm bớt nội dung ngoài câu gốc. Các dòng đánh dấu [CONTEXT - KHÔNG DỊCH] chỉ dùng để hiểu ngữ cảnh, tuyệt đối không dịch và không trả về ID của chúng.
```
Định dạng phần user:
```
[CONTEXT - KHÔNG DỊCH] <dòng ngữ cảnh 1>
[CONTEXT - KHÔNG DỊCH] <dòng ngữ cảnh 2>
Dưới đây là các câu cần dịch dạng JSON:
[{"id":0,"text":"..."},{"id":1,"text":"..."}]
```

## Phụ lục B: Response GTX mẫu (dùng làm fixture)
```json
[[["Xin chào thế giới","Hello world",null,null,10]],null,"en"]
```
Nhiều dòng (khi nối bằng `\n`): mỗi câu là một phần tử trong `raw[0]`, các `\n` nằm trong `[i][0]`. Ghép tất cả lại rồi tách theo `\n`.

## Phụ lục C: Tham số mặc định (lấy từ code Desktop)
| Tham số | Giá trị | Nguồn |
|---|---|---|
| Breaker GTX/Gemini | base 1m, max 10m, probeFail 1m, network 2m, threshold 3, maxStep 6 | `breaker.go`, `gemini.go` |
| Sàn Retry-After | 15s | `breaker.go` |
| Gemini RPM | 12; Tier-2 cần ≥ 3 token | `gemini.go` |
| Timeout Gemini | 3500ms / 8000ms | `gemini.go` |
| Số câu/lần gọi Gemini | 10 | `gemini.go` |
| Timeout GTX | 5s | `translator.go` |
| Nghỉ khi GTX dịch từng dòng | 60ms + jitter | `translator.go` |
| Phrase LRU | 8000 | `translator.go` |
| Cửa sổ Tier-1 | [t−1s, t+15s] | `pipeline.go:1644` |
| Batch tier1 / tier2 | 3/240, 5/400 | `pipeline.go:1700` |
| Model mặc định | `gemini-3.5-flash-lite` | `gemini.go` |
