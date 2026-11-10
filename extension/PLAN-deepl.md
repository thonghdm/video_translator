# Phase 12: DeepL API Free làm engine dự phòng cho Google Translate (GTX)

> Phụ lục của `PLAN.md`. **Agent đọc theo thứ tự:** `PLAN.md` §3 (quy tắc bất biến) → `PLAN-drive-sidecar.md` §0 (luật làm việc: chỉ sửa file được liệt kê, không sửa expect test cũ, không log key/nội dung) → file này §0–§5 → phase đang làm.
> **[T]** = phải kiểm chứng bằng key thật trước khi code phần phụ thuộc. Kết quả ghi vào `NOTES.md`.
> Bối cảnh: endpoint token Edge (`edge.microsoft.com/translate/auth`) đã chết (404, kiểm chứng 10/11/2026). Azure/Cerebras đòi thẻ; OpenRouter free chỉ 50 request/ngày. DeepL API Free: 500.000 ký tự/tháng, có tiếng Việt (`VI`), người dùng đã tạo được key không cần thẻ.

---

## 0. Mục tiêu và quyết định thiết kế

**Mục tiêu.** Khi GTX bị chặn (429, breaker mở) hoặc lỗi phía Google, tầng dịch máy **tự chuyển sang DeepL** thay vì đứng chờ đếm ngược hoặc phải có Gemini. Chuỗi mới:

```
Tầng "api" (dịch máy):  GTX ──lỗi (không phải mạng)──► DeepL      (hoặc ngược lại nếu bật "Ưu tiên DeepL")
Tầng "cloud":           Gemini (giữ nguyên)
```

**Quyết định quan trọng — DeepL nằm TRONG tầng `api`, KHÔNG thêm `EngineId` mới.**

| | Thêm `EngineId = "deepl"` | **DeepL bên trong tầng `api` (CHỌN)** |
|---|---|---|
| File phải sửa | `types.ts`, router `planTiers`, khóa cache `engineKey`, `pickCachedLine`, scheduler (luật upgrade `engine === "api"`), overlay (màu chấm), popup đếm `byEngine`, `TabStatus`, test của tất cả | `router.ts` (1 hàm), engine mới, settings, popup/options, state |
| Rủi ro hồi quy | Cao (cache cũ, hybrid upgrade, overlay) | Thấp: content script **không đổi** |
| Nhược | — | Popup/overlay không phân biệt dòng GTX với dòng DeepL (cùng là "dịch máy", cùng chấm xanh lá); cache cụm từ/IndexedDB dùng chung khóa `api` |

Hệ quả cần chấp nhận (ghi vào README): dòng do DeepL dịch hiển thị như "Google/dịch máy"; chế độ hybrid vẫn nâng cấp các dòng `api` (kể cả dòng DeepL) lên Gemini như cũ.

**Không đổi manifest.** `host_permissions` đã có `<all_urls>` → gọi `api-free.deepl.com` / `api.deepl.com` từ service worker không cần quyền mới. **Không** thêm dòng nào vào `manifest.config.ts`.

**Key DeepL** được bảo vệ y như key Gemini (PLAN §3.4): lưu riêng trong `chrome.storage.local` (`deeplApiKey`), không bao giờ gửi xuống content script, chỉ gửi trong header `Authorization: DeepL-Auth-Key …`, che key trong mọi thông báo lỗi, mọi fetch đi qua `apiFetch()` (`credentials:"omit"`).

---

## 1. Hợp đồng DeepL API dùng trong phase này

- Endpoint: key kết thúc `:fx` → `https://api-free.deepl.com`, ngược lại → `https://api.deepl.com`.
- Dịch: `POST /v2/translate`, header `Authorization: DeepL-Auth-Key <key>`, `Content-Type: application/json`, body:
  ```json
  { "text": ["line 1", "line 2"], "target_lang": "VI", "source_lang": "EN",
    "split_sentences": "nonewlines", "preserve_formatting": true }
  ```
  - `source_lang` chỉ gửi khi `srcLang` khác `"auto"` (viết HOA, cắt phần vùng: `en-US` → `EN`).
  - Có gửi `model_type` hay không: theo kết quả **[T] G0-3**.
  - Phản hồi: `{ "translations": [ { "detected_source_language": "EN", "text": "…" }, … ] }` — số phần tử **phải** bằng số `text` gửi đi, đúng thứ tự.
- Hạn mức: `GET /v2/usage` → `{ "character_count": n, "character_limit": m }`.
- Giới hạn mỗi request: tối đa **50** chuỗi `text`, body ≤ **128 KiB** → engine tự chia lô.
- Mã HTTP → lỗi nội bộ (`engines/errors.ts`):

| HTTP | Ý nghĩa | Lỗi ném ra | Breaker |
|---|---|---|---|
| 200 | OK (đúng số phần tử) | — | `ok` |
| 200 nhưng số phần tử sai / JSON hỏng | | `InvalidResponseIdsError` | `other` |
| 400, 413 | Yêu cầu sai / quá lớn | `Error` thường | `other` |
| 401, 403 | Key sai / bị thu hồi | `DisabledError("DeepL: key không hợp lệ")` | **không** report (không phải lỗi tạm thời) |
| 429 | Gọi quá nhanh | `RateLimitedError(retryAfter từ header Retry-After, mặc định 5 s)` | `blocked` |
| 456 | Hết hạn mức tháng | `DeepLQuotaError` (kế thừa `RateLimitedError`, `retryAfterMs = 6 giờ`) | `blocked` |
| 5xx, 529 | Lỗi máy chủ | `Error` thường | `other` |
| `TypeError` của fetch | Mất mạng | `NetworkError` | `network` |
| Abort | Hủy / timeout | `CanceledError` (hủy) / `Error("timeout")` | `canceled` / `other` |

---

## 2. Quy tắc dự phòng trong tầng `api` (router)

Hàm mới `viaMachine(lines, srcLang, isTier1, signal)` thay cho lời gọi `viaGoogle` trong vòng lặp tầng:

1. Thứ tự: `settings.deepl.prefer ? [deepl, gtx] : [gtx, deepl]`. Bỏ `deepl` khỏi danh sách nếu **chưa có key** hoặc **`settings.deepl.enabled === false`**.
2. Thử lần lượt. Engine trả kết quả → trả ngay (đủ `lines.length` phần tử).
3. Engine ném lỗi:
   - `CanceledError` / `signal.aborted` → ném lại ngay, không thử engine sau.
   - `NetworkError` → ném lại ngay (engine kia cũng cần mạng; router hiện có `skipCloud` sẽ xử lý như cũ).
   - Lỗi khác (`RateLimitedError`, `DeepLQuotaError`, `DisabledError`, lỗi HTTP…) → ghi nhớ rồi thử engine tiếp theo.
4. Tất cả đều lỗi → ném lỗi **có ích nhất cho content**: ưu tiên `RateLimitedError` có `retryAfterMs` **nhỏ nhất** (để đếm ngược đúng lúc engine sớm mở lại nhất); không có thì ném lỗi của engine đầu tiên.
5. DeepL có **breaker riêng** (`deeplBreaker`) và **hàng đợi riêng** (`new GtxQueue(1, 250)` — dùng lại class hiện có, đặt tên biến `deeplQueue`). Kiểm tra breaker **ngay trước khi gọi HTTP**, đúng mẫu `viaGoogle` hiện có (xin `allow()` sau khi đã có chỗ trong hàng đợi; report kết quả; probe half-open).
6. Kết quả DeepL vẫn gắn `engine: "api"` và vẫn ghi vào cache cụm từ `api|…` (như GTX).

**Bất biến:** khi không có key DeepL, hành vi router phải **giống hệt trước Phase 12** (mọi test router cũ xanh, không sửa expect).

---

## 3. Settings, lưu key, hợp đồng message

`src/shared/settings.ts`:
```ts
deepl: {
  apiKey: string;     // "" — LƯU RIÊNG tại "deeplApiKey" (như geminiApiKey), blob settings luôn ghi ""
  enabled: boolean;   // true — có key + enabled mới dùng
  prefer: boolean;    // false — true: DeepL trước, GTX sau (tốn hạn mức 500K/tháng nhanh)
}
```
- `loadSettings({ includeApiKey })`: `includeApiKey === false` (content script) → `deepl.apiKey = ""` (giống Gemini). Đọc cả `geminiApiKey` lẫn `deeplApiKey` trong **một** lần `storage.local.get`.
- `saveSettings(partial)`: `partial.deepl?.apiKey !== undefined` → ghi `deeplApiKey` (đã trim) trong **cùng một** lần `storage.local.set` với blob (giữ quy tắc "1 sự kiện onChanged").
- `onSettingsChanged`: lắng nghe thêm thay đổi `deeplApiKey`.
- `sanitizeSettings`: ép kiểu boolean cho `enabled`/`prefer`; `apiKey` là string đã trim.

`src/shared/messages.ts` (chỉ **thêm**):
```ts
// UiReq
| { type: "deepl.test"; apiKey: string }
// Kết quả "deepl.test": { ok: true; latencyMs: number; used: number; limit: number; sample: string } | { ok: false; error: string }
// Kết quả "status" (UiReq) và B2C "status": thêm trường TÙY CHỌN
breakers: { api: BreakerView; cloud: BreakerView; deepl?: BreakerView }
```

`src/background/state.ts`: `SessionState` thêm `deeplBreaker?: BreakerSnapshot`; `StateManager` nhận thêm tham số **cuối, không bắt buộc** `deeplBreaker?: CircuitBreaker`.

---

## Phase G0: Kiểm chứng key DeepL thật [T] (người dùng tự chạy — KHÔNG gửi key cho AI)

**Được sửa:** `NOTES.md` (mục "Phase 12 – G0").

Mở `chrome://extensions` → SubTrans → "service worker" → Console, dán (thay `KEY`):

```js
const KEY = "dán-key-vào-đây"; // KHÔNG chia sẻ key này với ai
const BASE = KEY.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
const H = { "Authorization": "DeepL-Auth-Key " + KEY, "Content-Type": "application/json" };
const lines = ["Welcome back to the course.", "In this lecture we will install the AWS CLI.", "Amazon S3 is an object storage service."];
const run = async (extra) => { const t = performance.now(); const r = await fetch(BASE + "/v2/translate", { method: "POST", headers: H, body: JSON.stringify({ text: lines, target_lang: "VI", source_lang: "EN", split_sentences: "nonewlines", preserve_formatting: true, ...extra }) }); const j = await r.json().catch(() => null); return { status: r.status, ms: Math.round(performance.now() - t), n: j?.translations?.length, out: j?.translations?.map(x => x.text) ?? j }; };
console.log("G0-1 usage", await (await fetch(BASE + "/v2/usage", { headers: H })).json());
console.log("G0-2 translate", await run({}));
console.log("G0-3 quality_optimized", await run({ model_type: "quality_optimized" }));
console.log("G0-4 50 dòng", (await (await fetch(BASE + "/v2/translate", { method: "POST", headers: H, body: JSON.stringify({ text: Array.from({ length: 50 }, (_, i) => `Line ${i}: hello world`), target_lang: "VI" }) })).json()).translations?.length);
```

Ghi vào NOTES (**không ghi key**):

| # | Câu hỏi | Kết quả |
|---|---|---|
| G0-1 | `/v2/usage` trả `character_limit` bao nhiêu? | |
| G0-2 | Dịch sang `VI` không có `model_type`: status, độ trễ, câu dịch có hợp lý? | |
| G0-3 | Có `model_type: "quality_optimized"`: status (200 hay 400?), chất lượng có khác? | |
| G0-4 | Gửi 50 dòng trong 1 request: nhận đủ 50? | |

**Cổng quyết định:**
- G0-2 lỗi (403 / 400 "target_lang not supported") → **DỪNG Phase 12**, báo lại.
- G0-3 = 200 và dịch tốt hơn → engine gửi `model_type: "quality_optimized"`. G0-3 = 400 → **không** gửi `model_type`.

**Commit:** `docs(extension): phase 12 G0 - deepl key verification`

---

## Phase G1: Engine DeepL (thuần, có test)

**Được sửa:** `src/background/engines/deepl.ts` (mới), `src/background/engines/errors.ts` (chỉ **thêm** class `DeepLQuotaError`), `tests/deepl.test.ts` (mới).

**API:**
```ts
export const DEEPL_MAX_TEXTS = 50;
export const DEEPL_MAX_BODY_BYTES = 120 * 1024; // chừa biên dưới 128 KiB
export const DEEPL_TIMEOUT_MS = 8000;
export const DEEPL_SEND_MODEL_TYPE: boolean;    // theo G0-3
export function deeplBaseUrl(apiKey: string): string;            // ":fx" → api-free
export function toDeepLSourceLang(srcLang: string): string | undefined; // "auto"/"" → undefined; "en-US" → "EN"
export function chunkForDeepL(lines: string[]): string[][];      // ≤ 50 phần tử, ≤ DEEPL_MAX_BODY_BYTES (đo bằng TextEncoder trên JSON)
export class DeepLEngine {
  constructor(cfg: { apiKey: string }, fetchFn?: typeof fetch);
  updateKey(apiKey: string): void;
  hasKey(): boolean;
  translateLines(lines: string[], srcLang: string, signal?: AbortSignal): Promise<string[]>; // đủ lines.length phần tử
  static testConnection(apiKey: string, fetchFn?: typeof fetch): Promise<{ ok: true; latencyMs: number; used: number; limit: number; sample: string } | { ok: false; error: string }>;
}
export class DeepLQuotaError extends RateLimitedError {} // trong errors.ts, retryAfterMs mặc định 6 giờ
```

**Bắt buộc:**
- Mọi request đi qua `apiFetch()` (ép `credentials:"omit"`), timeout bằng `createTimeoutSignal`, `cleanup()` trong `finally`; gộp `signal` của người gọi (hủy → `CanceledError`).
- Ánh xạ HTTP → lỗi **đúng bảng §1**. Thông báo lỗi đi qua `sanitizeApiKey(msg, apiKey)` (đã có trong `gemini.ts`; **import** dùng lại, không sao chép).
- Dòng rỗng / chỉ khoảng trắng: **không gửi** lên DeepL (không tốn hạn mức), trả `""` đúng vị trí.
- Chia lô theo `chunkForDeepL`, gọi **tuần tự** từng lô, ghép kết quả đúng thứ tự gốc. Một lô lỗi → ném lỗi (không trả kết quả nửa vời).
- `testConnection`: gọi `/v2/usage` rồi dịch 1 câu "Hello world" → trả `used/limit/sample/latencyMs`.
- **Không** `console.*` nào in key, text gửi đi hoặc text nhận về.

**Test bắt buộc** (`tests/deepl.test.ts`, mock `fetchFn`):
1. `deeplBaseUrl`: `abc:fx` → api-free; `abc` → api.
2. `toDeepLSourceLang`: `auto`, `""`, `en`, `en-US`, `EN`.
3. Body gửi đi đúng JSON §1 (target `VI`, `split_sentences`, `preserve_formatting`, có/không `source_lang`, có/không `model_type` theo hằng); header đúng `DeepL-Auth-Key`; `credentials` là `"omit"`.
4. 3 dòng → 3 bản dịch đúng thứ tự.
5. Có dòng rỗng ở giữa → không có trong body, kết quả trả `""` đúng chỗ.
6. 120 dòng → 3 request (50/50/20), kết quả ghép đúng thứ tự.
7. Dòng rất dài → `chunkForDeepL` tách theo byte.
8. Từng mã HTTP trong bảng §1 → đúng lớp lỗi (`it.each`); 429 đọc `Retry-After`; 456 → `DeepLQuotaError` với `retryAfterMs` 6 giờ.
9. Số phần tử phản hồi sai → `InvalidResponseIdsError`.
10. `TypeError` → `NetworkError`; abort → `CanceledError`; timeout → lỗi timeout.
11. Thông báo lỗi chứa key → đã bị che.
12. `testConnection` OK và lỗi 403.

**Commit:** `feat(extension): phase 12 G1 - deepl engine`

---

## Phase G2: Settings + lưu key + hợp đồng message

**Được sửa:** `src/shared/settings.ts`, `src/shared/messages.ts`, `src/background/state.ts`, `tests/settings.test.ts` (chỉ **thêm** case), `tests/deeplSettings.test.ts` (mới).

**Việc cần làm:** đúng §3.

**Bẫy cần tránh:**
- `includeApiKey: false` phải xóa **cả** `gemini.apiKey` lẫn `deepl.apiKey`.
- Blob `settings` lưu trong storage **không bao giờ** chứa key DeepL (luôn `""`).
- Settings cũ không có `deepl` → `{ apiKey: "", enabled: true, prefer: false }`.
- Đổi key DeepL phải phát đúng **1** sự kiện `onChanged` (ghi chung 1 lần `set`).
- `StateManager`: tham số mới ở **cuối**, không bắt buộc; `restore()` bỏ qua snapshot DeepL nếu không có breaker.

**Test bắt buộc:**
- Mặc định; blob cũ không có `deepl`; sai kiểu → mặc định.
- Lưu `deepl.apiKey` → nằm ở `deeplApiKey`, blob có `""`; `setCalls` đúng 1 lần.
- `loadSettings({ includeApiKey: false })` → cả 2 key rỗng.
- Đổi `deeplApiKey` → `onSettingsChanged` được gọi.
- `StateManager` lưu/khôi phục snapshot `deeplBreaker`; không truyền breaker → không lỗi.

**Commit:** `feat(extension): phase 12 G2 - deepl settings and contracts`

---

## Phase G3: Nối DeepL vào router + service worker

**Được sửa:** `src/background/router.ts`, `src/background/index.ts`, `src/background/messaging.ts` (chỉ `status` + case `deepl.test`), `tests/routerDeepl.test.ts` (mới), `tests/phase2-messaging.test.ts` (chỉ **thêm** case).

**Việc cần làm:**
1. `TranslationRouter` nhận thêm tham số **cuối, không bắt buộc**:
   ```ts
   deepl?: { engine: DeepLEngine; breaker: CircuitBreaker; queue: GtxQueue; getPrefs: () => { enabled: boolean; prefer: boolean } }
   ```
   Test cũ gọi constructor theo vị trí → **không chèn vào giữa**.
2. Tách `viaGoogle` thành `callGtx(...)` (giữ nguyên nội dung) + thêm `callDeepL(...)` (cùng mẫu: `queue.run` → `breaker.allow()` → gọi engine → `report`), rồi `viaMachine(...)` theo **§2**. Vòng lặp tầng gọi `viaMachine` cho `tier.id === "api"`.
3. `DisabledError` từ DeepL (key sai) **không** report breaker.
4. `index.ts` (SW, top-level, đồng bộ):
   - Tạo `deeplEngine` (key rỗng), `deeplBreaker = new CircuitBreaker()`, `deeplQueue = new GtxQueue(1, 250)`, `deeplPrefs`.
   - Truyền vào router và `StateManager`.
   - Trong `applySettings`: `deeplEngine.updateKey(s.deepl.apiKey)`, cập nhật `deeplPrefs`.
   - `init()` đọc settings bằng `loadSettings()` (có key) như hiện tại.
5. `messaging.ts`:
   - `status` (UiReq và B2C `status`): thêm `deepl: { blocked, until }` khi có breaker.
   - Case `deepl.test` → `DeepLEngine.testConnection(msg.apiKey)`.
   - `MessagingHub` nhận `deeplBreaker?` ở **cuối** constructor.

**Bẫy cần tránh:**
- Không có key DeepL → `viaMachine` phải đi đúng đường cũ: lỗi GTX ném ra **nguyên vẹn** (cùng lớp, cùng `retryAfterMs`). Test router cũ không sửa expect.
- GTX lỗi mạng → **không** gọi DeepL.
- Breaker GTX đang mở → `callGtx` ném `RateLimitedError` ngay (không gọi HTTP) → DeepL được gọi → **đây là lợi ích chính của phase**.
- Cả hai bị chặn → content nhận `blocked` với `retryAfterMs` nhỏ nhất.
- `phraseCache`: kết quả DeepL ghi `api|<dòng>` như GTX.
- Không đổi `planTiers` (DeepL không phải tầng).

**Test bắt buộc** (`routerDeepl.test.ts`, mock engine/breaker như `router.test.ts`):
1. Không key DeepL: GTX 429 → lỗi `blocked` y như trước, DeepL không được gọi.
2. Có key: GTX 429 → DeepL dịch → kết quả `engine: "api"`, không lỗi.
3. Có key: breaker GTX mở → DeepL được gọi, GTX **không** gọi HTTP.
4. `prefer: true` → DeepL trước; DeepL 456 → GTX dịch.
5. `enabled: false` → như không có key.
6. GTX `NetworkError` → không gọi DeepL; lỗi `network`.
7. Cả hai 429 (GTX retry 30 s, DeepL retry 5 s) → lỗi `blocked`, `retryAfterMs` = 5 s.
8. DeepL 403 → breaker DeepL **không** bị report; lỗi cuối là lỗi của GTX.
9. Hủy (`signal.abort`) trong lúc DeepL chạy → `CanceledError`.
10. Kết quả DeepL vào `phraseCache` với khóa `api|…`; lần sau trúng cache, không gọi lại.
11. Chế độ `gemini`/`hybrid`: tầng `cloud` không đổi; tầng `api` dự phòng vẫn dùng DeepL.
- `phase2-messaging`: `status` có `breakers.deepl`; `deepl.test` gọi đúng hàm và trả kết quả.

**Commit:** `feat(extension): phase 12 G3 - deepl fallback in router`

---

## Phase G4: Popup + Options (và sửa nhãn đảo ngược có sẵn)

**Được sửa:** `src/popup/Popup.tsx`, `src/options/Options.tsx`, `tests/popupOptions.test.ts` (chỉ **thêm** case), `tests/deeplUi.test.ts` (mới).

**Việc cần làm:**
1. **Sửa lỗi có sẵn (phát hiện khi lên plan):** trong `Popup.tsx`, nhãn đếm và thông báo breaker đang **đảo ngược**:
   - `byEngine.api` đang ghi "Gemini" → phải là **"Google/DeepL"** (chấm xanh lá); `byEngine.cloud` đang ghi "Google" → phải là **"Gemini"** (chấm cyan).
   - `breakers.cloud.blocked` đang báo "Google Translate tạm dừng" → phải là **"Gemini tạm dừng (hết quota / 429)"**; `breakers.api.blocked` → **"Google Translate tạm dừng"**.
   - Thêm `breakers.deepl?.blocked` → **"DeepL tạm dừng (hết hạn mức tháng / 429)"**.
2. **Popup — mục DeepL** (đặt dưới mục Gemini, cùng phong cách):
   - Ô nhập key (type password, tự lưu như ô key Gemini), nút **Kiểm tra** → `deepl.test` → hiện `✓ 120 ms · đã dùng 12.345 / 500.000 ký tự` hoặc lỗi (đã che key).
   - Công tắc **"Dùng DeepL khi Google Translate lỗi"** (`deepl.enabled`).
   - Công tắc **"Ưu tiên DeepL (dùng trước Google)"** (`deepl.prefer`), kèm dòng nhỏ: "Tốn hạn mức 500.000 ký tự/tháng nhanh hơn".
3. **Options:** một dòng mô tả trong khu vực engine; không thêm thông số nâng cao.

**Bẫy cần tránh:**
- Key chỉ được đọc/ghi qua `useSettings` của popup/options (có `includeApiKey`), **không** qua content script.
- Không hiển thị key đầy đủ ở bất kỳ đâu ngoài ô nhập (ô nhập là type password).
- Test UI dựng thật component (như `driveOptionsToggle.test.ts`), không chỉ test storage.

**Test bắt buộc:**
- Nhãn đếm và thông báo breaker đúng (render popup với `tabStatus`/`breakers` giả).
- Nhập key → sau debounce lưu vào `deeplApiKey`; bấm Kiểm tra → gửi `deepl.test` với key; hiển thị kết quả OK và lỗi.
- 2 công tắc lưu đúng `deepl.enabled` / `deepl.prefer`.

**Commit:** `feat(extension): phase 12 G4 - deepl ui and popup label fix`

---

## Phase G5: Tài liệu + kiểm thử thật

**Được sửa:** `README.md`, `NOTES.md`, `PLAN.md` (dòng trỏ tới file này).

**README:**
- Bảng chế độ dịch: thêm "Google Translate lỗi/bị chặn → tự chuyển DeepL (nếu có key)".
- Mục cấu hình DeepL: cách lấy key free (deepl.com/pro-api), dán vào popup, nút Kiểm tra, hạn mức 500.000 ký tự/tháng, công tắc "Ưu tiên DeepL".
- Quyền riêng tư: câu phụ đề gửi tới DeepL khi dùng; key lưu `chrome.storage.local`, chỉ gửi qua header tới `api(-free).deepl.com`, request không kèm cookie.
- Giới hạn: dòng DeepL hiển thị chung nhóm "Google/dịch máy" (cùng chấm xanh lá).

**Kiểm thử thủ công — người dùng chạy, agent KHÔNG được tự điền:**

| # | Kiểm tra | Kỳ vọng | Kết quả |
|---|---|---|---|
| 1 | Popup → dán key → Kiểm tra | ✓ + số ký tự đã dùng | |
| 2 | Bật "Ưu tiên DeepL", mở video YouTube có CC tiếng Anh | Dịch chạy; `/v2/usage` tăng | |
| 3 | Tắt "Ưu tiên DeepL"; giả lập GTX bị chặn (DevTools SW → Network → chặn `translate.googleapis.com`) | Dịch vẫn chạy qua DeepL, không đếm ngược | |
| 4 | Tắt công tắc "Dùng DeepL…", vẫn chặn GTX | Hiện đếm ngược như trước | |
| 5 | Dán key sai → Kiểm tra | Báo lỗi key, key bị che trong thông báo | |
| 6 | Popup | Nhãn "Google/DeepL" xanh lá, "Gemini" cyan; thông báo tạm dừng đúng engine | |
| 7 | Console production (SW, popup) | Không có key / nội dung phụ đề | |

**Commit:** `feat(extension): phase 12 G5 - docs and manual verification`

---

## 4. Rủi ro

| # | Rủi ro | Xử lý |
|---|---|---|
| R1 | DeepL đổi điều kiện gói Free (đòi thẻ, giảm hạn mức) | Engine chỉ là dự phòng; không có key → hành vi như trước Phase 12 |
| R2 | Hết 500K ký tự/tháng | 456 → `DeepLQuotaError` khóa DeepL 6 giờ; router quay về GTX; popup báo |
| R3 | Bật "Ưu tiên DeepL" làm hết hạn mức sớm | Mặc định tắt; popup ghi rõ; nút Kiểm tra hiển thị đã dùng/giới hạn |
| R4 | Lộ key | §0 + test che key + không có `console.*` chứa key (test G1-11) |
| R5 | Hồi quy router khi không có key | Bất biến §2 + test G3-1/G3-5 + toàn bộ test router cũ không sửa |
| R6 | Chất lượng `VI` của model mặc định kém | G0-3 quyết định `model_type` |

## 5. Checklist review (sau mỗi phase)

- [ ] `git diff --stat` chỉ có file trong "Được sửa".
- [ ] `apiFetch` không đổi; `manifest.config.ts` không đổi.
- [ ] Không chèn tham số mới vào giữa constructor (`TranslationRouter`, `MessagingHub`, `StateManager`).
- [ ] Không có `console.*` chứa key / text phụ đề; lỗi đã qua `sanitizeApiKey`.
- [ ] Không sửa expect của test cũ.
- [ ] `pnpm run typecheck && pnpm run test && pnpm run build` xanh.
- [ ] `NOTES.md` có mục của phase.

---

## 6. Prompt cho từng phase

Mỗi lần dán **một** prompt, làm xong đưa review rồi mới dán prompt kế tiếp. G0 do bạn tự chạy (cần key).

### G1
```text
Bạn đang làm Phase 12 G1 của SubTrans Chrome Extension (extension/, nhánh feat/extension).
ĐIỀU KIỆN: NOTES.md có mục "Phase 12 – G0" với G0-2 thành công. Không có → DỪNG, báo lại.
ĐỌC TRƯỚC: extension/PLAN.md §3; extension/PLAN-drive-sidecar.md §0; extension/PLAN-deepl.md §0, §1 và "Phase G1"; src/background/engines/gemini.ts (sanitizeApiKey, testConnection), src/background/engines/http.ts (apiFetch, createTimeoutSignal), src/background/engines/errors.ts.
NHIỆM VỤ: tạo src/background/engines/deepl.ts đúng API trong plan; thêm DeepLQuotaError vào errors.ts; DEEPL_SEND_MODEL_TYPE theo kết quả G0-3 trong NOTES.
Được sửa DUY NHẤT: src/background/engines/deepl.ts (mới), src/background/engines/errors.ts (chỉ THÊM class), tests/deepl.test.ts (mới).
TUYỆT ĐỐI KHÔNG: sửa apiFetch/manifest; log key hoặc text; sao chép sanitizeApiKey (phải import).
Bắt buộc: ánh xạ HTTP đúng bảng §1; chia lô ≤50 dòng/≤120KiB; bỏ dòng rỗng khỏi body; đủ 12 nhóm test trong plan.
Nghiệm thu: pnpm run typecheck && pnpm run test && pnpm run build
Không commit. Báo lại: git status, số test trước → sau.
```

### G2
```text
Bạn đang làm Phase 12 G2 của SubTrans Chrome Extension (extension/, nhánh feat/extension). G1 đã xong.
ĐỌC TRƯỚC: extension/PLAN-deepl.md §3 và "Phase G2"; src/shared/settings.ts (cách lưu geminiApiKey, loadSettings/saveSettings/onSettingsChanged/sanitizeSettings), src/shared/messages.ts, src/background/state.ts.
NHIỆM VỤ: thêm settings.deepl (apiKey lưu riêng "deeplApiKey"), hợp đồng message (deepl.test, breakers.deepl tùy chọn), SessionState.deeplBreaker — đúng §3.
Được sửa DUY NHẤT: src/shared/settings.ts, src/shared/messages.ts, src/background/state.ts, tests/settings.test.ts (chỉ THÊM case), tests/deeplSettings.test.ts (mới).
TUYỆT ĐỐI KHÔNG: để key DeepL trong blob settings; trả key cho content script (includeApiKey:false); chèn tham số vào giữa constructor StateManager; ghi storage 2 lần khi đổi key.
Nghiệm thu: pnpm run typecheck && pnpm run test && pnpm run build
Không commit. Báo lại: git status, số test trước → sau.
```

### G3
```text
Bạn đang làm Phase 12 G3 của SubTrans Chrome Extension (extension/, nhánh feat/extension). G1, G2 đã xong và đã được review.
ĐỌC TRƯỚC: extension/PLAN-deepl.md §0, §2 và "Phase G3"; src/background/router.ts (đặc biệt viaGoogle và vòng lặp tầng), src/background/index.ts, src/background/messaging.ts, tests/router.test.ts (cách mock).
NHIỆM VỤ: viaMachine (GTX ↔ DeepL theo §2) trong tầng "api"; breaker + queue riêng cho DeepL; nối vào SW (index.ts) và messaging (status.deepl, deepl.test).
Được sửa DUY NHẤT: src/background/router.ts, src/background/index.ts, src/background/messaging.ts (chỉ status + case deepl.test + tham số cuối constructor), tests/routerDeepl.test.ts (mới), tests/phase2-messaging.test.ts (chỉ THÊM case).
TUYỆT ĐỐI KHÔNG: đổi planTiers hay EngineId; chèn tham số vào giữa constructor TranslationRouter/MessagingHub; gọi DeepL khi GTX lỗi mạng; report breaker DeepL khi DisabledError; sửa expect test router cũ.
Bắt buộc: không có key DeepL → hành vi y hệt trước (lỗi GTX ném nguyên vẹn); đủ 11 test router + test messaging trong plan.
Nghiệm thu: pnpm run typecheck && pnpm run test && pnpm run build
Không commit. Báo lại: git status, git diff --stat, số test trước → sau.
```

### G4
```text
Bạn đang làm Phase 12 G4 của SubTrans Chrome Extension (extension/, nhánh feat/extension). G1–G3 đã xong.
ĐỌC TRƯỚC: extension/PLAN-deepl.md "Phase G4"; src/popup/Popup.tsx (mục Gemini: ô key, nút Kiểm tra, ~dòng 350–380 nhãn đếm/breaker), src/options/Options.tsx, src/shared/useSettings.ts, tests/driveOptionsToggle.test.ts (mẫu test render thật).
NHIỆM VỤ: (1) sửa nhãn đếm + thông báo breaker đang ĐẢO NGƯỢC trong Popup; (2) mục DeepL trong popup (key password tự lưu, nút Kiểm tra → deepl.test hiển thị đã dùng/giới hạn, 2 công tắc enabled/prefer); (3) 1 dòng mô tả trong Options.
Được sửa DUY NHẤT: src/popup/Popup.tsx, src/options/Options.tsx, tests/popupOptions.test.ts (chỉ THÊM case), tests/deeplUi.test.ts (mới).
TUYỆT ĐỐI KHÔNG: hiện key đầy đủ ngoài ô password; đọc key ở content script; đổi luồng lưu key Gemini.
Bắt buộc: test render thật component cho nhãn/thông báo breaker, ô key, nút Kiểm tra, 2 công tắc.
Nghiệm thu: pnpm run typecheck && pnpm run test && pnpm run build
Không commit. Báo lại: git status, số test trước → sau, ảnh chụp popup (nếu chạy được).
```

### G5
```text
Bạn đang làm Phase 12 G5 của SubTrans Chrome Extension (extension/, nhánh feat/extension). G1–G4 đã xong.
ĐỌC TRƯỚC: extension/PLAN-deepl.md "Phase G5"; README.md.
NHIỆM VỤ: cập nhật README (chế độ dịch, cấu hình DeepL, quyền riêng tư, giới hạn); thêm mục "Phase 12 – G5" vào NOTES với bảng 7 mục kiểm thử ĐỂ TRỐNG cột kết quả; cập nhật dòng trỏ trong PLAN.md.
Được sửa DUY NHẤT: README.md, NOTES.md, PLAN.md.
TUYỆT ĐỐI KHÔNG tự điền kết quả kiểm thử thủ công.
Nghiệm thu: pnpm run typecheck && pnpm run test && pnpm run zip
Không commit. Báo lại: git status.
```
