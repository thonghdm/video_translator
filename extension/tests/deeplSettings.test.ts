import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  sanitizeSettings,
  onSettingsChanged,
} from "../src/shared/settings";
import { CircuitBreaker } from "../src/shared/breaker";
import { TokenBucket } from "../src/shared/tokenBucket";
import { StateManager } from "../src/background/state";

describe("Phase 12 G2 — DeepL Settings and StateManager Tests", () => {
  let localStorageStore: Record<string, unknown>;
  let sessionStorageStore: Record<string, unknown>;
  let changeListeners: Array<(changes: Record<string, any>, area: string) => void>;

  beforeEach(() => {
    localStorageStore = {};
    sessionStorageStore = {};
    changeListeners = [];

    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: vi.fn(async (keys: string | string[]) => {
            const keyArr = Array.isArray(keys) ? keys : [keys];
            const res: Record<string, unknown> = {};
            for (const k of keyArr) {
              if (k in localStorageStore) {
                res[k] = localStorageStore[k];
              }
            }
            return res;
          }),
          set: vi.fn(async (items: Record<string, unknown>) => {
            const changes: Record<string, any> = {};
            for (const [k, v] of Object.entries(items)) {
              changes[k] = { oldValue: localStorageStore[k], newValue: v };
              localStorageStore[k] = v;
            }
            for (const l of changeListeners) {
              l(changes, "local");
            }
          }),
        },
        session: {
          get: vi.fn(async (keys: string | string[]) => {
            const keyArr = Array.isArray(keys) ? keys : [keys];
            const res: Record<string, unknown> = {};
            for (const k of keyArr) {
              if (k in sessionStorageStore) {
                res[k] = sessionStorageStore[k];
              }
            }
            return res;
          }),
          set: vi.fn(async (items: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(items)) {
              sessionStorageStore[k] = v;
            }
          }),
        },
        onChanged: {
          addListener: vi.fn((listener: (changes: Record<string, any>, area: string) => void) => {
            changeListeners.push(listener);
          }),
          removeListener: vi.fn((listener: (changes: Record<string, any>, area: string) => void) => {
            changeListeners = changeListeners.filter((l) => l !== listener);
          }),
        },
      },
    };
  });

  // 1. Mặc định; blob cũ không có "deepl" → mặc định; sai kiểu → mặc định
  it("1. Mặc định, blob cũ không có deepl, sai kiểu dữ liệu đều cho kết quả chuẩn", async () => {
    // Mặc định
    const defaults = await loadSettings();
    expect(defaults.deepl.apiKey).toBe("");
    expect(defaults.deepl.enabled).toBe(true);
    expect(defaults.deepl.prefer).toBe(false);

    // Blob cũ không có deepl
    localStorageStore = {
      settings: {
        mode: "google",
        gemini: { model: "gemini-3.5-flash-lite" },
      },
    };
    const loadedOld = await loadSettings();
    expect(loadedOld.deepl.apiKey).toBe("");
    expect(loadedOld.deepl.enabled).toBe(true);
    expect(loadedOld.deepl.prefer).toBe(false);

    // Sai kiểu dữ liệu trong sanitizeSettings
    const sanitized = sanitizeSettings({
      ...DEFAULT_SETTINGS,
      deepl: {
        apiKey: 12345 as unknown as string,
        enabled: "yes" as unknown as boolean,
        prefer: null as unknown as boolean,
      },
    });
    expect(sanitized.deepl.apiKey).toBe("");
    expect(sanitized.deepl.enabled).toBe(true);
    expect(sanitized.deepl.prefer).toBe(false);

    // apiKey có khoảng trắng được trim
    const trimmed = sanitizeSettings({
      ...DEFAULT_SETTINGS,
      deepl: {
        apiKey: "   my-key:fx   ",
        enabled: false,
        prefer: true,
      },
    });
    expect(trimmed.deepl.apiKey).toBe("my-key:fx");
    expect(trimmed.deepl.enabled).toBe(false);
    expect(trimmed.deepl.prefer).toBe(true);
  });

  // 2. Lưu deepl.apiKey → nằm ở "deeplApiKey", blob có ""; storage.local.set được gọi đúng 1 lần
  it("2. Lưu deepl.apiKey được ghi vào deeplApiKey riêng biệt, blob settings có key rỗng, storage.local.set gọi đúng 1 lần", async () => {
    const setSpy = vi.spyOn(chrome.storage.local, "set");

    await saveSettings({
      deepl: {
        apiKey: "  secret-deepl-key:fx  ",
        enabled: true,
        prefer: true,
      },
    });

    expect(setSpy).toHaveBeenCalledTimes(1);

    // Kiểm tra payload ghi vào storage
    expect(localStorageStore["deeplApiKey"]).toBe("secret-deepl-key:fx");
    const settingsBlob = localStorageStore["settings"] as any;
    expect(settingsBlob.deepl.apiKey).toBe(""); // Luôn rỗng trong blob
    expect(settingsBlob.deepl.enabled).toBe(true);
    expect(settingsBlob.deepl.prefer).toBe(true);
  });

  // 3. loadSettings({includeApiKey:false}) → cả 2 key rỗng; loadSettings() → có cả 2 key
  it("3. loadSettings({includeApiKey: false}) làm rỗng cả hai API key, loadSettings() nạp đủ cả hai", async () => {
    localStorageStore["settings"] = {
      ...DEFAULT_SETTINGS,
      gemini: { ...DEFAULT_SETTINGS.gemini, apiKey: "" },
      deepl: { ...DEFAULT_SETTINGS.deepl, apiKey: "" },
    };
    localStorageStore["geminiApiKey"] = "gemini-secret-123";
    localStorageStore["deeplApiKey"] = "deepl-secret-456:fx";

    // includeApiKey: false (cho content script)
    const contentSettings = await loadSettings({ includeApiKey: false });
    expect(contentSettings.gemini.apiKey).toBe("");
    expect(contentSettings.deepl.apiKey).toBe("");

    // loadSettings() mặc định includeApiKey = true
    const backgroundSettings = await loadSettings();
    expect(backgroundSettings.gemini.apiKey).toBe("gemini-secret-123");
    expect(backgroundSettings.deepl.apiKey).toBe("deepl-secret-456:fx");
  });

  // 4. Đổi "deeplApiKey" → onSettingsChanged được gọi
  it("4. Thay đổi deeplApiKey trong chrome.storage phát sự kiện onSettingsChanged", async () => {
    let notifiedSettings: any = null;
    const unsub = onSettingsChanged((newS) => {
      notifiedSettings = newS;
    });

    await chrome.storage.local.set({
      deeplApiKey: "updated-key-999:fx",
    });

    // Cho promise microtasks chạy
    await new Promise((r) => setTimeout(r, 10));

    expect(notifiedSettings).not.toBeNull();
    expect(notifiedSettings.deepl.apiKey).toBe("updated-key-999:fx");

    unsub();
  });

  // 5. StateManager lưu/khôi phục snapshot deeplBreaker; không truyền deeplBreaker → không lỗi
  it("5. StateManager lưu và khôi phục snapshot deeplBreaker; không truyền breaker vẫn an toàn không lỗi", async () => {
    const gtx = new CircuitBreaker();
    const gemini = new CircuitBreaker();
    const bucket = new TokenBucket(12);
    const deepl = new CircuitBreaker();

    // Đánh dấu deepl breaker bị block
    deepl.report({ kind: "blocked", retryAfterMs: 60000 }, false);

    const sm = new StateManager(gtx, gemini, bucket, deepl);
    await sm.saveNow();

    const savedState = sessionStorageStore["subtrans_sw_state"] as any;
    expect(savedState).toBeDefined();
    expect(savedState.deeplBreaker).toBeDefined();
    expect(savedState.deeplBreaker.blockedUntil).toBeGreaterThan(0);

    // Khôi phục sang breaker mới
    const newDeepl = new CircuitBreaker();
    const smRestore = new StateManager(new CircuitBreaker(), new CircuitBreaker(), new TokenBucket(12), newDeepl);
    await smRestore.restore();

    expect(newDeepl.snapshot().blockedUntil).toBe(savedState.deeplBreaker.blockedUntil);

    // Trường hợp StateManager không có deeplBreaker truyền vào -> không lỗi khi save và restore
    const smNoDeepl = new StateManager(gtx, gemini, bucket);
    await smNoDeepl.saveNow();
    const savedNoDeepl = sessionStorageStore["subtrans_sw_state"] as any;
    expect(savedNoDeepl.deeplBreaker).toBeUndefined();

    // Restore khi state trong storage có deeplBreaker nhưng StateManager không có deeplBreaker
    sessionStorageStore["subtrans_sw_state"] = savedState;
    await expect(smNoDeepl.restore()).resolves.not.toThrow();
  });
});
