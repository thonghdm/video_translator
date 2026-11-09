/**
 * SubTrans Extension — Unit tests cho ghép phụ đề EN + VI (Phase 9.6 E2)
 */

import { describe, it, expect } from "vitest";
import {
  mergeEnVi,
  parseViForced,
  PAIR_MIN_OVERLAP,
  PAIR_MIN_RATIO,
} from "../src/shared/subtitlePair";
import type { SubtitleItem } from "../src/shared/types";
import { parseSrtOrVttBilingual } from "../src/shared/subtitleFormat";

describe("Phase 9.6 E2: subtitlePair", () => {
  it("Khớp 1-1 → ratio 1", () => {
    const en: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 1.0,
        end_sec: 3.0,
        source_text: "Hello world",
        target_text: "",
        translated: false,
        engine: null,
      },
    ];
    const vi: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 1.0,
        end_sec: 3.0,
        source_text: "",
        target_text: "Xin chào thế giới",
        translated: true,
        engine: "file",
      },
    ];

    const res = mergeEnVi(en, vi);
    expect(res.stats).toEqual({ total: 1, matched: 1, ratio: 1 });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toEqual({
      id: 0,
      block: 0,
      start_sec: 1.0,
      end_sec: 3.0,
      source_text: "Hello world",
      target_text: "Xin chào thế giới",
      translated: true,
      engine: "file",
    });
  });

  it("1 EN : 2 VI → nối đúng thứ tự", () => {
    const en: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 1.0,
        end_sec: 5.0,
        source_text: "Hello and welcome",
        target_text: "",
        translated: false,
        engine: null,
      },
    ];
    const vi: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 1.0,
        end_sec: 2.8,
        source_text: "",
        target_text: "Xin chào",
        translated: true,
        engine: "file",
      },
      {
        id: 1,
        block: 0,
        start_sec: 3.0,
        end_sec: 4.8,
        source_text: "",
        target_text: "và chào mừng",
        translated: true,
        engine: "file",
      },
    ];

    const res = mergeEnVi(en, vi);
    expect(res.stats).toEqual({ total: 1, matched: 1, ratio: 1 });
    expect(res.items[0].target_text).toBe("Xin chào và chào mừng");
    expect(res.items[0].translated).toBe(true);
    expect(res.items[0].engine).toBe("file");
  });

  it("2 EN : 1 VI → VI chỉ vào câu chồng lấn nhiều hơn", () => {
    const en: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 1.0,
        end_sec: 3.0,
        source_text: "First sentence",
        target_text: "",
        translated: false,
        engine: null,
      },
      {
        id: 1,
        block: 0,
        start_sec: 3.0,
        end_sec: 5.0,
        source_text: "Second sentence",
        target_text: "",
        translated: false,
        engine: null,
      },
    ];
    // VI cue: 2.6 -> 4.8.
    // Overlap EN 0: 3.0 - 2.6 = 0.4s (minDur=2.0s -> 0.2 < 0.5)
    // Overlap EN 1: 4.8 - 3.0 = 1.8s (minDur=2.0s -> 0.9 >= 0.5)
    const vi: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 2.6,
        end_sec: 4.8,
        source_text: "",
        target_text: "Câu thứ hai",
        translated: true,
        engine: "file",
      },
    ];

    const res = mergeEnVi(en, vi);
    expect(res.stats).toEqual({ total: 2, matched: 1, ratio: 0.5 });
    expect(res.items[0].target_text).toBe("");
    expect(res.items[0].translated).toBe(false);
    expect(res.items[1].target_text).toBe("Câu thứ hai");
    expect(res.items[1].translated).toBe(true);
    expect(res.items[1].engine).toBe("file");
  });

  it("Lệch 200 ms vẫn khớp", () => {
    const en: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 1.0,
        end_sec: 3.0,
        source_text: "Hello",
        target_text: "",
        translated: false,
        engine: null,
      },
    ];
    const vi: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 1.2,
        end_sec: 3.2,
        source_text: "",
        target_text: "Xin chào",
        translated: true,
        engine: "file",
      },
    ];

    const res = mergeEnVi(en, vi);
    expect(res.stats.ratio).toBe(1);
    expect(res.items[0].target_text).toBe("Xin chào");
    expect(res.items[0].translated).toBe(true);
  });

  it("Lệch 5 s → ratio thấp (< PAIR_MIN_RATIO)", () => {
    const en: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 1.0,
        end_sec: 3.0,
        source_text: "Hello",
        target_text: "",
        translated: false,
        engine: null,
      },
    ];
    const vi: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 6.0,
        end_sec: 8.0,
        source_text: "",
        target_text: "Xin chào",
        translated: true,
        engine: "file",
      },
    ];

    const res = mergeEnVi(en, vi);
    expect(res.stats.ratio).toBe(0);
    expect(res.stats.ratio).toBeLessThan(PAIR_MIN_RATIO);
    expect(res.items[0].translated).toBe(false);
  });

  it("VI thừa ở cuối bị bỏ", () => {
    const en: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 1.0,
        end_sec: 3.0,
        source_text: "Hello",
        target_text: "",
        translated: false,
        engine: null,
      },
    ];
    const vi: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 1.0,
        end_sec: 3.0,
        source_text: "",
        target_text: "Xin chào",
        translated: true,
        engine: "file",
      },
      {
        id: 1,
        block: 0,
        start_sec: 10.0,
        end_sec: 12.0,
        source_text: "",
        target_text: "Dư thừa",
        translated: true,
        engine: "file",
      },
    ];

    const res = mergeEnVi(en, vi);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].target_text).toBe("Xin chào");
    expect(res.stats).toEqual({ total: 1, matched: 1, ratio: 1 });
  });

  it("EN không có VI giữ translated = false", () => {
    const en: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 1.0,
        end_sec: 3.0,
        source_text: "Sentence 1",
        target_text: "",
        translated: false,
        engine: null,
      },
      {
        id: 1,
        block: 0,
        start_sec: 5.0,
        end_sec: 7.0,
        source_text: "Sentence 2",
        target_text: "",
        translated: false,
        engine: null,
      },
    ];
    const vi: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 1.0,
        end_sec: 3.0,
        source_text: "",
        target_text: "Câu 1",
        translated: true,
        engine: "file",
      },
    ];

    const res = mergeEnVi(en, vi);
    expect(res.items[0].translated).toBe(true);
    expect(res.items[0].target_text).toBe("Câu 1");
    expect(res.items[1].translated).toBe(false);
    expect(res.items[1].target_text).toBe("");
    expect(res.items[1].engine).toBeNull();
    expect(res.stats).toEqual({ total: 2, matched: 1, ratio: 0.5 });
  });

  it("Câu EN không có VI nhưng bản thân đã có target_text song ngữ thì giữ nguyên", () => {
    const en: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 1.0,
        end_sec: 3.0,
        source_text: "Already translated",
        target_text: "Đã có dịch sẵn",
        translated: true,
        engine: "file",
      },
    ];
    const vi: SubtitleItem[] = [];

    const res = mergeEnVi(en, vi);
    expect(res.items[0].target_text).toBe("Đã có dịch sẵn");
    expect(res.items[0].translated).toBe(true);
    expect(res.items[0].engine).toBe("file");
    expect(res.stats).toEqual({ total: 1, matched: 0, ratio: 0 });
  });

  it("Câu VI không dấu ('AWS', 'OK') vẫn được ghép", () => {
    const viSrt = `1
00:00:01,000 --> 00:00:03,000
AWS

2
00:00:04,000 --> 00:00:06,000
OK
`;
    const viParsed = parseViForced(viSrt);
    expect(viParsed).toHaveLength(2);
    expect(viParsed[0].target_text).toBe("AWS");
    expect(viParsed[0].source_text).toBe("");
    expect(viParsed[0].translated).toBe(true);
    expect(viParsed[0].engine).toBe("file");
    expect(viParsed[1].target_text).toBe("OK");

    const en: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 1.0,
        end_sec: 3.0,
        source_text: "Amazon Web Services",
        target_text: "",
        translated: false,
        engine: null,
      },
      {
        id: 1,
        block: 0,
        start_sec: 4.0,
        end_sec: 6.0,
        source_text: "Alright",
        target_text: "",
        translated: false,
        engine: null,
      },
    ];

    const res = mergeEnVi(en, viParsed);
    expect(res.items[0].target_text).toBe("AWS");
    expect(res.items[0].translated).toBe(true);
    expect(res.items[0].engine).toBe("file");
    expect(res.items[1].target_text).toBe("OK");
    expect(res.items[1].translated).toBe(true);
    expect(res.items[1].engine).toBe("file");
    expect(res.stats.ratio).toBe(1);
  });

  it("Mảng rỗng", () => {
    expect(mergeEnVi([], [])).toEqual({
      items: [],
      stats: { total: 0, matched: 0, ratio: 0 },
    });

    const sample: SubtitleItem = {
      id: 0,
      block: 0,
      start_sec: 1,
      end_sec: 2,
      source_text: "A",
      target_text: "",
      translated: false,
      engine: null,
    };

    expect(mergeEnVi([sample], [])).toEqual({
      items: [sample],
      stats: { total: 1, matched: 0, ratio: 0 },
    });

    expect(mergeEnVi([], [sample])).toEqual({
      items: [],
      stats: { total: 0, matched: 0, ratio: 0 },
    });
  });

  it("2000 câu chạy < 50 ms", () => {
    const en2000: SubtitleItem[] = [];
    const vi2000: SubtitleItem[] = [];
    for (let i = 0; i < 2000; i++) {
      en2000.push({
        id: i,
        block: 0,
        start_sec: i * 3,
        end_sec: i * 3 + 2.5,
        source_text: `Sentence ${i}`,
        target_text: "",
        translated: false,
        engine: null,
      });
      vi2000.push({
        id: i,
        block: 0,
        start_sec: i * 3 + 0.1,
        end_sec: i * 3 + 2.4,
        source_text: "",
        target_text: `Câu ${i}`,
        translated: true,
        engine: "file",
      });
    }

    const t0 = performance.now();
    const res = mergeEnVi(en2000, vi2000);
    const duration = performance.now() - t0;

    expect(duration).toBeLessThan(50);
    expect(res.items).toHaveLength(2000);
    expect(res.stats).toEqual({ total: 2000, matched: 2000, ratio: 1 });
    expect(res.items[0].target_text).toBe("Câu 0");
    expect(res.items[1999].target_text).toBe("Câu 1999");
  });

  it("Tỷ lệ chồng lấn < 0.5 không được gán", () => {
    const en: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 1.0,
        end_sec: 3.0,
        source_text: "Hello",
        target_text: "",
        translated: false,
        engine: null,
      },
    ];
    // durA = 2.0s, durB = 2.0s, overlap = 0.9s -> overlap/minDur = 0.45 < PAIR_MIN_OVERLAP
    const vi: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 2.1,
        end_sec: 4.1,
        source_text: "",
        target_text: "Xin chào",
        translated: true,
        engine: "file",
      },
    ];

    const res = mergeEnVi(en, vi);
    expect(res.stats.matched).toBe(0);
    expect(res.stats.ratio).toBe(0);
    expect(res.items[0].translated).toBe(false);
    expect(PAIR_MIN_OVERLAP).toBe(0.5);
  });
});

describe("Review E2", () => {
  const srtOf = (rows: Array<[number, number, string]>) =>
    rows
      .map(([s, e, t], i) => `${i + 1}\n00:00:${String(s).padStart(2, "0")},000 --> 00:00:${String(e).padStart(2, "0")},000\n${t}\n`)
      .join("\n");

  it("file VI không theo thứ tự thời gian vẫn ghép đủ", () => {
    const en = parseSrtOrVttBilingual(srtOf([[1, 3, "Hello"], [4, 6, "World"], [7, 9, "Bye"]]));
    const vi = parseViForced(srtOf([[7, 9, "Tạm biệt"], [1, 3, "Xin chào"], [4, 6, "Thế giới"]]));
    const { items, stats } = mergeEnVi(en, vi);
    expect(stats.ratio).toBe(1);
    expect(items.map((i) => i.target_text)).toEqual(["Xin chào", "Thế giới", "Tạm biệt"]);
  });

  it("file EN không theo thứ tự: giữ nguyên thứ tự/id EN, vẫn ghép đúng", () => {
    const en = parseSrtOrVttBilingual(srtOf([[7, 9, "Bye"], [1, 3, "Hello"]]));
    const vi = parseViForced(srtOf([[1, 3, "Xin chào"], [7, 9, "Tạm biệt"]]));
    const { items } = mergeEnVi(en, vi);
    expect(items.map((i) => [i.id, i.source_text, i.target_text])).toEqual([
      [en[0].id, "Bye", "Tạm biệt"],
      [en[1].id, "Hello", "Xin chào"],
    ]);
  });
});
