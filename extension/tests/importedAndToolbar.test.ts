/**
 * Unit tests cho Phase 8: Nhập/xuất phụ đề, ImportedSubtitleSource, Round-trip, và Timing Offset
 */

import { describe, it, expect } from "vitest";
import { ImportedSubtitleSource } from "../src/content/adapters/imported";
import { buildSubtitleContent } from "../src/shared/subtitleFormat";
import type { SubtitleItem } from "../src/shared/types";
import { fnv1a32 } from "../src/shared/hash";

describe("Phase 8: ImportedSubtitleSource", () => {
  const sampleBilingualSrt = `1
00:00:01,000 --> 00:00:03,500
Hello everyone
Xin chào mọi người

2
00:00:04,200 --> 00:00:07,800
Welcome to TypeScript and React
Chào mừng đến với TypeScript và React
`;

  const sampleEnOnlySrt = `1
00:00:01,000 --> 00:00:03,500
Hello world

2
00:00:04,000 --> 00:00:06,000
This is an English only subtitle
`;

  it("đọc file SRT song ngữ: nhận diện đúng source_text, target_text, translated = true và engine = 'file'", async () => {
    const source = new ImportedSubtitleSource("course_bilingual.srt", sampleBilingualSrt);
    const cues = await source.load();
    const initialItems = source.getInitialItems();

    expect(cues).toHaveLength(2);
    expect(initialItems).toHaveLength(2);

    expect(initialItems[0].source_text).toBe("Hello everyone");
    expect(initialItems[0].target_text).toBe("Xin chào mọi người");
    expect(initialItems[0].translated).toBe(true);
    expect(initialItems[0].engine).toBe("file");
    expect(initialItems[0].start_sec).toBe(1.0);
    expect(initialItems[0].end_sec).toBe(3.5);

    expect(initialItems[1].source_text).toBe("Welcome to TypeScript and React");
    expect(initialItems[1].target_text).toBe("Chào mừng đến với TypeScript và React");
    expect(initialItems[1].translated).toBe(true);
    expect(initialItems[1].engine).toBe("file");
  });

  it("đọc file SRT chỉ tiếng Anh: target_text rỗng, translated = false, engine = null", async () => {
    const source = new ImportedSubtitleSource("english.srt", sampleEnOnlySrt);
    const initialItems = source.getInitialItems();

    expect(initialItems).toHaveLength(2);
    expect(initialItems[0].source_text).toBe("Hello world");
    expect(initialItems[0].target_text).toBe("");
    expect(initialItems[0].translated).toBe(false);
    expect(initialItems[0].engine).toBe(null);
  });

  it("trackKey được tạo đúng theo PLAN 6.4: file:fileName:fnv1a(content)", () => {
    const fileName = "test_sub.srt";
    const source = new ImportedSubtitleSource(fileName, sampleBilingualSrt);
    const expectedHash = fnv1a32(sampleBilingualSrt);

    expect(source.track.trackKey).toBe(`file:${fileName}:${expectedHash}`);
    expect(source.track.platform).toBe("file");
    expect(source.track.kind).toBe("imported");
    expect(source.track.title).toBe("test_sub");
  });
});

describe("Phase 8: Round-trip Xuất -> Nhập", () => {
  const originalItems: SubtitleItem[] = [
    {
      id: 0,
      block: 0,
      start_sec: 2.5,
      end_sec: 5.0,
      source_text: "Let's build a browser extension",
      target_text: "Hãy cùng xây dựng một tiện ích mở rộng",
      translated: true,
      engine: "api",
    },
    {
      id: 1,
      block: 1,
      start_sec: 5.5,
      end_sec: 8.25,
      source_text: "It works smoothly on YouTube",
      target_text: "Nó hoạt động mượt mà trên YouTube",
      translated: true,
      engine: "cloud",
    },
  ];

  it("round-trip SRT song ngữ: xuất từ items rồi nhập lại cho đúng nội dung", () => {
    // 1. Xuất ra SRT song ngữ
    const srt = buildSubtitleContent(originalItems, "srt", "bilingual");

    // 2. Nhập lại qua ImportedSubtitleSource
    const imported = new ImportedSubtitleSource("export_bilingual.srt", srt);
    const items = imported.getInitialItems();

    expect(items).toHaveLength(2);
    expect(items[0].start_sec).toBe(2.5);
    expect(items[0].end_sec).toBe(5.0);
    expect(items[0].source_text).toBe(originalItems[0].source_text);
    expect(items[0].target_text).toBe(originalItems[0].target_text);
    expect(items[0].translated).toBe(true);
    expect(items[0].engine).toBe("file");

    expect(items[1].start_sec).toBe(5.5);
    expect(items[1].end_sec).toBe(8.25);
    expect(items[1].source_text).toBe(originalItems[1].source_text);
    expect(items[1].target_text).toBe(originalItems[1].target_text);
  });

  it("round-trip VTT song ngữ: xuất ra VTT rồi nhập lại cho đúng nội dung", () => {
    const vtt = buildSubtitleContent(originalItems, "vtt", "bilingual");
    const imported = new ImportedSubtitleSource("export.vtt", vtt);
    const items = imported.getInitialItems();

    expect(items).toHaveLength(2);
    expect(items[0].source_text).toBe(originalItems[0].source_text);
    expect(items[0].target_text).toBe(originalItems[0].target_text);
  });
});

describe("Phase 8: Timing Offset Math", () => {
  it("làm tròn 0.1s tránh lỗi số chấm động của JavaScript", () => {
    let offset = 0;
    // Tăng 3 lần 0.1s
    offset = Math.round((offset + 0.1) * 10) / 10;
    offset = Math.round((offset + 0.1) * 10) / 10;
    offset = Math.round((offset + 0.1) * 10) / 10;
    expect(offset).toBe(0.3);

    // Giảm 4 lần 0.1s
    offset = Math.round((offset - 0.1) * 10) / 10;
    offset = Math.round((offset - 0.1) * 10) / 10;
    offset = Math.round((offset - 0.1) * 10) / 10;
    offset = Math.round((offset - 0.1) * 10) / 10;
    expect(offset).toBe(-0.1);
  });
});
