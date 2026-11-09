# Phase 9.6: Drive tự nhận phụ đề theo 3 trường hợp EN + VI / EN / VI

> Phụ lục của `PLAN.md`, tiếp nối `PLAN-drive-sidecar.md` (Phase 9.5).
> **Agent đọc theo thứ tự:** `PLAN.md` §3 → `PLAN-drive-sidecar.md` §0 (luật làm việc), §3 (ngoại lệ bảo mật) → file này §0–§4 → phase đang làm.
> Luật ở `PLAN-drive-sidecar.md` §0 áp dụng nguyên vẹn cho phase này: chỉ sửa đúng file được liệt kê, không sửa expect của test cũ, không đổi manifest, không log nội dung/tên/id, kiểm tra `gen` sau mọi `await`.
> Cấu trúc DOM Drive đã được kiểm chứng ngày 09/11/2026 (xem NOTES "Sửa lỗi không dịch được trên Drive"); phase này **không** đụng vào phần selector.

---

## 0. Mục tiêu

| TH | Thư mục có | Hiển thị | Gọi API dịch |
|---|---|---|---|
| **1** | `X_en.srt` + `X_vi.srt` | Song ngữ: EN từ `_en`, VI từ `_vi` (ghép theo thời gian) | **Không**, trừ những câu EN không ghép được với câu VI nào |
| **2** | Chỉ `X_en.srt` | EN, VI do máy dịch | **Có** (như hiện tại) |
| **3** | Chỉ `X_vi.srt` | Chỉ VI | **Không** |

Giữ nguyên:
- `_bilingual.srt` (nếu có) vẫn ưu tiên cao nhất, không gọi API.
- `X.srt` (không hậu tố) vẫn được coi là **nguồn EN**. Nếu nội dung thực ra toàn tiếng Việt thì parser hiện có đã tự nhận ra (giữ hành vi cũ).
- Thứ tự `user > sidecar > adapter`, cache IndexedDB, toast, công tắc `drive.autoSidecar`: không đổi.

**Ngoài phạm vi:** ghép nhiều hơn 2 file; tự sửa lệch thời gian giữa EN và VI; nhận diện ngôn ngữ khác ngoài EN/VI; áp dụng việc ghép cho nút **Nhập** tay (vẫn nhập 1 file như cũ).

---

## 1. Quy tắc chọn file (thay `findSidecar` bằng `findSidecarSet`)

Gọi `base = normalizeName(stripExt(normalizeName(videoName), VIDEO_EXTS))` (giữ nguyên như D1).

Nhóm hậu tố (so sánh đầy đủ chuỗi bằng `stemMatches`, như D1):
- `bilingual`: `_bilingual`, `.bilingual`, `-bilingual`, ` bilingual`
- `en`: danh sách EN hiện có (`_en`, `.en`, …, `.en_us`)
- `plain`: `""`, được coi là EN, đứng sau nhóm `en`
- `vi` (**mới**): `_vi`, `.vi`, `-vi`, ` vi`, `_vie`, `.vie`, `_vietnamese`, `.vietnamese`, ` (vietnamese)`, ` [vietnamese]`, `.vi-vn`, `_vi-vn`, `-vi-vn`, `_vi_vn`, `.vi_vn`

Chọn ứng viên tốt nhất **trong từng vai trò** (cùng quy tắc xếp hạng D1: `.srt` > `.vtt`, rồi tới thứ tự hậu tố; ngang hạng mà khác `id` → `ambiguous` cho vai trò đó):
- `bi` = tốt nhất trong nhóm `bilingual`
- `en` = tốt nhất trong nhóm `en`; nếu nhóm `en` rỗng thì lấy tốt nhất trong nhóm `plain`
- `vi` = tốt nhất trong nhóm `vi`

Kết quả:

```ts
export type SidecarSet =
  | { status: "bilingual"; bi: DriveEntry }
  | { status: "pair"; en: DriveEntry; vi: DriveEntry }
  | { status: "en"; en: DriveEntry }
  | { status: "vi"; vi: DriveEntry }
  | { status: "none" }
  | { status: "ambiguous" };
```

Thứ tự quyết định:
1. Có `bi` hợp lệ → `bilingual`.
2. Có `en` và `vi` → `pair`.
3. Chỉ `en` → `en`.
4. Chỉ `vi` → `vi`.
5. Không có gì → `none`.

**`ambiguous`:**
- Vai trò `bi` ambiguous → toàn bộ `ambiguous`.
- Vai trò `en` ambiguous → `ambiguous`.
- Vai trò `vi` ambiguous mà `en` hợp lệ → **bỏ `vi`**, trả `en` (vẫn dùng được, chỉ phải dịch).
- Vai trò `vi` ambiguous mà không có `en` → `ambiguous`.

---

## 2. Quy tắc ghép EN + VI theo thời gian (`mergeEnVi`)

File mới `src/shared/subtitlePair.ts`, hàm thuần:

```ts
export interface PairStats { total: number; matched: number; ratio: number }
export const PAIR_MIN_OVERLAP = 0.5;   // tỷ lệ chồng lấn tối thiểu (so với câu ngắn hơn)
export const PAIR_MIN_RATIO = 0.6;     // dưới ngưỡng này coi như 2 file lệch → không dùng VI
export function mergeEnVi(en: SubtitleItem[], vi: SubtitleItem[]): { items: SubtitleItem[]; stats: PairStats };
```

**Đầu vào:**
- `en` = `parseSrtOrVttBilingual(enText)`.
- `vi` = các câu của file VI, **ép là tiếng Việt**: lấy toàn bộ chữ của câu, không qua `isVietnamese`, vì câu không dấu như "AWS", "OK" vẫn thuộc file VI.

**Thuật toán** (2 con trỏ, cả hai mảng đã sắp xếp theo `start_sec`):
1. Với mỗi câu VI, tìm **một** câu EN có độ chồng lấn lớn nhất: `overlap = max(0, min(endA, endB) − max(startA, startB))`.
   Chỉ nhận khi `overlap / min(durA, durB) ≥ PAIR_MIN_OVERLAP`.
2. Gán câu VI vào câu EN đó. Một câu EN có thể nhận **nhiều** câu VI: nối chữ theo thứ tự thời gian, cách nhau một dấu cách. Mỗi câu VI chỉ gán cho **một** câu EN.
3. Câu EN có ít nhất 1 câu VI:
   `target_text = chữ VI đã nối`, `translated = true`, `engine = "file"`.
4. Câu EN không có câu VI nào: giữ như parse (thường là `translated = false`, sẽ được gửi đi dịch). Câu EN mà bản thân đã song ngữ hoặc tiếng Việt thì giữ nguyên `target_text`/`engine` gốc, không ghi đè.
5. Câu VI không ghép được với câu EN nào: bỏ, không tạo câu mới. Timeline luôn theo file EN.
6. `stats = { total: en.length, matched: số câu EN có VI, ratio: matched / total }` (`total = 0` → `ratio = 0`).

**Bảo toàn:**
- Số phần tử, `id`, `start_sec`, `end_sec`, `source_text` của mảng EN **không đổi**. Session đang dùng `getInitialItems()` và chỉ chấp nhận khi `length` bằng số cue.
- Độ phức tạp O(n + m). Không dùng vòng lặp lồng O(n·m).

---

## 3. Luồng mới

```
DriveIndex.lookup → findSidecarSet → { result: "bilingual" | "pair" | "en" | "vi", files }
SW DriveSidecarService → tải 1 hoặc 2 file SONG SONG (driveFetchText, LRU, gộp request trùng theo từng id)
                       → trả { ok: true, mode, en?: {name,text}, vi?: {name,text} }
Frame video trySidecar → dựng nguồn theo mode:
   bilingual/en : ImportedSubtitleSource(name, text)                       (như cũ)
   vi           : ImportedSubtitleSource(name, text, { forceLang: "vi" })  (mọi câu = tiếng Việt, không dịch)
   pair         : ImportedSubtitleSource.fromPair(en, vi)
                  → mergeEnVi; nếu stats.ratio < PAIR_MIN_RATIO → bỏ VI, dùng như mode "en" + toast cảnh báo
```

**Hạ cấp khi lỗi (ở SW, mode `pair`):**
- Tải `vi` lỗi, `en` OK → trả `mode: "en"` (vẫn dịch được).
- Tải `en` lỗi, `vi` OK → trả `mode: "vi"`.
- Cả hai lỗi → trả `reason` của file `en`.
- `parseCount === 0` áp dụng cho từng file; file nào hỏng thì coi như tải lỗi file đó.

**`trackKey`** (để cache bản dịch riêng cho từng tổ hợp):
- `en`/`bilingual`: giữ nguyên `file:${name}:${hash}` (tương thích cache cũ).
- `vi`: `file:${name}:vi:${hash}` (khác khóa với lần Nhập tay cùng file, để bản dịch máy trong cache không ghi đè câu VI).
- `pair`: `file:${enName}+${viName}:${fnv1a32(enText + "\u0000" + viText)}`.

**Toast:**

| mode | Toast |
|---|---|
| `pair` (ratio ≥ ngưỡng) | `Đã tự nhận phụ đề EN + VI: ${enName}` |
| `pair` (ratio < ngưỡng) | `Phụ đề VI lệch thời gian – dùng bản dịch máy cho ${enName}` |
| `en` | `Đã tự nhận phụ đề: ${enName}` (như cũ) |
| `vi` | `Đã tự nhận phụ đề tiếng Việt: ${viName}` |
| `bilingual` | `Đã tự nhận phụ đề: ${name}` (như cũ) |

---

## 4. Hợp đồng dữ liệu mới

`src/shared/driveTypes.ts`:

```ts
export type DriveFileRef = { id: string; name: string };
export type DriveLookupRes =
  | { ok: true; indexed: number; result: "bilingual"; bi: DriveFileRef }
  | { ok: true; indexed: number; result: "pair"; en: DriveFileRef; vi: DriveFileRef }
  | { ok: true; indexed: number; result: "en"; en: DriveFileRef }
  | { ok: true; indexed: number; result: "vi"; vi: DriveFileRef }
  | { ok: true; indexed: number; result: "none" | "ambiguous" }
  | { ok: false };
export type SidecarMode = "bilingual" | "pair" | "en" | "vi";
export type SidecarFile = { name: string; text: string };
```

`src/shared/messages.ts`: kết quả thành công của `drive.sidecar.result` đổi thành

```ts
| { type: "drive.sidecar.result"; reqId: string; ok: true; mode: SidecarMode; en?: SidecarFile; vi?: SidecarFile; bi?: SidecarFile }
```

Ràng buộc:
- `mode` `pair` ⇒ có cả `en` và `vi`.
- `en` ⇒ có `en`; `vi` ⇒ có `vi`; `bilingual` ⇒ có `bi`.
- Nhánh lỗi giữ nguyên.

Đây là thay đổi phá vỡ hợp đồng **nội bộ** (SW và content luôn cùng phiên bản), nên được phép sửa các test cũ **liên quan trực tiếp** tới hình dạng message. Các file test được phép sửa liệt kê ở từng phase.

---

## Phase E1: `findSidecarSet` (TypeScript thuần)

**Được sửa:** `src/shared/sidecarMatch.ts`, `tests/sidecarMatch.test.ts` (chỉ **thêm** case), `tests/sidecarSet.test.ts` (mới).

**Việc cần làm:**
1. Thêm `VI_SUFFIXES` theo §1 (thay hằng `VI_SUFFIXES` dùng để loại trừ hiện tại: nay nó trở thành một nhóm được nhận).
2. Thêm `findSidecarSet(videoName, entries): SidecarSet` theo đúng §1.
3. **Giữ** `findSidecar` để test cũ vẫn xanh, cài lại thành `findSidecarSet` → map về kiểu cũ (`bilingual` → `match` kind `bilingual`; `pair`/`en` → `match` của `en`; `vi`/`none` → `none`). Hành vi cũ "file `_vi` không bao giờ được chọn" vẫn đúng với `findSidecar`.

**Test bắt buộc** (`sidecarSet.test.ts`):
1. Ví dụ thật: `001 Introduction.mp4` + `001 Introduction_en.srt` + `001 Introduction_vi.srt` → `pair`.
2. Chỉ `_en` → `en`; chỉ `X.srt` → `en` (plain); chỉ `_vi` → `vi`.
3. `_bilingual` + `_en` + `_vi` → `bilingual`.
4. `_en` + `X.srt` + `_vi` → `pair` với `en` = file `_en` (nhóm `en` thắng `plain`).
5. Mỗi hậu tố VI ở §1 (`it.each`) → `vi`.
6. `.srt` thắng `.vtt` trong nhóm `vi`.
7. Hai `_vi` khác id + một `_en` → `en` (bỏ vi). Hai `_vi`, không `_en` → `ambiguous`.
8. Hai `_en` khác id → `ambiguous`.
9. `001 a.mp4` không ăn `0010 a_vi.srt` hay `001 a part2_vi.srt`.
10. Video tên `abc_vi.mp4` + `abc_vi_en.srt` → `en`.
11. Danh sách rỗng / tên rỗng → `none`.

**Commit:** `feat(extension): phase 9.6 E1 - sidecar set matcher (en/vi/pair)`

---

## Phase E2: Ghép EN + VI và nguồn phụ đề

**Được sửa:** `src/shared/subtitlePair.ts` (mới), `src/content/adapters/imported.ts`, `tests/subtitlePair.test.ts` (mới), `tests/importedPair.test.ts` (mới).

**Việc cần làm:**
1. `subtitlePair.ts`: `mergeEnVi` theo §2, kèm `parseViForced(text): SubtitleItem[]` (parse như `parseSrtOrVttBilingual` nhưng mọi câu: `source_text = ""`, `target_text = toàn bộ chữ`, `translated = true`, `engine = "file"`). Dùng lại các helper parse có sẵn, **không** sao chép regex timestamp; nếu cần thì export helper từ `subtitleFormat.ts`, khi đó thêm `subtitleFormat.ts` vào danh sách được sửa và chỉ được **thêm export**.
2. `imported.ts`:
   - Constructor nhận thêm `opts?: { forceLang?: "vi" }`. `forceLang: "vi"` → `items = parseViForced(content)`; `cues` tạo từ `target_text` (vì `source_text` rỗng).
   - `static fromPair(en: SidecarFile, vi: SidecarFile): { source: ImportedSubtitleSource; stats: PairStats }`, với `trackKey`/`title` theo §3 (title = tên file EN bỏ đuôi).
   - `getInitialItems()` trả items đã ghép; `load()` trả cue EN. Số phần tử phải bằng nhau.
   - Constructor cũ `(fileName, content)` **giữ nguyên hành vi** (nút Nhập dùng nó).

**Bẫy cần tránh:**
- Dùng thời gian của câu EN làm timeline; không trộn mảng.
- File VI có câu ngắn hơn và tách nhỏ hơn câu EN (thường gặp): một câu EN nhận 2–3 câu VI là bình thường.
- `mergeEnVi` không được làm đổi thứ tự hay `id` của câu EN.

**Test bắt buộc:**
- `subtitlePair.test.ts`:
  - Khớp 1-1 → ratio 1.
  - 1 EN : 2 VI → nối đúng thứ tự.
  - 2 EN : 1 VI → VI chỉ vào câu chồng lấn nhiều hơn.
  - Lệch 200 ms vẫn khớp.
  - Lệch 5 s → ratio thấp (< `PAIR_MIN_RATIO`).
  - VI thừa ở cuối bị bỏ.
  - EN không có VI giữ `translated = false`.
  - Câu VI không dấu ("AWS") vẫn được ghép.
  - Mảng rỗng.
  - 2000 câu chạy < 50 ms.
- `importedPair.test.ts`:
  - `fromPair` có `trackKey` đúng dạng; `getInitialItems().length === (await load()).length`.
  - `forceLang: "vi"` → mọi item `translated`, `engine = "file"`.
  - Constructor cũ không đổi hành vi (so với snapshot của một file EN và một file song ngữ).

**Commit:** `feat(extension): phase 9.6 E2 - en+vi subtitle pairing`

---

## Phase E3: Hợp đồng + Service worker tải 1–2 file

**Được sửa:** `src/shared/driveTypes.ts`, `src/shared/messages.ts`, `src/background/drive/sidecarService.ts`, `tests/driveSidecarService.test.ts`, `tests/driveTypes.test.ts` (chỉ thêm case), `tests/phase2-messaging.test.ts` (chỉ sửa case `drive.sidecar` cho đúng hình dạng mới).

**Việc cần làm:**
1. Đổi kiểu theo §4.
2. `DriveSidecarService.handle`:
   - Bước 5–6 (cũ): kiểm tra **từng** `DriveFileRef` (id khớp `DRIVE_ID_RE`, name không rỗng). Ref nào sai → coi như không có file đó. Sau khi lọc mà không còn file nào → `index_unavailable`.
   - Tải các file cần thiết **song song** (`Promise.all`). Mỗi id vẫn qua LRU và gộp request trùng như cũ: tách hàm `fetchOne(id, name)` dùng chung.
   - `parseCount` cho từng file.
   - Áp dụng quy tắc hạ cấp ở §3.
   - Trả `{ ok: true, mode, en?, vi?, bi? }`.
3. Không đổi: bước 1–4 (setting, host, docId, lookup lỗi), timeout lookup, `{frameId: 0}`.

**Test bắt buộc:**
- Lookup `pair` → `fetchText` được gọi 2 lần **đồng thời** (cả hai promise đã bắt đầu trước khi cái đầu tiên xong).
- `pair` mà `vi` lỗi → `mode: "en"`; `en` lỗi → `mode: "vi"`; cả hai lỗi → reason của `en`.
- `pair` mà `vi` parse 0 câu → `mode: "en"`.
- Lookup `vi` → `mode: "vi"`, chỉ tải 1 file.
- Ref có id sai → bị bỏ; cả hai sai → `index_unavailable`.
- LRU hit cho file `en` vẫn tải `vi`.
- Hai request `pair` đồng thời cùng id → mỗi id chỉ tải 1 lần.

**Commit:** `feat(extension): phase 9.6 E3 - background fetch en/vi pair`

---

## Phase E4: Top frame + frame video

**Được sửa:** `src/content/drive/driveIndex.ts` (**chỉ** hàm `lookup`), `src/content/index.ts` (**chỉ** `trySidecar` và kiểu của `sidecarCache`), `src/content/drive/sidecarClient.ts` (chỉ kiểu trả về), `tests/driveIndex.test.ts` + `tests/driveIndex-review.test.ts` (chỉ sửa expect của `lookup` cho đúng hình dạng mới), `tests/driveSidecarClient.test.ts` (sửa message giả lập cho đúng hình dạng mới, và thêm case).

**Việc cần làm:**
1. `DriveIndex.lookup`: dùng `findSidecarSet`, map sang `DriveLookupRes` mới. Giữ nguyên việc phát hiện video trùng tên → `ambiguous`. **Không** đụng `scan`, `findPreviewTitle`, `DRIVE_SELECTORS`.
2. `trySidecar`: dựng nguồn theo `mode` (§3), áp ngưỡng `PAIR_MIN_RATIO`, toast theo bảng §3. `sidecarCache` lưu nguyên kết quả thành công (mode + files).
3. Mọi quy tắc của D5 giữ nguyên: kiểm tra `gen`/`signal` sau mỗi `await`, không đè bản `user`, cache lỗi theo danh sách cũ.

**Test bắt buộc (controller):**
- `pair` khớp tốt → session có item `engine = "file"` ở các câu đã ghép, và **không** có `translate` nào gửi cho những câu đó; toast "EN + VI".
- `pair` lệch (ratio thấp) → dùng như `en`, có toast cảnh báo, có `translate` được gửi.
- `pair` khớp một phần (ví dụ 80%) → chỉ những câu chưa ghép được gửi đi `translate`.
- `vi` → mọi item `translated`, không có `translate`; toast "tiếng Việt".
- `en` → hành vi như cũ.
- Bạn Nhập sau khi đã có `pair` → thay, chỉ 1 overlay.
- Kết quả đến sau khi đổi video → bỏ.
- Toàn bộ test D5 cũ vẫn xanh (chỉ sửa hình dạng message giả lập, **không** đổi kỳ vọng hành vi).

**Commit:** `feat(extension): phase 9.6 E4 - apply en/vi/pair sidecar in player`

---

## Phase E5: Tài liệu + kiểm thử thật

**Được sửa:** `README.md` (mục "Google Drive: tự nhận phụ đề"), `NOTES.md`, `PLAN.md` (dòng trỏ tới file này).

**Việc cần làm:**
1. README: thay bảng quy tắc bằng bảng 3 trường hợp ở §0, cộng thêm hậu tố VI. Ghi rõ: câu EN không ghép được với VI vẫn được dịch bằng máy; VI lệch thời gian quá nhiều thì dùng bản dịch máy.
2. Kiểm thử thủ công **do người dùng tự chạy** trên thư mục AWS (`01 - Introduction` có sẵn `_en` + `_vi`). Agent **không được** tự điền PASS khi chưa có kết quả từ người dùng; mục chưa chạy thì để trống.

| # | Kiểm tra | Kỳ vọng |
|---|---|---|
| 1 | Mở `001 Introduction.mp4` | Toast "EN + VI", song ngữ hiện ngay |
| 2 | Popup | Số dòng dịch Google/Gemini ≈ 0 (chỉ các câu không ghép được) |
| 3 | Tab Network của SW | 2 request `uc?export=download`, không có request `translate` (hoặc rất ít) |
| 4 | Tạm đổi tên `_vi` thành tên khác | Về TH2: toast thường, có dịch |
| 5 | Thư mục chỉ có `_vi` | Toast "tiếng Việt", chỉ hiện VI, không có request dịch |
| 6 | F5, mở lại bài 001 | Hiện ngay từ cache |
| 7 | Bấm Nhập một file khác | Thay phụ đề, chỉ 1 overlay |

**Commit:** `feat(extension): phase 9.6 E5 - docs and manual verification`

---

## 5. Prompt cho từng phase

Mỗi lần dán **một** prompt. Làm xong thì đưa đi review, rồi mới dán prompt kế tiếp.

### E1
```text
Bạn đang làm Phase 9.6 E1 của SubTrans Chrome Extension (extension/, nhánh feat/extension).
ĐỌC TRƯỚC: extension/PLAN-drive-sidecar.md §0; extension/PLAN-drive-envi.md §0, §1 và "Phase E1"; src/shared/sidecarMatch.ts hiện tại.
NHIỆM VỤ: thêm nhóm hậu tố VI và findSidecarSet() đúng §1; giữ findSidecar() (cài lại qua findSidecarSet) để test cũ xanh.
Được sửa DUY NHẤT: src/shared/sidecarMatch.ts, tests/sidecarMatch.test.ts (chỉ THÊM case), tests/sidecarSet.test.ts (mới).
Bắt buộc: hàm thuần; so sánh toàn chuỗi bằng === (dùng stemMatches có sẵn); không dựng RegExp từ tên file; đủ 11 test trong plan.
Nghiệm thu: pnpm run typecheck && pnpm run test && pnpm run build
Không commit. Báo lại: git status, số test trước → sau.
```

### E2
```text
Bạn đang làm Phase 9.6 E2 của SubTrans Chrome Extension (extension/, nhánh feat/extension). E1 đã xong.
ĐỌC TRƯỚC: extension/PLAN-drive-envi.md §0, §2, §3 và "Phase E2"; src/shared/subtitleFormat.ts (parseSrtOrVttBilingual), src/content/adapters/imported.ts, src/content/pipeline/session.ts (cách dùng getInitialItems).
NHIỆM VỤ: src/shared/subtitlePair.ts (mergeEnVi, parseViForced) + ImportedSubtitleSource (opts.forceLang, static fromPair) đúng §2–§3.
Được sửa DUY NHẤT: src/shared/subtitlePair.ts (mới), src/content/adapters/imported.ts, tests/subtitlePair.test.ts (mới), tests/importedPair.test.ts (mới); subtitleFormat.ts chỉ được THÊM export helper nếu cần.
TUYỆT ĐỐI KHÔNG: đổi hành vi constructor cũ ImportedSubtitleSource(fileName, content); đổi thứ tự/id/thời gian câu EN; dùng vòng lặp lồng O(n·m).
Bắt buộc: đủ test trong plan, gồm test 2000 câu < 50ms.
Nghiệm thu: pnpm run typecheck && pnpm run test && pnpm run build
Không commit. Báo lại: git status, số test trước → sau.
```

### E3
```text
Bạn đang làm Phase 9.6 E3 của SubTrans Chrome Extension (extension/, nhánh feat/extension). E1, E2 đã xong.
ĐỌC TRƯỚC: extension/PLAN-drive-sidecar.md §3 (ngoại lệ bảo mật); extension/PLAN-drive-envi.md §3, §4 và "Phase E3"; src/background/drive/sidecarService.ts, src/background/engines/driveFetch.ts, src/shared/driveTypes.ts, src/shared/messages.ts.
NHIỆM VỤ: đổi hợp đồng theo §4; SidecarService tải 1–2 file SONG SONG, áp quy tắc hạ cấp §3.
Được sửa DUY NHẤT: src/shared/driveTypes.ts, src/shared/messages.ts, src/background/drive/sidecarService.ts, tests/driveSidecarService.test.ts, tests/driveTypes.test.ts (chỉ thêm case), tests/phase2-messaging.test.ts (chỉ sửa case drive.sidecar cho đúng hình dạng mới).
TUYỆT ĐỐI KHÔNG: sửa driveFetch.ts hay apiFetch; đổi bước 1–4 của handle(); log text/tên/id.
Bắt buộc: tách fetchOne(id, name) dùng chung LRU + gộp request trùng; đủ test trong plan (kiểm tra 2 request chạy đồng thời).
Nghiệm thu: pnpm run typecheck && pnpm run test && pnpm run build
Không commit. Báo lại: git status, số test trước → sau.
```

### E4
```text
Bạn đang làm Phase 9.6 E4 của SubTrans Chrome Extension (extension/, nhánh feat/extension). E1–E3 đã xong và đã được review.
ĐỌC TRƯỚC: extension/PLAN-drive-envi.md §0, §3 và "Phase E4"; PLAN-drive-sidecar.md "Phase D5" (các bẫy đã gặp); src/content/index.ts (trySidecar, startImported, startSession), src/content/drive/driveIndex.ts (lookup), src/content/drive/sidecarClient.ts.
NHIỆM VỤ: DriveIndex.lookup dùng findSidecarSet; trySidecar dựng nguồn theo mode (bilingual/en/vi/pair), áp PAIR_MIN_RATIO, toast theo bảng §3.
Được sửa DUY NHẤT: src/content/drive/driveIndex.ts (CHỈ hàm lookup), src/content/index.ts (CHỈ trySidecar + kiểu sidecarCache), src/content/drive/sidecarClient.ts (chỉ kiểu), tests/driveIndex.test.ts + tests/driveIndex-review.test.ts (chỉ sửa expect của lookup theo hình dạng mới), tests/driveSidecarClient.test.ts (sửa message giả lập + thêm case).
TUYỆT ĐỐI KHÔNG: đụng scan/findPreviewTitle/DRIVE_SELECTORS; đổi hành vi nút Nhập; bỏ kiểm tra gen/signal sau await; để sidecar đè bản "user".
Bắt buộc: đủ test controller trong plan; toàn bộ test D5 cũ vẫn xanh (chỉ đổi hình dạng message giả lập).
Nghiệm thu: pnpm run typecheck && pnpm run test && pnpm run build
Không commit. Báo lại: git status, git diff --stat, số test trước → sau.
```

### E5
```text
Bạn đang làm Phase 9.6 E5 của SubTrans Chrome Extension (extension/, nhánh feat/extension). E1–E4 đã xong.
ĐỌC TRƯỚC: extension/PLAN-drive-envi.md §0 và "Phase E5"; README.md mục "Google Drive: tự nhận phụ đề".
NHIỆM VỤ: cập nhật README theo §0 (bảng 3 trường hợp + hậu tố VI); thêm mục "Phase 9.6" vào NOTES với bảng kiểm thử thủ công 7 mục ĐỂ TRỐNG cột kết quả; cập nhật dòng trỏ trong PLAN.md.
Được sửa DUY NHẤT: README.md, NOTES.md, PLAN.md.
TUYỆT ĐỐI KHÔNG tự điền PASS/FAIL cho kiểm thử thủ công — chỉ người dùng chạy trên Drive thật mới điền.
Nghiệm thu: pnpm run typecheck && pnpm run test && pnpm run zip
Không commit. Báo lại: git status.
```
