# Phase 9.5: Tự nhận phụ đề `.srt` nằm cạnh video trên Google Drive

> Phụ lục của `PLAN.md`. **Agent đọc theo thứ tự:** `PLAN.md` §0, §3, §6 → file này §0–§4 → phase đang làm.
> Mọi quy tắc của `PLAN.md` §3 vẫn giữ nguyên, **trừ đúng một ngoại lệ** ở §3 bên dưới.
> **[T]** = phải kiểm chứng trên Drive thật. Không được đoán. Kết quả ghi vào `NOTES.md`.

---

## 0. Luật làm việc cho agent (áp dụng cho MỌI phase D0–D6)

1. **Làm từng phase một.** Chưa đạt "Nghiệm thu" của phase N thì không bắt đầu phase N+1. Mỗi phase là một commit riêng.
2. **Chỉ sửa các file nằm trong mục "Được sửa" của phase đó.** Cần sửa file khác thì dừng lại và ghi lý do vào `NOTES.md`, không tự ý mở rộng phạm vi.
3. **Không bao giờ được:**
   - Sửa `apiFetch()` trong `src/background/engines/http.ts`.
   - Thêm `permissions` hay `host_permissions` vào `manifest.config.ts`. Phase này **không cần đổi manifest**: content script đã chạy ở `<all_urls>` với `all_frames`; `chrome.tabs.sendMessage` không cần quyền `tabs`; `port.sender.tab.url` đọc được nhờ host permission `<all_urls>`.
   - Dùng `chrome.cookies`, đọc hay chép cookie, hoặc nhận URL tải từ content script.
   - Log nội dung phụ đề, tên file, `fileId` ở bản production. Log dev chỉ được nằm trong `if (import.meta.env.DEV)`.
   - Sửa kỳ vọng (expect) của test cũ cho khớp code mới. Test cũ đỏ nghĩa là code mới sai.
   - Đụng vào bất cứ thứ gì ngoài `extension/` (bản Desktop, `frontend/wailsjs/*`, file ở root repo).
4. **Selector DOM của Drive** chỉ được nằm trong hằng `DRIVE_SELECTORS` (D4), và giá trị lấy từ kết quả D0. Không rải chuỗi selector ở chỗ khác.
5. **Mọi `await` trong content script** đều phải kiểm tra lại `gen === this.generation` (và `signal.aborted`) trước khi đụng vào state. Đây là nguồn bug số 1 của dự án (xem NOTES Phase 6–9).
6. **Mọi listener, timer, observer** đều phải gắn vào một `Disposer`. Không có `setTimeout`/`MutationObserver` nào "trôi nổi".
7. **Lệnh nghiệm thu chung** (chạy trong `extension/`, phải pass hết):
   ```bash
   pnpm run typecheck && pnpm run test && pnpm run build
   ```
8. Commit chỉ dùng `git add extension/`. Message theo mẫu ghi ở cuối từng phase.

---

## 1. Mục tiêu, phạm vi, thứ tự ưu tiên

**Mục tiêu.** Bạn mở thư mục khóa học trên Drive (`001 ... .mp4`, `001 ..._en.srt`, …), mở preview một video và bấm play. SubTrans tự tìm file phụ đề cùng tên trong thư mục, tải ngầm và nạp vào, y như khi bạn bấm **Nhập** file đó.

**Trong phạm vi**

- Preview mở từ trang thư mục (`drive.google.com/drive/.../folders/...`), cả list view lẫn grid view.
- File `.srt`/`.vtt` cùng thư mục, **đã được Drive render ra DOM** (xem R2).
- File `_bilingual.srt` do bản Desktop xuất: hiện song ngữ ngay, không gọi API dịch.

**Ngoài phạm vi**

- Drive API chính thức (OAuth, `chrome.identity`).
- Link mở thẳng `drive.google.com/file/d/{id}/view`, không có danh sách thư mục.
- Ghép `_en.srt` với `_vi.srt`.
- Thư mục cấm tải xuống.

**Thứ tự ưu tiên nguồn phụ đề (bản chốt)**

| Nguồn                                     | `sessionOrigin` | Được thay bởi         |
| ----------------------------------------- | --------------- | --------------------- |
| Bạn bấm **Nhập**                          | `"user"`        | Chỉ một lần Nhập khác |
| File `.srt` tự nhận trên Drive            | `"sidecar"`     | `"user"`              |
| Phụ đề do player cung cấp (luồng Phase 9) | `"adapter"`     | `"sidecar"`, `"user"` |

Lý do cho sidecar thắng adapter:

- Player YouTube embed là click-to-play. Trước khi bấm play, `listSources()` trả về rỗng; sau khi play mới có (đã kiểm chứng ở Phase 9). Nếu chọn "adapter thắng" thì sẽ có race giữa hai nguồn.
- Phụ đề `_en.srt` của khóa học thường chuẩn hơn phụ đề tự động.

---

## 2. Kiến trúc

```
[Top frame drive.google.com]                [Service worker]                     [Frame video (iframe player)]
 DriveIndex (D4)                                                                   ContentController.onVideo
  gom {id,name} từ DOM                                                              ├─ trySetup()  (luồng cũ)
  MutationObserver theo folderId                                                    └─ trySidecar() (D5) — chạy song song
                                     ◄────────── port C2B "drive.sidecar" ─────────
 ◄── tabs.sendMessage(frameId:0) ──   DriveSidecarService (D3)
     "drive.lookup"                     ├─ kiểm tra setting, host của tab
 ─── {match | none | ambiguous} ───►    ├─ gộp request trùng + LRU 20
                                        └─ driveFetchText(id)  ← ngoại lệ §3
                                     ─────────── B2C "drive.sidecar.result" ───────►  ImportedSubtitleSource
                                                                                       → startSession(origin "sidecar")
```

Timeout phải lồng nhau đúng thứ tự: **lookup 1.5 s < fetch 8 s < client 12 s**.

Khi SW bị tắt giữa chừng, `BackgroundPort` tự gửi lại request (giữ nguyên `reqId`). `DriveSidecarService` phải chịu được việc nhận lại một request trùng.

---

## 3. Ngoại lệ bảo mật (bổ sung cho PLAN §3)

`driveFetchText()` là **chỗ duy nhất** trong code có `credentials: "include"`. Ràng buộc:

1. Chỉ chạy trong SW. Content script không bao giờ fetch Drive.
2. SW tự dựng URL `https://drive.google.com/uc?export=download&id=${id}`. Không nhận URL từ bên ngoài.
3. `id` phải khớp `DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,128}$/`.
4. `id` lấy từ câu trả lời `drive.lookup` của **top frame (frameId 0) của chính tab gửi request**. `new URL(port.sender.tab.url).hostname` phải là `drive.google.com`. Frame video chỉ được _xin_, không được _chỉ định_ id.
5. `new URL(res.url).hostname` (sau redirect) phải thuộc `DRIVE_FETCH_HOSTS` (giá trị lấy từ T6, dự kiến `drive.google.com` và `drive.usercontent.google.com`).
6. `content-type` chứa `text/html`, hoặc nội dung sau khi bỏ khoảng trắng đầu bắt đầu bằng `<!doctype` hay `<html` (không phân biệt hoa thường) → `not_permitted`.
7. Đọc bằng stream, tối đa **1 MB** (dừng khi vượt, không tin `content-length`). Timeout **8 s**.
8. Init cố định: `{ method: "GET", credentials: "include", cache: "no-store", referrerPolicy: "no-referrer", redirect: "follow", signal }`.
9. Lỗi chỉ trả mã. Không kèm URL, id hay nội dung.
10. Tắt `settings.drive.autoSidecar` thì SW trả `disabled` ngay, không lookup, không fetch.

---

## 4. Bảng mã lỗi và cách hiển thị (dùng chung D2, D3, D5)

| `reason`                         | Nghĩa                                            | Frame video xử lý                                         |
| -------------------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| `disabled`                       | Bạn đã tắt tính năng                             | Im lặng, không thử lại                                    |
| `not_drive`                      | Tab không phải Drive                             | Im lặng, không thử lại                                    |
| `index_unavailable`              | Top frame không trả lời hoặc chưa sẵn sàng       | Thử lại **1 lần** sau 2 s, sau đó im lặng                 |
| `no_match` (khi `indexed === 0`) | Danh sách chưa được gom                          | Như trên                                                  |
| `no_match` (khi `indexed > 0`)   | Không có file phụ đề khớp                        | Im lặng                                                   |
| `ambiguous`                      | Có nhiều file hoặc video trùng tên               | Toast "Có nhiều file trùng tên – bấm Nhập để chọn"        |
| `not_permitted`                  | Không có quyền tải, hoặc nhận về trang đăng nhập | Toast "Không có quyền tải phụ đề – bấm Nhập để chọn file" |
| `not_found`                      | HTTP 404                                         | Toast "Không tìm thấy file phụ đề – bấm Nhập"             |
| `too_large`                      | File > 1 MB                                      | Toast "File phụ đề quá lớn (> 1MB)"                       |
| `bad_format`                     | Không parse được cue nào                         | Toast "File phụ đề không hợp lệ – bấm Nhập"               |
| `timeout` / `network`            | Mạng                                             | Toast "Không tải được phụ đề (mạng) – bấm Nhập"           |

---

## Phase D0: Khảo sát Drive thật [T]

**Mục tiêu.** Có dữ liệu thật thay cho phỏng đoán. **Không viết code `src/` ở phase này.**

**Được sửa:** `NOTES.md` (thêm mục "Phase 9.5 – Khảo sát Drive").

**Chuẩn bị.**

- Một thư mục khóa học thật có ≥ 60 file, mỗi bài có `.mp4` và `_en.srt`.
- Thêm một thư mục nhỏ có `_bilingual.srt`.
- Đã cài bản build dev hiện tại của SubTrans.

**Việc cần làm.** Mở preview một video, bấm play, rồi trả lời từng câu trong bảng. Chỉ ghi **cấu trúc**: host, tên thuộc tính, số lượng, true/false. **Không chép nội dung phụ đề**, và tên file chỉ ghi rút gọn.

| #   | Câu hỏi                                                                                                                                            | Cách kiểm tra                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | `<video>` nằm ở frame nào (host + path)?                                                                                                           | Console top frame: `[...document.querySelectorAll('iframe')].map(f => { try { const u = new URL(f.src); return u.host + u.pathname } catch { return String(f.src) } })` và `document.querySelectorAll('video').length`                                                                                                                |
| T2  | URL của iframe video có chứa id của file video không? Tham số tên gì?                                                                              | `[...new URL(iframe.src).searchParams.keys()]`, so sánh với `data-id` của dòng video                                                                                                                                                                                                                                                  |
| T3  | Dòng file trong danh sách: phần tử nào mang `fileId` và tên? Có ở cả list view và grid view không?                                                 | `document.querySelectorAll('[data-id]').length`; với 1 phần tử, xem `data-id`, `aria-label`, `data-tooltip`, text con                                                                                                                                                                                                                 |
| T4  | Tiêu đề file trong preview: phần tử nào, thuộc tính nào ổn định?                                                                                   | Inspect thanh tiêu đề preview                                                                                                                                                                                                                                                                                                         |
| T5  | Danh sách có ảo hóa không?                                                                                                                         | Đếm `[data-id]` lúc đầu và sau khi cuộn hết                                                                                                                                                                                                                                                                                           |
| T6  | Tải `.srt`: chuỗi redirect, host cuối, `content-type`?                                                                                             | Tab Network khi bấm Tải xuống một file `.srt`                                                                                                                                                                                                                                                                                         |
| T7  | SW fetch kèm `credentials:"include"` có được nội dung không?                                                                                       | `chrome://extensions` → SubTrans → "service worker" → Console: `fetch('https://drive.google.com/uc?export=download&id=<SRT_ID>', {credentials:'include'}).then(async r => [r.url.split('?')[0], r.status, r.headers.get('content-type'), (await r.text()).slice(0,8)])`. Chỉ ghi 8 ký tự đầu để phân biệt `1\r\n00:00` với `<!DOCTYP` |
| T8  | Bấm mũi tên sang bài kế trong preview: iframe **bị tạo lại**, **đổi `src`**, hay **giữ nguyên document**? `location.href` của iframe có đổi không? | Gán `iframe.dataset.mark = 1` trước khi bấm, sau đó kiểm tra `src`, mark và `location.href` trong frame                                                                                                                                                                                                                               |
| T9  | Trong frame video, SubTrans chọn adapter nào? `listSources()` trước và sau khi play trả về mấy nguồn?                                              | Bản build dev, log `[SubTrans]` trong console của frame đó                                                                                                                                                                                                                                                                            |
| T10 | Trong frame video, `location.ancestorOrigins` chứa gì?                                                                                             | Console, chọn context của frame video                                                                                                                                                                                                                                                                                                 |

**Cổng quyết định (ghi rõ vào NOTES):**

- T7 âm tính (nhận về HTML) → **dừng**, chuyển sang R4 và báo lại trước khi làm D3.
- T1 = video nằm ngay top frame → "chế độ cùng frame": D5 gọi `DriveIndex.lookup` trực tiếp (fetch vẫn qua SW, nhưng SW chấp nhận `frameId 0` tự hỏi chính nó qua `tabs.sendMessage`. Không cần đổi D3).
- T8 = `location.href` của iframe không đổi khi đổi bài → D5 dùng phương án "không cache theo href" (D5, bẫy 3).
- T2 âm tính → khớp theo tiêu đề (T4); `ambiguous` thành trường hợp bình thường.

**Nghiệm thu.**

- `NOTES.md` có đủ T1–T10, có ngày kiểm tra.
- Có giá trị đề xuất cho `DRIVE_SELECTORS` (list, grid, tiêu đề preview), `DRIVE_FETCH_HOSTS`, `DOC_ID_PARAM`, và chế độ frame.

**Commit:** `docs(extension): phase 9.5 D0 - drive DOM/frame survey`

---

## Phase D1: Hàm khớp tên (TypeScript thuần)

**Mục tiêu.** Một hàm thuần, không đụng DOM hay chrome, quyết định file nào là phụ đề của video.

**Được sửa:** `src/shared/sidecarMatch.ts` (mới), `tests/sidecarMatch.test.ts` (mới).

**API (giữ đúng chữ ký):**

```ts
export interface DriveEntry {
  id: string;
  name: string;
}
export type SidecarKind = "bilingual" | "en" | "plain";
export type SidecarResult =
  | { status: "match"; entry: DriveEntry; kind: SidecarKind }
  | { status: "none" }
  | { status: "ambiguous" };

export const VIDEO_EXTS: readonly string[]; // [".mp4",".mkv",".webm",".mov",".m4v",".avi"]
export const SUB_EXTS: readonly string[]; // [".srt",".vtt"]
export function normalizeName(s: string): string;
export function stripExt(name: string, exts: readonly string[]): string;
export function findSidecar(
  videoName: string,
  entries: readonly DriveEntry[],
): SidecarResult;
```

**Quy tắc (làm đúng từng dòng):**

1. `normalizeName`: `s.normalize("NFC").toLowerCase()`, đổi mọi khoảng trắng (`\s`, ` `) thành dấu cách, gộp các dấu cách liên tiếp, rồi `trim()`.
2. `stripExt`: so sánh không phân biệt hoa thường; chỉ cắt đúng 1 đuôi ở cuối.
3. `base = normalizeName(stripExt(normalizeName(videoName), VIDEO_EXTS))` (chuẩn hoá trước để tiêu đề dư khoảng trắng cuối vẫn cắt được đuôi). Tên không có đuôi video thì giữ nguyên.
4. Entry là ứng viên khi `normalizeName(entry.name)` kết thúc bằng một đuôi trong `SUB_EXTS`. Phần còn lại sau khi bỏ đuôi là `stem`.
5. Nhóm hậu tố theo thứ tự ưu tiên:
   - `bilingual`: `_bilingual`, `.bilingual`, `-bilingual`, ` bilingual`
   - `en`: `_en`, `.en`, `-en`, ` en`, `_eng`, `.eng`, `_english`, `.english`, ` (english)`, ` [english]`, `.en-us`, `_en-us`, `-en-us`, `_en_us`, `.en_us`
   - `plain`: `""`
6. Khớp khi và chỉ khi `stem === base + suffix` (chấp nhận khoảng trắng thừa ngay trước hậu tố: `Lesson _en.srt` ↔ `Lesson .mp4`). **So toàn bộ chuỗi, không dùng `startsWith`, không dựng regex từ tên file.**
7. Chọn nhóm có ưu tiên cao nhất có ứng viên. Trong nhóm đó: `.srt` thắng `.vtt`, rồi tới hậu tố đứng trước trong danh sách.
8. Còn ≥ 2 ứng viên **khác `id`** ngang hạng nhau → `ambiguous`. Entry trùng `id` (DOM lặp) chỉ tính là 1.
9. `stem` kết thúc bằng `_vi`, `.vi`, `-vi`, `_vie`, `.vie` không bao giờ được chọn.
10. `base === ""` → `none`.

**Test bắt buộc** (`tests/sidecarMatch.test.ts`, mỗi dòng là 1 `it`):

1. Ví dụ thật: `001 Step-01 Install CLI - Introduction.mp4` + `..._en.srt` → `match`, kind `en`.
2. Mỗi hậu tố ở bước 5 khớp đúng nhóm (`it.each`).
3. `bilingual` thắng `en`, `en` thắng `plain`.
4. `.srt` thắng `.vtt` cùng nhóm.
5. Hoa thường lẫn lộn (`Intro.MP4` ↔ `intro_EN.SRT`).
6. NFD ↔ NFC (dựng bằng `"Bài 1".normalize("NFD")`).
7. Khoảng trắng đôi và ` `.
8. `0010 a_en.srt` và `001 a part2_en.srt` không khớp `001 a.mp4`.
9. Đuôi giả `.srt.txt` không khớp.
10. `_vi.srt` bị bỏ qua; chỉ có `_vi.srt` → `none`.
11. Hai ứng viên khác id ngang hạng → `ambiguous`; trùng id → `match`.
12. Tên video không có đuôi (tiêu đề preview) vẫn khớp.
13. Danh sách rỗng → `none`; `videoName` rỗng → `none`.
14. Tên chứa `(`, `[`, `+`, `.`, `$` khớp đúng.
15. File `.mp4` cùng tên không bị coi là phụ đề.

**Nghiệm thu:** lệnh chung.

**Commit:** `feat(extension): phase 9.5 D1 - sidecar filename matcher`

---

## Phase D2: Hợp đồng message + setting + công tắc Options

**Mục tiêu.** Có kiểu dữ liệu và công tắc trước, để D3, D4, D5 không phải tự đặt tên mỗi nơi một kiểu.

**Được sửa:** `src/shared/driveTypes.ts` (mới), `src/shared/messages.ts`, `src/shared/settings.ts`, `src/options/Options.tsx`, `tests/settings.test.ts` (chỉ **thêm** case), `tests/popupOptions.test.ts` (chỉ thêm case), `tests/driveTypes.test.ts` (mới).

**Việc cần làm:**

1. `src/shared/driveTypes.ts`:
   ```ts
   export const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,128}$/;
   export type SidecarFailReason =
     | "disabled"
     | "not_drive"
     | "index_unavailable"
     | "no_match"
     | "ambiguous"
     | "not_permitted"
     | "not_found"
     | "too_large"
     | "timeout"
     | "bad_format"
     | "network";
   export type DriveLookupReq = { type: "drive.lookup"; videoDocId?: string };
   export type DriveLookupRes =
     | { ok: true; indexed: number; result: "match"; id: string; name: string }
     | { ok: true; indexed: number; result: "none" | "ambiguous" }
     | { ok: false };
   /** type đúng; videoDocId (nếu có) là string khớp DRIVE_ID_RE */
   export function isDriveLookupReq(m: unknown): m is DriveLookupReq;
   ```
2. `messages.ts`: thêm vào `C2B` dòng `| { type: "drive.sidecar"; reqId: string; videoDocId?: string }`, và vào `B2C`:
   ```ts
   | { type: "drive.sidecar.result"; reqId: string; ok: true; fileName: string; text: string }
   | { type: "drive.sidecar.result"; reqId: string; ok: false; reason: SidecarFailReason; indexed?: number }
   ```
3. `settings.ts`:
   - Thêm `drive: { autoSidecar: boolean }` vào `Settings` và `DEFAULT_SETTINGS` (`true`).
   - Trong `sanitizeSettings`: `s.drive = { autoSidecar: typeof s.drive?.autoSidecar === "boolean" ? s.drive.autoSidecar : d.drive.autoSidecar };`
   - **Không** đổi `deepMerge`/`saveSettings`/`loadSettings`.
4. `Options.tsx`: thêm công tắc "Tự nhận phụ đề .srt cùng thư mục trên Google Drive", kèm mô tả _"Dùng phiên đăng nhập Google của bạn để tải file phụ đề cùng thư mục. Nội dung chỉ dùng trong tiện ích."_ Làm theo đúng pattern của các công tắc boolean đã có trong file.

**Bẫy cần tránh:**

- Settings cũ không có khóa `drive` → phải ra `autoSidecar: true`.
- Giá trị sai kiểu → về mặc định, không ném lỗi.
- `C2B`/`B2C` là union: chỉ _thêm_ thành viên, không đổi thành viên cũ. Mọi `switch` hiện có phải vẫn compile. `port.ts` dùng `Extract<C2B, {reqId}>`, nên `drive.sidecar` tự được hỗ trợ `request()`.

**Test bắt buộc:**

- `settings.test.ts`: mặc định `true`; blob cũ không có `drive` → `true`; sai kiểu → `true`; lưu `false` rồi load → `false`.
- `driveTypes.test.ts`: `isDriveLookupReq` nhận đúng và từ chối (sai type, docId sai regex, docId không phải string, `null`, mảng).
- `popupOptions.test.ts`: công tắc hiển thị đúng giá trị và gọi `saveSettings({ drive: { autoSidecar: false } })` khi bấm.

**Nghiệm thu:** lệnh chung.

**Commit:** `feat(extension): phase 9.5 D2 - drive sidecar contracts and setting`

---

## Phase D3: Service worker (fetch + service + nối vào hub)

**Mục tiêu.** SW nhận `drive.sidecar`, hỏi top frame, tải file theo đúng §3 và trả kết quả.

**Điều kiện bắt đầu:** D0 có T6 và T7 dương tính.

**Được sửa:** `src/background/engines/driveFetch.ts` (mới), `src/background/drive/sidecarService.ts` (mới), `src/background/messaging.ts`, `src/background/index.ts`, `tests/driveFetch.test.ts` (mới), `tests/driveSidecarService.test.ts` (mới), `tests/security-guards.test.ts` (mới), `tests/phase2-messaging.test.ts` (chỉ thêm case).

**1. `driveFetch.ts`**

```ts
export const DRIVE_FETCH_HOSTS: readonly string[]; // từ T6
export const DRIVE_MAX_BYTES = 1024 * 1024;
export const DRIVE_FETCH_TIMEOUT_MS = 8000;
export type DriveFetchResult =
  | { ok: true; text: string }
  | {
      ok: false;
      reason:
        | "not_found"
        | "not_permitted"
        | "too_large"
        | "timeout"
        | "network";
    };
export async function driveFetchText(
  id: string,
  fetchFn: typeof fetch = fetch,
): Promise<DriveFetchResult>;
export function decodeSubtitleBytes(bytes: Uint8Array): string; // tách ra để test riêng
```

- `!DRIVE_ID_RE.test(id)` → **ném lỗi** (lỗi lập trình).
- Dùng `createTimeoutSignal(DRIVE_FETCH_TIMEOUT_MS)` có sẵn trong `http.ts`; `cleanup()` đặt trong `finally`.
- Map HTTP: 404 → `not_found`; 401/403 → `not_permitted`; mọi `!res.ok` khác → `network`.
- Host sau redirect sai → `not_permitted`.
- Đọc `res.body.getReader()`, cộng dồn số byte; vượt `DRIVE_MAX_BYTES` → `await reader.cancel()` và trả `too_large`.
- `decodeSubtitleBytes`:
  - Có BOM UTF-16LE (`FF FE`) hoặc BE (`FE FF`) → decode theo BOM.
  - Có BOM UTF-8 (`EF BB BF`) → bỏ BOM.
  - Còn lại decode `utf-8`. Nếu số ký tự `�` > 1% → decode lại bằng `windows-1252`.
- Nhận diện HTML theo §3.6 → `not_permitted`.
- `AbortError` → `timeout`; mọi lỗi khác của `fetch` → `network`.

**2. `sidecarService.ts`**

```ts
export interface SidecarDeps {
  isEnabled(): boolean;
  lookup(tabId: number, req: DriveLookupReq): Promise<DriveLookupRes>; // mặc định: chrome.tabs.sendMessage(tabId, req, { frameId: 0 }) + timeout 1.5s
  fetchText(id: string): Promise<DriveFetchResult>; // mặc định: driveFetchText
  parseCount(text: string): number; // mặc định: parseSrtOrVttBilingual(text).length
}
export type SidecarOutcome =
  | { ok: true; fileName: string; text: string }
  | { ok: false; reason: SidecarFailReason; indexed?: number };
export class DriveSidecarService {
  constructor(deps?: Partial<SidecarDeps>);
  handle(
    sender: chrome.runtime.MessageSender | undefined,
    videoDocId?: string,
  ): Promise<SidecarOutcome>;
}
```

Logic `handle`, theo **đúng thứ tự**:

1. `!isEnabled()` → `disabled`.
2. Thiếu `sender.tab.id`/`sender.tab.url`, hoặc `hostname !== "drive.google.com"` → `not_drive`.
3. `videoDocId` sai regex → coi như không có (không báo lỗi).
4. `lookup` ném lỗi, quá timeout, hoặc `{ok:false}` → `index_unavailable`.
5. `result === "none"` → `no_match` (kèm `indexed`); `"ambiguous"` → `ambiguous`.
6. `id` từ lookup sai regex, hoặc `name` rỗng → `index_unavailable` (không tin dữ liệu, kể cả từ top frame).
7. **LRU** `id → {name, text}` (tối đa 20). Hit → trả ngay. Dùng `src/shared/lru.ts` có sẵn.
8. **Gộp request trùng** theo khóa `id`: đang có promise cùng khóa thì dùng lại; xóa khỏi map trong `finally`.
9. `fetchText(id)` lỗi → trả `reason` tương ứng.
10. `parseCount(text) === 0` → `bad_format` (không đưa vào LRU).
11. OK → lưu LRU, trả `{ ok: true, fileName: name, text }`.

**3. Nối vào hub**

- `MessagingHub` nhận thêm tham số **cuối cùng, không bắt buộc** `driveSidecar?: DriveSidecarService`. Test cũ gọi constructor theo vị trí, nên **không chèn tham số vào giữa**.
- Thêm case `"drive.sidecar"` vào `switch` của port message. Phải chờ `this.ready` **đúng cách các case khác đang làm** (đọc kỹ file trước khi viết). Gửi kết quả bằng `safePost(port, { type: "drive.sidecar.result", reqId: msg.reqId, ...outcome })`. Không có `driveSidecar` → `{ ok: false, reason: "disabled" }`.
- `src/background/index.ts`:
  - `let driveAuto = DEFAULT_SETTINGS.drive.autoSidecar;`
  - `const driveSidecar = new DriveSidecarService({ isEnabled: () => driveAuto });`
  - Truyền `driveSidecar` vào hub (tham số cuối). Trong `applySettings` gán `driveAuto = s.drive.autoSidecar`.
  - Tất cả đặt ở top-level, đồng bộ (quy tắc MV3: listener đăng ký trong lượt chạy đầu).

**Bẫy cần tránh:**

- `chrome.tabs.sendMessage` không có listener sẽ reject với "Receiving end does not exist". Phải bắt lỗi và trả `index_unavailable`; không được để thành unhandled rejection.
- Thiếu `{ frameId: 0 }` thì message tới mọi frame, frame nào trả lời trước sẽ thắng. Bắt buộc phải có, và có test kiểm tra tham số.
- Timeout của lookup phải hủy được timer (`clearTimeout` trong `finally`).
- Không đưa `text`, `name`, `id` vào bất kỳ `console.*` nào.
- Không gọi `port.postMessage` trực tiếp, chỉ dùng `safePost`.

**Test bắt buộc:**

- `driveFetch.test.ts` (mock `fetchFn` trả `new Response(new ReadableStream(...), { headers })`; gán `res.url` bằng `Object.defineProperty`):
  - OK UTF-8; BOM UTF-8 bị bỏ; UTF-16LE có BOM; fallback windows-1252.
  - 404 → `not_found`; 403 → `not_permitted`; 500 → `network`.
  - `res.url = "https://evil.example/x"` → `not_permitted`.
  - `content-type: text/html` → `not_permitted`.
  - Body `"\n  <!DOCTYPE html>"` với `text/plain` → `not_permitted`.
  - Body 1 MB + 1 byte → `too_large`, và `cancel` được gọi.
  - Timeout (fake timers) → `timeout`.
  - `fetchFn` ném `TypeError` → `network`.
  - id sai regex → ném lỗi.
  - Kiểm tra init gửi đi: `credentials:"include"`, `cache:"no-store"`, `referrerPolicy:"no-referrer"`, `redirect:"follow"`; URL đúng dạng ở §3.2.
- `driveSidecarService.test.ts`: mỗi bước 1–11 có ít nhất 1 test, gồm:
  - 2 lần `handle` đồng thời cùng id → `fetchText` chỉ được gọi 1 lần.
  - LRU hit → không fetch.
  - `bad_format` không bị cache.
  - `lookup` ném "Receiving end does not exist" → `index_unavailable`.
  - Lookup chậm hơn 1.5 s → `index_unavailable`.
  - Lookup trả id sai regex → `index_unavailable`.
  - Tab host `evil.com` → `not_drive`, và `lookup` không được gọi.
  - Lookup mặc định gọi `chrome.tabs.sendMessage(tabId, req, { frameId: 0 })`.
- `phase2-messaging.test.ts`: `drive.sidecar` qua fake port → đúng `drive.sidecar.result` cùng `reqId`; không truyền `driveSidecar` → `disabled`; port đã ngắt → không ném lỗi.
- `security-guards.test.ts`:
  - `apiFetch` vẫn ép `credentials:"omit"`.
  - Đọc đệ quy `src/` bằng `fs` (`import.meta.dirname` hoặc `process.cwd()`); số file khớp `/credentials\s*:\s*["']include["']/` phải đúng **1**, và đó là `driveFetch.ts`.

**Nghiệm thu:** lệnh chung.

**Commit:** `feat(extension): phase 9.5 D3 - background drive sidecar fetch`

---

## Phase D4: Top frame `DriveIndex`

**Mục tiêu.** Top frame Drive gom `{id, name}` của thư mục hiện tại và trả lời `drive.lookup`.

**Điều kiện bắt đầu:** D0 có T1, T3, T4, T5.

**Được sửa:** `src/content/drive/driveFrame.ts` (mới), `src/content/drive/driveIndex.ts` (mới), `src/content/index.ts` (**chỉ** khối bootstrap ở cuối file), `tests/driveIndex.test.ts` (mới).

**1. `driveFrame.ts`** (hàm thuần):

```ts
export const DOC_ID_PARAM: string; // từ T2 (rỗng nếu T2 âm tính)
export function isDriveTopFrame(win: Window): boolean; // win.top === win && win.location.hostname === "drive.google.com"
export function isDrivePlayerFrame(win: Window): boolean; // win.top !== win && ancestorOrigins (T10) có "https://drive.google.com"; try/catch, lỗi → false
export function getFolderId(url: string): string | null; // /drive/(u/\d+/)?folders/{id}; id khớp DRIVE_ID_RE
export function getVideoDocId(url: string): string | null; // đọc DOC_ID_PARAM; sai regex/rỗng → null
```

**2. `driveIndex.ts`**

```ts
export const DRIVE_SELECTORS = {
  row: "…",
  rowId: "…",
  rowName: "…",
  previewTitle: "…",
} as const; // từ D0
export class DriveIndex {
  constructor(doc: Document, getUrl: () => string);
  start(): void; // gọi lại nhiều lần không tạo observer thứ 2
  dispose(): void;
  get size(): number;
  lookup(videoDocId?: string): DriveLookupRes;
}
```

- `start()`: `scan()` ngay; tạo `MutationObserver(doc.body, { childList: true, subtree: true })`, debounce 300 ms rồi gọi `scan()`. Observer và timer gắn vào `Disposer` của instance.
- `scan()`:
  - `getFolderId(getUrl())` đổi so với lần trước → `map.clear()`. Drive là SPA; kiểm tra trong `scan()` là đủ, không hook `history`.
  - Duyệt `DRIVE_SELECTORS.row`, lấy id và tên. id phải khớp `DRIVE_ID_RE`; tên đã `trim`, không rỗng, dài ≤ 512.
  - `map.set(id, name)`, tối đa **5000** entry.
  - **Chỉ đọc thuộc tính/text**, không đọc layout (`getBoundingClientRect`, `getComputedStyle`).
- `lookup(videoDocId)`:
  1. `videoName = videoDocId ? map.get(videoDocId) : undefined`.
  2. Không có → đọc tiêu đề preview (`DRIVE_SELECTORS.previewTitle`).
  3. Vẫn không có → `{ ok: true, indexed: size, result: "none" }`.
  4. Khi khớp **theo tiêu đề** mà map có ≥ 2 file video cùng `normalizeName(stripExt(name, VIDEO_EXTS))` → `ambiguous`.
  5. `findSidecar(videoName, entries)` → map sang `DriveLookupRes`.

**3. Bootstrap** (cuối `src/content/index.ts`, ngoài `ContentController`):

- Chỉ khi `isDriveTopFrame(window)`.
- `loadSettings({ includeApiKey: false })`. `drive.autoSidecar && isEnabledFor(settings, "drive.google.com")` → `index.start()`. `onSettingsChanged` → `start()`/`dispose()` theo giá trị mới.
- Listener:
  ```ts
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!isDriveLookupReq(msg)) return; // không trả lời message khác
    sendResponse(running ? index.lookup(msg.videoDocId) : { ok: false });
    return false;
  });
  ```
- Lưu vào `globalThis.__subtransDrive` và `dispose()` bản cũ khi bị tiêm lại (theo pattern `__subtransContent`). Bản DEV có thể expose `size` để debug.

**Bẫy cần tránh:**

- Chỉ top frame được trả lời `drive.lookup`. Listener chỉ được đăng ký khi `isDriveTopFrame`.
- Listener `onPopupMessage` của `ContentController` không được trả lời `drive.lookup`. Hiện tại nó đã return sớm khi không có session và chỉ xử lý `tab.*`. Không sửa, nhưng phải có test.
- `MutationObserver` trên `body` của Drive bắn liên tục: bắt buộc debounce; `dispose()` phải gỡ observer, xóa map, hủy timer.
- `start()` gọi 2 lần (settings bật/tắt/bật) không được tạo 2 observer.

**Test bắt buộc** (`tests/driveIndex.test.ts`, jsdom, fixture DOM dựng **đúng cấu trúc ghi ở D0**, cả list và grid):

- `getFolderId` (có/không `u/0`, id sai, không phải trang thư mục).
- `getVideoDocId` (đúng, thiếu, sai regex).
- `isDriveTopFrame` / `isDrivePlayerFrame` với window giả, gồm cả trường hợp `ancestorOrigins` ném lỗi.
- `scan` gom đúng; id sai bị bỏ; tên rỗng bị bỏ; giới hạn 5000.
- Chèn dòng sau `start()` → sau 300 ms (fake timers) có trong map; trước 300 ms thì chưa.
- Đổi folder → map bị xóa.
- `lookup` theo docId; theo tiêu đề; không có tiêu đề → `none`; video trùng tên → `ambiguous`.
- `start()` 2 lần → chỉ 1 observer (spy `MutationObserver`).
- `dispose()` → chèn DOM + 300 ms, size không đổi.
- Bootstrap: frame không phải top không đăng ký listener; message lạ không được trả lời; setting tắt → `{ ok: false }`; `onPopupMessage` không trả lời `drive.lookup`.

**Nghiệm thu:** lệnh chung + thủ công (bản dev): mở thư mục Drive, console top frame `__subtransDrive.size > 0`; cuộn → size tăng; đổi thư mục → size reset.

**Commit:** `feat(extension): phase 9.5 D4 - drive folder index in top frame`

---

## Phase D5: Frame video, `trySidecar` + tích hợp `ContentController`

**Mục tiêu.** Frame player Drive xin phụ đề và nạp vào, đúng thứ tự ưu tiên §1, không nhân đôi overlay, không lẫn bài.

**Điều kiện bắt đầu:** D3, D4 đã xong; có T2, T8, T9, T10.

**Được sửa:** `src/content/drive/sidecarClient.ts` (mới), `src/content/index.ts` (`ContentController`), `tests/driveSidecarClient.test.ts` (mới).

**1. `sidecarClient.ts`**

```ts
type Req = Extract<C2B, { type: "drive.sidecar" }>;
type Res = Extract<B2C, { type: "drive.sidecar.result" }>;
export interface SidecarClientDeps {
  request(msg: Req): Promise<Res>;
  sleep(ms: number, signal: AbortSignal): Promise<void>; // reject khi abort
  newReqId(): string;
}
export const SIDECAR_RETRY_DELAY_MS = 2000;
export const SIDECAR_TOTAL_TIMEOUT_MS = 12000;
export async function requestSidecar(
  videoDocId: string | undefined,
  deps: SidecarClientDeps,
  signal: AbortSignal,
): Promise<
  | { ok: true; fileName: string; text: string }
  | { ok: false; reason: SidecarFailReason }
>;
```

- Lần 1. Nếu `index_unavailable`, hoặc `no_match` với `indexed === 0` → `sleep(2000)` → gửi lại **đúng 1 lần** với `reqId` mới.
- Bọc toàn bộ trong timeout 12 s; hết giờ → `{ ok: false, reason: "timeout" }`.
- `signal` bị abort → reject `AbortError` (bên gọi sẽ bỏ qua). Không gửi request mới sau khi đã abort.
- `request()` ném lỗi (port timeout/closed) → `network`.

**2. Tích hợp `ContentController`**

- Field mới:
  ```ts
  private sessionOrigin: "adapter" | "sidecar" | "user" | null = null;
  /** null = đã xác định là không có, không hỏi lại */
  private sidecarCache = new Map<string, { fileName: string; text: string } | null>();
  ```
- `startSession(video, adapter, source, scope, gen, origin)`: thêm tham số `origin` **bắt buộc** (compiler sẽ chỉ ra mọi chỗ gọi).
  - Gán `this.sessionOrigin = origin`.
  - Trong cleanup của `sessionScope`: `if (this.session === session) this.sessionOrigin = null` (đặt cạnh chỗ đang set `this.session = null`).
  - `trySetup` truyền `"adapter"`.
- Tách `private startImported(source: ImportedSubtitleSource, origin: "user" | "sidecar", okToast: string): Promise<boolean>`: chứa phần kiểm tra `n === 0` + toast "File không có dòng phụ đề hợp lệ" + `startSession` + toast OK, lấy nguyên văn từ `handleImportFile`. `handleImportFile` gọi `startImported(source, "user", \`Đã nạp phụ đề: ${file.name}\`)`. **Hành vi nhập tay không được đổi một chữ** (test Phase 8 phải xanh nguyên vẹn).
- Cuối `onVideo` (sau `void trySetup();`):
  ```ts
  if (
    this.settings.drive.autoSidecar &&
    (isDrivePlayerFrame(window) || isDriveTopFrame(window))
  ) {
    void this.trySidecar(video, scope, gen);
  }
  ```
  `isDriveTopFrame` chỉ đúng khi T1 = "cùng frame"; ngược lại top frame không có `<video>` nên `onVideo` không bao giờ chạy ở đó.
- `trySidecar(video, scope, gen)`:
  1. `docId = getVideoDocId(location.href)`. `key = docId ?? (T8 cho phép ? location.href : null)`.
  2. `key !== null && sidecarCache.has(key)` → dùng giá trị cache (null → return; có giá trị → sang bước 5).
  3. `r = await requestSidecar(docId ?? undefined, deps, scope.signal)` trong `try/catch` (abort → return).
  4. **Ngay sau `await`:** `gen !== this.generation || scope.signal.aborted` → return.
  5. Thất bại:
     - Nếu `key !== null` và `reason` ∈ {`no_match`, `ambiguous`, `not_permitted`, `not_found`, `too_large`, `bad_format`, `disabled`, `not_drive`} → `sidecarCache.set(key, null)`.
     - `network`/`timeout`/`index_unavailable` **không** cache.
     - Toast theo bảng §4 (`disabled`, `not_drive`, `index_unavailable`, `no_match` → không toast).
  6. Thành công: `key !== null` → cache. `this.sessionOrigin === "user"` → return (không đè bản Nhập). Ngược lại `await this.startImported(new ImportedSubtitleSource(r.fileName, r.text), "sidecar", \`Đã tự nhận phụ đề: ${r.fileName}\`)`. **Kiểm tra lại `gen` trước khi gọi.\*\*
- `trySetup` giữ nguyên điều kiện `if (gen !== this.generation || this.session) return`. Nhờ đó sidecar nạp trước thì phụ đề player đến sau không đè lên; adapter nạp trước thì sidecar vẫn thay được (bước 6).

**Bẫy cần tránh (đã gặp ở các phase trước):**

1. **Lẫn bài:** kết quả đến sau khi đổi video → bỏ (bước 4 và kiểm tra lại ở bước 6).
2. **Nhân đôi overlay:** luôn đi qua `startSession` → `ensureView`. Không tự tạo `OverlayHost`.
3. **T8:** nếu player đổi video mà `location.href` của frame không đổi → **không** dùng `location.href` làm khóa (bước 1 trả `key = null`), mỗi `onVideo` đều hỏi lại (SW đã có LRU nên vẫn rẻ). Ghi rõ lựa chọn vào NOTES.
4. **Vòng lặp dựng lại:** `onSourceChanged` của session gọi lại `onVideo` → `trySidecar` lại → nhờ cache nên không request lại (khi có `key`). Phải có test request chỉ đi 1 lần.
5. **Port mở lười:** `autoSidecar` tắt hoặc frame không phải Drive → tuyệt đối không gọi `this.getPort()`.
6. `deactivate()`/`teardownVideo()` hủy `scope` → `requestSidecar` bị abort; không để toast hiện sau khi đã tắt.

**Test bắt buộc** (`tests/driveSidecarClient.test.ts`; tận dụng fake chrome/port/video của `phase8-fixes`/`phase9-fixes`):

- `requestSidecar`:
  - ok lần đầu (1 request).
  - `index_unavailable` rồi ok (2 request, reqId khác nhau).
  - `index_unavailable` × 2 → fail, đúng 2 request.
  - `no_match` với `indexed > 0` → 1 request.
  - Abort trong lúc `sleep` → reject, không có request thứ 2.
  - Quá 12 s (fake timers) → `timeout`.
  - `request` ném lỗi → `network`.
- Controller (giả lập frame player Drive bằng `ancestorOrigins` giả):
  1. `listSources` rỗng + sidecar ok → session `trackKey` bắt đầu bằng `file:`, toast "Đã tự nhận phụ đề: …", `sessionOrigin === "sidecar"`.
  2. Adapter ra nguồn trước, sidecar ok sau → session thay bằng sidecar; **đúng 1 overlay host** trong DOM.
  3. Sidecar ok trước, rồi sự kiện `playing` làm adapter có nguồn → vẫn giữ sidecar.
  4. Bạn Nhập trước, sidecar ok sau → giữ bản Nhập.
  5. Sidecar đã nạp, bạn Nhập → thay; 1 overlay; `sessionOrigin === "user"`.
  6. Đổi video (tăng `generation`) trước khi có kết quả → kết quả bị bỏ, không toast.
  7. `onSourceChanged` dựng lại → `drive.sidecar` chỉ gửi 1 lần (khi có docId).
  8. `autoSidecar = false` → không mở port, không gửi gì.
  9. Frame không phải Drive (YouTube thường, trang `<track>`) → không gửi `drive.sidecar`.
  10. Từng `reason` → đúng chữ toast ở §4; các reason "im lặng" → không toast.
  11. `network` → không cache (lần `onVideo` sau gửi lại); `no_match` → cache (không gửi lại).
  12. `deactivate()` giữa chừng → không toast, không session.
  13. `tab.status` và `tab.export` hoạt động với session sidecar.
- **Toàn bộ test Phase 8/9 cũ xanh, không sửa expect.**

**Nghiệm thu:** lệnh chung + chạy tay mục 1, 2, 8 ở D6.

**Commit:** `feat(extension): phase 9.5 D5 - auto-load drive sidecar in player frame`

---

## Phase D6: Bảo vệ build, tài liệu, kiểm thử thật

**Được sửa:** `scripts/verify-dist.mjs`, `README.md`, `NOTES.md`, `PLAN.md` (chỉ dòng trỏ tới file này).

**Việc cần làm:**

1. `verify-dist.mjs`, thêm kiểm tra với regex `/credentials\s*:\s*["']include["']/g` (code minify không có dấu cách):
   - Không xuất hiện trong bất kỳ file nào được liệt kê ở `manifest.content_scripts[].js`, kể cả các chunk mà file đó import (đọc tĩnh các `import` trong file loader, hoặc đơn giản hơn: chỉ cho phép xuất hiện trong file bundle của `manifest.background.service_worker` và các chunk **không** được content script import).
   - Nếu khó xác định chunk: tối thiểu kiểm tra tổng số lần xuất hiện trong `dist/**/*.js` ≤ 1 và ghi chú vào NOTES.
2. `README.md`:
   - Mục mới "Google Drive: tự nhận phụ đề": bảng hậu tố, thứ tự ưu tiên, cách tắt, giới hạn (thư mục dài cần cuộn, thư mục cấm tải).
   - Dòng Quyền riêng tư: _"Trên Google Drive, SubTrans dùng phiên đăng nhập của bạn để tải file phụ đề nằm cùng thư mục với video đang xem. File chỉ được đọc trong tiện ích, không gửi đi nơi khác ngoài bước dịch như bình thường."_
3. `NOTES.md`: bảng kết quả kiểm thử thủ công, kèm các lỗi phát hiện và đã sửa.

**Kiểm thử thủ công** (bản `pnpm run zip` → giải nén → Load unpacked):

1. [ ] Thư mục `001.mp4 + 001_en.srt`: preview, play → toast "Đã tự nhận…" trong ~2 s, phụ đề song ngữ chạy.
2. [ ] Mũi tên sang 002, 003 → mỗi bài nhận đúng file của nó, không dính phụ đề bài trước.
3. [ ] Thư mục ≥ 60 bài, mở bài cuối khi chưa cuộn → ghi lại hành vi. Cuộn xuống rồi mở lại → nhận được.
4. [ ] Có `_bilingual.srt` + `_en.srt` → chọn `_bilingual`; popup 0 dòng dịch qua API.
5. [ ] Không có `.srt` → không có toast; nút Nhập chạy.
6. [ ] Tắt công tắc, F5 → không có request `uc?export=download` (Network của SW), không có toast.
7. [ ] Video có phụ đề player sẵn và có `_en.srt` → dùng `_en.srt`.
8. [ ] Đã tự nhận, bấm Nhập file khác → thay; chỉ 1 overlay.
9. [ ] Fullscreen, kéo thả, V/G/H, xuất SRT/VTT → như bản Nhập tay.
10. [ ] F5, mở lại bài cũ → phần dịch lấy từ cache (không có request dịch mới).
11. [ ] Thư mục chia sẻ cấm tải → toast "Không có quyền…", không treo, nút Nhập dùng được.
12. [ ] Console production (SW, top frame, frame player): không có tên file, id hay nội dung phụ đề.
13. [ ] Hồi quy: YouTube `/watch`, trang `<track>`, Udemy (nếu có) hoạt động y như trước Phase 9.5.

**Nghiệm thu:** lệnh chung + `pnpm run zip` OK + ≥ 12/13 mục pass trên ≥ 2 thư mục thật; mục không pass phải có lý do trong NOTES.

**Commit:** `feat(extension): phase 9.5 D6 - build guard, docs, manual verification`

---

## 5. Rủi ro và phương án

| #   | Rủi ro                                     | Phương án                                                                                                                                                                                                                                         |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Google đổi DOM Drive                       | Selector chỉ nằm trong `DRIVE_SELECTORS`; hỏng thì chỉ mất tính năng tự nhận, nút Nhập vẫn chạy. Sửa = cập nhật hằng và fixture DOM trong test. NOTES ghi ngày kiểm chứng                                                                         |
| R2  | Danh sách ảo hóa, `.srt` chưa có trong DOM | Map tích lũy theo thư mục trong phiên; thử lại 1 lần; sau đó im lặng. README hướng dẫn cuộn hoặc dùng list view                                                                                                                                   |
| R3  | Không lấy được docId (T2 âm tính)          | Khớp theo tiêu đề preview; video trùng tên → `ambiguous` → không tự nạp                                                                                                                                                                           |
| R4  | SW fetch không có cookie (T7 âm tính)      | **Dừng D3, báo lại.** Phương án B: top frame fetch cùng origin (chỉ được nếu không bị redirect sang host khác, cần T6). Phương án C: toast có nút "Mở file .srt" (mở tab tải), rồi bạn kéo file vào nút Nhập. Không bao giờ dùng `chrome.cookies` |
| R5  | Encoding lạ                                | BOM → UTF-8 → fallback windows-1252 (D3), có test                                                                                                                                                                                                 |
| R6  | Mở/đóng preview liên tục                   | Cache content theo docId + gộp request + LRU ở SW                                                                                                                                                                                                 |
| R7  | Mở rộng quyền làm lộ dữ liệu               | §3 + test bảo vệ (D3) + `verify-dist` (D6)                                                                                                                                                                                                        |
| R8  | Hồi quy trên trang khác                    | Mọi đường code mới chặn bởi `isDrivePlayerFrame`/`isDriveTopFrame` + test D5.9 + mục 13 kiểm thử thủ công                                                                                                                                         |

---

## 6. Checklist review (chạy sau mỗi phase)

- [ ] `git diff --stat` chỉ có các file trong "Được sửa".
- [ ] `apiFetch` không đổi; `credentials` include chỉ có trong `driveFetch.ts`.
- [ ] `manifest.config.ts` không đổi.
- [ ] Không có `console.*` ngoài `import.meta.env.DEV`, trừ `console.warn` lỗi trong SW, mà các log này không chứa text, tên hay id.
- [ ] Mọi `await` trong content đều có kiểm tra `gen`/`signal` ngay sau đó.
- [ ] Mọi listener, observer, timer đều gắn vào `Disposer`.
- [ ] Không sửa expect của test cũ.
- [ ] Lệnh nghiệm thu chung xanh; số test tăng đúng như phase yêu cầu.
- [ ] `NOTES.md` có mục của phase: việc đã làm, lỗi gặp và cách sửa, việc còn lại.
