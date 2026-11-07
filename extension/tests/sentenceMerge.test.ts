import { describe, it, expect } from "vitest";
import { mergeAsrCues } from "../src/shared/sentenceMerge";
import type { Cue } from "../src/shared/types";

describe("mergeAsrCues", () => {
  it("trả về mảng rỗng khi cues rỗng", () => {
    expect(mergeAsrCues([])).toEqual([]);
  });

  it("gộp các cue ASR liên tiếp cho tới khi gặp dấu kết câu", () => {
    const rawCues: Cue[] = [
      { start: 0.0, end: 1.0, text: "In this" },
      { start: 1.1, end: 2.0, text: "video tutorial," },
      { start: 2.1, end: 3.5, text: "we will learn Go." },
      { start: 4.0, end: 5.0, text: "Let's start now!" },
    ];

    const merged = mergeAsrCues(rawCues);
    expect(merged.length).toBe(2);

    expect(merged[0]).toEqual({
      start: 0.0,
      end: 3.5,
      text: "In this video tutorial, we will learn Go.",
    });

    expect(merged[1]).toEqual({
      start: 4.0,
      end: 5.0,
      text: "Let's start now!",
    });
  });

  it("ngắt nhóm khi khoảng lặng giữa 2 cue lớn hơn maxGapSec", () => {
    const rawCues: Cue[] = [
      { start: 0.0, end: 1.0, text: "Hello there" },
      // Khoảng lặng 2.0s > 1.2s mặc định
      { start: 3.0, end: 4.0, text: "welcome back" },
    ];

    const merged = mergeAsrCues(rawCues, { maxGapSec: 1.2 });
    expect(merged.length).toBe(2);
    expect(merged[0].text).toBe("Hello there");
    expect(merged[1].text).toBe("welcome back");
  });

  it("ngắt nhóm khi vượt quá maxDurSec hoặc maxChars", () => {
    const rawCues: Cue[] = [
      { start: 0.0, end: 4.0, text: "Part one" },
      // Tổng thời lượng nếu gộp là 8.0s > 7.0s
      { start: 4.2, end: 8.0, text: "part two" },
    ];

    const merged = mergeAsrCues(rawCues, { maxDurSec: 7.0 });
    expect(merged.length).toBe(2);
    expect(merged[0].text).toBe("Part one");
    expect(merged[1].text).toBe("part two");
  });

  it("hỗ trợ maxGapSec = 0 cho track thủ công chỉ gộp các đoạn dính liền", () => {
    const rawCues: Cue[] = [
      { start: 0.0, end: 1.0, text: "First part" },
      { start: 1.2, end: 2.0, text: "second part" },
    ];

    const merged = mergeAsrCues(rawCues, { maxGapSec: 0 });
    expect(merged.length).toBe(2);
  });
});
