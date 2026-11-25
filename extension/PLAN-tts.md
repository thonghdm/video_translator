# PLAN-tts.md: Phase 13 — Lồng tiếng tiếng Việt tự động (Edge Neural TTS) cho Firefox & Chromium (v3)

> Phụ lục của `PLAN.md`. Thiết kế tương thích với kiến trúc hiện tại của `extension/` (nhánh `feat/edge-tts-dubbing`).
> Trình duyệt mục tiêu: **Firefox (MV3 / AMO)** và **Chromium (Edge, Chrome, Cốc Cốc)**.
>
> **Thay đổi so với v2:**
> - Sửa lỗi script spike Bước 0 (timestamp bị thừa chữ `Z`, log thêm close code, in rõ kết quả theo trình duyệt).
> - Thêm mục **Rủi ro & giới hạn đã biết** (endpoint không chính thức, DNR `Origin`, đổi pitch khi tăng `playbackRate`) và kế hoạch dự phòng.
> - Bước 1: chỉ retry khi chưa nhận byte audio nào; ghi log close code; xác minh kiểu message `cancel` đã tồn tại.
> - Bước 2: tách bản sao `ArrayBuffer` trước `decodeAudioData` (hàm này làm "detach" buffer); xóa cache khi `AudioContext` bị tạo lại; thêm test tương ứng.
> - Bước 3: thêm khai báo `data_collection_permissions` cho Firefox (AMO) trong `scripts/zip.mjs`, cập nhật mô tả store & README.
> - Khối prompt dùng rào 4 dấu backtick để các khối code ``` bên trong không làm vỡ định dạng.

---

## 0. Quy tắc bất biến (AI thực thi bắt buộc tuân thủ)

1. **Không làm gãy test cũ & cổng kiểm tra build:**
   - Sau mỗi bước phải chạy `pnpm typecheck`, `pnpm test`, `pnpm build` (bao gồm `scripts/verify-dist.mjs`) tại thư mục `extension/` và toàn bộ phải xanh.
   - Khi `settings.tts.enabled === false` (mặc định), hành vi của `Session`, `Scheduler`, `Overlay` phải giống hệt hiện tại (không khởi tạo `AudioContext`, không gọi TTS).
2. **Namespace & Bảo mật (`verify-dist.mjs`):**
   - Toàn bộ codebase dùng namespace **`chrome.*`** (`@types/chrome`). Firefox MV3 hỗ trợ tương thích `chrome.*`. **Không dùng `browser.*`** để không làm gãy `tsc --noEmit`.
   - **Không** thêm `credentials: "include"` vào bất kỳ file nào (`scripts/verify-dist.mjs` khóa cứng tổng số xuất hiện `<= 1` chỉ riêng cho `driveFetch.ts`). Mọi lệnh `fetch` phụ trợ phải ghi rõ `credentials: "omit"`.
3. **Truyền dữ liệu nhị phân qua Port `"subtrans"`:**
   - Chromium tuần tự hóa message qua `chrome.runtime.Port` bằng JSON nên `ArrayBuffer` / `Uint8Array` sẽ bị biến thành `{}`.
   - Background bắt buộc chuyển MP3 sang **Base64 (`audioBase64`) theo từng khối 32 KB** (tránh tràn Call Stack) trước khi gửi qua `B2C`.
4. **Phát âm thanh trong Content Script bằng Web Audio API (vượt CSP `media-src`):**
   - **Không dùng** `new Audio(blobUrl)` ở Content Script vì nhiều trang có CSP (`media-src`) chặn `blob:` / `data:`.
   - Giải mã Base64 → `ArrayBuffer` → **`AudioContext.decodeAudioData`** → phát qua **`AudioBufferSourceNode` + `GainNode`**. Cách này giải mã trong RAM, không phụ thuộc `media-src`, đo được `audioBuffer.duration` thật, và hỗ trợ `audioCtx.suspend()` / `resume()` giữa câu.

---

## Rủi ro & giới hạn đã biết (đọc trước khi bắt đầu)

| Rủi ro | Mức | Cách xử lý trong kế hoạch |
|---|---|---|
| Endpoint Edge Read Aloud **không chính thức**: token, `Sec-MS-GEC-Version` có thể bị Microsoft đổi bất cứ lúc nào; giả `Origin` extension Edge có thể trái điều khoản dịch vụ và bị store xem xét | Cao | Gom hằng số vào `EDGE_TTS_CONFIG`; bù lệch đồng hồ; tính năng mặc định tắt; minh bạch trong UI, `PRIVACY_POLICY.md`, mô tả store. Phase 13b (tùy chọn): engine dự phòng `speechSynthesis` (không thu được `AudioBuffer`, nên không đo duration và chỉ chỉnh `rate`) |
| `declarativeNetRequest` có thể không ghi đè được `Origin` cho WebSocket ở một trình duyệt | Trung bình | **Bước 0 là cổng chặn**: nếu spike thất bại trên trình duyệt nào, ghi lại kết quả và quyết định trước khi code Bước 1 |
| `AudioBufferSourceNode.playbackRate` > 1 **làm tăng cao độ** (không bảo toàn pitch) | Thấp | Chỉ tăng khi câu quá dài, trần 1.45; ưu tiên `rate` SSML (`autoBoost`) cho câu dài đã biết trước nếu cần cải thiện sau |
| Văn bản phụ đề được gửi sang Microsoft | Trung bình | Tính năng mặc định tắt; khai báo trong UI, `PRIVACY_POLICY.md`, `data_collection_permissions` (Firefox) |
| Độ trễ tổng hợp 0,3–1 s cho câu đầu / câu mới được Tier-2 dịch | Thấp | Prefetch câu kế tiếp, bỏ qua câu đã quá hạn (`item.end - 0.15`) |

---

## Bước 0: Kiểm chứng thực tế DNR + WebSocket trên Chrome & Firefox (cổng chặn trước khi code)

Mở trang quản lý extension trên **Chrome/Edge** (`chrome://extensions` → Inspect views: `service worker`) và **Firefox** (`about:debugging#/runtime/this-firefox` → Inspect), dán đoạn script sau vào **Console của Background**. Extension dùng để test phải đã có `declarativeNetRequestWithHostAccess` và host permission `https://speech.platform.bing.com/*` (thêm tạm vào manifest nếu cần).

```js
(async () => {
  const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
  const VER = "1-130.0.2849.68";
  const ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
  if (chrome.declarativeNetRequest?.updateDynamicRules) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [9101],
      addRules: [{
        id: 9101,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Origin", operation: "set", value: ORIGIN },
            { header: "User-Agent", operation: "set", value: UA }
          ]
        },
        condition: { urlFilter: "||speech.platform.bing.com/", resourceTypes: ["websocket", "xmlhttprequest", "other"] }
      }]
    }).then(() => console.log("[SPIKE] DNR rule OK"))
      .catch(e => console.warn("[SPIKE] DNR warn:", e));
  } else {
    console.warn("[SPIKE] Không có chrome.declarativeNetRequest");
  }
  let ticks = BigInt(Math.floor(Date.now() / 1000) + 11644473600);
  ticks -= ticks % 300n;
  const raw = `${(ticks * 10000000n).toString()}${TOKEN}`;
  const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const gec = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  const connId = crypto.randomUUID().replace(/-/g, "");
  const ws = new WebSocket(`wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${VER}&ConnectionId=${connId}`);
  ws.binaryType = "arraybuffer";
  let audioBytes = 0;
  const t0 = performance.now();
  ws.onopen = () => {
    const ts = new Date().toISOString();
    ws.send(`X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`);
    ws.send(`X-RequestId:${connId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='vi-VN'><voice name='vi-VN-HoaiMyNeural'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>Xin chào</prosody></voice></speak>`);
  };
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      const hLen = new DataView(e.data).getUint16(0, false);
      const h = new TextDecoder().decode(e.data.slice(2, 2 + hLen));
      if (h.includes("Path:audio")) audioBytes += e.data.byteLength - 2 - hLen;
    } else if (typeof e.data === "string" && e.data.includes("Path:turn.end")) {
      console.log(`[SPIKE OK] MP3 bytes: ${audioBytes}, ${Math.round(performance.now() - t0)} ms`);
      ws.close();
    }
  };
  ws.onerror = (e) => console.error("[SPIKE ERR]", e);
  ws.onclose = (e) => console.log("[SPIKE CLOSE]", e.code, e.reason);
})();
```

**Ghi lại kết quả trước khi sang Bước 1:**

| Trình duyệt | Phiên bản | DNR rule OK | MP3 bytes > 0 | Ghi chú |
|---|---|---|---|---|
| Chrome / Edge | | | | |
| Firefox | | | | |

- Nếu cả hai OK → tiếp tục Bước 1.
- Nếu 1 trình duyệt thất bại (close code 1006/403, 0 byte) → dừng, xác định nguyên nhân (header `Origin` không bị ghi đè? `Sec-MS-GEC-Version` lỗi thời? lệch đồng hồ?) và quyết định: sửa config, chỉ phát hành tính năng này cho trình duyệt hoạt động, hoặc chuyển sang Phase 13b.

---

## Bước 1: Prompt triển khai Background Edge TTS Engine, DNR, Queue & Hợp đồng Port

Copy prompt dưới đây dán vào IDE:

````text
Hãy triển khai Bước 1 của tính năng Lồng tiếng tiếng Việt (Edge Neural TTS) trong thư mục `extension/` theo đúng kiến trúc hiện có (tham chiếu `extension/PLAN-tts.md`).

Trước khi code, hãy đọc các file sau để nắm đúng hợp đồng dữ liệu và quy tắc bất biến:
- `extension/manifest.config.ts`
- `extension/scripts/verify-dist.mjs` (Lưu ý: KHÔNG thêm `credentials: "include"`; chỉ dùng `chrome.*`, không dùng `browser.*`)
- `extension/src/shared/messages.ts` (xác nhận đã có kiểu message `{ type: "cancel", reqId }` từ Content → Background; nếu chưa có thì thêm, nếu có rồi thì dùng lại)
- `extension/src/background/messaging.ts`
- `extension/src/background/index.ts`

Yêu cầu thực hiện chi tiết:

1. Cập nhật `extension/manifest.config.ts`:
   - Thêm `"declarativeNetRequestWithHostAccess"` vào mảng `permissions` (giữ nguyên `"storage"`, `"unlimitedStorage"`).
   - Thêm `"https://speech.platform.bing.com/*"` vào `host_permissions` (KHÔNG thêm `wss://...` vì match pattern của WebExtensions không nhận scheme `wss://`).

2. Mở rộng hợp đồng message trong `extension/src/shared/messages.ts`:
   - Thêm `export type TtsVoice = "vi-VN-HoaiMyNeural" | "vi-VN-NamMinhNeural";`.
   - Thêm vào union `C2B`:
     | { type: "tts.synthesize"; reqId: string; text: string; voice: TtsVoice; rate: string /* "+0%", "+15%", "-10%" */ }
   - Thêm vào union `B2C`:
     | { type: "tts.result"; reqId: string; ok: boolean; audioBase64?: string; mime?: "audio/mpeg"; error?: string }
   - Thêm vào union `UiReq`:
     | { type: "tts.test"; voice: TtsVoice; rate?: string; text?: string }

3. Tạo file mới `extension/src/background/engines/edgeTts.ts` (thuần TypeScript, chỉ dùng Web API chuẩn `WebSocket`, `crypto.subtle`, `TextEncoder`, `TextDecoder`, `DataView`):
   - Tách toàn bộ hằng số cấu hình lên đầu file để dễ bảo trì khi Microsoft nâng phiên bản:
     `export const EDGE_TTS_CONFIG = { TRUSTED_CLIENT_TOKEN: "6A5AA1D4EAFF4E9FB37E23D68491D6F4", SEC_MS_GEC_VERSION: "1-130.0.2849.68", EDGE_ORIGIN: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold", EDGE_UA: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0", WSS_URL: "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1", CLOCK_SYNC_URL: "https://speech.platform.bing.com/", DNR_RULE_ID: 9101, MAX_TEXT_CHARS: 600, MAX_CONCURRENCY: 2 } as const;`
   - Hàm `ensureEdgeTtsHeaderRules(): Promise<void>`:
     - Dùng `chrome.declarativeNetRequest?.updateDynamicRules` với `removeRuleIds: [EDGE_TTS_CONFIG.DNR_RULE_ID]` CÙNG LÚC với `addRules` (không bao giờ lỗi trùng ID khi background khởi động lại).
     - `condition`: `urlFilter: "||speech.platform.bing.com/"`, `resourceTypes: ["websocket", "xmlhttprequest", "other"] as chrome.declarativeNetRequest.ResourceType[]`. Nếu có `chrome.runtime?.id` thì thử kèm `initiatorDomains: [chrome.runtime.id]`; nếu trình duyệt báo lỗi thì fallback gọi lại `updateDynamicRules` không có `initiatorDomains`.
     - Bọc `try/catch`, không bao giờ ném lỗi ra ngoài; ghi `console.warn` khi thất bại.
   - Hàm `generateSecMsGec(nowMs = Date.now(), clockSkewSec = 0): Promise<string>`:
     - `const unixSec = Math.floor(nowMs / 1000) + Math.round(clockSkewSec);`
     - `let ticks = BigInt(unixSec) + 11644473600n;` rồi `ticks -= ticks % 300n;`
     - `const strToHash = `${(ticks * 10000000n).toString()}${EDGE_TTS_CONFIG.TRUSTED_CLIENT_TOKEN}`;`
     - `crypto.subtle.digest("SHA-256", new TextEncoder().encode(strToHash))` → chuỗi HEX IN HOA 64 ký tự.
   - Bù lệch đồng hồ `syncClockSkew()`:
     - Biến module `let cachedClockSkewSec = 0;`.
     - Gọi `fetch(EDGE_TTS_CONFIG.CLOCK_SYNC_URL, { method: "HEAD", credentials: "omit", cache: "no-store" })`, đọc header `Date` (`Date.parse`), đặt `cachedClockSkewSec = Math.round((serverMs - Date.now()) / 1000)`. Nếu fetch lỗi hoặc không có header `Date` thì giữ nguyên giá trị cũ.
   - Hàm `extractAudioFromBinaryFrame(buf: ArrayBuffer): Uint8Array | null`:
     - Kiểm tra `buf.byteLength >= 2`; `const headerLen = new DataView(buf).getUint16(0, false);`.
     - Kiểm tra `buf.byteLength > 2 + headerLen`; giải mã header `new TextDecoder().decode(buf.slice(2, 2 + headerLen))`.
     - Chỉ khi header chứa `"Path:audio"` mới trả về `new Uint8Array(buf, 2 + headerLen)`; ngược lại `null`. Không bao giờ ghép header vào dữ liệu MP3.
   - Hàm `arrayBufferToBase64(bytes: Uint8Array): string` (chống tràn stack):
     ```ts
     let binary = "";
     const chunkSize = 0x8000;
     for (let i = 0; i < bytes.length; i += chunkSize) {
       const sub = bytes.subarray(i, i + chunkSize);
       binary += String.fromCharCode.apply(null, sub as unknown as number[]);
     }
     return btoa(binary);
     ```
   - Hàng đợi giới hạn đồng thời (`MAX_CONCURRENCY = 2`): tối đa 2 WebSocket cùng lúc. Request đang chờ trong hàng đợi mà `signal.aborted` thì loại ngay, không mở WebSocket.
   - Hàm chính `synthesizeEdgeTts(opts: { text: string; voice: TtsVoice; rate: string; signal?: AbortSignal; timeoutMs?: number }): Promise<string>` (timeout mặc định 10.000 ms):
     - Cắt ngắn văn bản nếu vượt `MAX_TEXT_CHARS`, loại ký tự điều khiển `[\x00-\x08\x0B\x0C\x0E-\x1F]`, rồi escape XML (`&`, `<`, `>`, `"`, `'`). Văn bản rỗng sau khi làm sạch thì reject lỗi ngay.
     - Dùng cùng một `X-Timestamp` dạng `new Date().toISOString()` cho cả 2 frame (KHÔNG nối thêm chữ `Z`).
     - `ws.binaryType = "arraybuffer"`. `onopen`: gửi frame `speech.config` (`outputFormat: "audio-24khz-48kbitrate-mono-mp3"`) rồi frame `ssml` (`xml:lang='vi-VN'`).
     - `onmessage`: gom chunk từ `extractAudioFromBinaryFrame`; khi nhận frame text chứa `"Path:turn.end"` thì đóng socket, ghép chunk và trả `arrayBufferToBase64(merged)` (0 byte → reject).
     - Hủy qua `signal`: `ws.close()` ngay và reject với lỗi `AbortError`.
     - Retry: nếu lỗi/đóng bất thường ở lần thử đầu, **chưa nhận byte audio nào**, và KHÔNG do `signal.aborted` → gọi `syncClockSkew()` và thử lại đúng 1 lần với `cachedClockSkewSec` mới; ngược lại ném lỗi (kèm close code trong thông điệp lỗi).

4. Nối vào `extension/src/background/messaging.ts` và `extension/src/background/index.ts`:
   - `index.ts`: gọi `void ensureEdgeTtsHeaderRules();` khi khởi động background.
   - `MessagingHub.handlePortMessage`: thêm `case "tts.synthesize":` tạo `AbortController`, lưu `portInFlight.set(msg.reqId, controller)` (để `{ type: "cancel", reqId }` hoặc đóng tab hủy được cả trong queue lẫn WebSocket đang chạy), gọi `synthesizeEdgeTts`, trả `safePost(port, { type: "tts.result", reqId, ok: true, audioBase64, mime: "audio/mpeg" })` (hoặc `ok: false, error`). Nhớ `portInFlight.delete(reqId)` trong `finally`.
   - `MessagingHub.handleUiMessage`: thêm `case "tts.test":` gọi `synthesizeEdgeTts` với `msg.text || "Xin chào, đây là giọng thuyết minh phụ đề tiếng Việt tự động."` và trả `{ ok: true, latencyMs, audioBase64, mime: "audio/mpeg" }` (lỗi → `{ ok: false, error }`).

5. Viết unit test `extension/tests/edgeTts.test.ts`:
   - `generateSecMsGec` với mốc thời gian cố định và có/không `clockSkewSec` → đúng chuỗi SHA-256 HEX IN HOA 64 ký tự; hai thời điểm trong cùng cửa sổ 5 phút cho cùng kết quả.
   - `extractAudioFromBinaryFrame` cắt đúng header `Path:audio\r\n`, trả `null` với frame không phải audio hoặc frame quá ngắn.
   - `arrayBufferToBase64` với buffer > 100 KB không lỗi `Maximum call stack size exceeded` và giải mã ngược khớp byte gốc.
   - `ensureEdgeTtsHeaderRules` truyền cả `removeRuleIds: [9101]` và `addRules`; fallback khi lần đầu có `initiatorDomains` bị từ chối; không ném lỗi khi không có API.
   - Giả lập `WebSocket`: gửi đủ 2 frame, nhận binary + `Path:turn.end` trả đúng Base64; hủy qua `AbortSignal` đóng socket; retry đúng 1 lần với `syncClockSkew` khi lỗi trước khi có audio; KHÔNG retry khi đã nhận audio hoặc đã abort.

Chạy `pnpm typecheck`, `pnpm test`, `pnpm build` trong `extension/` và đảm bảo tất cả đều pass.
````

---

## Bước 2: Prompt triển khai Settings, `DubbingManager` (Web Audio API + Real Duration Sync) & Tích hợp `Session`

Sau khi Bước 1 hoàn tất và pass toàn bộ test, copy tiếp prompt Bước 2:

````text
Tiếp theo Bước 2: Hãy thêm cấu hình `tts` vào `Settings`, xây dựng `DubbingManager` sử dụng Web Audio API (`AudioContext.decodeAudioData`) ở Content Script và tích hợp vào `Session` (`extension/src/content/pipeline/session.ts`).

Trước khi code, hãy đọc kỹ các file sau:
- `extension/src/shared/settings.ts`
- `extension/src/content/pipeline/session.ts`
- `extension/src/content/port.ts`
- `extension/src/shared/types.ts`

Yêu cầu thực hiện chi tiết:

1. Cập nhật `extension/src/shared/settings.ts`:
   - Mở rộng interface `Settings` và `DEFAULT_SETTINGS`:
     ```ts
     tts: {
       enabled: boolean; // mặc định: false (BẮT BUỘC để không ảnh hưởng hành vi mặc định và test cũ)
       voice: "vi-VN-HoaiMyNeural" | "vi-VN-NamMinhNeural"; // mặc định: "vi-VN-HoaiMyNeural"
       rateOffset: number; // mặc định: 0 (đơn vị %, -20..50, tốc độ cơ sở khi tổng hợp)
       ttsVolume: number; // mặc định: 1.0 (0.1..1.0)
       duckingVolume: number; // mặc định: 0.2 (âm lượng video gốc khi đang đọc, 0.0..1.0)
     };
     ```
   - Thêm vào `SETTING_LIMITS`: `"tts.rateOffset": [-20, 50]`, `"tts.ttsVolume": [0.1, 1]`, `"tts.duckingVolume": [0, 1]`.
   - Cập nhật `sanitizeSettings`: chuẩn hóa `s.tts` (boolean `enabled`, enum `voice`, `rateOffset` kẹp rồi làm tròn bội số 5: `Math.round(clampSetting("tts.rateOffset", s.tts?.rateOffset, d.tts.rateOffset) / 5) * 5`, và làm tròn 2 chữ số thập phân cho `ttsVolume`, `duckingVolume`). Settings cũ không có `tts` phải được điền bằng mặc định.

2. Tạo class `DubbingManager` tại `extension/src/content/tts/dubbingManager.ts`:
   - Constructor: `(video: HTMLVideoElement, port: BackgroundPort, settings: Settings, opts?: { onStatusNotice?: (msg: string) => void; createAudioContext?: () => AudioContext })`.
   - **Giải mã & phát bằng Web Audio API (không dùng `new Audio(blobUrl)`):**
     - Khởi tạo lười `AudioContext` + `GainNode` chính (`gainNode.connect(audioCtx.destination)`) chỉ khi `settings.tts.enabled === true` và có câu cần đọc. Khi `tts.enabled` tắt, `close()` context để giải phóng tài nguyên.
     - Cập nhật `gainNode.gain.value = settings.tts.ttsVolume` mỗi khi bắt đầu đọc và khi `updateSettings` đổi `ttsVolume`.
     - Giải mã `audioBase64` → `ArrayBuffer` → `await audioCtx.decodeAudioData(arrayBuffer)`. LƯU Ý: `decodeAudioData` làm detach buffer đầu vào, nên luôn truyền vào một bản sao (`bytes.buffer.slice(0)`) nếu còn cần dùng lại bytes.
   - **LRU Cache `AudioBuffer` (tối đa 60 câu) + Dedup in-flight:**
     - `rate` gửi Background chỉ phụ thuộc `settings.tts.rateOffset` qua `formatRateOffset(offset: number): string` (`Math.round(offset / 5) * 5`, trả `"+15%"`, `"+0%"`, `"-10%"`). Key cache: `${voice}|${rateStr}|${cleanText}` — không phụ thuộc `video.playbackRate`.
     - `inFlight = new Map<string, { reqId: string; promise: Promise<AudioBuffer | null> }>()`: nếu câu đang được prefetch mà video đã tới câu đó thì `await` Promise đang bay thay vì gửi request thứ hai.
     - `AudioBuffer` gắn với `AudioContext` đã giải mã nó: khi `AudioContext` bị đóng/tạo lại thì PHẢI xóa sạch cache và `inFlight`.
   - **Đo `audioBuffer.duration` thật để cân chỉnh `sourceNode.playbackRate.value`:**
     - Sau khi có `AudioBuffer`, lấy `nowPlayhead`. Nếu `nowPlayhead >= item.end - 0.15` thì **bỏ qua không phát** (câu đã quá hạn).
     - `const remainingCueSec = Math.max(0.4, (item.end - Math.max(item.start, nowPlayhead)) / Math.max(0.25, video.playbackRate || 1));`
     - `const neededRate = audioBuffer.duration > remainingCueSec ? audioBuffer.duration / remainingCueSec : 1.0;`
     - `const finalPlaybackRate = Math.min(1.45, Math.max(1.0, Math.round(neededRate * 100) / 100));` rồi gán `sourceNode.playbackRate.value = finalPlaybackRate`.
     - Khi `ratechange` của `<video>` xảy ra giữa lúc đang đọc, tính lại theo `video.playbackRate` mới và cập nhật trực tiếp lên `activeSourceNode.playbackRate.value`.
   - **Chính sách chồng chéo (cắt cũ, ưu tiên mới):** khi cue mới (`item.id !== activeCueId`) tới hạn và đã dịch xong (`item.translated && item.target_text.trim()`), nếu `activeSourceNode` của câu trước còn phát thì gọi `stopActiveSource()` ngay để phát câu mới.
   - **Chống đọc lặp khi dịch 2 tầng (`lastSpokenCueId`):**
     - Ở chế độ `hybrid`: tầng 1 (GTX/DeepL) dịch xong bật `item.translated = true` kèm `engine: "api"`; vài giây sau tầng 2 (Gemini) ghi đè `target_text` lên cùng `item.id` với `engine: "cloud"`.
     - Ngay khi câu `item.id` được yêu cầu đọc lần đầu (bản `api` hay `cloud`), gán `this.lastSpokenCueId = item.id`; cập nhật bản dịch cho cùng `item.id` sau đó thì **không đọc lại**.
     - Nếu lúc cue xuất hiện mà `item.translated === false`, chưa gán `lastSpokenCueId`; ngay khi `setItems()` làm `item.translated === true` và playhead còn trong `[item.start, item.end - 0.2]` thì đọc câu đó.
   - **Pause & Resume giữa câu:**
     - `pause`: nếu đang có `activeSourceNode` và `audioCtx.state === "running"` thì `void audioCtx.suspend()` và khôi phục `video.volume` gốc. KHÔNG xóa `lastSpokenCueId`.
     - `play` / `playing`: nếu vẫn trong cùng `activeCueId` và `audioCtx.state === "suspended"` thì hạ lại ducking và `void audioCtx.resume()`.
   - **Autoplay Policy:** trước `sourceNode.start(0)`, nếu `audioCtx.state === "suspended"` thì `await audioCtx.resume()`. Nếu bị chặn, báo 1 lần `onStatusNotice?.("Nhấp vào vùng video để mở khóa âm thanh lồng tiếng")` và đăng ký listener `{ once: true }` trên `pointerdown` / `keydown` của `document` để tự `resume()`.
   - **Audio Ducking an toàn:**
     - Khi bắt đầu phát: lưu `savedVideoVolume = video.volume` (nếu chưa duck) và `video.volume = Math.min(video.volume, settings.tts.duckingVolume)` với cờ `isApplyingDucking = true` quanh dòng gán.
     - `volumechange` khi `!isApplyingDucking` (người dùng tự chỉnh) → cập nhật `savedVideoVolume = video.volume`.
     - Khôi phục `video.volume = savedVideoVolume` rồi xóa `savedVideoVolume` khi: `sourceNode.onended` (và không có câu mới bắt đầu trong 250 ms), `pause`, `seeking`, tắt `tts.enabled`, `dispose()`.
   - **Error Cooldown:** đếm `consecutiveErrors`; đạt 3 lần liên tiếp thì tạm ngưng gọi TTS 30 giây và báo `onStatusNotice?.("Lồng tiếng tạm ngưng 30s do lỗi kết nối Edge TTS")`. Gọi thành công thì reset về 0.
   - **Lookahead Prefetch:** khi đang ở `item.id`, prefetch ngầm tối đa 2 câu kế tiếp đã dịch xong (`it.id > item.id && it.translated && it.target_text.trim()`), không phát ra loa.

3. Tích hợp vào `extension/src/content/pipeline/session.ts`:
   - Khởi tạo `this.dubbing` khi có `this.opts.port`, với `onStatusNotice: (msg) => this.store.flashToast(msg)`; đăng ký `this.disposer.add(() => this.dubbing?.dispose())`.
   - Trong `Session.tick()`: nếu `item !== this.lastShown` HOẶC (`item !== null && this.lastShown !== null && !this.lastShown.translated && item.translated`) thì cập nhật `this.lastShown = item`, `this.store.setState({ item })` và gọi `this.dubbing?.onCueTick(t, item, this.items)`.
   - `Session.onSettingsChanged(newSettings)`: gọi `this.dubbing?.updateSettings(newSettings)`.
   - `Session.bindVideoEvents()`: nối `play`, `playing`, `pause`, `ended`, `seeking`, `seeked`, `ratechange`, `volumechange`, `visibilitychange` vào các hàm tương ứng của `this.dubbing`.

4. Viết unit test `extension/tests/dubbingManager.test.ts` (giả lập `AudioContext`, `GainNode`, `AudioBufferSourceNode`):
   1) Giải mã `audioBase64` qua `decodeAudioData` (nhận bản sao buffer), gán đúng `gainNode.gain.value = settings.tts.ttsVolume`.
   2) `audioBuffer.duration = 4.0s`, `remainingCueSec = 3.0s` → `playbackRate.value = 1.33`; đổi `video.playbackRate` giữa chừng cập nhật theo; trần 1.45.
   3) Cache: cùng câu + giọng + rate không gửi `tts.synthesize` lần 2; dedup in-flight giữa prefetch và phát; xóa cache khi `AudioContext` bị tạo lại.
   4) Chống đọc lặp Hybrid (`api` → `cloud` trên cùng `item.id`) và đọc bù khi `translated` chuyển `false` → `true` giữa cue.
   5) `pause` gọi `audioCtx.suspend()` + trả `video.volume`; `play` trong cùng cue gọi `resume()` + hạ lại volume, không gọi lại `tts.synthesize`.
   6) `seeking`/`seeked` dừng `activeSourceNode`, hủy request bay qua `port.cancel(reqId)`, reset `lastSpokenCueId`.
   7) `audioCtx.resume()` bị từ chối không làm crash, gọi `onStatusNotice`.
   8) Câu đã quá hạn (`playhead >= item.end - 0.15`) không được phát.
   9) Ducking hạ `video.volume` xuống `0.2` khi bắt đầu đọc và khôi phục `1.0` khi đọc xong / `dispose()`; người dùng tự đổi volume trong lúc duck thì giá trị khôi phục là giá trị mới.
   10) Chồng chéo: cue mới cắt câu đang đọc dở; 3 lỗi liên tiếp kích hoạt cooldown 30 s.
   11) Prefetch tải trước câu kế tiếp đã dịch, bỏ qua câu chưa dịch.

Chạy `pnpm typecheck`, `pnpm test`, `pnpm build` và đảm bảo toàn bộ test cũ + mới đều xanh.
````

---

## Bước 3: Prompt tích hợp UI (`MiniToolbar`, `Popup`, `Options`), Phím tắt & Quyền riêng tư

Sau khi Bước 2 pass toàn bộ test, copy tiếp prompt Bước 3:

````text
Tiếp theo Bước 3: Hãy bổ sung điều khiển Lồng tiếng tiếng Việt (Auto Dubbing) lên `MiniToolbar` (trên video), `Popup`, `Options`, phím tắt bàn phím, và cập nhật tài liệu quyền riêng tư / khai báo store.

Trước khi code, hãy đọc các file sau:
- `extension/src/content/overlay/store.ts`
- `extension/src/content/overlay/OverlayApp.tsx`
- `extension/src/content/overlay/MiniToolbar.tsx`
- `extension/src/content/index.ts`
- `extension/src/popup/Popup.tsx`
- `extension/src/options/Options.tsx`
- `extension/scripts/zip.mjs` (nơi tiêm `browser_specific_settings.gecko` cho bản đóng gói Firefox AMO)
- `PRIVACY_POLICY.md`

Yêu cầu thực hiện chi tiết:

1. Thanh công cụ nổi trên video (`MiniToolbar.tsx`, `OverlayApp.tsx`, `mount.ts`, `store.ts`, `src/content/index.ts`):
   - Thêm `ttsEnabled?: boolean` vào `OverlayState` trong `store.ts` (mặc định `false`), đồng bộ từ `this.settings.tts.enabled` trong `ContentController`.
   - Thêm callback `onToggleTts?: () => void` truyền `ContentController` → `OverlayHost` (`mount.ts`) → `OverlayApp` → `MiniToolbar`.
   - `MiniToolbar.tsx`: thêm nút bật/tắt nhanh (icon `Volume2` khi bật, `VolumeX` khi tắt từ `lucide-react`), sáng màu khi `ttsEnabled === true`. Trong bảng phím tắt (`showShortcutsHelp`) thêm dòng `D`: `"Bật/tắt thuyết minh tiếng Việt"`.
   - `ContentController`: khi bấm nút hoặc nhấn phím `D` (chỉ khi `this.settings.shortcuts?.enabled`, có `this.session && this.store?.getState().hasTrack`, không giữ `Ctrl/Alt/Meta/Shift`, và `!isTypingEvent(e)`): đảo `settings.tts.enabled` qua `saveSettings({ tts: { ...this.settings.tts, enabled: next } })` và `store.flashToast(next ? "Thuyết minh: Bật" : "Thuyết minh: Tắt")`. Kiểm tra phím `D` không xung đột với phím tắt hiện có của extension.

2. `Popup.tsx` và `Options.tsx` — khu vực **"Thuyết minh tiếng Việt (Edge Neural TTS)"**:
   - Công tắc Bật/Tắt (`settings.tts.enabled`).
   - Dropdown giọng đọc: `vi-VN-HoaiMyNeural` — Nữ (Hoài Mỹ - Tự nhiên); `vi-VN-NamMinhNeural` — Nam (Nam Minh - Trầm ấm).
   - Nút **"🔊 Nghe thử"**: gửi `{ type: "tts.test", voice, rate }` qua `chrome.runtime.sendMessage`, nhận `audioBase64`, phát qua `AudioContext.decodeAudioData` (trên trang extension), hiển thị độ trễ (ms) hoặc thông báo lỗi rõ ràng.
   - Thanh trượt **Âm lượng giọng đọc** (`ttsVolume`, 10%–100%).
   - Thanh trượt **Âm lượng video gốc khi đang đọc** (`duckingVolume`, 0%–100%, mặc định 20%).
   - Thanh trượt **Tốc độ đọc cơ sở** (`rateOffset`, -20% đến +50%, bước 5%, mặc định 0% — tự động tăng tốc khi câu dài).
   - Ghi chú minh bạch: *"Khi bật thuyết minh, văn bản phụ đề tiếng Việt sẽ được gửi tới dịch vụ Microsoft Edge Read Aloud (speech.platform.bing.com) để tổng hợp giọng nói. Đây là dịch vụ không chính thức, có thể ngừng hoạt động bất cứ lúc nào."*
   - Mọi thay đổi gọi `updateSettings(...)` từ hook `useSettings()` có sẵn để đồng bộ real-time xuống tab video qua `chrome.storage.onChanged`.

3. Cập nhật `PRIVACY_POLICY.md` (thư mục gốc): thêm mục ngắn nêu rõ khi người dùng chủ động bật Thuyết minh (TTS), chỉ văn bản phụ đề tiếng Việt cần đọc được gửi tới `speech.platform.bing.com` của Microsoft để tổng hợp giọng nói; không gửi định danh cá nhân; tính năng mặc định tắt.

4. Khai báo cho store:
   - Kiểm tra phần `browser_specific_settings.gecko.data_collection_permissions` trong `extension/scripts/zip.mjs` (LƯU Ý: KHÔNG đặt `browser_specific_settings` vào `manifest.config.ts` để tránh Chrome báo warning manifest key không hợp lệ; repo đang tiêm `browser_specific_settings` riêng cho gói Firefox tại `scripts/zip.mjs`). Giữ tương thích với cấu hình AMO hiện có và đảm bảo `verify-dist.mjs` vẫn xanh.
   - Cập nhật `README.md` / mô tả store: nêu tính năng thuyết minh, dịch vụ Microsoft được dùng và việc mặc định tắt.

5. Kiểm tra toàn diện:
   - Chạy `pnpm typecheck`, `pnpm test`, `pnpm build` trong `extension/`; tùy chọn `pnpm zip`.
   - Toàn bộ test cũ và mới trong `extension/tests/` xanh 100% và `scripts/verify-dist.mjs` báo `[verify-dist] OK`.
   - Kiểm thử thủ công trên Chrome và Firefox: bật/tắt bằng nút và phím `D`, nghe thử, pause/resume giữa câu, tua video, đổi tốc độ video, trang có CSP chặt.
````
