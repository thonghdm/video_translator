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
