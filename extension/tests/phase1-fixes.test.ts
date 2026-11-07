/**
 * Test hồi quy cho các lỗi phát hiện khi review Phase 1.
 */
import { describe, it, expect, afterEach } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, deepMerge, cloneDefaults } from "../src/shared/settings";
import { decodeHtmlEntities } from "../src/shared/text";
import { mergeAsrCues } from "../src/shared/sentenceMerge";
import { buildSubtitleContent, parseSrtOrVttBilingual } from "../src/shared/subtitleFormat";
import { cuesToItems } from "../src/shared/subtitles";
import type { SubtitleItem } from "../src/shared/types";

const g = globalThis as unknown as { chrome?: unknown };

describe("settings: không làm bẩn DEFAULT_SETTINGS", () => {
  afterEach(() => {
    delete g.chrome;
  });

  it("loadSettings khi storage chỉ có API key -> DEFAULT_SETTINGS vẫn sạch", async () => {
    g.chrome = { storage: { local: { get: async () => ({ geminiApiKey: "SECRET" }) } } };
    const s = await loadSettings();
    expect(s.gemini.apiKey).toBe("SECRET");
    expect(DEFAULT_SETTINGS.gemini.apiKey).toBe("");
    expect(s.gemini).not.toBe(DEFAULT_SETTINGS.gemini);
  });

  it("loadSettings không có chrome -> trả bản sao, sửa bản sao không ảnh hưởng mặc định", async () => {
    const s = await loadSettings();
    s.style.fontScale = 9;
    s.disabledHosts.push("x.com");
    expect(DEFAULT_SETTINGS.style.fontScale).toBe(1.0);
    expect(DEFAULT_SETTINGS.disabledHosts).toEqual([]);
  });

  it("deepMerge không chia sẻ tham chiếu với target hoặc source", () => {
    const src = { disabledHosts: ["a.com"], style: { fontScale: 1.2 } };
    const out = deepMerge(cloneDefaults(), src);
    out.disabledHosts.push("b.com");
    out.gemini.model = "khac";
    expect(src.disabledHosts).toEqual(["a.com"]);
    expect(DEFAULT_SETTINGS.gemini.model).toBe("gemini-3.5-flash-lite");
    expect(out.style.fontScale).toBe(1.2);
    expect(out.style.viColor).toBe(DEFAULT_SETTINGS.style.viColor);
  });
});

describe("decodeHtmlEntities", () => {
  it("không giải mã 2 lần", () => {
    expect(decodeHtmlEntities("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
    expect(decodeHtmlEntities("Tom &amp;amp; Jerry")).toBe("Tom &amp; Jerry");
  });
  it("giải mã entity dạng số (thập phân và hex)", () => {
    expect(decodeHtmlEntities("it&#39;s &#8220;ok&#8221; &#x2014; done")).toBe("it's “ok” — done");
  });
  it("giữ nguyên entity số không hợp lệ", () => {
    expect(decodeHtmlEntities("&#99999999;")).toBe("&#99999999;");
  });
});

describe("mergeAsrCues", () => {
  it("bỏ qua cue rỗng ở đầu, không dư dấu cách", () => {
    const out = mergeAsrCues([
      { start: 0, end: 1, text: "" },
      { start: 1, end: 2, text: "  " },
      { start: 2, end: 3, text: "hello" },
      { start: 3, end: 4, text: "world." },
    ]);
    expect(out).toEqual([{ start: 2, end: 4, text: "hello world." }]);
  });
  it("toàn bộ cue rỗng -> mảng rỗng", () => {
    expect(mergeAsrCues([{ start: 0, end: 1, text: " " }])).toEqual([]);
  });
});

describe("buildSubtitleContent khớp byte-to-byte với Go (app.go BuildSubtitleContent)", () => {
  const items: SubtitleItem[] = [
    { id: 0, block: 0, start_sec: 1, end_sec: 2.5, source_text: "Hello", target_text: "Xin chào", translated: true, engine: "api" },
    { id: 1, block: 0, start_sec: 3, end_sec: 4, source_text: "World", target_text: "", translated: false, engine: null },
  ];
  it("SRT bilingual", () => {
    expect(buildSubtitleContent(items, "srt", "bilingual")).toBe(
      "1\n00:00:01,000 --> 00:00:02,500\nHello\nXin chào\n\n" +
        "2\n00:00:03,000 --> 00:00:04,000\nWorld\n\n"
    );
  });
  it("VTT target (rỗng thì dùng source)", () => {
    expect(buildSubtitleContent(items, "vtt", "target")).toBe(
      "WEBVTT\n\n" +
        "1\n00:00:01.000 --> 00:00:02.500\nXin chào\n\n" +
        "2\n00:00:03.000 --> 00:00:04.000\nWorld\n\n"
    );
  });
  it("danh sách rỗng: SRT -> \"\", VTT -> chỉ header", () => {
    expect(buildSubtitleContent([], "srt", "source")).toBe("");
    expect(buildSubtitleContent([], "vtt", "source")).toBe("WEBVTT\n\n");
  });
});

describe("parseSrtOrVttBilingual", () => {
  it("file chỉ có tiếng Việt (.vi.srt) -> target, đánh dấu đã dịch", () => {
    const items = parseSrtOrVttBilingual("1\n00:00:01,000 --> 00:00:02,000\nXin chào các bạn\n\n");
    expect(items).toHaveLength(1);
    expect(items[0].target_text).toBe("Xin chào các bạn");
    expect(items[0].source_text).toBe("");
    expect(items[0].translated).toBe(true);
  });
  it("round-trip: xuất bilingual rồi đọc lại", () => {
    const src: SubtitleItem[] = [
      { id: 0, block: 0, start_sec: 1, end_sec: 2, source_text: "Open the terminal", target_text: "Mở terminal lên", translated: true, engine: "cloud" },
    ];
    const back = parseSrtOrVttBilingual(buildSubtitleContent(src, "srt", "bilingual"));
    expect(back[0].source_text).toBe("Open the terminal");
    expect(back[0].target_text).toBe("Mở terminal lên");
    expect(back[0].start_sec).toBe(1);
    expect(back[0].end_sec).toBe(2);
  });
});

describe("cuesToItems", () => {
  it("gán ignored cho tiếng động / nốt nhạc", () => {
    const items = cuesToItems([
      { start: 0, end: 1, text: "[Music]" },
      { start: 1, end: 2, text: "Hello" },
      { start: 2, end: 3, text: "♪ ♪" },
    ]);
    expect(items.map((i) => i.ignored)).toEqual([true, false, true]);
  });
});
