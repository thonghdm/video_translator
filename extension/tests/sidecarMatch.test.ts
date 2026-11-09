import { describe, it, expect } from "vitest";
import {
  findSidecar,
  normalizeName,
  stripExt,
  VIDEO_EXTS,
  SUB_EXTS,
  type DriveEntry,
  type SidecarKind,
} from "../src/shared/sidecarMatch";

describe("Phase 9.5 D1 — sidecarMatch", () => {
  it("1. Ví dụ thật: 001 Step-01 Install CLI - Introduction.mp4 khớp file _en.srt ra match, kind en", () => {
    const video = "001 Step-01 Install CLI - Introduction.mp4";
    const entries: DriveEntry[] = [
      { id: "sub1", name: "001 Step-01 Install CLI - Introduction_en.srt" },
    ];
    const res = findSidecar(video, entries);
    expect(res).toEqual({
      status: "match",
      entry: { id: "sub1", name: "001 Step-01 Install CLI - Introduction_en.srt" },
      kind: "en",
    });
  });

  const suffixCases: Array<[string, SidecarKind]> = [
    ["_bilingual", "bilingual"],
    [".bilingual", "bilingual"],
    ["-bilingual", "bilingual"],
    [" bilingual", "bilingual"],
    ["_en", "en"],
    [".en", "en"],
    ["-en", "en"],
    [" en", "en"],
    ["_eng", "en"],
    [".eng", "en"],
    ["_english", "en"],
    [".english", "en"],
    [" (english)", "en"],
    [" [english]", "en"],
    ["", "plain"],
  ];

  it.each(suffixCases)(
    "2. Mỗi hậu tố ở bước 5 khớp đúng nhóm: '%s' -> %s",
    (suffix, expectedKind) => {
      const video = "Lesson 1.mp4";
      const entry: DriveEntry = { id: "id_" + suffix, name: `Lesson 1${suffix}.srt` };
      const res = findSidecar(video, [entry]);
      expect(res).toEqual({
        status: "match",
        entry,
        kind: expectedKind,
      });
    }
  );

  it("3. bilingual thắng en, en thắng plain", () => {
    const video = "Lesson.mp4";
    const eBilingual: DriveEntry = { id: "1", name: "Lesson_bilingual.srt" };
    const eEn: DriveEntry = { id: "2", name: "Lesson_en.srt" };
    const ePlain: DriveEntry = { id: "3", name: "Lesson.srt" };

    expect(findSidecar(video, [eEn, eBilingual, ePlain])).toEqual({
      status: "match",
      entry: eBilingual,
      kind: "bilingual",
    });

    expect(findSidecar(video, [ePlain, eEn])).toEqual({
      status: "match",
      entry: eEn,
      kind: "en",
    });
  });

  it("4. .srt thắng .vtt cùng nhóm", () => {
    const video = "Lesson.mp4";
    const srt: DriveEntry = { id: "1", name: "Lesson_en.srt" };
    const vtt: DriveEntry = { id: "2", name: "Lesson_en.vtt" };
    const res = findSidecar(video, [vtt, srt]);
    expect(res).toEqual({
      status: "match",
      entry: srt,
      kind: "en",
    });
  });

  it("5. Hoa thường lẫn lộn (Intro.MP4 khớp intro_EN.SRT)", () => {
    const video = "Intro.MP4";
    const sub: DriveEntry = { id: "1", name: "intro_EN.SRT" };
    const res = findSidecar(video, [sub]);
    expect(res).toEqual({
      status: "match",
      entry: sub,
      kind: "en",
    });
  });

  it("6. NFD ↔ NFC (tên dựng bằng NFD vẫn khớp NFC)", () => {
    const videoNfd = "Bài 1".normalize("NFD") + ".mp4";
    const subNfc: DriveEntry = { id: "1", name: "Bài 1".normalize("NFC") + "_en.srt" };
    const res = findSidecar(videoNfd, [subNfc]);
    expect(res).toEqual({
      status: "match",
      entry: subNfc,
      kind: "en",
    });
  });

  it("7. Khoảng trắng đôi và khoảng trắng không ngắt (\\u00A0)", () => {
    const video = "Bài  1\u00A0phần 2.mp4";
    const sub: DriveEntry = { id: "1", name: "Bài 1  phần  2_en.srt" };
    const res = findSidecar(video, [sub]);
    expect(res).toEqual({
      status: "match",
      entry: sub,
      kind: "en",
    });
  });

  it("8. 0010 a_en.srt và 001 a part2_en.srt không khớp 001 a.mp4", () => {
    const video = "001 a.mp4";
    const sub1: DriveEntry = { id: "1", name: "0010 a_en.srt" };
    const sub2: DriveEntry = { id: "2", name: "001 a part2_en.srt" };
    expect(findSidecar(video, [sub1, sub2])).toEqual({ status: "none" });
  });

  it("9. Đuôi giả .srt.txt không khớp", () => {
    const video = "Lesson.mp4";
    const sub: DriveEntry = { id: "1", name: "Lesson_en.srt.txt" };
    expect(findSidecar(video, [sub])).toEqual({ status: "none" });
  });

  it("10. _vi.srt bị bỏ qua; chỉ có _vi.srt → none", () => {
    const video = "Lesson.mp4";
    const viSub: DriveEntry = { id: "1", name: "Lesson_vi.srt" };
    const vieSub: DriveEntry = { id: "2", name: "Lesson.vie.srt" };
    expect(findSidecar(video, [viSub, vieSub])).toEqual({ status: "none" });
  });

  it("11. Hai ứng viên khác id ngang hạng → ambiguous; trùng id → match", () => {
    const video = "Lesson.mp4";
    const subA: DriveEntry = { id: "id1", name: "Lesson_en.srt" };
    const subB: DriveEntry = { id: "id2", name: "Lesson_en.srt" };
    expect(findSidecar(video, [subA, subB])).toEqual({ status: "ambiguous" });

    const subDup: DriveEntry = { id: "id1", name: "Lesson_en.srt" };
    expect(findSidecar(video, [subA, subDup])).toEqual({
      status: "match",
      entry: subA,
      kind: "en",
    });
  });

  it("12. Tên video không có đuôi (tiêu đề preview) vẫn khớp", () => {
    const video = "001 Step-01 Install CLI - Introduction";
    const sub: DriveEntry = { id: "1", name: "001 Step-01 Install CLI - Introduction_en.srt" };
    expect(findSidecar(video, [sub])).toEqual({
      status: "match",
      entry: sub,
      kind: "en",
    });
  });

  it("13. Danh sách rỗng → none; videoName rỗng → none", () => {
    expect(findSidecar("Lesson.mp4", [])).toEqual({ status: "none" });
    expect(findSidecar("", [{ id: "1", name: "Lesson_en.srt" }])).toEqual({ status: "none" });
    expect(findSidecar("   .mp4", [{ id: "1", name: "Lesson_en.srt" }])).toEqual({ status: "none" });
  });

  it("14. Tên chứa ký tự regex: ( [ + . $ khớp đúng", () => {
    const video = "Lesson 1 (C++) [v2] cost $100.mp4";
    const sub: DriveEntry = { id: "1", name: "Lesson 1 (C++) [v2] cost $100_en.srt" };
    expect(findSidecar(video, [sub])).toEqual({
      status: "match",
      entry: sub,
      kind: "en",
    });
  });

  it("15. File .mp4 cùng tên không bị coi là phụ đề", () => {
    const video = "Lesson.mp4";
    const mp4Entry: DriveEntry = { id: "1", name: "Lesson.mp4" };
    expect(findSidecar(video, [mp4Entry])).toEqual({ status: "none" });
  });

  it("16. Khoảng trắng thừa: tiêu đề có dấu cách cuối, và dấu cách trước đuôi file", () => {
    const sub: DriveEntry = { id: "1", name: "Lesson_en.srt" };
    expect(findSidecar("Lesson.mp4 ", [sub])).toEqual({ status: "match", entry: sub, kind: "en" });
    const subSp: DriveEntry = { id: "2", name: "Lesson _en.srt" };
    expect(findSidecar("Lesson .mp4", [subSp])).toEqual({ status: "match", entry: subSp, kind: "en" });
    const plainSp: DriveEntry = { id: "3", name: "Lesson .srt" };
    expect(findSidecar("Lesson .mp4", [plainSp])).toEqual({ status: "match", entry: plainSp, kind: "plain" });
    // khoảng trắng không được làm khớp nhầm tên khác
    expect(findSidecar("Lesson.mp4", [{ id: "4", name: "Lesson 2_en.srt" }])).toEqual({ status: "none" });
  });

  it.each(["Lesson.en-US.srt", "Lesson_en-US.srt", "Lesson-en-us.srt", "Lesson_en_US.srt", "Lesson.en_US.vtt"])(
    "17. Hậu tố có mã vùng tiếng Anh: %s → en",
    (name) => {
      const sub: DriveEntry = { id: "1", name };
      expect(findSidecar("Lesson.mp4", [sub])).toEqual({ status: "match", entry: sub, kind: "en" });
    }
  );

  it("các hằng số và hàm tiện ích normalizeName, stripExt xuất đúng chuẩn", () => {
    expect(VIDEO_EXTS).toContain(".mp4");
    expect(SUB_EXTS).toContain(".srt");
    expect(stripExt("Movie.MP4", VIDEO_EXTS)).toBe("Movie");
    expect(normalizeName("  BÀI  1\u00A0 ")).toBe("bài 1");
  });

  it("18. findSidecar cài lại qua findSidecarSet vẫn chọn _en khi có cả _en và _vi", () => {
    const video = "Lesson.mp4";
    const en: DriveEntry = { id: "1", name: "Lesson_en.srt" };
    const vi: DriveEntry = { id: "2", name: "Lesson_vi.srt" };
    expect(findSidecar(video, [vi, en])).toEqual({
      status: "match",
      entry: en,
      kind: "en",
    });
  });
});
