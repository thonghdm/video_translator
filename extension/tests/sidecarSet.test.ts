import { describe, it, expect } from "vitest";
import {
  findSidecarSet,
  VI_SUFFIXES,
  type DriveEntry,
} from "../src/shared/sidecarMatch";

describe("Phase 9.6 E1 — sidecarSet (findSidecarSet)", () => {
  // 1. Ví dụ thật: 001 Introduction.mp4 + 001 Introduction_en.srt + 001 Introduction_vi.srt → pair
  it("1. Ví dụ thật: 001 Introduction.mp4 + 001 Introduction_en.srt + 001 Introduction_vi.srt → pair", () => {
    const video = "001 Introduction.mp4";
    const en: DriveEntry = { id: "id_en", name: "001 Introduction_en.srt" };
    const vi: DriveEntry = { id: "id_vi", name: "001 Introduction_vi.srt" };
    const res = findSidecarSet(video, [vi, en]);
    expect(res).toEqual({
      status: "pair",
      en,
      vi,
    });
  });

  // 2. Chỉ _en → en; chỉ X.srt → en (plain); chỉ _vi → vi
  it("2. Chỉ _en → en; chỉ X.srt → en (plain); chỉ _vi → vi", () => {
    const video = "Lesson 1.mp4";
    const en: DriveEntry = { id: "1", name: "Lesson 1_en.srt" };
    const plain: DriveEntry = { id: "2", name: "Lesson 1.srt" };
    const vi: DriveEntry = { id: "3", name: "Lesson 1_vi.srt" };

    expect(findSidecarSet(video, [en])).toEqual({
      status: "en",
      en,
    });

    expect(findSidecarSet(video, [plain])).toEqual({
      status: "en",
      en: plain,
    });

    expect(findSidecarSet(video, [vi])).toEqual({
      status: "vi",
      vi,
    });
  });

  // 3. _bilingual + _en + _vi → bilingual
  it("3. _bilingual + _en + _vi → bilingual (bilingual ưu tiên cao nhất)", () => {
    const video = "Lesson.mp4";
    const bi: DriveEntry = { id: "1", name: "Lesson_bilingual.srt" };
    const en: DriveEntry = { id: "2", name: "Lesson_en.srt" };
    const vi: DriveEntry = { id: "3", name: "Lesson_vi.srt" };

    const res = findSidecarSet(video, [vi, en, bi]);
    expect(res).toEqual({
      status: "bilingual",
      bi,
    });
  });

  // 4. _en + X.srt + _vi → pair với en = file _en (nhóm en thắng plain)
  it("4. _en + X.srt + _vi → pair với en = file _en (nhóm en thắng plain)", () => {
    const video = "Lesson.mp4";
    const en: DriveEntry = { id: "1", name: "Lesson_en.srt" };
    const plain: DriveEntry = { id: "2", name: "Lesson.srt" };
    const vi: DriveEntry = { id: "3", name: "Lesson_vi.srt" };

    const res = findSidecarSet(video, [plain, vi, en]);
    expect(res).toEqual({
      status: "pair",
      en,
      vi,
    });
  });

  // 5. Mỗi hậu tố VI ở §1 (it.each) → vi
  it.each(VI_SUFFIXES)(
    "5. Mỗi hậu tố VI ở §1: '%s' → vi",
    (suffix) => {
      const video = "Lesson 1.mp4";
      const entry: DriveEntry = { id: "id_" + suffix, name: `Lesson 1${suffix}.srt` };
      const res = findSidecarSet(video, [entry]);
      expect(res).toEqual({
        status: "vi",
        vi: entry,
      });
    }
  );

  // 6. .srt thắng .vtt trong nhóm vi
  it("6. .srt thắng .vtt trong nhóm vi", () => {
    const video = "Lesson.mp4";
    const srt: DriveEntry = { id: "1", name: "Lesson_vi.srt" };
    const vtt: DriveEntry = { id: "2", name: "Lesson_vi.vtt" };
    const res = findSidecarSet(video, [vtt, srt]);
    expect(res).toEqual({
      status: "vi",
      vi: srt,
    });
  });

  // 7. Hai _vi khác id + một _en → en (bỏ vi). Hai _vi, không _en → ambiguous
  it("7. Hai _vi khác id + một _en → en (bỏ vi). Hai _vi, không _en → ambiguous", () => {
    const video = "Lesson.mp4";
    const vi1: DriveEntry = { id: "vi1", name: "Lesson_vi.srt" };
    const vi2: DriveEntry = { id: "vi2", name: "Lesson_vi.srt" };
    const en: DriveEntry = { id: "en1", name: "Lesson_en.srt" };

    // Có en hợp lệ: vi ambiguous bị bỏ qua, trả en
    expect(findSidecarSet(video, [vi1, vi2, en])).toEqual({
      status: "en",
      en,
    });

    // Không có en: vi ambiguous dẫn tới ambiguous toàn bộ
    expect(findSidecarSet(video, [vi1, vi2])).toEqual({
      status: "ambiguous",
    });
  });

  // 8. Hai _en khác id → ambiguous
  it("8. Hai _en khác id → ambiguous (kể cả khi có _vi)", () => {
    const video = "Lesson.mp4";
    const en1: DriveEntry = { id: "en1", name: "Lesson_en.srt" };
    const en2: DriveEntry = { id: "en2", name: "Lesson_en.srt" };
    const vi: DriveEntry = { id: "vi1", name: "Lesson_vi.srt" };

    expect(findSidecarSet(video, [en1, en2])).toEqual({
      status: "ambiguous",
    });

    expect(findSidecarSet(video, [en1, en2, vi])).toEqual({
      status: "ambiguous",
    });
  });

  // 9. 001 a.mp4 không ăn 0010 a_vi.srt hay 001 a part2_vi.srt
  it("9. 001 a.mp4 không ăn 0010 a_vi.srt hay 001 a part2_vi.srt", () => {
    const video = "001 a.mp4";
    const sub1: DriveEntry = { id: "1", name: "0010 a_vi.srt" };
    const sub2: DriveEntry = { id: "2", name: "001 a part2_vi.srt" };
    expect(findSidecarSet(video, [sub1, sub2])).toEqual({
      status: "none",
    });
  });

  // 10. Video tên abc_vi.mp4 + abc_vi_en.srt → en
  it("10. Video tên abc_vi.mp4 + abc_vi_en.srt → en", () => {
    const video = "abc_vi.mp4";
    const enSub: DriveEntry = { id: "1", name: "abc_vi_en.srt" };
    expect(findSidecarSet(video, [enSub])).toEqual({
      status: "en",
      en: enSub,
    });
  });

  // 11. Danh sách rỗng / tên rỗng → none
  it("11. Danh sách rỗng / tên rỗng → none", () => {
    expect(findSidecarSet("Lesson.mp4", [])).toEqual({ status: "none" });
    expect(findSidecarSet("", [{ id: "1", name: "Lesson_en.srt" }])).toEqual({ status: "none" });
    expect(findSidecarSet("   .mp4", [{ id: "1", name: "Lesson_en.srt" }])).toEqual({ status: "none" });
  });
});
