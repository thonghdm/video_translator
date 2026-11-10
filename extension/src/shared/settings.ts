/**
 * SubTrans Extension — Cài đặt (Settings)
 * Phù hợp với Mục 6.3 của PLAN.md
 */

import type { SubtitleMode, TranslateMode } from "./types";

export interface Settings {
  enabled: boolean; // true
  disabledHosts: string[]; // []
  mode: TranslateMode; // "google"
  subtitleMode: SubtitleMode; // "bilingual"
  targetLang: "vi"; // cố định trong MVP
  gemini: {
    apiKey: string; // "" (lưu riêng tại geminiApiKey trong chrome.storage.local)
    model: string; // "gemini-3.5-flash-lite"
    endpoint: string; // "https://generativelanguage.googleapis.com/v1beta/models"
    rpm: number; // 12
    timeoutTier1Ms: number; // 3500
    timeoutTier2Ms: number; // 8000
    maxItemsTier1: number; // 10
    maxItemsTier2: number; // 20
  };
  gtx: {
    concurrency: number; // 2
    gapMs: number; // 150
    timeoutMs: number; // 5000
  };
  style: {
    fontScale: number; // 1.0 (0.8 - 1.8)
    viColor: string; // "#fcd34d" = amber-300
    enColor: string; // "#d4d4d4" = neutral-300
    bgOpacity: number; // 0.8
  };
  youtube: {
    hideNativeCaptions: boolean; // true
    preferManual: boolean; // true
  };
  pretranslateWholeTrack: boolean; // true
  cache: {
    maxTracks: number; // 200
    maxAgeDays: number; // 30
  };
  shortcuts: {
    enabled: boolean; // true
  };
  drive: {
    autoSidecar: boolean; // true
  };
  deepl: {
    apiKey: string; // "" (lưu riêng tại deeplApiKey trong chrome.storage.local)
    enabled: boolean; // true — có key + enabled mới dùng
    prefer: boolean; // false — true: DeepL trước, GTX sau
  };
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  disabledHosts: [],
  mode: "google",
  subtitleMode: "bilingual",
  targetLang: "vi",
  gemini: {
    apiKey: "",
    model: "gemini-3.5-flash-lite",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    rpm: 12,
    timeoutTier1Ms: 3500,
    timeoutTier2Ms: 8000,
    maxItemsTier1: 10,
    maxItemsTier2: 20,
  },
  gtx: {
    concurrency: 2,
    gapMs: 150,
    timeoutMs: 5000,
  },
  style: {
    fontScale: 1.0,
    viColor: "#fcd34d",
    enColor: "#d4d4d4",
    bgOpacity: 0.8,
  },
  youtube: {
    hideNativeCaptions: true,
    preferManual: true,
  },
  pretranslateWholeTrack: true,
  cache: {
    maxTracks: 200,
    maxAgeDays: 30,
  },
  shortcuts: {
    enabled: true,
  },
  drive: {
    autoSidecar: true,
  },
  deepl: {
    apiKey: "",
    enabled: true,
    prefer: false,
  },
};

/** Bản sao sâu của DEFAULT_SETTINGS (không bao giờ trả về tham chiếu tới object mặc định) */
export function cloneDefaults(): Settings {
  return structuredClone(DEFAULT_SETTINGS);
}

/** Kiểm tra extension có được bật trên hostname này không */
export function isEnabledFor(settings: Settings, hostname: string): boolean {
  if (!settings.enabled) return false;
  if (!hostname) return true;
  return !(settings.disabledHosts || []).includes(hostname);
}

/**
 * Deep merge: luôn trả về object MỚI (deep clone), không chia sẻ tham chiếu với target/source,
 * để việc gán settings.gemini.apiKey sau đó không làm bẩn DEFAULT_SETTINGS.
 */
export function deepMerge<T>(target: T, source: unknown): T {
  if (!source || typeof source !== "object") return structuredClone(target);
  const result = structuredClone(target) as Record<string, unknown>;
  const src = source as Record<string, unknown>;

  for (const key of Object.keys(src)) {
    const sVal = src[key];
    const tVal = (target as Record<string, unknown>)?.[key];
    if (sVal !== undefined) {
      if (
        tVal !== null &&
        typeof tVal === "object" &&
        !Array.isArray(tVal) &&
        typeof sVal === "object" &&
        !Array.isArray(sVal)
      ) {
        result[key] = deepMerge(tVal, sVal);
      } else {
        result[key] = structuredClone(sVal);
      }
    }
  }
  return result as T;
}

/** Khoảng giá trị hợp lệ của các setting dạng số (dùng chung cho sanitize và UI) */
export const SETTING_LIMITS = {
  "gtx.concurrency": [1, 4],
  "gtx.gapMs": [0, 2000],
  "gtx.timeoutMs": [1000, 15000],
  "gemini.rpm": [1, 60],
  "gemini.timeoutTier1Ms": [1000, 15000],
  "gemini.timeoutTier2Ms": [2000, 30000],
  "gemini.maxItemsTier1": [1, 25],
  "gemini.maxItemsTier2": [5, 50],
  "style.fontScale": [0.8, 1.8],
  "style.bgOpacity": [0, 1],
  "cache.maxTracks": [10, 1000],
  "cache.maxAgeDays": [1, 365],
} as const satisfies Record<string, readonly [number, number]>;

export type LimitKey = keyof typeof SETTING_LIMITS;

export function clampSetting(key: LimitKey, value: unknown, fallback: number): number {
  const [lo, hi] = SETTING_LIMITS[key];
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

const MODES = ["google", "gemini", "hybrid"] as const;
const SUB_MODES = ["bilingual", "vi", "en", "off"] as const;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Chuẩn hóa settings (gọi khi load VÀ khi save): kẹp số về khoảng hợp lệ, enum sai → mặc định,
 * màu không phải #rrggbb → mặc định, endpoint phải là https. Bảo vệ khỏi giá trị gõ tay/console/bản cũ
 * (ví dụ rpm = 1000 hay concurrency = 50 sẽ làm API bị chặn).
 */
export function sanitizeSettings(input: Settings): Settings {
  const d = DEFAULT_SETTINGS;
  const s = structuredClone(input);
  const int = (k: LimitKey, v: unknown, f: number) => Math.round(clampSetting(k, v, f));

  s.enabled = typeof s.enabled === "boolean" ? s.enabled : d.enabled;
  s.disabledHosts = Array.isArray(s.disabledHosts)
    ? Array.from(new Set(s.disabledHosts.filter((h): h is string => typeof h === "string" && h.trim() !== "").map((h) => h.trim())))
    : [];
  s.mode = (MODES as readonly string[]).includes(s.mode) ? s.mode : d.mode;
  s.subtitleMode = (SUB_MODES as readonly string[]).includes(s.subtitleMode) ? s.subtitleMode : d.subtitleMode;
  s.targetLang = "vi";

  const g = s.gemini;
  g.apiKey = typeof g.apiKey === "string" ? g.apiKey.trim() : "";
  g.model = typeof g.model === "string" && g.model.trim() ? g.model.trim().replace(/^models\//, "") : d.gemini.model;
  g.endpoint = typeof g.endpoint === "string" && /^https:\/\/[^\s]+$/i.test(g.endpoint.trim()) ? g.endpoint.trim() : d.gemini.endpoint;
  g.rpm = int("gemini.rpm", g.rpm, d.gemini.rpm);
  g.timeoutTier1Ms = int("gemini.timeoutTier1Ms", g.timeoutTier1Ms, d.gemini.timeoutTier1Ms);
  g.timeoutTier2Ms = int("gemini.timeoutTier2Ms", g.timeoutTier2Ms, d.gemini.timeoutTier2Ms);
  g.maxItemsTier1 = int("gemini.maxItemsTier1", g.maxItemsTier1, d.gemini.maxItemsTier1);
  g.maxItemsTier2 = int("gemini.maxItemsTier2", g.maxItemsTier2, d.gemini.maxItemsTier2);

  s.gtx.concurrency = int("gtx.concurrency", s.gtx.concurrency, d.gtx.concurrency);
  s.gtx.gapMs = int("gtx.gapMs", s.gtx.gapMs, d.gtx.gapMs);
  s.gtx.timeoutMs = int("gtx.timeoutMs", s.gtx.timeoutMs, d.gtx.timeoutMs);

  s.style.fontScale = Math.round(clampSetting("style.fontScale", s.style.fontScale, d.style.fontScale) * 100) / 100;
  s.style.bgOpacity = Math.round(clampSetting("style.bgOpacity", s.style.bgOpacity, d.style.bgOpacity) * 100) / 100;
  s.style.viColor = typeof s.style.viColor === "string" && HEX_COLOR.test(s.style.viColor) ? s.style.viColor : d.style.viColor;
  s.style.enColor = typeof s.style.enColor === "string" && HEX_COLOR.test(s.style.enColor) ? s.style.enColor : d.style.enColor;

  s.youtube.hideNativeCaptions = typeof s.youtube.hideNativeCaptions === "boolean" ? s.youtube.hideNativeCaptions : d.youtube.hideNativeCaptions;
  s.youtube.preferManual = typeof s.youtube.preferManual === "boolean" ? s.youtube.preferManual : d.youtube.preferManual;
  s.pretranslateWholeTrack = typeof s.pretranslateWholeTrack === "boolean" ? s.pretranslateWholeTrack : d.pretranslateWholeTrack;
  s.cache.maxTracks = int("cache.maxTracks", s.cache.maxTracks, d.cache.maxTracks);
  s.cache.maxAgeDays = int("cache.maxAgeDays", s.cache.maxAgeDays, d.cache.maxAgeDays);
  s.shortcuts.enabled = typeof s.shortcuts.enabled === "boolean" ? s.shortcuts.enabled : d.shortcuts.enabled;
  s.drive = { autoSidecar: typeof s.drive?.autoSidecar === "boolean" ? s.drive.autoSidecar : d.drive.autoSidecar };
  s.deepl = {
    apiKey: typeof s.deepl?.apiKey === "string" ? s.deepl.apiKey.trim() : "",
    enabled: typeof s.deepl?.enabled === "boolean" ? s.deepl.enabled : d.deepl.enabled,
    prefer: typeof s.deepl?.prefer === "boolean" ? s.deepl.prefer : d.deepl.prefer,
  };
  return s;
}

const SETTINGS_KEY = "settings";
const API_KEY_KEY = "geminiApiKey";
const DEEPL_API_KEY_KEY = "deeplApiKey";

/**
 * Tải cài đặt từ chrome.storage.local, tự động deep-merge với DEFAULT_SETTINGS
 */
export interface LoadSettingsOptions {
  /**
   * Có đọc Gemini/DeepL API key hay không (mặc định true).
   * Content script PHẢI truyền false: key không bao giờ được đưa vào context của trang (PLAN 3.4).
   */
  includeApiKey?: boolean;
}

export async function loadSettings(opts: LoadSettingsOptions = {}): Promise<Settings> {
  const includeApiKey = opts.includeApiKey !== false;
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return cloneDefaults();
  }

  const keys = includeApiKey
    ? [SETTINGS_KEY, API_KEY_KEY, DEEPL_API_KEY_KEY]
    : [SETTINGS_KEY];
  const data = await chrome.storage.local.get(keys);
  const saved = data[SETTINGS_KEY];
  const settings = sanitizeSettings(deepMerge(DEFAULT_SETTINGS, saved));
  settings.gemini.apiKey = "";
  settings.deepl.apiKey = "";

  if (includeApiKey) {
    if (typeof data[API_KEY_KEY] === "string") {
      settings.gemini.apiKey = data[API_KEY_KEY].trim();
    }
    if (typeof data[DEEPL_API_KEY_KEY] === "string") {
      settings.deepl.apiKey = data[DEEPL_API_KEY_KEY].trim();
    }
  }

  return settings;
}

/**
 * Lưu cài đặt mới (hỗ trợ lưu một phần - partial)
 */
export async function saveSettings(partial: Partial<Settings>): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return;
  }

  const current = await loadSettings();
  const updated = sanitizeSettings(deepMerge(current, partial));

  // Ghi 1 lần (key + blob) → chỉ 1 sự kiện storage.onChanged. API key lưu riêng, KHÔNG nằm trong blob.
  const toSave = {
    ...updated,
    gemini: { ...updated.gemini, apiKey: "" },
    deepl: { ...updated.deepl, apiKey: "" },
  };
  const payload: Record<string, unknown> = { [SETTINGS_KEY]: toSave };
  if (partial.gemini?.apiKey !== undefined) {
    payload[API_KEY_KEY] = updated.gemini.apiKey;
  }
  if (partial.deepl?.apiKey !== undefined) {
    payload[DEEPL_API_KEY_KEY] = updated.deepl.apiKey;
  }
  await chrome.storage.local.set(payload);
}

export async function getApiKey(): Promise<string> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return "";
  }
  const data = await chrome.storage.local.get(API_KEY_KEY);
  return typeof data[API_KEY_KEY] === "string" ? data[API_KEY_KEY] : "";
}

export async function setApiKey(key: string): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return;
  }
  await chrome.storage.local.set({ [API_KEY_KEY]: key });
}

/**
 * Lắng nghe thay đổi cài đặt từ chrome.storage.onChanged
 */
export function onSettingsChanged(
  callback: (newSettings: Settings) => void,
  opts: LoadSettingsOptions = {}
): () => void {
  if (typeof chrome === "undefined" || !chrome.storage?.onChanged) {
    return () => {};
  }

  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string
  ) => {
    if (
      areaName === "local" &&
      (changes[SETTINGS_KEY] || changes[API_KEY_KEY] || changes[DEEPL_API_KEY_KEY])
    ) {
      void loadSettings(opts).then(callback);
    }
  };

  chrome.storage.onChanged.addListener(listener);
  return () => {
    chrome.storage.onChanged.removeListener(listener);
  };
}
