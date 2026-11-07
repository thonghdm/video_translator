/**
 * Test hồi quy cho các lỗi phát hiện khi review Phase 7 (Popup/Options/useSettings/content).
 */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  saveSettings,
  loadSettings,
  clampSetting,
  type Settings,
} from "../src/shared/settings";
import { useSettings, SETTINGS_DEBOUNCE_MS, type UseSettingsResult } from "../src/shared/useSettings";
import { NumberField, commitNumber } from "../src/options/NumberField";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

/** chrome.storage.local giả có onChanged (giống Chrome: bắn sự kiện sau mỗi set) */
function fakeChrome(extra: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = {};
  const listeners = new Set<(c: Record<string, unknown>, area: string) => void>();
  const setCalls: Array<Record<string, unknown>> = [];
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const ks = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(ks.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
        },
        set: async (obj: Record<string, unknown>) => {
          setCalls.push(structuredClone(obj));
          const changes: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: store[k], newValue: v };
            store[k] = structuredClone(v);
          }
          queueMicrotask(() => listeners.forEach((l) => l(changes, "local")));
        },
        remove: async () => {},
      },
      onChanged: {
        addListener: (l: any) => listeners.add(l),
        removeListener: (l: any) => listeners.delete(l),
      },
    },
    ...extra,
  };
  return { store, setCalls };
}

afterEach(() => {
  delete (globalThis as any).chrome;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
describe("sanitizeSettings — kẹp giá trị nguy hiểm", () => {
  it("số ngoài khoảng, NaN, enum sai, màu sai, endpoint không https", () => {
    const bad = structuredClone(DEFAULT_SETTINGS) as Settings & Record<string, any>;
    bad.gemini.rpm = 1000;
    bad.gtx.concurrency = 50;
    bad.gtx.gapMs = -5;
    bad.gemini.timeoutTier1Ms = NaN as unknown as number;
    bad.style.fontScale = 9;
    bad.style.viColor = "red; background:url(x)";
    bad.mode = "evil" as any;
    bad.subtitleMode = "xx" as any;
    bad.gemini.endpoint = "http://attacker.example";
    bad.gemini.model = "  models/gemini-x  ";
    bad.disabledHosts = ["a.com", " a.com ", "", 5 as any];
    const s = sanitizeSettings(bad);
    expect(s.gemini.rpm).toBe(60);
    expect(s.gtx.concurrency).toBe(4);
    expect(s.gtx.gapMs).toBe(0);
    expect(s.gemini.timeoutTier1Ms).toBe(DEFAULT_SETTINGS.gemini.timeoutTier1Ms);
    expect(s.style.fontScale).toBe(1.8);
    expect(s.style.viColor).toBe(DEFAULT_SETTINGS.style.viColor);
    expect(s.mode).toBe("google");
    expect(s.subtitleMode).toBe("bilingual");
    expect(s.gemini.endpoint).toBe(DEFAULT_SETTINGS.gemini.endpoint);
    expect(s.gemini.model).toBe("gemini-x");
    expect(s.disabledHosts).toEqual(["a.com"]);
  });

  it("loadSettings sanitize cả dữ liệu cũ trong storage", async () => {
    const { store } = fakeChrome();
    store.settings = { gemini: { rpm: 9999 }, gtx: { concurrency: 0 } };
    const s = await loadSettings();
    expect(s.gemini.rpm).toBe(60);
    expect(s.gtx.concurrency).toBe(1);
  });

  it("saveSettings: 1 lần set (key + blob), blob không chứa API key", async () => {
    const { setCalls, store } = fakeChrome();
    await saveSettings({ gemini: { ...DEFAULT_SETTINGS.gemini, apiKey: "  KEY123  " } });
    expect(setCalls).toHaveLength(1);
    expect(store.geminiApiKey).toBe("KEY123");
    expect((store.settings as Settings).gemini.apiKey).toBe("");
  });

  it("clampSetting", () => {
    expect(clampSetting("gemini.rpm", "30", 12)).toBe(30);
    expect(clampSetting("gemini.rpm", "abc", 12)).toBe(12);
    expect(clampSetting("style.bgOpacity", 2, 0.8)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
function renderHook() {
  const ref: { current: UseSettingsResult | null } = { current: null };
  function Probe() {
    ref.current = useSettings();
    return null;
  }
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  return { ref, root, mount: () => act(async () => root.render(createElement(Probe))) };
}

describe("useSettings", () => {
  it("popup đóng (pagehide) trước khi hết debounce → vẫn lưu", async () => {
    const { store } = fakeChrome();
    const { ref, mount } = renderHook();
    await mount();
    await act(async () => {
      ref.current!.updateSettings({ gemini: { ...ref.current!.settings.gemini, apiKey: "PASTED_KEY" } });
    });
    expect(store.geminiApiKey).toBeUndefined(); // chưa tới 300ms
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(store.geminiApiKey).toBe("PASTED_KEY");
  });

  it("unmount cũng lưu ngay", async () => {
    const { store } = fakeChrome();
    const { ref, root, mount } = renderHook();
    await mount();
    await act(async () => ref.current!.updateSettings({ mode: "hybrid" }));
    await act(async () => {
      root.unmount();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect((store.settings as Settings).mode).toBe("hybrid");
  });

  it("sự kiện storage từ lần lưu trước KHÔNG ghi đè thứ người dùng đang gõ", async () => {
    fakeChrome();
    const { ref, mount } = renderHook();
    await mount();
    const g = () => ref.current!.settings.gemini;
    await act(async () => ref.current!.updateSettings({ gemini: { ...g(), apiKey: "AB" } }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, SETTINGS_DEBOUNCE_MS + 20)); // lưu "AB"
    });
    // Người dùng gõ tiếp, rồi sự kiện onChanged của lần lưu "AB" tới muộn
    await act(async () => ref.current!.updateSettings({ gemini: { ...g(), apiKey: "ABCD" } }));
    await act(async () => {
      await (globalThis as any).chrome.storage.local.set({ geminiApiKey: "AB" });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(ref.current!.settings.gemini.apiKey).toBe("ABCD");
  });
});

// ---------------------------------------------------------------------------
describe("NumberField", () => {
  it("commitNumber: kẹp, rỗng → giữ giá trị cũ, dấu phẩy thập phân", () => {
    expect(commitNumber("1000", "gemini.rpm", 12)).toBe(60);
    expect(commitNumber("", "gemini.rpm", 12)).toBe(12);
    expect(commitNumber("0,5", "style.bgOpacity", 0.8, false)).toBe(0.5);
    expect(commitNumber("7.6", "gtx.concurrency", 2)).toBe(4);
  });

  it("gõ tự do, chỉ lưu khi blur; Esc hủy", async () => {
    const onCommit = vi.fn();
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => root.render(createElement(NumberField, { limitKey: "gemini.rpm", value: 12, onCommit })));
    const input = el.querySelector("input")!;
    const type = async (v: string) =>
      act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });

    await act(async () => input.focus());
    await type("");
    expect(input.value).toBe(""); // không nhảy về mặc định khi xóa trắng
    await type("30");
    expect(onCommit).not.toHaveBeenCalled();
    await act(async () => input.blur());
    expect(onCommit).toHaveBeenCalledWith(30);

    onCommit.mockClear();
    await act(async () => input.focus());
    await type("55");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCommit).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});

// ---------------------------------------------------------------------------
describe("content: chỉ frame có session mới trả lời popup", () => {
  it("frame không có video → không gọi sendResponse (để frame có video trả lời)", async () => {
    let listener: any = null;
    fakeChrome({
      runtime: {
        id: "ext-id",
        onMessage: { addListener: (l: any) => (listener = l) },
        connect: () => {
          throw new Error("không dùng");
        },
      },
    });
    vi.resetModules();
    await import("../src/content/index");
    await new Promise((r) => setTimeout(r, 20));
    expect(listener).toBeTypeOf("function");
    const sendResponse = vi.fn();
    listener({ type: "tab.status" }, {}, sendResponse);
    listener({ type: "tab.export", format: "srt", mode: "bilingual" }, {}, sendResponse);
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
