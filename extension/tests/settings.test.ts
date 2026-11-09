import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  deepMerge,
  loadSettings,
  saveSettings,
  sanitizeSettings,
  getApiKey,
  setApiKey,
} from "../src/shared/settings";

describe("Settings Management", () => {
  beforeEach(() => {
    // Mock chrome.storage.local
    const storageStore: Record<string, unknown> = {};

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

  it("deepMerge: gộp đúng các trường con mà không làm mất trường mặc định", () => {
    const base = {
      a: 1,
      b: { c: 2, d: 3 },
      e: [1, 2],
    };
    const incoming = {
      b: { c: 20 },
      e: [3],
    };
    const merged = deepMerge(base, incoming);
    expect(merged.a).toBe(1);
    expect(merged.b.c).toBe(20);
    expect(merged.b.d).toBe(3);
    expect(merged.e).toEqual([3]);
  });

  it("loadSettings: trả về DEFAULT_SETTINGS khi storage rỗng", async () => {
    const s = await loadSettings();
    expect(s.mode).toBe("google");
    expect(s.gemini.model).toBe("gemini-3.5-flash-lite");
    expect(s.gemini.rpm).toBe(12);
  });

  it("saveSettings và loadSettings: lưu partial và tách riêng API key", async () => {
    await saveSettings({
      mode: "gemini",
      gemini: {
        ...DEFAULT_SETTINGS.gemini,
        apiKey: "AIzaSyTestKey123",
      },
    });

    const s = await loadSettings();
    expect(s.mode).toBe("gemini");
    expect(s.gemini.apiKey).toBe("AIzaSyTestKey123");

    // Kiểm tra API key riêng qua getApiKey / setApiKey
    expect(await getApiKey()).toBe("AIzaSyTestKey123");
    await setApiKey("NewKey456");
    expect(await getApiKey()).toBe("NewKey456");
  });

  describe("Phase 9.5 D2 — Drive autoSidecar setting", () => {
    it("mặc định DEFAULT_SETTINGS.drive.autoSidecar là true", () => {
      expect(DEFAULT_SETTINGS.drive.autoSidecar).toBe(true);
    });

    it("blob cũ không có khóa drive → load ra drive.autoSidecar === true", async () => {
      // Giả lập storage lưu blob cũ từ bản trước Phase 9.5 (không hề có trường drive)
      const oldBlob = {
        mode: "google",
        gemini: { model: "gemini-3.5-flash-lite", rpm: 12 },
        shortcuts: { enabled: true },
      };
      await chrome.storage.local.set({ settings: oldBlob });

      const loaded = await loadSettings();
      expect(loaded.drive).toBeDefined();
      expect(loaded.drive.autoSidecar).toBe(true);
    });

    it("drive.autoSidecar sai kiểu dữ liệu → sanitize về mặc định true", () => {
      const base = sanitizeSettings({
        ...DEFAULT_SETTINGS,
        drive: { autoSidecar: "invalid" as unknown as boolean },
      });
      expect(base.drive.autoSidecar).toBe(true);

      const nullType = sanitizeSettings({
        ...DEFAULT_SETTINGS,
        drive: { autoSidecar: null as unknown as boolean },
      });
      expect(nullType.drive.autoSidecar).toBe(true);

      const numType = sanitizeSettings({
        ...DEFAULT_SETTINGS,
        drive: { autoSidecar: 0 as unknown as boolean },
      });
      expect(numType.drive.autoSidecar).toBe(true);
    });

    it("lưu false rồi load → nhận đúng false", async () => {
      await saveSettings({
        drive: { autoSidecar: false },
      });

      const loaded = await loadSettings();
      expect(loaded.drive.autoSidecar).toBe(false);
    });
  });
});
