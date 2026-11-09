/**
 * SubTrans Extension — So khớp tên file phụ đề đi kèm (Sidecar Matcher)
 * Phase 9.5 D1: Hàm thuần quyết định file nào là phụ đề tương ứng của video
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

const BILINGUAL_SUFFIXES = [
  "_bilingual",
  ".bilingual",
  "-bilingual",
  " bilingual",
] as const;

const EN_SUFFIXES = [
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

const VI_SUFFIXES = ["_vi", ".vi", "-vi", "_vie", ".vie"] as const;

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
function stemMatches(stem: string, base: string, suffix: string): boolean {
  if (!stem.endsWith(suffix)) return false;
  const rest = stem.slice(0, stem.length - suffix.length);
  return rest === base || rest.trimEnd() === base;
}

interface MatchCandidate {
  entry: DriveEntry;
  kind: SidecarKind;
  groupRank: number; // 0: bilingual, 1: en, 2: plain
  subExtRank: number; // 0: .srt, 1: .vtt
  suffixRank: number; // vị trí trong mảng suffix của group
}

/**
 * Quyết định file nào trong entries là phụ đề của videoName.
 * Hàm thuần: không đụng DOM, chrome API, fetch hay Date.
 */
export function findSidecar(
  videoName: string,
  entries: readonly DriveEntry[]
): SidecarResult {
  // Chuẩn hoá TRƯỚC khi cắt đuôi: tiêu đề preview/tên file có thể dư khoảng trắng ở cuối ("Lesson.mp4 ")
  const base = normalizeName(stripExt(normalizeName(videoName), VIDEO_EXTS));
  // 10. base rỗng -> none
  if (base === "") {
    return { status: "none" };
  }

  const candidates: MatchCandidate[] = [];

  for (const entry of entries) {
    const normEntryName = normalizeName(entry.name);

    // 4. Entry là ứng viên khi kết thúc bằng một đuôi trong SUB_EXTS
    let subExt = "";
    for (const ext of SUB_EXTS) {
      if (normEntryName.endsWith(ext)) {
        subExt = ext;
        break;
      }
    }
    if (!subExt) continue;

    const stem = normEntryName.slice(0, normEntryName.length - subExt.length);

    // 9. stem kết thúc bằng _vi, .vi, -vi, _vie, .vie không bao giờ được chọn
    if (VI_SUFFIXES.some((vi) => stem.endsWith(vi))) {
      continue;
    }

    const subExtRank = subExt === ".srt" ? 0 : 1;

    // 5 & 6. Khớp khi và chỉ khi stem === base + suffix (so toàn bộ chuỗi)
    // Nhóm 1: bilingual
    let matched = false;
    for (let i = 0; i < BILINGUAL_SUFFIXES.length; i++) {
      const suffix = BILINGUAL_SUFFIXES[i];
      if (stemMatches(stem, base, suffix)) {
        candidates.push({
          entry,
          kind: "bilingual",
          groupRank: 0,
          subExtRank,
          suffixRank: i,
        });
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Nhóm 2: en
    for (let i = 0; i < EN_SUFFIXES.length; i++) {
      const suffix = EN_SUFFIXES[i];
      if (stemMatches(stem, base, suffix)) {
        candidates.push({
          entry,
          kind: "en",
          groupRank: 1,
          subExtRank,
          suffixRank: i,
        });
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Nhóm 3: plain ("")
    if (stemMatches(stem, base, "")) {
      candidates.push({
        entry,
        kind: "plain",
        groupRank: 2,
        subExtRank,
        suffixRank: 0,
      });
    }
  }

  if (candidates.length === 0) {
    return { status: "none" };
  }

  // 7. Chọn nhóm có ưu tiên cao nhất có ứng viên
  let bestGroupRank = 2;
  for (const c of candidates) {
    if (c.groupRank < bestGroupRank) {
      bestGroupRank = c.groupRank;
    }
  }
  const groupCandidates = candidates.filter((c) => c.groupRank === bestGroupRank);

  // Trong nhóm: .srt thắng .vtt (subExtRank asc), rồi tới hậu tố đứng trước (suffixRank asc)
  groupCandidates.sort((a, b) => {
    if (a.subExtRank !== b.subExtRank) {
      return a.subExtRank - b.subExtRank;
    }
    return a.suffixRank - b.suffixRank;
  });

  const best = groupCandidates[0];
  const topTied = groupCandidates.filter(
    (c) => c.subExtRank === best.subExtRank && c.suffixRank === best.suffixRank
  );

  // 8. Còn >= 2 ứng viên khác id ngang hạng nhau -> ambiguous. Trùng id -> tính là 1
  const uniqueIds = new Set(topTied.map((c) => c.entry.id));
  if (uniqueIds.size > 1) {
    return { status: "ambiguous" };
  }

  return {
    status: "match",
    entry: topTied[0].entry,
    kind: best.kind,
  };
}
