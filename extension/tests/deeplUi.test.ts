// @vitest-environment jsdom
/**
 * Phase 12 G4 — Popup: nhãn đếm/thông báo breaker (đã sửa đảo ngược), mục DeepL (key, Kiểm tra, 2 công tắc).
 * Render THẬT component Popup.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Popup } from "../src/popup/Popup";
import type { Settings } from "../src/shared/settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Env {
  store: Record<string, unknown>;
  sent: unknown[];
}

function fakeChrome(opts: {
  initial?: Record<string, unknown>;
  tabStatus?: unknown;
  breakers?: unknown;
  deeplTest?: unknown;
}): Env {
  const store: Record<string, unknown> = { ...(opts.initial ?? {}) };
  const sent: unknown[] = [];
  const listeners = new Set<(c: Record<string, unknown>, area: string) => void>();
  const reply = (msg: { type: string }) => {
    if (msg.type === "status") return { ok: true, breakers: opts.breakers };
    if (msg.type === "deepl.test") return opts.deeplTest;
    return { ok: true };
  };
  (globalThis as any).chrome = {
    runtime: {
      lastError: undefined,
      sendMessage: (msg: { type: string }, cb?: (r: unknown) => void) => {
        sent.push(msg);
        const r = reply(msg);
        if (cb) {
          cb(r);
          return undefined;
        }
        return Promise.resolve(r);
      },
      openOptionsPage: vi.fn(),
    },
    tabs: {
      query: async () => [{ id: 7, url: "https://www.youtube.com/watch?v=abc" }],
      sendMessage: (_id: number, _msg: unknown, cb: (r: unknown) => void) => cb(opts.tabStatus),
    },
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
  return { store, sent };
}

let root: Root | null = null;
let host: HTMLDivElement;

async function mount(): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(Popup)));
  await act(async () => new Promise((r) => setTimeout(r, 20)));
  return host;
}

const wait = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));

function byText<T extends Element = HTMLElement>(el: Element, selector: string, text: string): T {
  const found = [...el.querySelectorAll(selector)].find((e) => (e.textContent || "").includes(text));
  if (!found) throw new Error(`Không thấy ${selector} chứa "${text}"`);
  return found as T;
}

async function openDeepl(el: HTMLElement) {
  await act(async () => byText<HTMLButtonElement>(el, "button", "Cấu hình DeepL").click());
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

const activeTab = { active: true, title: "Video", total: 10, translated: 8, byEngine: { api: 5, cloud: 3 } };

describe("Phase 12 G4 — Popup", () => {
  it("nhãn đếm: 'Google/DeepL' = byEngine.api, 'Gemini' = byEngine.cloud", async () => {
    fakeChrome({ tabStatus: activeTab, breakers: { api: { blocked: false, until: 0 }, cloud: { blocked: false, until: 0 } } });
    const el = await mount();
    expect(el.textContent).toContain("Google/DeepL: 5");
    expect(el.textContent).toContain("Gemini: 3");
  });

  it("thông báo breaker đúng engine (api → Google, cloud → Gemini, deepl → DeepL)", async () => {
    fakeChrome({
      tabStatus: activeTab,
      breakers: { api: { blocked: true, until: 1 }, cloud: { blocked: false, until: 0 }, deepl: { blocked: true, until: 1 } },
    });
    const el = await mount();
    expect(el.textContent).toContain("Google Translate tạm dừng");
    expect(el.textContent).toContain("DeepL tạm dừng");
    expect(el.textContent).not.toContain("Gemini tạm dừng");
  });

  it("chỉ breaker cloud bị chặn → chỉ báo Gemini", async () => {
    fakeChrome({ tabStatus: activeTab, breakers: { api: { blocked: false, until: 0 }, cloud: { blocked: true, until: 1 } } });
    const el = await mount();
    expect(el.textContent).toContain("Gemini tạm dừng");
    expect(el.textContent).not.toContain("Google Translate tạm dừng");
  });

  it("nhập key DeepL → sau debounce lưu vào 'deeplApiKey', blob settings không chứa key; ô nhập là password", async () => {
    const env = fakeChrome({ tabStatus: undefined, breakers: undefined });
    const el = await mount();
    await openDeepl(el);
    const input = el.querySelector<HTMLInputElement>('input[placeholder$=":fx"]')!;
    expect(input.type).toBe("password");
    await typeInto(input, "  abc-key-123:fx  ");
    await wait(450);
    expect(env.store.deeplApiKey).toBe("abc-key-123:fx");
    expect((env.store.settings as Settings).deepl.apiKey).toBe("");
  });

  it("Kiểm tra kết nối → gửi deepl.test kèm key; hiển thị số đã dùng/giới hạn có dấu chấm", async () => {
    const env = fakeChrome({
      initial: { deeplApiKey: "abc-key-123:fx" },
      deeplTest: { ok: true, latencyMs: 120, used: 12345, limit: 500000, sample: "Xin chào" },
    });
    const el = await mount();
    await openDeepl(el);
    await act(async () => byText<HTMLButtonElement>(el, "button", "Kiểm tra kết nối").click());
    await wait(10);
    expect(env.sent).toContainEqual({ type: "deepl.test", apiKey: "abc-key-123:fx" });
    expect(el.textContent).toContain("120 ms · đã dùng 12.345 / 500.000 ký tự");
  });

  it("Kiểm tra kết nối lỗi → hiển thị lỗi; đổi key → kết quả cũ biến mất", async () => {
    fakeChrome({ initial: { deeplApiKey: "abc-key-123:fx" }, deeplTest: { ok: false, error: "DeepL: key không hợp lệ (HTTP 403)" } });
    const el = await mount();
    await openDeepl(el);
    await act(async () => byText<HTMLButtonElement>(el, "button", "Kiểm tra kết nối").click());
    await wait(10);
    expect(el.textContent).toContain("key không hợp lệ (HTTP 403)");
    await typeInto(el.querySelector<HTMLInputElement>('input[placeholder$=":fx"]')!, "new-key-456:fx");
    expect(el.textContent).not.toContain("key không hợp lệ (HTTP 403)");
  });

  it("2 công tắc lưu đúng deepl.enabled và deepl.prefer", async () => {
    const env = fakeChrome({ initial: { deeplApiKey: "abc-key-123:fx" } });
    const el = await mount();
    await openDeepl(el);
    const enabled = byText<HTMLLabelElement>(el, "label", "Dùng DeepL khi Google Translate lỗi").querySelector("input")!;
    const prefer = byText<HTMLLabelElement>(el, "label", "Ưu tiên DeepL").querySelector("input")!;
    expect(enabled.checked).toBe(true);
    expect(prefer.checked).toBe(false);
    await act(async () => enabled.click());
    await act(async () => prefer.click());
    await wait(450);
    const saved = env.store.settings as Settings;
    expect(saved.deepl.enabled).toBe(false);
    expect(saved.deepl.prefer).toBe(true);
    expect(env.store.deeplApiKey).toBe("abc-key-123:fx");
  });
});
