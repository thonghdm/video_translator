/**
 * Unit tests cho Phase 7: Popup, Options, Settings hook, and Export logic
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { isEnabledFor, cloneDefaults, DEFAULT_SETTINGS, saveSettings, loadSettings } from "../src/shared/settings";
import { sanitizeApiKey } from "../src/background/engines/gemini";
import { buildSubtitleContent } from "../src/shared/subtitleFormat";

describe("Phase 7: Settings and Host Enablement", () => {
  it("isEnabledFor: tôn trọng cờ enabled toàn cục và danh sách disabledHosts", () => {
    const s = cloneDefaults();
    s.enabled = true;
    s.disabledHosts = ["example.com", "badsite.org"];

    expect(isEnabledFor(s, "youtube.com")).toBe(true);
    expect(isEnabledFor(s, "example.com")).toBe(false);
    expect(isEnabledFor(s, "badsite.org")).toBe(false);

    // Khi tắt toàn cục
    s.enabled = false;
    expect(isEnabledFor(s, "youtube.com")).toBe(false);
    expect(isEnabledFor(s, "example.com")).toBe(false);
  });
});

describe("Phase 7: API Key Sanitization", () => {
  it("sanitizeApiKey che giấu API key trong các thông báo lỗi trả về giao diện", () => {
    const key = "AIzaSySecretApiKey123456789";
    const rawError = `Lỗi kết nối tới endpoint với khóa ${key}: HTTP 403 Forbidden`;
    const safeError = sanitizeApiKey(rawError, key);

    expect(safeError).not.toContain(key);
    expect(safeError).toContain("[REDACTED_API_KEY]");
  });

  it("sanitizeApiKey không thay đổi thông báo khi không có API key hoặc key ngắn", () => {
    const errorMsg = "Mất kết nối mạng";
    expect(sanitizeApiKey(errorMsg, "")).toBe(errorMsg);
    expect(sanitizeApiKey(errorMsg, "123")).toBe(errorMsg);
  });
});

describe("Phase 7: Subtitle Export Logic", () => {
  const dummyItems = [
    {
      id: 0,
      block: 0,
      start_sec: 1.0,
      end_sec: 3.5,
      source_text: "Hello everyone",
      target_text: "Xin chào mọi người",
      translated: true,
      engine: "api" as const,
    },
    {
      id: 1,
      block: 1,
      start_sec: 4.0,
      end_sec: 6.0,
      source_text: "Welcome to this course",
      target_text: "Chào mừng đến với khóa học này",
      translated: true,
      engine: "cloud" as const,
    },
  ];

  it("xuất đúng định dạng SRT song ngữ", () => {
    const srt = buildSubtitleContent(dummyItems, "srt", "bilingual");
    expect(srt).toContain("00:00:01,000 --> 00:00:03,500");
    expect(srt).toContain("Hello everyone\nXin chào mọi người");
    expect(srt).toContain("Welcome to this course\nChào mừng đến với khóa học này");
  });

  it("xuất đúng định dạng VTT chỉ tiếng Việt", () => {
    const vtt = buildSubtitleContent(dummyItems, "vtt", "target");
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:00:01.000 --> 00:00:03.500");
    expect(vtt).toContain("Xin chào mọi người");
    expect(vtt).not.toContain("Hello everyone");
  });

  it("xuất đúng định dạng SRT chỉ tiếng Anh", () => {
    const srt = buildSubtitleContent(dummyItems, "srt", "source");
    expect(srt).toContain("Hello everyone");
    expect(srt).not.toContain("Xin chào mọi người");
  });

  it("chuẩn hoá tên file xuất không chứa các ký tự cấm", () => {
    const rawTitle = 'Video: Lập trình C++ / Hướng dẫn & Bí kíp * "2026"?';
    const cleanTitle = rawTitle.replace(/[/\\?%*:|"<>]/g, "-").trim();
    const filename = `${cleanTitle}.bilingual.srt`;

    expect(filename).not.toMatch(/[/\\?%*:|"<>]/);
    expect(filename).toContain(".bilingual.srt");
  });
});

describe("Phase 7: Settings Storage and Debouncing", () => {
  let storageStore: Record<string, unknown> = {};

  beforeEach(() => {
    storageStore = {};
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: vi.fn(async (keys: string | string[]) => {
            const keyArr = Array.isArray(keys) ? keys : [keys];
            const res: Record<string, unknown> = {};
            for (const k of keyArr) {
              if (k in storageStore) {
                res[k] = storageStore[k];
              }
            }
            return res;
          }),
          set: vi.fn(async (items: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(items)) {
              storageStore[k] = v;
            }
          }),
        },
      },
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lưu cài đặt và tách riêng geminiApiKey", async () => {
    await saveSettings({
      gemini: {
        ...DEFAULT_SETTINGS.gemini,
        apiKey: "AIzaTestKey999",
        model: "gemini-2.5-pro",
      },
    });

    // geminiApiKey lưu riêng biệt
    expect(storageStore["geminiApiKey"]).toBe("AIzaTestKey999");

    // Trong settings blob, apiKey phải rỗng
    const savedSettings = storageStore["settings"] as typeof DEFAULT_SETTINGS;
    expect(savedSettings.gemini.apiKey).toBe("");
    expect(savedSettings.gemini.model).toBe("gemini-2.5-pro");

    // Khi loadSettings với includeApiKey: true -> nạp lại được key
    const loaded = await loadSettings({ includeApiKey: true });
    expect(loaded.gemini.apiKey).toBe("AIzaTestKey999");
    expect(loaded.gemini.model).toBe("gemini-2.5-pro");

    // Khi loadSettings với includeApiKey: false (content script) -> không có key
    const contentLoaded = await loadSettings({ includeApiKey: false });
    expect(contentLoaded.gemini.apiKey).toBe("");
  });
});
