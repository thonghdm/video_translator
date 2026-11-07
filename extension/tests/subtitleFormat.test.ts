import { describe, it, expect } from "vitest";
import {
  parseSrtOrVtt,
  parseSrtOrVttBilingual,
  buildSubtitleContent,
  formatSrtTime,
  formatVttTime,
} from "../src/shared/subtitleFormat";
import type { SubtitleItem } from "../src/shared/types";

describe("Subtitle Format (SRT & VTT)", () => {
  it("formatSrtTime và formatVttTime: chuyển đổi chính xác mốc thời gian", () => {
    // 0s
    expect(formatSrtTime(0)).toBe("00:00:00,000");
    expect(formatVttTime(0)).toBe("00:00:00.000");

    // 1h 2m 3s 456ms = 3600 + 120 + 3 + 0.456 = 3723.456s
    expect(formatSrtTime(3723.456)).toBe("01:02:03,456");
    expect(formatVttTime(3723.456)).toBe("01:02:03.456");

    // Làm tròn 999ms cap
    expect(formatSrtTime(0.9999)).toBe("00:00:00,999");
  });

  it("parseSrtOrVtt: parse file SRT có UTF-8 BOM, CRLF và thẻ HTML", () => {
    const srtContent =
      "\ufeff1\r\n00:00:01,000 --> 00:00:04,500\r\nHello <i>world</i>\r\n\r\n" +
      "2\r\n00:00:05,000 --> 00:00:08,000\r\nSecond line\r\nwith multiple lines\r\n\r\n" +
      "3\r\n00:00:10,000 --> 00:00:09,000\r\nInvalid cue end <= start\r\n";

    const cues = parseSrtOrVtt(srtContent);
    expect(cues.length).toBe(2);
    expect(cues[0]).toEqual({
      start: 1.0,
      end: 4.5,
      text: "Hello world",
    });
    expect(cues[1]).toEqual({
      start: 5.0,
      end: 8.0,
      text: "Second line with multiple lines",
    });
  });

  it("parseSrtOrVtt: parse file WebVTT có giờ MM:SS.mmm không có giờ HH", () => {
    const vttContent =
      "WEBVTT\n\n" +
      "1\n01:23.456 --> 01:28.789\nWebVTT short time\n\n" +
      "2\n01:02:03.456 --> 01:02:05.123\nWebVTT long time\n";

    const cues = parseSrtOrVtt(vttContent);
    expect(cues.length).toBe(2);
    expect(cues[0].start).toBeCloseTo(83.456, 3);
    expect(cues[0].end).toBeCloseTo(88.789, 3);
    expect(cues[0].text).toBe("WebVTT short time");

    expect(cues[1].start).toBeCloseTo(3723.456, 3);
    expect(cues[1].end).toBeCloseTo(3725.123, 3);
  });

  it("parseSrtOrVttBilingual: nhận diện đúng file song ngữ Desktop", () => {
    const bilingualContent =
      "1\n00:00:01,000 --> 00:00:03,000\nHello world\nXin chào thế giới\n\n" +
      "2\n00:00:04,000 --> 00:00:06,000\nOnly English line\n";

    const items = parseSrtOrVttBilingual(bilingualContent);
    expect(items.length).toBe(2);
    expect(items[0].source_text).toBe("Hello world");
    expect(items[0].target_text).toBe("Xin chào thế giới");
    expect(items[0].translated).toBe(true);

    expect(items[1].source_text).toBe("Only English line");
    expect(items[1].target_text).toBe("");
    expect(items[1].translated).toBe(false);
  });

  it("buildSubtitleContent: xuất phụ đề theo 3 chế độ", () => {
    const items: SubtitleItem[] = [
      {
        id: 0,
        block: 0,
        start_sec: 1.0,
        end_sec: 3.0,
        source_text: "Hello",
        target_text: "Xin chào",
        translated: true,
        engine: "api",
      },
      {
        id: 1,
        block: 0,
        start_sec: 4.0,
        end_sec: 6.0,
        source_text: "Untranslated",
        target_text: "",
        translated: false,
        engine: null,
      },
    ];

    // Chế độ source (EN)
    const enSrt = buildSubtitleContent(items, "srt", "source");
    expect(enSrt).toContain("Hello");
    expect(enSrt).not.toContain("Xin chào");

    // Chế độ target (VI) - câu chưa dịch tự fallback về source_text
    const viSrt = buildSubtitleContent(items, "srt", "target");
    expect(viSrt).toContain("Xin chào");
    expect(viSrt).toContain("Untranslated");

    // Chế độ bilingual
    const biVtt = buildSubtitleContent(items, "vtt", "bilingual");
    expect(biVtt.startsWith("WEBVTT")).toBe(true);
    expect(biVtt).toContain("Hello\nXin chào");
    expect(biVtt).toContain("Untranslated");

    // Round-trip parse
    const parsed = parseSrtOrVtt(enSrt);
    expect(parsed.length).toBe(2);
    expect(parsed[0].text).toBe("Hello");
    expect(parsed[0].start).toBe(1.0);
    expect(parsed[0].end).toBe(3.0);
  });
});
