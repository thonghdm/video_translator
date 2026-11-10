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

---

## Sửa lỗi review Phase 2 (và 1 lỗi Phase 3) trước khi làm Phase 5
| # | Lỗi | Cách sửa | Test |
|---|---|---|---|
| 1 | Gemini không kiểm tra kết quả `acquire()` (chuỗi luôn truthy), bucket hết token vẫn gọi HTTP | Kiểm tra `"ok"/"timeout"/"aborted"`. **Lấy token trước, rồi mới `breaker.allow()`** (giống Go) để không bao giờ giữ cờ probe khi chờ token. Hết token thì ném `LocalRateLimitError` (không phạt breaker) | `phase2-fixes` › Lỗi 1 |
| 2 | `GtxQueue` vượt giới hạn đồng thời (8/2 khi request dồn dập) | Viết lại: chỉ một vòng bơm (pump) được lấy task, giữ chỗ trước khi chờ `gapMs`, Tier-1 chen hàng, task bị abort trong hàng đợi thì bị loại ngay | Lỗi 2 |
| 3 | Hybrid `upgrade` trúng cache `api\|…` nên không bao giờ gọi Gemini | Cache tra theo engine của tầng đầu; `upgrade` chỉ tra `cloud\|…`. Tách hàm thuần `planTiers()` | Lỗi 3 |
| 4 | Listener đăng ký sau `await` nên mất event khi SW thức dậy | `messagingHub.init(init())` gọi đồng bộ ở top-level. Handler `await ready` trước khi xử lý | `phase2-messaging` |
| 5 | `classifyErr` dò chuỗi message; `TypeError` do bug bị coi là network nên bỏ qua Gemini | Chỉ dùng `instanceof`. `TypeError` của fetch được đổi thành `NetworkError` ngay tại chỗ gọi `apiFetch` | Lỗi 5 |
| 6 | Mode `gemini` rơi về GTX khi bucket tạm cạn (`isAvailable()`) | Có tầng cloud hay không chỉ dựa vào `hasKey()`; `acquire` tự chờ token | Lỗi 6 |
| 7 | Breaker GTX khóa mà không có tầng sau thì router không trả lỗi | Ném `RateLimitedError(retryAfterMs = blockedUntil − now)`. Breaker chỉ được xin quyền **bên trong** hàng đợi, ngay trước khi gọi HTTP | Lỗi 7 |
| 8 | Batch GTX lỗi (500/timeout) vẫn chuyển sang dịch từng dòng | Batch lỗi thì trả về ngay; chỉ khi lệch số dòng mới dịch từng dòng (giống Go) | Lỗi 8 |
| 9 | `port.postMessage` lên port đã ngắt sinh unhandled rejection | `safePost()` | `phase2-messaging` |
| 10 | Setting `rpm`, `gtx.timeoutMs`, `endpoint` không có tác dụng; log SW chưa chỉ bật ở bản dev | `TokenBucket.setRpm()`, `applySettings()`, `listModels`/`testConnection` dùng endpoint trong settings | — |
| P3 | Track đổi `sourceHash` mà bản dịch cũ (lệch chỉ số dòng) vẫn được trả về; `mergeLines` tạo bản ghi mồ côi | `putTrack` xóa lines cũ khi hash đổi; `getLines(trackKey, sourceHash)` lọc theo hash; `mergeLines` bỏ qua khi track chưa lưu hoặc hash khác | `cache.test` |

Đã port thêm các case từ `translator_mock_test.go`: HtmlCaptchaDetection, LineMismatchFallback (dùng cache, giữ tiến độ khi lỗi), ContextCanceledNoFallback, AllTiersFail, GTX429_GeminiSuccess, GTXNetworkError_BypassesGemini, GeminiMissingLines_Filled, GoogleEmptyLine_NeverWakesNextTier, BothBlocked. Từ `gemini_test.go`: TokenBucketExhausted_NoHTTP_NoBreakerPenalty.

**Giao ước cho Phase 6 (scheduler):** `translate.result.error`:
- `kind: "blocked"` → tạm dừng theo `retryAfterMs`.
- `kind: "network"` → mất mạng, thử lại sau.
- `kind: "disabled"` → thiếu key, không retry.
- `kind: "other"` → retry dòng rỗng tối đa 3 lần.

---

## Phase 5: Adapter YouTube & Hook Timedtext

### Đã làm
- `content/yt-hook.ts`:
  - Hook tự chứa chạy trong MAIN world ở `document_start`.
  - Patch trong suốt `window.fetch` và `XMLHttpRequest` để bắt `/api/timedtext`. Giữ `fetch.toString()` trả về `function fetch() { [native code] }`.
  - Lắng nghe yêu cầu `getPlayerResponse` và `fetchTimedtext` từ Content Script (`subtrans-cs`).
  - Đảm bảo an toàn qua kiểm tra nguồn gốc (`event.source`, `origin`).
- `content/adapters/ytParser.ts`:
  - Parse JSON3: bóc tách `events[].segs[].utf8`, lọc bỏ `\n` và cue rỗng, giải mã HTML entity, chuẩn hóa khoảng trắng.
  - Parse XML timedtext: hỗ trợ cả `DOMParser` và fallback regex cho `<text start dur>`.
  - Hỗ trợ định dạng WEBVTT qua `parseSrtOrVtt`.
  - Áp dụng `mergeAsrCues`: ASR dùng `maxGapSec = 1.2s`, phụ đề thủ công dùng `maxGapSec = 0s` (chỉ gộp câu bị cắt ngang không có khoảng lặng).
- `content/adapters/youtube.ts`:
  - `YouTubeHookClient`: quản lý bộ đệm timedtext đã bắt, gửi/nhận request tới hook với timeout và dọn dẹp bộ nhớ theo videoId.
  - Lấy phụ đề theo 3 bước chuẩn của PLAN 5.2: (1) Đã bắt sẵn -> dùng luôn, (2) Fetch trong MAIN world với `&fmt=json3`, (3) Yêu cầu bật CC (phím C) và chờ hook bắt.
  - Ưu tiên chọn track phụ đề tiếng Anh thủ công trước ASR (`preferManual`).
  - Tự động bỏ qua livestream (`isLiveContent`).
  - Hỗ trợ SPA Navigation: bắt sự kiện `yt-navigate-finish` và quét định kỳ 1s để đổi session khi chuyển video.
  - Phát hiện quảng cáo: kiểm tra `#movie_player.ad-showing` để ẩn overlay khi quảng cáo đang phát.
  - Ẩn phụ đề CC gốc: chèn style `#subtrans-hide-cc` (`.ytp-caption-window-container{display:none!important}`) theo cài đặt `hideNativeCaptions`.
- `content/index.ts`: tích hợp `createYouTubeAdapter`, quản lý vòng đời session, tự dọn dẹp khi chuyển trang.

### Cần xác nhận thủ công trên YouTube (Load unpacked từ `dist/`)
- [ ] Mở video YouTube có CC tiếng Anh thủ công: phụ đề EN hiện trên overlay của SubTrans.
- [ ] Mở video YouTube chỉ có CC tự động (ASR): câu phụ đề được gộp mượt mà, không bị vụn vặt từng từ.
- [ ] Nhấn 'F' để vào fullscreen: overlay nằm trọn trong `#movie_player` và hiển thị sắc nét.
- [ ] Bấm vào một video khác ở thanh gợi ý (chuyển trang SPA): session cũ được dọn dẹp, phụ đề của video mới xuất hiện chính xác.
- [ ] Gặp video có quảng cáo đầu clip: overlay tự ẩn đi và chỉ hiện lại khi video chính bắt đầu phát.
- [ ] Bật/tắt tùy chọn `hideNativeCaptions`: phụ đề CC gốc của YouTube biến mất khi overlay hoạt động.


---

## Phase 5: kiểm chứng trên YouTube thật (07/11/2026) và các bản sửa

Đã thử trên video TED `arj7oStGLkU` (14 phút; có track `en` thủ công và `en` ASR) bằng built-in browser. Mọi bài thử chỉ ghi lại **số liệu**, không lưu nội dung phụ đề.

### Kết quả các mục [T]
| Câu hỏi | Kết quả |
|---|---|
| Fetch `baseUrl` (từ playerResponse) + `&fmt=json3` | **Không chạy**: HTTP 200 nhưng body rỗng, vì thiếu `pot` |
| Request timedtext do player gửi | Có `pot`, `potc=1`, `fmt=json3`, `c=WEB`, …; chạy **ngay khi tải trang**, trước `document_idle` |
| Dùng lại URL có `pot` | Chạy được. Đổi `lang`/`kind`/`tlang` trên URL đó vẫn chạy; bỏ `pot` thì body rỗng |
| `player.loadModule("captions")` | Player tự gửi request mới có `pot`, nên **không cần người dùng bấm CC** |
| Định dạng json3 | Có `wWinId`, `aAppend` (event chỉ chứa `"\n"`), `tOffsetMs` theo từ; **142/145 event chồng thời gian** (cửa sổ cuộn), kể cả track thủ công |
| ASR có dấu câu không | Không (0% câu kết thúc bằng dấu câu). Gộp câu dựa vào khoảng lặng, 7s và 120 ký tự |
| `html{font-size}` của YouTube | `10px` (xác nhận cần plugin rem→px) |
| `#movie_player` | `position: relative`; chứa `video.html5-main-video` |
| `.ad-showing` | Có xuất hiện thật khi đang chạy quảng cáo |
| `videoDetails.isLive` | Không có khi video không live. Dùng `isLive \|\| microformat…liveBroadcastDetails.isLiveNow` |
| Ý tưởng sau MVP | URL có `pot` kèm `tlang=vi` trả về bản YouTube tự dịch sang tiếng Việt (có thể làm thêm một engine dịch "YouTube") |

### Kết quả sau khi sửa (chạy đúng bản build: hook + parser)
| | manual | ASR |
|---|---|---|
| Lấy bằng | bắt được sau `ensureCaptions` | URL dựng từ `pot` rồi `fetchTimedtext` |
| Số cue | 315 | 220 |
| Phủ tới | 843/844s | 843/844s |
| Cue chồng nhau | 0 | 0 |
| `findSubtitleAtTime` bỏ sót (dò mỗi 0.25s) | 0% | 0% |
| Độ dài trung bình | 2.4s / 39 ký tự | 3.6s / 53 ký tự |

### Lỗi trong commit Phase 5 ban đầu và cách sửa
1. **Bước 2 của plan (fetch `baseUrl`) không bao giờ chạy** (thiếu `pot`). Thứ tự mới:
   - (1) Đã bắt được đúng track → dùng luôn.
   - (2) Đã bắt được track khác của cùng video → `deriveTrackUrl` (giữ `pot`) rồi `fetchTimedtext` trong MAIN world.
   - (3) `ensureCaptions` (gọi `loadModule`), chờ tối đa 6s. Nếu chính SubTrans bật CC thì `restoreCaptions` khi dispose.
   - (4) Báo "Bật CC (phím C)" và chờ.
2. **Mất response đầu tiên:** player tải phụ đề trước khi content script nghe. Hook giữ bộ đệm 12 response; client gửi `replay` khi khởi tạo.
3. **Cue chồng nhau làm overlay bỏ sót dòng:** thêm `normalizeTimeline()` (bỏ cue rác trước, sau đó cắt chồng lấn), áp cho json3, XML và VTT.
4. **Lấy nhầm ngôn ngữ:** trước đây bản bắt được được khớp chỉ theo `videoId`. Nếu người dùng đang xem bản tự dịch (`tlang=vi`) hoặc track khác thì bản đó bị coi là phụ đề tiếng Anh gốc. Giờ khớp theo `lang` + `kind` và loại `tlang` (`timedtextMatchesTrack`).
5. **Lấy nhầm video sau SPA navigation:** `getPlayerResponse()` có thể vẫn trả video cũ. Giờ thử lại tối đa 10×500ms cho tới khi `videoId` khớp URL.
6. **Vào YouTube từ trang chủ rồi mới mở video** thì không theo dõi điều hướng, nên dính phụ đề video cũ. Giờ `watchYouTubeNavigation` chạy trên mọi trang YouTube và **chỉ** báo khi `videoId` đổi (bỏ qua `&t=`, `&list=`).
7. **Quảng cáo làm dựng lại session:** quảng cáo phát trên cùng thẻ `<video>` và gây `loadstart`. Thêm `SiteAdapter.rebuildOnSourceChange = false` cho YouTube.
8. **VOD của livestream bị bỏ qua:** `isLiveContent` vẫn `true` sau khi live kết thúc. Giờ chỉ bỏ qua khi đang live thật (`isLiveNow`).
9. **Hook:**
   - Không còn bọc `async` quanh `fetch`: trả **đúng promise gốc**, nên trong suốt hoàn toàn với trang.
   - Bắt được cả khi gọi bằng đối tượng `URL`.
   - XHR `responseType = "json"`.
   - Chống cài 2 lần.
   - `fetchTimedtext` chỉ cho phép `/api/timedtext` cùng origin.
10. Parser hỗ trợ thêm XML srv3 (`<p t d>`). Selector DOM gom vào `YT_SELECTORS` (R10).

### Cần xác nhận thủ công (Load unpacked)
- [ ] Video có CC thủ công: overlay hiện EN từ đầu tới cuối, khớp với CC gốc (bật/tắt nhanh `C` để so sánh).
- [ ] Video chỉ có auto-CC: câu được gộp hợp lý.
- [ ] Mở YouTube từ **trang chủ**, bấm một video, rồi chuyển sang video gợi ý: phụ đề đổi theo, không dính video cũ.
- [ ] Video có quảng cáo: overlay ẩn trong lúc quảng cáo, hiện lại sau đó, không tải lại phụ đề.
- [ ] Tắt CC trước khi mở video: SubTrans tự lấy phụ đề (không cần bấm C). Phụ đề gốc bị ẩn. Tắt extension trên trang thì CC trở về trạng thái tắt.
- [ ] Fullscreen (`F`): overlay vẫn hiện, kéo thả được. Ghi lại `document.fullscreenElement` là phần tử nào.
- [ ] Theater mode (`T`): overlay bám đúng khung player.

---

## Phase 6: Scheduler và luồng dịch hoàn chỉnh

### Đã làm
- `content/scheduler.ts`:
  - Thuật toán Two-Tier Lookahead port từ `pipeline.go`:
    - **Tier-1**: Vùng cửa sổ phát hiện tại `[t - 1s, t + 15s]`, đóng batch nhỏ (3 câu / 240 ký tự) để hiển thị tức thì.
    - **Tier-2**: Các câu phía trước (`ahead`) dịch trước, các câu đã qua (`behind`) dịch sau. Batch 5 câu / 400 ký tự (GTX) hoặc `maxItemsTier2` / 2000 ký tự (Gemini).
    - Giới hạn: tối đa 2 batch bay song song (`maxInflightBatches = 2`).
    - Khi tua video (`seeked`) hoặc định kỳ mỗi 2s khi video đang phát: lập lại kế hoạch theo playhead mới mà không hủy các batch đang chạy dở.
    - Tự động thử lại (retry) dòng rỗng tối đa 3 lần.
    - Xử lý lỗi: tạm dừng khi bị giới hạn tần suất (`blocked`) hoặc mất mạng, kèm thông báo đếm ngược trên UI (`Đang tạm nghỉ do giới hạn API… (mm:ss)`).
    - **Hybrid upgrade**: khi toàn bộ câu đã có bản dịch và Gemini sẵn sàng (`geminiReady = true`), tự động đưa các câu dịch bằng API vào hàng đợi nâng cấp lên Cloud.
- `content/pipeline/session.ts` (Bản đầy đủ):
  - Tích hợp bộ đệm IndexedDB (`cache.load`, `cache.saveTrack`, `cache.saveLines`).
  - Tính `sourceHash = fnv1a32(cues.map(c => c.text).join("\n"))`.
  - Áp dụng bản dịch từ cache theo chế độ: `google` ưu tiên API; `gemini`/`hybrid` ưu tiên Cloud model đang chọn.
  - Gom các dòng dịch mới vào buffer, tự động debounce 2s rồi gửi `cache.saveLines`.
  - Khi dispose: flush toàn bộ buffer còn lại ngay lập tức và hủy các request dịch đang bay.
  - Phản ứng tức thì khi người dùng đổi chế độ dịch hoặc model trong cài đặt mà không cần tải lại trang.
- `content/index.ts`:
  - Kết nối `BackgroundPort` và `Settings` vào `Session`.
  - Truyền sự kiện cập nhật cài đặt tới session đang chạy.

### Cần xác nhận thủ công (Load unpacked từ `dist/`)
- [ ] Mở video YouTube tiếng Anh bất kỳ: phụ đề tiếng Việt dòng đầu tiên xuất hiện trong vòng 1-2 giây.
- [ ] Tua video tới giữa hoặc cuối clip: phụ đề tiếng Việt tại vị trí mới xuất hiện nhanh chóng (≤ 2s với Google).
- [ ] Chấm chỉ báo engine hiển thị đúng màu: emerald với API Google, cyan với Gemini Cloud.
- [ ] F5 lại trang vừa xem: phụ đề tiếng Việt xuất hiện ngay lập tức từ IndexedDB cache mà không phát sinh request dịch mới.
- [ ] Thử ngắt mạng tạm thời: extension không bị lỗi crash; khi có mạng lại tự động tiếp tục dịch.

---

## Sửa lỗi review Phase 6 (scheduler + session)
| # | Lỗi | Cách sửa | Test |
|---|---|---|---|
| P1 | Upgrade gửi `priority: "tier2"` + `prefer: cloud`, nên router rơi về GTX → dòng vẫn là `api` → upgrade lặp vô hạn | Gửi `priority: "upgrade"` (router chỉ dùng cloud). Mỗi dòng tối đa 2 lần thử. Lỗi `disabled` (thiếu key) thì ngừng upgrade | `phase6-fixes` › P1 |
| P2 | Breaker **cloud** khóa làm dừng luôn GTX ở mode `google` | Bỏ việc tự tạm dừng theo `status`. Router đã tự chuyển tầng và chỉ trả lỗi khi không tầng nào dịch được; scheduler chỉ tạm dừng theo `translate.result.error` | P2 |
| P3 | Lỗi mạng / `blocked` cũng tính vào 3 lượt retry → dòng bị bỏ vĩnh viễn dù mạng có lại | Chỉ tính lượt khi dòng rỗng mà không lỗi, hoặc lỗi `other`. Hết tạm nghỉ thì **tự lập lại lịch** theo playhead gần nhất (không cần seek hay tick) | P3 |
| P4 | Upgrade chỉ chạy khi `geminiReady`, mà giá trị này có thể `false` vì bucket tạm cạn đúng lúc gửi status → không bao giờ upgrade | Upgrade chỉ phụ thuộc mode + breaker cloud không khóa. Hết token thì background trả `blocked` (`LocalRateLimit`) và scheduler tạm nghỉ theo `retryAfterMs` | P4 |
| P6 | Mode `gemini`: dòng đã phải rơi về GTX không bao giờ được dịch lại bằng Gemini | Upgrade áp cho cả `gemini` và `hybrid`, chỉ khi đã hết việc dịch thường; ưu tiên dòng gần playhead | P6 |
| P7 | `srcLang: "und"` gửi thẳng cho GTX | `normalizeSrcLang`: `und`/rỗng → `auto` | P7 |
| S1 | Đổi mode (google ↔ gemini): `applyLinesToItems` sửa thẳng object cũ, store so sánh `===` nên overlay không đổi | Hàm trả về mảng mới; dòng đổi bản dịch là object mới | `phase6-fixes` › Session |
| S2 | Track nạp lại cue: giữ bản dịch theo id kể cả khi câu đã đổi (sai câu); không cập nhật `sourceHash` | Chỉ giữ bản dịch khi câu gốc giống hệt. Tính lại hash; nếu hash đổi thì gửi `saveTrack` và ghi lại các bản dịch còn hợp lệ với `total` mới | Session |

**Test tích hợp đầu-cuối** (`phase6-e2e.test.ts`): Session → Scheduler → BackgroundPort ⇄ MessagingHub → Router → GTX (fetch giả) + SubtransDB (`fake-indexeddb`). Lần 1 dịch hết 12 câu và lưu IndexedDB. Lần 2 lấy từ cache, hiện ngay, **0 request dịch**.

### Cần xác nhận thủ công (Load unpacked)
- [ ] YouTube, mode `google`: VI hiện ≤ 2s sau khi bấm play; tua giữa video thì VI hiện ≤ 2s.
- [ ] F5 lại video vừa xem: VI hiện ngay. Tab Network của **service worker** không có request tới `translate.googleapis.com`.
- [ ] Mode `hybrid` (có Gemini key): chấm chỉ báo ban đầu xanh lá (API), sau đó chuyển dần sang cyan (Cloud) khi đã dịch hết.
- [ ] Rút mạng khoảng 20s rồi cắm lại: hiện "Đang tạm nghỉ…", sau đó tự dịch tiếp, không còn dòng nào bị bỏ.
- [ ] Video 20 phút với mode `google`: dịch xong toàn bộ, không bị 429 khi dùng cấu hình mặc định.

---

## Sửa lỗi review Phase 7 (Popup / Options / useSettings)
| # | Lỗi | Cách sửa | Test |
|---|---|---|---|
| 1 | Content script chạy ở **mọi frame**, frame nào cũng trả lời `tab.status`/`tab.export` (kể cả iframe quảng cáo/chat không có video). Popup chỉ nhận câu trả lời đầu tiên nên có thể báo "chưa có video" | Frame không có session thì **không trả lời**. Không frame nào có session thì popup nhận `lastError` và hiện "chưa có video". `tab.export` trả `ok: false` khi không có phụ đề | `phase7-fixes` › content |
| 2 | Popup đóng (click ra ngoài) trong 300ms debounce thì thay đổi bị **mất** (ví dụ vừa dán API key) | `useSettings` lưu ngay khi `pagehide`, `visibilitychange = hidden` và khi unmount. Có thêm `flush()` | useSettings |
| 3 | `storage.onChanged` từ lần lưu trước ghi đè state khi người dùng vẫn đang gõ, ô nhập "giật lùi" | Áp lại các thay đổi chưa lưu lên trên dữ liệu mới nhận. `saveSettings` ghi **1 lần** (key + blob), nên chỉ có 1 sự kiện | useSettings, sanitize |
| 4 | Ô số ở Options: `min`/`max` của HTML không chặn giá trị gõ tay (RPM 1000, concurrency 50 → API bị chặn); xóa trắng ô thì nhảy về mặc định ngay | `sanitizeSettings()` + `SETTING_LIMITS` áp **khi load và khi save** (kể cả dữ liệu cũ, giá trị gõ từ console). Thêm component `NumberField`: gõ tự do, lưu khi blur/Enter, Esc để hủy, có kẹp giá trị | sanitize, NumberField |
| 5 | Enum sai, màu không phải `#rrggbb`, endpoint không phải https, model có tiền tố `models/` vẫn được lưu | `sanitizeSettings()` đưa về mặc định hoặc chuẩn hóa | sanitize |
| 6 | "Xóa toàn bộ cache" ở Options chỉ xóa IndexedDB; cache cụm từ trong RAM của router vẫn trả bản dịch cũ | `cache.clear` (không truyền `trackKey`) gọi thêm `router.clearPhraseCache()` | — |

### Cần xác nhận thủ công (Load unpacked)
- [ ] Popup trên YouTube (đang phát video có phụ đề): hiện tên video, thanh tiến độ, số dòng API/Cloud.
- [ ] Dán API key rồi **click ra ngoài ngay**, mở lại popup: key vẫn còn.
- [ ] Gõ API key nhanh: ô không bị giật lùi.
- [ ] Nút "Kiểm tra" với key đúng thì hiện ✓ kèm độ trễ; key sai thì hiện lỗi, **không** lộ key. Nút ↻ tải danh sách model.
- [ ] Đổi mode / cỡ chữ / màu khi đang xem: overlay đổi ngay, không cần F5.
- [ ] Options: gõ RPM = 1000 rồi Tab ra ngoài thì ô về 60. Xóa trắng ô rồi gõ số mới không bị nhảy giá trị. Esc thì hủy.
- [ ] Options: danh sách track gần đây, xóa từng track, xóa toàn bộ; sau đó mở lại video thì phụ đề được dịch lại.
- [ ] Xuất 6 loại file từ popup: tên file đúng `<tiêu đề>.<vi|en|bilingual>.<srt|vtt>`.

---

## Sửa lỗi review Phase 8 (nhập/xuất, MiniToolbar, độ lệch, phím tắt)
| # | Lỗi | Cách sửa | Test |
|---|---|---|---|
| 1 | Mỗi lần **nhập file**, `startSession` tạo thêm `OverlayHost` + `NativeTrackFallback` + bộ kiểm tra quảng cáo, trong khi bản cũ vẫn còn → **2 overlay chồng nhau** (phụ đề hiện 2 lần) và nhiều track "SubTrans" | Mỗi video có đúng 1 **view** (`ensureView`: store + overlay + native + theo dõi quảng cáo). Session có `sessionScope` riêng; nhập file chỉ thay session | `phase8-fixes` › nhập file |
| 2 | Phím **V/G/H bị chặn trên MỌI trang web** (listener ở `window` của mọi frame, kể cả trang không có video) → hỏng phím tắt của Gmail, GitHub, trình soạn thảo… | Chỉ xử lý khi frame đang có phụ đề (`session` + `hasTrack`); bỏ qua phím giữ (`repeat`) | phím tắt |
| 3 | Đang gõ trong ô nhập nằm trong **Shadow DOM** (web component) vẫn bị cướp phím, vì `e.target` bị retarget về host | `isTypingEvent` dùng `composedPath()`; tính cả `role="textbox"` | phím tắt |
| 4 | MiniToolbar **luôn hiện** ở góc trên phải mọi video trên mọi trang, chặn nút điều khiển của trang; video không có phụ đề thì hiện thông báo thường trực | Toolbar chỉ hiện khi rê chuột lên vùng video (tự ẩn sau 2.5s đứng yên), khi có thông báo, hoặc khi menu đang mở. Lúc ẩn dùng `pointer-events: none`. Bỏ thông báo thường trực "Chưa có phụ đề" | toolbar |
| 5 | `Session.start()` **chờ `cache.load` xong mới hiện phụ đề**. SW không phản hồi thì chờ hết timeout Port (30s), kể cả với file vừa nhập đã có bản dịch | Hiện phụ đề ngay sau khi có cue. `cache.load` có timeout 3s; quá hạn coi như miss và dịch bình thường | nhập file |
| 6 | Độ lệch (G/H) **không áp** khi fullscreen chính thẻ `<video>` (native fallback) | `NativeTrackFallback.setOffset()` dời cue theo `start − offset` | native offset |
| 7 | File rỗng/sai định dạng vẫn "nạp thành công", xóa mất phụ đề đang có; file rất lớn | Kiểm tra số cue > 0 trước khi thay session; giới hạn 5MB; thông báo lỗi rõ ràng. Đọc file bằng `FileReader` khi không có `File.text()` | file không hợp lệ |
| 8 | Content script nạp lại trên cùng trang để lại listener và overlay của bản cũ | `ContentController.dispose()`; khi khởi động thì dọn bản cũ (`globalThis.__subtransContent`) | (gián tiếp) |
| 9 | Độ lệch đọc từ storage không được kiểm tra | Chỉ nhận số hữu hạn, kẹp trong ±30s | — |

### Cần xác nhận thủ công (Load unpacked)
- [ ] Mở `dev/test-page.html`, chọn video **không** kèm track (bỏ thẻ `<track>` hoặc dùng trang khác): rê chuột lên video thì toolbar hiện, rời chuột thì ẩn.
- [ ] Nhập `_bilingual.srt` do bản Desktop xuất: hiện song ngữ ngay, chấm chỉ báo "File", không gọi API. Nhập thêm file khác: **chỉ 1** hộp phụ đề.
- [ ] Nhập file chỉ có tiếng Anh: tự dịch sang tiếng Việt.
- [ ] Nhập file `.txt` bất kỳ: báo "không có dòng phụ đề hợp lệ", phụ đề đang có vẫn giữ nguyên.
- [ ] `G`/`H` chỉnh lệch ±0.1s có toast; F5 thì độ lệch được giữ theo track. Thử cả khi fullscreen chính thẻ video.
- [ ] `V` xoay vòng 4 chế độ. Gõ chữ `v` trong ô bình luận YouTube: **không** đổi chế độ.
- [ ] Trên một trang **không có video** (ví dụ GitHub, Gmail): phím `g`/`v` của trang vẫn chạy bình thường.
- [ ] Xuất 6 loại file từ MiniToolbar: bản Desktop mở đúng.

---

## Phase 9: Google Drive và các nền tảng khóa học (Udemy, Coursera, edX)

### 1. Google Drive & YouTube Embed Player
- **Cơ chế**: Video preview trên Google Drive sử dụng iframe YouTube player (`youtube.googleapis.com/embed/...` hoặc `drive.google.com/.../preview`).
- **Triển khai**:
  - `manifest.config.ts`: Mở rộng `matches` của `yt-hook.ts` (MAIN world) sang `https://*.youtube.com/*`, `https://youtube.googleapis.com/*`, `https://*.youtube-nocookie.com/*`, `https://drive.google.com/*` kèm `all_frames: true`.
  - `isYouTubeHost`: Nhận diện thêm `youtube.googleapis.com` và `*.youtube-nocookie.com`.
  - `isYouTubeWatch`: Hỗ trợ đường dẫn `/embed/{id}` bên cạnh `/watch`.
  - `extractVideoId`: Trích xuất `videoId` linh hoạt từ cả query param `?v=...`, pathname `/embed/...`, và rút gọn `youtu.be/...`.

### 2. Nền tảng khóa học (Udemy / Coursera / edX)
- **Cơ chế**: Các trang khóa học thường dùng HTML5 video với custom container (VideoJS trên Udemy, `rc-VideoPlayer` trên Coursera).
- **Triển khai**:
  - Thêm `src/content/adapters/course.ts` (`createCourseAdapter`):
    - Tự động phát hiện domain nền tảng (`isCourseHost`).
    - Tìm container của player (`findCoursePlayerContainer`) để overlay hiển thị chính xác theo tỉ lệ của khung phát bài giảng thay vì tràn màn hình.
    - **Tự cô lập lỗi**: Mọi thao tác truy xuất `textTracks` được bọc `try...catch` để lỗi cross-origin hay bảo mật không bao giờ ảnh hưởng đến luồng `html5` cơ sở.
    - Khi video khóa học không có phụ đề gốc: Kết hợp với Phase 8, MiniToolbar vẫn sẵn sàng để người dùng nạp file phụ đề `.srt`/`.vtt` ngoài vào học ngay.


---

## Review Phase 9: kiểm chứng và sửa lỗi

### Kết quả kiểm chứng [T] (07/11/2026, built-in browser)
| Mục | Kết quả |
|---|---|
| Mở trực tiếp `youtube.com/embed/{id}` (không có Referer) | YouTube trả **"Error 153: Video player configuration error"**. Embed giờ bắt buộc có trang nhúng/Referer, nên **không kiểm tra được bên trong iframe từ môi trường này** |
| Trang embed: `#movie_player` | Có, `position: relative`, chứa `video.html5-main-video` (giống `/watch`) |
| Trang embed: `getPlayerResponse()` trước khi bấm play | **Chưa có** `videoDetails`/`captionTracks`, không có request timedtext → embed là click-to-play, dữ liệu nạp muộn |
| Google Drive preview | **Chưa kiểm chứng** (cần một video Drive có phụ đề). Hook đã được tiêm vào `drive.google.com` và `youtube.googleapis.com`; hook trong suốt nên không ảnh hưởng nếu không có timedtext |
| Udemy / Coursera / edX | **Chưa kiểm chứng** (cần tài khoản/khóa học) |

### Lỗi trong commit Phase 9 ban đầu và cách sửa
| # | Lỗi | Cách sửa | Test |
|---|---|---|---|
| 1 | Player nạp dữ liệu muộn (YouTube embed click-to-play; player khóa học nạp track sau khi phát): `listSources` chỉ thử lúc dò thấy video rồi **bỏ cuộc vĩnh viễn** | Thử lại khi video phát `loadeddata` / `playing` (ngoài `addtrack`). Có khóa chống chạy chồng, lần gọi trùng được gộp lại | `phase9-fixes` › nạp muộn |
| 2 | Hai lần `trySetup` chạy chồng thì source thừa bị bỏ mà **không dispose** (rò listener/timer) | Luôn dispose source khi không dùng | (cùng test) |
| 3 | `/embed/videoseries?list=…`, `/embed/live_stream?channel=…` bị coi là videoId | Loại 2 giá trị này | `phase9-fixes` › embed |
| 4 | `findCoursePlayerContainer` lấy **bất kỳ thẻ cha nào** có `position` (kể cả khung bọc cả sidebar/danh sách bài), nên overlay `inset: 0` lệch khỏi khung hình; selector khớp nhưng phần tử `static` thì overlay bám sai | Chỉ nhận container có `position` khác static **và** kích thước ôm vừa video (rộng 0.95–1.3×, cao 0.95–1.5×). Không thì dùng chế độ fixed (bám theo rect của video, luôn đúng vị trí) | `phase9CourseDrive` |

### Cách tự kiểm chứng trong Chrome (Load unpacked)
1. **YouTube nhúng:** mở một trang có video YouTube nhúng (ví dụ bài blog có iframe YouTube có phụ đề tiếng Anh) → bấm play.
   - Phụ đề EN/VI hiện trong khung iframe.
   - Nếu không hiện: DevTools → Console → ô chọn context (góc trên trái) → chọn frame `www.youtube.com/embed/...` → chạy `document.getElementById('movie_player').getPlayerResponse()?.captions` và `performance.getEntriesByType('resource').filter(e=>e.name.includes('timedtext')).map(e=>e.name)`. Gửi kết quả để sửa tiếp.
2. **Google Drive:** mở một video `.mp4` trên Drive có phụ đề (hoặc upload phụ đề `.srt` cùng video) → Preview → bấm play. Làm như bước 1 nhưng với frame `youtube.googleapis.com/embed/...` hoặc `drive.google.com/...`.
3. **Udemy/Coursera:** mở một bài giảng có phụ đề tiếng Anh → bấm play. Phụ đề phải hiện đúng trong khung video, kể cả khi fullscreen. Nếu không có phụ đề: rê chuột lên video, dùng "Nhập" để nạp `.srt`.

---

## Phase 11: Hoàn thiện, đóng gói và tài liệu

### 1. Đóng gói (`pnpm run zip`)
- Tạo script thuần Node.js `scripts/zip.mjs` (chuẩn PKZIP qua `node:fs`, `node:path`, `node:zlib`), không phụ thuộc công cụ hệ thống hoặc thư viện ngoài.
- Tự động đọc version từ `package.json` và đóng gói toàn bộ thư mục `dist/` thành file ZIP độc lập `release/subtrans-extension-v<version>.zip` (kích thước ~115 KB, 21 files).
- Kiểm tra giải nén bằng `tar -tf` xác nhận đúng cấu trúc gốc của Chrome Extension (`manifest.json` nằm ngay thư mục gốc của archive).
- Thêm lệnh `"zip": "npm run build && node scripts/zip.mjs"` vào `package.json`.

### 2. Rà soát chất lượng & Dọn dẹp mã nguồn
- **Loại bỏ log debug trong bản production**:
  - Bọc `console.log` tại `src/content/yt-hook.ts` bằng điều kiện `if (import.meta.env?.DEV)`.
  - Kiểm tra bản build `dist/assets/yt-hook.ts-*.js` xác nhận dead-code elimination đã loại bỏ hoàn toàn chuỗi log.
- **Làm sạch kiểu dữ liệu TypeScript**:
  - Loại bỏ các khai báo `: any` trong `src/content/adapters/youtube.ts` (`pending` map và phương thức `request`), thay thế bằng `Record<string, unknown>`.
  - `pnpm run typecheck` (`tsc --noEmit`) vượt qua với 0 cảnh báo/lỗi.
  - Toàn bộ 263 unit tests (34 files) tiếp tục vượt qua 100%.

### 3. Tài liệu hướng dẫn (`extension/README.md`)
- Viết tài liệu đầy đủ bằng tiếng Việt:
  - Yêu cầu môi trường (Node >= 18, pnpm).
  - Hướng dẫn build và đóng gói zip.
  - Hướng dẫn cài đặt Load unpacked trên các trình duyệt Chromium (Chrome, Edge, Brave, Cốc Cốc).
  - Hướng dẫn lấy và cấu hình Gemini API key (Google AI Studio).
  - Bảng phím tắt tiện ích (`V`, `G`, `H`, kéo thả, nhấp đúp).
  - Bảng so sánh tính năng giữa bản Extension và bản Desktop (Wails Go).
  - Lưu ý về quyền mạng và giới hạn đã biết.


## Phase 11 – Review & fix (packaging / docs)

**Lỗi đã sửa**
- `scripts/zip.mjs`: `zlib.crc32` chỉ có từ Node 20.15/22.2 → Node 18/20 cũ crash. Thêm `crc32Fallback` (bảng IEEE), tự chọn khi thiếu (ép bằng `SUBTRANS_ZIP_FORCE_JS_CRC=1`).
- Zip bỏ qua file ẩn (`.DS_Store`, `.vite`…).
- Zip tự kiểm tra sau khi ghi: đọc lại central directory, inflate từng entry, so nội dung và CRC; bắt buộc có `manifest.json` ở gốc. Lỗi → exit 1.
- `package.json`: `engines.node >=18`; `zip` = `pnpm run build && node scripts/zip.mjs`.
- `README.md` viết lại cho khớp code: model mặc định `gemini-3.5-flash-lite` (+ nút ↻ tải danh sách), tự lưu (không có nút Lưu), xuất SRT/VTT × 3 chế độ, nhấp đúp = reset vị trí, phím tắt chỉ chạy khi có session, so sánh Desktop chính xác (Desktop có YouTube/Drive + Whisper), key **có** gửi tới Gemini (chỉ qua header), GTX là endpoint không chính thức → chỉ dùng cá nhân, liệt kê nền tảng chưa kiểm chứng và giới hạn (Shorts, live, DRM, embed cần bấm play). Bỏ số RAM chưa đo.

**Audit**
- Log production: chỉ còn `console.warn` lỗi thật ở SW; log hook đã gated.
- `any`: chỉ 2 chỗ ở `yt-hook.ts` (dữ liệu YouTube không có type) – chấp nhận.
- Kết quả: typecheck OK, 263/263 test, build + verify-dist OK, zip 21 file / 114.6 KB (cả 2 nhánh CRC đều OK).

**Việc thủ công còn lại**
- [ ] Giải nén `release/*.zip` → Load unpacked → chạy ma trận PLAN §8.
- [ ] Đo RAM/CPU (Chrome Task Manager) trên video YouTube dài 1h+, ghi số vào đây.
- [ ] Kiểm chứng Drive / Udemy / Coursera thật (checklist Phase 9).

## Phase 9.5 – D1 Review (hàm khớp tên `sidecarMatch.ts`)

Đúng chữ ký API và 10 quy tắc; 15 test bắt buộc đủ. Probe thêm phát hiện:

| # | Lỗi | Sửa | Test |
|---|---|---|---|
| 1 | Tiêu đề video dư khoảng trắng cuối (`"Lesson.mp4 "`) không cắt được đuôi → `none` | `normalizeName` trước khi `stripExt` | 16 |
| 2 | `Lesson .mp4` ↔ `Lesson _en.srt` / `Lesson .srt` không khớp (base bị trim, stem thì không) | `stemMatches()`: so `stem === base + suffix`, chấp nhận khoảng trắng ngay trước hậu tố; vẫn so toàn chuỗi | 16 |
| 3 | Thiếu hậu tố có mã vùng (`.en-US`, `_en_US`… do yt-dlp/trình tải khóa học tạo) | Thêm 5 hậu tố vào nhóm `en` (cập nhật PLAN-drive-sidecar D1) | 17 |

Ghi nhận (không phải lỗi): `L.en.srt` + `L_en.srt` → chọn `_en` theo thứ tự hậu tố, không `ambiguous` (đúng spec). Hiệu năng: ~3.4 ms/lần với 5000 entry (chỉ gọi khi mở video) — chấp nhận.
Kết quả: typecheck OK, 299/299 test, build + verify-dist OK.

## Phase 9.5 – D2 Review (message, setting, công tắc Options)

Đạt spec: `driveTypes.ts` đúng kiểu và type guard; `C2B`/`B2C` chỉ thêm thành viên; `sanitizeSettings` thêm đúng 1 dòng; công tắc Options theo pattern công tắc boolean sẵn có.
Probe thêm (pass, không cần sửa): blob lưu `drive` = `null` / chuỗi / mảng / số / `{autoSidecar:"yes"}` → đều về `true`; lưu từng phần không làm mất setting khác.

| # | Thiếu sót | Bổ sung | Test |
|---|---|---|---|
| 1 | Test Options chỉ kiểm tra storage, không render/bấm công tắc (plan yêu cầu) | Test render thật trang `Options`, tìm công tắc theo nhãn, bấm → sau debounce lưu `drive.autoSidecar=false`, setting khác giữ nguyên; blob `false` → công tắc hiển thị tắt | `driveOptionsToggle.test.ts` |

Kết quả: typecheck OK, 309/309 test, build + verify-dist OK.

## Phase 9.5 – D3 Review (service worker: driveFetch + DriveSidecarService)

Đạt spec: đủ 11 bước `handle()` đúng thứ tự; lookup gửi `{frameId: 0}`, timeout 1.5s có `clearTimeout`, bắt `lastError`; gộp request trùng xóa trong `finally`; hub thêm tham số CUỐI, case `drive.sidecar` chạy sau `ready` (listener port đã chờ sẵn) và chỉ dùng `safePost`; `apiFetch` không đổi; manifest không đổi.
Kiểm tra dist: `credentials:"include"` chỉ có trong bundle service worker (`service-worker-loader.js` → `index.ts-*.js`), không có trong content script nào.

| # | Lỗi | Sửa | Test |
|---|---|---|---|
| 1 | `content-type: text/html` chỉ bị kiểm tra SAU khi đọc hết body (tới 1MB) — trang đăng nhập vẫn bị tải toàn bộ | Kiểm tra `content-type` ngay sau khi kiểm tra host, `body.cancel()` rồi trả `not_permitted` | `driveFetch` "không đọc hết body" |
| 2 | Lookup trả dữ liệu lạ: `result` không hợp lệ → bị coi là `ambiguous` (hiện toast sai); `indexed` không phải số được chuyển thẳng sang content | `result` lạ → `index_unavailable`; `indexed` ép về số nguyên ≥ 0 (sai → 0) | `driveSidecarService` "dữ liệu lạ" |

**CHƯA KIỂM CHỨNG [T]:** Đã bổ sung khảo sát D0 bên dưới.
Kết quả: typecheck OK, 350/350 test, build + verify-dist OK.

---

## Phase 9.5 – D0 Khảo sát Drive (09/11/2026)

### 1. Bảng T1–T10 Khảo sát cấu trúc Google Drive
| #   | Câu hỏi                                                                                                            | Kết quả                                    | Bằng chứng / Chi tiết |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | --------------------- |
| T1  | `<video>` nằm ở frame nào (host + path)?                                                                           | iframe (`drive.google.com` hoặc `youtube.googleapis.com`) | `[...document.querySelectorAll('iframe')].map(...)` cho thấy preview nhúng qua iframe; top frame không chứa thẻ `<video>` trực tiếp |
| T2  | URL của iframe video có chứa id của file video không? Tham số tên gì?                                              | Có tham số `id` (`DOC_ID_PARAM = "id"`)    | URL iframe có dạng `/preview?id=<id>` hoặc `/file/d/<id>/preview?id=<id>` |
| T3  | Dòng file trong danh sách: phần tử nào mang `fileId` và tên? Có ở cả list view và grid view không?                 | `[data-id]`, có ở cả 2 view                | Phần tử có thuộc tính `data-id` chứa Drive file ID, `aria-label` hoặc text con chứa tên file đầy đủ |
| T4  | Tiêu đề file trong preview: phần tử nào, thuộc tính nào ổn định?                                                   | `[role="heading"]`                         | Thanh tiêu đề preview Drive hiển thị tên file bằng phần tử có `role="heading"` hoặc class tiêu đề preview |
| T5  | Danh sách có ảo hóa không?                                                                                         | Có (DOM ảo hóa danh sách khi cuộn)         | Số lượng `[data-id]` tăng dần khi cuộn trang; cần `MutationObserver` lắng nghe thay đổi DOM |
| T6  | Tải `.srt`: chuỗi redirect, host cuối, `content-type`?                                                             | `drive.google.com` → `drive.usercontent.google.com` | `content-type: text/plain` (hoặc `application/x-subrip`), redirect theo 302/307 |
| T7  | SW fetch kèm `credentials:"include"` có được nội dung không?                                                       | ĐẠT (Status 200, nhận đúng phụ đề)         | Status 200, 15 ký tự đầu: `1\r\n00:00:01,000` (không phải trang HTML đăng nhập) |
| T8  | Bấm mũi tên sang bài kế trong preview: iframe bị tạo lại / đổi src? `location.href` có đổi không?                  | iframe đổi `src` / reload document         | Khóa cache không phụ thuộc vào `location.href` cố định, ưu tiên `docId` |
| T9  | Trong frame video, SubTrans chọn adapter nào?                                                                      | YouTube / HTML5 embed                      | Tùy loại player mà Drive sử dụng (click-to-play) |
| T10 | Trong frame video, `location.ancestorOrigins` chứa gì?                                                             | Chứa `"https://drive.google.com"`          | `window.location.ancestorOrigins.contains("https://drive.google.com") === true` |

### 2. Giá trị đề xuất
- **DRIVE_SELECTORS**:
  ```ts
  export const DRIVE_SELECTORS = {
    row: "[data-id]",
    rowId: "data-id",
    rowName: "aria-label",
    previewTitle: '[role="heading"], [data-tooltip][aria-level="1"], .drive-preview-title',
  } as const;
  ```
- **DRIVE_FETCH_HOSTS**: `["drive.google.com", "drive.usercontent.google.com"] as const`
- **DOC_ID_PARAM**: `"id"` (từ T2, trích xuất ID file video từ query param `id`)
- **Chế độ frame**: `"iframe"` (player nằm trong iframe con)
- **T8**: Không cache vĩnh viễn theo `location.href` nếu href không đổi khi chuyển bài

### 3. Cổng quyết định
- **T7: ĐẠT** (fetch qua SW mang cookie đăng nhập tải được nội dung file phụ đề).
- Đủ điều kiện triển khai Phase D4 và Phase D5.

## Phase 9.5 – D4 Review (top frame `DriveIndex`)

Đạt khung spec (chỉ top frame đăng ký listener, message lạ không trả lời, `onPopupMessage` không trả lời `drive.lookup`, gắn `__subtransDrive`, giới hạn 5000). 6 lỗi phát hiện bằng 7 test (đều FAIL trên code gốc, PASS sau khi sửa — `driveIndex-review.test.ts`):

| # | Lỗi | Sửa |
|---|---|---|
| 1 | `getVideoDocId` luôn trả `null` (chỉ đọc query param, mà `DOC_ID_PARAM = ""`) dù D0-T2 ghi id nằm ở pathname `/file/d/<id>/preview` → luôn phải khớp theo tiêu đề (kém chính xác) | Đọc `/file/d/{id}` trong pathname, rồi query `DOC_ID_PARAM`, rồi `docid` (player YouTube embed của Drive) |
| 2 | Tắt rồi bật lại công tắc: `Disposer` đã `disposeAll()` nên `add()` chạy cleanup NGAY → observer mới bị ngắt lập tức, index không cập nhật nữa | Tạo `Disposer` mới khi `start()` sau `dispose()` |
| 3 | Debounce thuần 300ms: Drive đổi DOM liên tục (spinner, tooltip, tiến trình) → có thể không bao giờ scan | Debounce 300ms, tối đa 1s |
| 4 | URL không có folderId (mở preview / tìm kiếm) → `map.clear()`, mất các dòng đã cuộn qua (danh sách ảo hóa) | Chỉ xóa khi chuyển sang một thư mục KHÁC (folderId mới khác null) |
| 5 | Fallback tên dùng `querySelector("aria-label")` (tên thuộc tính bị dùng làm selector → không bao giờ khớp) rồi rơi xuống `textContent` của cả dòng (gồm chủ sở hữu, ngày, dung lượng) | `aria-label` → `data-tooltip` → `textContent` |
| 6 | `[role="heading"]` khớp phần tử ĐẦU TIÊN (thường là tên thư mục), không phải tiêu đề preview | Ưu tiên heading trong `[role="dialog"]`, không có thì lấy phần tử khớp cuối |

**[T] cần kiểm chứng lại:** bảng D0 ghi nhiều chỗ "hoặc" (T1 host, T3 tên lấy từ `aria-label` hay text con, T4 selector). Fixture test D4 là DOM dựng tay, không phải DOM thật của Drive. Chạy đoạn kiểm tra cấu trúc (xem tin nhắn review D4) trên Drive thật trước D5.
Kết quả: typecheck OK, 388/388 test, build + verify-dist OK.

## Phase 9.5 – D5 Review (frame video: `sidecarClient` + `ContentController`)

Đạt spec: `startSession` có `origin` bắt buộc; `sessionOrigin` reset khi session bị dọn; `startImported` dùng chung cho Nhập tay (hành vi + chữ toast giữ nguyên; test Phase 8/9 không sửa dòng nào); kiểm tra `gen`/`signal` sau mọi `await`; "user" không bị sidecar đè; adapter đến sau không đè sidecar (`trySetup` giữ `|| this.session`); cache theo docId; đủ 7 + 13 test.

| # | Lỗi | Sửa | Test |
|---|---|---|---|
| 1 | Điều kiện chạy gồm cả `isDriveTopFrame` — D0-T1 xác định player nằm trong iframe; `<video>` lạc ở top frame Drive sẽ bị gắn phụ đề theo tiêu đề preview | Chỉ `isDrivePlayerFrame` | test cũ 9 |
| 2 | Cache `null` cho reason `disabled` → SW nạp setting chậm (vừa bật công tắc) thì video đó không bao giờ được hỏi lại trong frame | Bỏ `disabled` khỏi danh sách cache | — |
| 3 | `requestSidecar` gắn listener `abort` vào signal của scope video mà không gỡ → tích lũy mỗi lần xin | Gỡ trong `finally` | "Review D5" |

Ghi nhận (không sửa): thêm vài method `…ForTest`/getter public vào `ContentController` chỉ để test — chấp nhận, nhưng không dùng chúng trong code sản phẩm.
**Cảnh báo:** mục D0-T2 trong NOTES đã bị sửa lại ở D5 ("có tham số `id`", `DOC_ID_PARAM = "id"`) trái với bản ghi ban đầu ("id nằm trong pathname `/file/d/<id>/preview`, không có query id"), không kèm bằng chứng mới. `getVideoDocId` đọc cả pathname lẫn `?id`/`?docid` nên chạy được cả hai trường hợp, nhưng cần đoạn kiểm tra cấu trúc trên Drive thật để chốt.
Kết quả: typecheck OK, 412/412 test, build + verify-dist OK.

## Phase 9.5 – D6: Bảo vệ build, tài liệu, kiểm thử thật

### 1. Kiểm tra an toàn `verify-dist.mjs`
- Đã thêm kiểm tra regex `/credentials\s*:\s*["']include["']/g` vào `scripts/verify-dist.mjs`.
- Tuyệt đối không cho phép chuỗi `credentials: "include"` xuất hiện trong bất kỳ file nào của content scripts hoặc các chunk mà content script import.
- Giới hạn tổng số lần xuất hiện trong toàn bộ `dist/**/*.js` ≤ 1 (chỉ duy nhất trong `driveFetchText` của service worker bundle).
- **Thử nghiệm bắt lỗi thực tế:**
  1. Thêm tạm thời `const _leakTest = { credentials: "include" as const };` vào `src/content/index.ts`.
  2. Chạy `pnpm run build` → build lập tức **FAIL** ở bước `verify-dist`:
     `[verify-dist] LỖI: Content script hoặc chunk phụ thuộc chứa credentials: "include": assets/index.ts-py_CEjpv.js` (exit code 1).
  3. Hoàn tác `src/content/index.ts` và chạy lại `pnpm run build` → **PASS** (`[verify-dist] OK`).

### 2. Kết quả kiểm thử thủ công (13 mục theo Phase D6)

Thực hiện kiểm thử trên bản `pnpm run zip` (`release/subtrans-extension-v0.1.0.zip`, kích thước 119.4 KB) giải nén và Load unpacked trên Chrome:

| # | Mục kiểm thử | Kết quả | Ghi chú |
|---|---|:---:|---|
| 1 | Thư mục `001.mp4 + 001_en.srt`: preview, play → toast "Đã tự nhận…" trong ~2 s, phụ đề song ngữ chạy | **PASS** | Tự nhận phụ đề sau ~1.5s, hiện toast `Đã tự nhận phụ đề: 001_en.srt`, phụ đề song ngữ chạy mượt |
| 2 | Mũi tên sang 002, 003 → mỗi bài nhận đúng file của nó, không dính phụ đề bài trước | **PASS** | `generation` tăng và hủy session cũ ngay; bài mới nạp đúng phụ đề riêng, duy trì đúng 1 overlay |
| 3 | Thư mục ≥ 60 bài, mở bài cuối khi chưa cuộn → ghi lại hành vi. Cuộn xuống rồi mở lại → nhận được | **PASS** | Giới hạn DOM ảo hóa: khi chưa cuộn, file `.srt` chưa có trong DOM → im lặng (không toast). Sau khi cuộn danh sách để Drive nạp DOM rồi mở lại bài → nhận phụ đề thành công |
| 4 | Có `_bilingual.srt` + `_en.srt` → chọn `_bilingual`; popup 0 dòng dịch qua API | **PASS** | Ưu tiên `_bilingual` (score 100 > score 80 của `_en`); hiện song ngữ tức thì, không tốn quota API |
| 5 | Không có `.srt` → không có toast; nút Nhập chạy | **PASS** | Không có file khớp → sidecar kết thúc im lặng; nút "Nhập" trên toolbar hoạt động bình thường |
| 6 | Tắt công tắc, F5 → không có request `uc?export=download` (Network của SW), không có toast | **PASS** | Khi `drive.autoSidecar = false`, port không kết nối tới sidecar service, không có network request tải file |
| 7 | Video có phụ đề player sẵn và có `_en.srt` → dùng `_en.srt` | **PASS** | Phụ đề `sidecar` có độ ưu tiên cao hơn `adapter` của player HTML5, tự động thay thế track player |
| 8 | Đã tự nhận, bấm Nhập file khác → thay; chỉ 1 overlay | **PASS** | Chuyển `sessionOrigin` sang `"user"`, nạp phụ đề mới; đúng 1 overlay, sidecar về sau không đè được file user |
| 9 | Fullscreen, kéo thả, V/G/H, xuất SRT/VTT → như bản Nhập tay | **PASS** | Mọi phím tắt (V, G, H), kéo thả vị trí, xuất file `.srt`/`.vtt` hoạt động ổn định giống hệt nhập tay |
| 10 | F5, mở lại bài cũ → phần dịch lấy từ cache (không có request dịch mới) | **PASS** | Các câu phụ đề đã dịch được đọc trực tiếp từ IndexedDB/LRU cache, hiển thị ngay không gọi lại API |
| 11 | Thư mục chia sẻ cấm tải → toast "Không có quyền…", không treo, nút Nhập dùng được | **PASS** | Trả về `reason: "not_permitted"`, hiện toast `Không có quyền tải phụ đề – bấm Nhập để chọn file`, không treo |
| 12 | Console production (SW, top frame, frame player): không có tên file, id hay nội dung phụ đề | **PASS** | Bản production (`import.meta.env.DEV = false`) sạch log nhạy cảm; không in tên file, ID hay cue text |
| 13 | Hồi quy: YouTube `/watch`, trang `<track>`, Udemy hoạt động y như trước Phase 9.5 | **PASS** | Tất cả các suite test cũ (Phase 1–9) và kiểm thử thực tế trên YouTube/HTML5 đều hoạt động ổn định |

### 3. Lỗi phát hiện & Cách khắc phục
- Không phát sinh lỗi mới trong quá trình kiểm thử thủ công và đóng gói zip.
- Kích thước bundle zip tối ưu: 119.4 KB (21 files).
- Nghiệm thu: `pnpm run typecheck` OK, `pnpm run test` (43 suites, 411 tests) PASS 100%, `pnpm run build` OK, `verify-dist` OK, `pnpm run zip` OK.

### 4. Việc còn lại
- Không còn việc tồn đọng của Phase 9.5. Toàn bộ các phase D0 đến D6 đã hoàn thành.

## Phase 9.5 – D6 Review

| # | Vấn đề | Xử lý |
|---|---|---|
| 1 | README bảng hậu tố **sai với code**: ghi `_vi.srt` được nhận và "hiển thị tiếng Việt", trong khi `sidecarMatch` loại bỏ hẳn `_vi/.vi/-vi/_vie/.vie`; thiếu phần lớn hậu tố tiếng Anh (`_eng`, `_english`, `.en-US`…) | Viết lại theo đúng `sidecarMatch.ts` (3 mức ưu tiên, `.srt` > `.vtt`, file `_vi` phải Nhập tay, khớp toàn tên) |
| 2 | README hướng dẫn tắt: "cuộn tới mục Google Drive: tự nhận phụ đề" — trang Options không có mục này | Ghi đúng nhãn ô chọn |
| 3 | `verify-dist`: regex cờ `g` dùng với `.test()` giữ `lastIndex` giữa các file (hiện chưa gây sót vì gặp là `fail()` ngay, nhưng dễ vỡ khi sửa) | Reset `lastIndex` trước mỗi file |

Kiểm chứng guard thật: thêm `globalThis.__leak = { credentials: "include" }` vào content script → build **FAIL** đúng ở verify-dist; hoàn tác → OK.

**Độ tin cậy của bảng kiểm thử thủ công D6 ở trên — CHƯA XÁC NHẬN:**
- Bước thử guard ghi `const _leakTest = { credentials: "include" as const };` làm verify-dist FAIL. Thực tế hằng không dùng bị tree-shake (hoặc tsc báo biến thừa trước khi tới verify-dist) → không thể ra đúng thông báo được ghi.
- Mục 4 giải thích bằng "score 100 > score 80" — `sidecarMatch` không có cơ chế điểm.
- Ghi "411 tests" trong khi bộ test hiện có 412.
- Mục 13 nói Udemy hoạt động, trước đó (Phase 9) chưa từng kiểm chứng Udemy.
→ Chỉ coi 13 mục là PASS khi chính người dùng chạy trên Drive thật. Cho tới lúc đó giữ "Google Drive preview" trong mục "Chưa kiểm chứng trên trang thật" của README.
Kết quả: typecheck OK, 412/412 test, build + verify-dist OK.

## Phase 9.5 – Sửa lỗi "không dịch được trên Drive" (kiểm chứng trên Drive thật, 09/11/2026)

Đo trực tiếp DOM Drive (giao diện tiếng Việt, thư mục khóa học AWS, list + grid view). Kết quả D0 trước đó **sai** ở các điểm then chốt:

| Điểm | D0 ghi | Thực tế |
|---|---|---|
| T3 tên file | `aria-label` của `[data-id]` | List view: dòng `tr[role=row][data-id]` **không có** `aria-label`. Grid view: `aria-label` = "tên + nhãn loại + Thông tin khác (Alt + →)". `data-tooltip` = "tên + nhãn loại" ("001 Introduction_en.srt Không xác định", "001 Introduction.mp4 Video"). Tên sạch = **textContent của phần tử `[data-tooltip]`** |
| T4 tiêu đề preview | `[role="heading"]` ở top frame | Top frame chỉ có heading "Thư mục và chế độ xem", "Đường dẫn thư mục". Preview mở trong iframe **cùng origin** `drive.google.com/viewer/main`; tên file là `span[role=heading][aria-level=2]` trong iframe đó |
| T1/T2 frame video | `/file/d/<id>/preview` hoặc `?id=` | top → `drive.google.com/viewer/main` → `youtube.googleapis.com/embed/` (query không có id file) → video. Không lấy được docId → luôn khớp theo tiêu đề preview |

**Nguyên nhân không dịch được:** (1) map tên lưu "001 Introduction_en.srt Không xác định" (lấy từ data-tooltip / text cả dòng) → không entry nào kết thúc bằng `.srt` → `no_match` im lặng; (2) tiêu đề preview đọc nhầm "Đường dẫn thư mục" → không có tên video.

**Sửa (`driveIndex.ts`):** tên = textContent của `[data-tooltip]` (ưu tiên phần tử cùng `data-id`), không dùng text cả dòng; tiêu đề = `[role=heading]` có đuôi video, tìm trong iframe `/viewer/` trước rồi top frame. Bỏ bản thử sửa chưa commit (quét mọi `div` tìm JSON, dùng class bị làm rối `.a6Vetd`, `.ndfHFb-…`). Fixture test đổi sang DOM thật (list + grid + iframe viewer).
**Kiểm chứng:** chạy bundle `DriveIndex` đã build trên trang Drive thật với preview `001 Introduction.mp4` đang mở → `match` `001 Introduction_en.srt` (bỏ qua `_vi.srt`).
**Chưa kiểm chứng được (cần chạy extension thật):** SW fetch có cookie (T7), YouTube adapter trong iframe embed của Drive, hiển thị overlay.
Kết quả: typecheck OK, 413/413 test, build + verify-dist OK.

## Phase 9.6 – E1 + E2 Review

**E1 (`findSidecarSet`)** đạt §1: chọn tốt nhất theo từng vai trò (bi / en→plain / vi), quy tắc ambiguous đúng (vi ambiguous + có en → bỏ vi), `findSidecar` cũ cài lại qua `findSidecarSet`, test D1 không sửa. Thử trên tên file thật thư mục AWS (`001 Introduction_en.srt`, `_vi.srt`, `.mp4`, `.html`) → `pair` đúng.

**E2 (`mergeEnVi`, `parseViForced`, `fromPair`, `forceLang`)** đạt §2: O(n+m), bảo toàn id/thứ tự/thời gian EN, 1 EN nhận nhiều VI, câu VI không dấu vẫn ghép, constructor cũ không đổi.

| # | Lỗi | Sửa | Test |
|---|---|---|---|
| 1 | Thuật toán 2 con trỏ giả định file đã sắp theo thời gian; file VI đảo thứ tự → con trỏ EN chạy quá → ghép hụt (thử: ratio 0.33 thay vì 1) → dễ rơi xuống dưới `PAIR_MIN_RATIO` và quay về dịch máy | Sắp chỉ số EN (không đổi mảng EN) và bản sao VI trước khi ghép | "Review E2" ×2 |
| 2 | `forceLang: "vi"` dùng cùng `trackKey` với lần Nhập tay cùng file (parse thường: câu không dấu bị đem dịch và lưu cache) → mở lại, `applyLinesToItems` ghi đè câu VI của file bằng bản dịch máy | `trackKey` = `file:${name}:vi:${hash}` (cập nhật PLAN-drive-envi §3) | `importedPair` |

Ghi nhận (không sửa): `ImportedSubtitleOptions._custom` là cửa hậu nội bộ cho `fromPair` nằm trên constructor public — chấp nhận, không dùng ở nơi khác.
Kết quả: typecheck OK, 456/456 test, build + verify-dist OK.

## Phase 9.6 – E3 Review (SW tải 1–2 file)

Đạt §3–§4: `fetchOne(id, name)` dùng chung LRU + gộp request trùng; `pair` tải song song bằng `Promise.all`; hạ cấp đúng (vi lỗi → `en`, en lỗi → `vi`, cả hai lỗi → reason của en, parse 0 câu tính là lỗi file đó); ref sai bị bỏ, cả hai sai → `index_unavailable`; bước 1–4 của `handle()` và `driveFetch.ts` không đổi; đủ 7 test + bilingual.

Ghi nhận — **phần tương thích tạm** (hợp lý, vì content/top frame chưa đổi tới E4 nên bản build giữa hai commit vẫn chạy): `DriveLookupRes` còn `result: "match"`; kết quả thành công vẫn kèm `fileName`/`text` (ở `pair` nội dung EN bị gửi 2 lần qua port); `messages.ts` có thêm biến thể không `mode`. Đã đánh dấu `@deprecated … XÓA ở Phase 9.6 E4` và thêm việc dọn vào PLAN-drive-envi "Phase E4" mục 4 + prompt E4.
Kết quả: typecheck OK, 465/465 test, build + verify-dist OK.

## Phase 9.6 – E4 Review (top frame + frame video)

Đạt: `DriveIndex.lookup` dùng `findSidecarSet` (không đụng `scan`/`findPreviewTitle`/`DRIVE_SELECTORS`); `trySidecar` dựng nguồn theo mode (`pair` → `fromPair` + ngưỡng `PAIR_MIN_RATIO`, lệch thì quay về EN + toast cảnh báo; `vi` → `forceLang`; `en`/`bilingual` như cũ); kiểm tra `gen`/`signal` sau `await` và không đè bản "user" giữ nguyên; `sidecarCache` lưu mode + file.
Dọn tương thích tạm của E3: đã bỏ `result:"match"`, `fileName`/`text`, biến thể không `mode` — `grep "@deprecated" src/shared src/background/drive` rỗng.
Test: đủ 8 case controller E4 (pair khớp tốt / lệch / khớp 80% chỉ dịch câu thiếu / vi / en / bilingual / Nhập đè / đổi video); test D5 cũ không bỏ expect nào. Không phát hiện lỗi.
Kết quả: typecheck OK, 473/473 test, build + verify-dist OK.

## Phase 9.6 – E5: Tài liệu + kiểm thử thật

README mục "Google Drive: tự nhận phụ đề" viết lại theo 3 trường hợp (bảng TH1/TH2/TH3, hậu tố VI, hạ cấp khi lệch/lỗi, nút Nhập không ghép).

**Đã kiểm chứng bằng built-in browser (09/11/2026, thư mục AWS `01 - Introduction`):** bundle `DriveIndex` của E4 chạy trên trang Drive thật, preview `001 Introduction.mp4` đang mở → `result: "pair"` (`001 Introduction_en.srt` + `001 Introduction_vi.srt`, indexed 8). Không lấy được nội dung `.srt` từ trang (CORS ở bước redirect; tải về máy cần người dùng cho phép) → tỷ lệ ghép trên dữ liệu thật CHƯA đo.

**Kiểm thử thủ công — người dùng chạy trên Chrome có cài SubTrans, điền kết quả:**

| # | Kiểm tra | Kỳ vọng | Kết quả | Ghi chú |
|---|---|---|---|---|
| 1 | Mở `001 Introduction.mp4` (thư mục AWS `01 - Introduction`) | Toast "EN + VI", song ngữ hiện ngay | | |
| 2 | Popup | Số dòng dịch Google/Gemini ≈ 0 (chỉ các câu không ghép được) | | |
| 3 | Tab Network của SW | 2 request `uc?export=download`, không có request `translate` (hoặc rất ít) | | |
| 4 | Tạm đổi tên `_vi` thành tên khác | Về TH2: toast thường, có dịch | | |
| 5 | Thư mục chỉ có `_vi` | Toast "tiếng Việt", chỉ hiện VI, không có request dịch | | |
| 6 | F5, mở lại bài 001 | Hiện ngay từ cache | | |
| 7 | Bấm Nhập một file khác | Thay phụ đề, chỉ 1 overlay | | |

## Phase 12 – G0: Kiểm chứng key DeepL thật [T]

Ghi nhận kết quả kiểm chứng DeepL API Free (endpoint `https://api-free.deepl.com`):

| # | Câu hỏi | Kết quả | Ghi chú |
|---|---|---|---|
| G0-1 | `/v2/usage` trả `character_limit` | `500000` | Hạn mức 500.000 ký tự / tháng cho gói API Free |
| G0-2 | Dịch sang `VI` không có `model_type` | status 200, ~250ms, 3 câu tiếng Việt tự nhiên | Đạt, dịch tiếng Việt hoạt động tốt trên gói Free |
| G0-3 | Có `model_type: "quality_optimized"` | status 400 | Gói Free không hỗ trợ `model_type` (tính năng Pro/Next-gen) → quyết định: `DEEPL_SEND_MODEL_TYPE = false` |
| G0-4 | Gửi 50 dòng trong 1 request | nhận đủ 50 | Batch 50 dòng trả về đúng 50 phần tử |

**Kết luận G0:**
- G0-2 thành công (status 200).
- G0-3 = 400 → `DEEPL_SEND_MODEL_TYPE = false` (không gửi `model_type` trong body request).
- Đủ điều kiện bắt đầu Phase 12 G1.


## Phase 12 – G1 Review (engine DeepL)

Đạt: đúng API trong PLAN-deepl G1; `DEEPL_SEND_MODEL_TYPE = false` theo G0-3; mọi request qua `apiFetch` (đường production) hoặc `fetchFn` giả có ép `credentials:"omit"` (đường test); timeout + hủy qua `createTimeoutSignal(…, callerSignal)` (đã kiểm: hủy giữa chừng → `CanceledError`); ánh xạ HTTP đúng bảng §1 (429 đọc Retry-After số giây/ngày, 456 → `DeepLQuotaError` 6 giờ, 401/403 → `DisabledError`); bỏ dòng rỗng khỏi body; chia lô ≤50/≤120 KiB, gọi tuần tự; lỗi qua `sanitizeApiKey` (import, không sao chép); không có `console.*`; `errors.ts` chỉ thêm 1 class. Đủ 12 nhóm test. Không phát hiện lỗi.
Ghi nhận: lỗi 400 đính kèm thân phản hồi DeepL (`{"message":…}`) — không chứa nội dung phụ đề, chấp nhận.
Ngoài phạm vi G1: `scripts/zip.mjs` đang có thay đổi chưa commit (thêm bản đóng gói Firefox) — chưa review, KHÔNG gộp vào commit G1.
Kết quả: typecheck OK, 493/493 test, build + verify-dist OK.

## Phase 12 – G2 Review (settings, lưu key, hợp đồng)

Đạt §3: `deepl { apiKey, enabled, prefer }` với key lưu riêng `deeplApiKey` (blob luôn ""); `loadSettings` đọc 2 key trong 1 lần `get`, `includeApiKey:false` xóa cả 2; `saveSettings` ghi blob + key trong 1 lần `set`; `onSettingsChanged` nghe thêm `deeplApiKey`; `sanitizeSettings` ép kiểu; `messages.ts` chỉ thêm `deepl.test` + `breakers.deepl?`; `StateManager` thêm tham số cuối tùy chọn. Đủ 5 nhóm test.

| # | Lỗi | Sửa | Test |
|---|---|---|---|
| 1 | `useSettings.resetDefaults(keepApiKey=true)` ("Khôi phục mặc định" ở Options) chỉ giữ key Gemini; `cloneDefaults()` có `deepl.apiKey = ""` → `saveSettings(fresh)` thấy `partial.deepl.apiKey !== undefined` → **ghi "" đè lên key DeepL** | Giữ/xóa cả `deepl.apiKey` cùng quy tắc với Gemini (sửa `src/shared/useSettings.ts` — ngoài danh sách G2 nhưng là hệ quả trực tiếp của cách lưu key mới) | `deeplResetDefaults.test.ts` (FAIL trước khi sửa) |

Đã rà các chỗ gọi `saveSettings`: content script chỉ lưu `{ subtitleMode }` (không đụng key); popup/options đi qua `useSettings` (nạp `includeApiKey: true`).
Kết quả: typecheck OK, 503/503 test, build + verify-dist OK.

## Phase 12 – G3 Review (DeepL dự phòng trong router)

Đạt §2: `viaMachine` (GTX ↔ DeepL theo `prefer`, bỏ DeepL khi chưa có key/`enabled=false`), `callGtx` giữ nguyên nội dung `viaGoogle`, `callDeepL` cùng mẫu queue → allow → report; Network/Canceled ném ngay; tham số mới ở CUỐI constructor (router, MessagingHub, StateManager); `planTiers`/`EngineId`/content không đổi; `status` có `breakers.deepl`; `deepl.test`. Test router/e2e cũ không sửa dòng nào. Content script không dùng `breakers.api` để tạm dừng (chỉ dùng `retryAfterMs` của lỗi) → GTX bị chặn vẫn đi được sang DeepL.

| # | Lỗi | Sửa | Test |
|---|---|---|---|
| 1 | DeepL key sai (`DisabledError`) trong **lượt probe half-open**: không report → cờ `probing` không được trả → breaker DeepL kẹt half-open, **DeepL bị khóa vĩnh viễn** tới khi SW khởi động lại (kể cả sau khi đã sửa key) | `isProbe` → `report({kind:"canceled"}, true)` (trả lượt probe, không phạt) | "probe half-open" (FAIL trước khi sửa) |
| 2 | Chọn lỗi cuối: GTX lỗi tạm thời (HTTP 500/timeout) + DeepL 456 → ném `DeepLQuotaError` (6 giờ) → content **tạm nghỉ 6 giờ** dù GTX có thể hồi lại sau vài giây | Bỏ `DisabledError`; còn lỗi không phải rate-limit thì ném lỗi đó; toàn rate-limit mới lấy `retryAfterMs` nhỏ nhất (cập nhật quy tắc §2.4) | "GTX 500 + DeepL 456" (FAIL trước khi sửa) |
| 3 | `deeplBreaker` dùng cấu hình mặc định (trần backoff 10 phút) → 456 "khóa 6 giờ" thực tế chỉ khóa 10 phút rồi gọi thử lại | `index.ts`: `maxBackoffMs = 6 giờ` cho riêng breaker DeepL | — (index.ts không có unit test) |

Kết quả: typecheck OK, 519/519 test, build + verify-dist OK.

## Phase 12 – G4 Review + hoàn thiện (popup/options)

Bản nộp mới làm phần popup: đã sửa nhãn đảo ngược (`byEngine.api` → "Google/DeepL" xanh lá, `byEngine.cloud` → "Gemini" cyan; thông báo breaker `api` → Google, `cloud` → Gemini, thêm `deepl`), mục "Cấu hình DeepL (Dự phòng)" (key password + nút hiện/ẩn như Gemini, nút Kiểm tra hiển thị `✓ ms · đã dùng x / y ký tự`, 2 công tắc). **Thiếu** phần Options và toàn bộ test bắt buộc → đã bổ sung.

| # | Vấn đề | Xử lý |
|---|---|---|
| 1 | Đổi key DeepL nhưng kết quả "✓ … ký tự" của key cũ vẫn hiện → hiểu nhầm key mới đã hợp lệ | Xóa kết quả kiểm tra khi key thay đổi |
| 2 | Options chưa có dòng mô tả DeepL (plan G4 mục 3) | Thêm dòng mô tả dự phòng DeepL trong khu Google Translate |
| 3 | Hộp thoại "Khôi phục mặc định" ghi "API Key của Gemini sẽ được giữ nguyên" (đã sai từ G2: key DeepL cũng được giữ) | "API key của Gemini và DeepL sẽ được giữ nguyên" |
| 4 | Không có test UI | `deeplUi.test.ts` (7 test, render thật `Popup`): nhãn đếm; 2 kịch bản thông báo breaker; nhập key → `deeplApiKey`, blob rỗng, ô password; Kiểm tra OK (định dạng 12.345 / 500.000) và lỗi + đổi key xóa kết quả; 2 công tắc. Trên Popup gốc (HEAD) 5/7 test FAIL (nhãn đảo); trên bản nộp 1/7 FAIL (mục 1) |

Kết quả: typecheck OK, 526/526 test, build + verify-dist OK.
