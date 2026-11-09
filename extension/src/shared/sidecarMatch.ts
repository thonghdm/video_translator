/**
 * SubTrans Extension — So khớp tên file phụ đề đi kèm (Sidecar Matcher)
 * Phase 9.5 D1 & Phase 9.6 E1: Hàm thuần quyết định file nào là phụ đề tương ứng của video
 */

export interface DriveEntry {
  id: string;
  name: string;
}

export type SidecarKind = "bilingual" | "en" | "plain";

export type SidecarResult =
  | { status: "match"; entry: DriveEntry; kind: SidecarKind }
  | { status: "none" }
  | { status: "ambiguous" };

export type SidecarSet =
  | { status: "bilingual"; bi: DriveEntry }
  | { status: "pair"; en: DriveEntry; vi: DriveEntry }
  | { status: "en"; en: DriveEntry }
  | { status: "vi"; vi: DriveEntry }
  | { status: "none" }
  | { status: "ambiguous" };

export const VIDEO_EXTS: readonly string[] = [
  ".mp4",
  ".mkv",
  ".webm",
  ".mov",
  ".m4v",
  ".avi",
] as const;

export const SUB_EXTS: readonly string[] = [
  ".srt",
  ".vtt",
] as const;

export const BILINGUAL_SUFFIXES = [
  "_bilingual",
  ".bilingual",
  "-bilingual",
  " bilingual",
] as const;

export const EN_SUFFIXES = [
  "_en",
  ".en",
  "-en",
  " en",
  "_eng",
  ".eng",
  "_english",
  ".english",
  " (english)",
  " [english]",
  // Biến thể có mã vùng (yt-dlp, trình tải khóa học): Lesson.en-US.srt, Lesson_en_US.srt
  ".en-us",
  "_en-us",
  "-en-us",
  "_en_us",
  ".en_us",
] as const;

export const VI_SUFFIXES = [
  "_vi",
  ".vi",
  "-vi",
  " vi",
  "_vie",
  ".vie",
  "_vietnamese",
  ".vietnamese",
  " (vietnamese)",
  " [vietnamese]",
  ".vi-vn",
  "_vi-vn",
  "-vi-vn",
  "_vi_vn",
  ".vi_vn",
] as const;

/**
 * Chuẩn hoá tên file:
 * NFC hoá, chuyển chữ thường, đổi mọi khoảng trắng (\s, \u00A0) thành dấu cách,
 * gộp các dấu cách liên tiếp, rồi trim().
 */
export function normalizeName(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s\u00A0]+/g, " ")
    .trim();
}

/**
 * Cắt bỏ phần mở rộng ở cuối (so sánh không phân biệt hoa thường).
 * Chỉ cắt đúng 1 đuôi ở cuối nếu khớp với một trong các exts.
 */
export function stripExt(name: string, exts: readonly string[]): string {
  const lower = name.toLowerCase();
  for (const ext of exts) {
    const extLower = ext.toLowerCase();
    if (lower.endsWith(extLower)) {
      return name.slice(0, name.length - ext.length);
    }
  }
  return name;
}

/**
 * stem === base + suffix, chấp nhận khoảng trắng thừa NGAY TRƯỚC hậu tố/đuôi file
 * ("Lesson .mp4" ↔ "Lesson _en.srt" / "Lesson .srt"). base đã được trim nên khoảng trắng đó bị mất.
 * Vẫn so TOÀN BỘ chuỗi bằng === (không startsWith/regex).
 */
export function stemMatches(stem: string, base: string, suffix: string): boolean {
  if (!stem.endsWith(suffix)) return false;
  const rest = stem.slice(0, stem.length - suffix.length);
  return rest === base || rest.trimEnd() === base;
}

interface RoleCandidate {
  entry: DriveEntry;
  subExtRank: number; // 0: .srt, 1: .vtt
  suffixRank: number; // vị trí trong mảng suffix của group
}

type RolePick =
  | { status: "ok"; entry: DriveEntry }
  | { status: "ambiguous" }
  | { status: "none" };

function pickBestCandidate(candidates: readonly RoleCandidate[]): RolePick {
  if (candidates.length === 0) {
    return { status: "none" };
  }

  const sorted = [...candidates].sort((a, b) => {
    if (a.subExtRank !== b.subExtRank) {
      return a.subExtRank - b.subExtRank;
    }
    return a.suffixRank - b.suffixRank;
  });

  const best = sorted[0];
  const topTied = sorted.filter(
    (c) => c.subExtRank === best.subExtRank && c.suffixRank === best.suffixRank
  );

  const uniqueIds = new Set(topTied.map((c) => c.entry.id));
  if (uniqueIds.size > 1) {
    return { status: "ambiguous" };
  }

  return { status: "ok", entry: topTied[0].entry };
}

/**
 * Phân loại bộ file phụ đề ứng với videoName theo 3 trường hợp EN + VI / EN / VI (Phase 9.6 E1).
 * Hàm thuần: không đụng DOM, chrome API, fetch hay Date.
 */
export function findSidecarSet(
  videoName: string,
  entries: readonly DriveEntry[]
): SidecarSet {
  const base = normalizeName(stripExt(normalizeName(videoName), VIDEO_EXTS));
  if (base === "") {
    return { status: "none" };
  }

  const biCandidates: RoleCandidate[] = [];
  const enCandidates: RoleCandidate[] = [];
  const plainCandidates: RoleCandidate[] = [];
  const viCandidates: RoleCandidate[] = [];

  for (const entry of entries) {
    const normEntryName = normalizeName(entry.name);

    let subExt = "";
    for (const ext of SUB_EXTS) {
      if (normEntryName.endsWith(ext)) {
        subExt = ext;
        break;
      }
    }
    if (!subExt) continue;

    const subExtRank = subExt === ".srt" ? 0 : 1;
    const stem = normEntryName.slice(0, normEntryName.length - subExt.length);

    let matched = false;
    // 1. Nhóm bilingual
    for (let i = 0; i < BILINGUAL_SUFFIXES.length; i++) {
      if (stemMatches(stem, base, BILINGUAL_SUFFIXES[i])) {
        biCandidates.push({ entry, subExtRank, suffixRank: i });
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // 2. Nhóm en
    for (let i = 0; i < EN_SUFFIXES.length; i++) {
      if (stemMatches(stem, base, EN_SUFFIXES[i])) {
        enCandidates.push({ entry, subExtRank, suffixRank: i });
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // 3. Nhóm vi
    for (let i = 0; i < VI_SUFFIXES.length; i++) {
      if (stemMatches(stem, base, VI_SUFFIXES[i])) {
        viCandidates.push({ entry, subExtRank, suffixRank: i });
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // 4. Nhóm plain ("")
    if (stemMatches(stem, base, "")) {
      plainCandidates.push({ entry, subExtRank, suffixRank: 0 });
    }
  }

  const biRole = pickBestCandidate(biCandidates);
  let enRole = pickBestCandidate(enCandidates);
  if (enCandidates.length === 0) {
    enRole = pickBestCandidate(plainCandidates);
  }
  const viRole = pickBestCandidate(viCandidates);

  // Thứ tự quyết định & ambiguous theo §1:
  // 1. Vai trò bi ambiguous -> toàn bộ ambiguous
  if (biRole.status === "ambiguous") {
    return { status: "ambiguous" };
  }
  // Có bi hợp lệ -> bilingual
  if (biRole.status === "ok") {
    return { status: "bilingual", bi: biRole.entry };
  }

  // Vai trò en ambiguous -> ambiguous
  if (enRole.status === "ambiguous") {
    return { status: "ambiguous" };
  }

  // Có en hợp lệ
  if (enRole.status === "ok") {
    if (viRole.status === "ok") {
      // 2. Có en và vi -> pair
      return { status: "pair", en: enRole.entry, vi: viRole.entry };
    }
    // viRole là ambiguous mà en hợp lệ -> bỏ vi, trả en
    // viRole là none mà en hợp lệ -> trả en
    return { status: "en", en: enRole.entry };
  }

  // Không có en (enRole.status === "none")
  if (viRole.status === "ambiguous") {
    // viRole ambiguous mà không có en -> ambiguous
    return { status: "ambiguous" };
  }
  if (viRole.status === "ok") {
    // 4. Chỉ vi -> vi
    return { status: "vi", vi: viRole.entry };
  }

  // 5. Không có gì -> none
  return { status: "none" };
}

/**
 * Quyết định file nào trong entries là phụ đề của videoName (tương thích ngược Phase 9.5 D1).
 * Cài lại qua findSidecarSet.
 */
export function findSidecar(
  videoName: string,
  entries: readonly DriveEntry[]
): SidecarResult {
  const set = findSidecarSet(videoName, entries);
  switch (set.status) {
    case "bilingual":
      return { status: "match", entry: set.bi, kind: "bilingual" };
    case "pair":
      return { status: "match", entry: set.en, kind: "en" };
    case "en": {
      const base = normalizeName(stripExt(normalizeName(videoName), VIDEO_EXTS));
      const normName = normalizeName(set.en.name);
      let subExt = "";
      for (const ext of SUB_EXTS) {
        if (normName.endsWith(ext)) {
          subExt = ext;
          break;
        }
      }
      const stem = normName.slice(0, normName.length - subExt.length);
      const isEnSuffix = EN_SUFFIXES.some((s) => stemMatches(stem, base, s));
      return { status: "match", entry: set.en, kind: isEnSuffix ? "en" : "plain" };
    }
    case "ambiguous":
      return { status: "ambiguous" };
    case "vi":
    case "none":
      return { status: "none" };
  }
}
