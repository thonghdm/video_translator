// @vitest-environment jsdom
/**
 * Phase 12 G2 review — "Khôi phục mặc định" (useSettings.resetDefaults) không được xóa key DeepL.
 */
import { describe, it, expect } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useSettings, type UseSettingsResult } from "../src/shared/useSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeChrome(initial: Record<string, unknown>) {
  const store: Record<string, unknown> = { ...initial };
  const listeners = new Set<(c: Record<string, unknown>, area: string) => void>();
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const ks = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(ks.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
        },
        set: async (obj: Record<string, unknown>) => {
          const changes: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: store[k], newValue: v };
            store[k] = structuredClone(v);
          }
          queueMicrotask(() => listeners.forEach((l) => l(changes, "local")));
        },
        remove: async () => {},
      },
      onChanged: { addListener: (l: any) => listeners.add(l), removeListener: (l: any) => listeners.delete(l) },
    },
  };
  return store;
}

async function mountHook() {
  const ref: { current: UseSettingsResult | null } = { current: null };
  function Probe() {
    ref.current = useSettings();
    return null;
  }
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => root.render(createElement(Probe)));
  await act(async () => new Promise((r) => setTimeout(r, 10)));
  return { ref, root };
}

describe("useSettings.resetDefaults và key DeepL", () => {
  it("keepApiKey = true (mặc định) giữ cả key Gemini lẫn key DeepL", async () => {
    const store = fakeChrome({ geminiApiKey: "GEM-KEY-123", deeplApiKey: "DEEPL-KEY-123:fx" });
    const { ref, root } = await mountHook();
    expect(ref.current!.settings.deepl.apiKey).toBe("DEEPL-KEY-123:fx");
    await act(async () => ref.current!.resetDefaults());
    expect(store.geminiApiKey).toBe("GEM-KEY-123");
    expect(store.deeplApiKey).toBe("DEEPL-KEY-123:fx");
    expect(ref.current!.settings.deepl.apiKey).toBe("DEEPL-KEY-123:fx");
    await act(async () => root.unmount());
  });

  it("keepApiKey = false xóa cả hai key", async () => {
    const store = fakeChrome({ geminiApiKey: "GEM-KEY-123", deeplApiKey: "DEEPL-KEY-123:fx" });
    const { ref, root } = await mountHook();
    await act(async () => ref.current!.resetDefaults(false));
    expect(store.geminiApiKey).toBe("");
    expect(store.deeplApiKey).toBe("");
    await act(async () => root.unmount());
  });
});
