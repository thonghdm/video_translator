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

const SETTINGS_KEY = "settings";
const API_KEY_KEY = "geminiApiKey";

/**
 * Tải cài đặt từ chrome.storage.local, tự động deep-merge với DEFAULT_SETTINGS
 */
export interface LoadSettingsOptions {
  /**
   * Có đọc Gemini API key hay không (mặc định true).
   * Content script PHẢI truyền false: key không bao giờ được đưa vào context của trang (PLAN 3.4).
   */
  includeApiKey?: boolean;
}

export async function loadSettings(opts: LoadSettingsOptions = {}): Promise<Settings> {
  const includeApiKey = opts.includeApiKey !== false;
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return cloneDefaults();
  }

  const keys = includeApiKey ? [SETTINGS_KEY, API_KEY_KEY] : [SETTINGS_KEY];
  const data = await chrome.storage.local.get(keys);
  const saved = data[SETTINGS_KEY];
  const settings = deepMerge(DEFAULT_SETTINGS, saved);
  settings.gemini.apiKey = "";

  if (includeApiKey && typeof data[API_KEY_KEY] === "string") {
    settings.gemini.apiKey = data[API_KEY_KEY];
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
  const updated = deepMerge(current, partial);

  // Tách apiKey ra lưu riêng tại API_KEY_KEY
  if (partial.gemini?.apiKey !== undefined) {
    await chrome.storage.local.set({ [API_KEY_KEY]: partial.gemini.apiKey });
  }

  // Không lưu trực tiếp apiKey trong settings blob
  const toSave = { ...updated };
  toSave.gemini = { ...updated.gemini, apiKey: "" };

  await chrome.storage.local.set({ [SETTINGS_KEY]: toSave });
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
    if (areaName === "local" && (changes[SETTINGS_KEY] || changes[API_KEY_KEY])) {
      void loadSettings(opts).then(callback);
    }
  };

  chrome.storage.onChanged.addListener(listener);
  return () => {
    chrome.storage.onChanged.removeListener(listener);
  };
}
