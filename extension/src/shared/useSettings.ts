/**
 * SubTrans Extension — Hook React quản lý Settings (Popup/Options), debounce 300ms.
 *
 * Hai lỗi đã xử lý (review Phase 7):
 * 1. Popup đóng ngay khi người dùng click ra ngoài → thay đổi đang chờ debounce bị MẤT (vd. vừa dán API key).
 *    → Lưu NGAY khi trang sắp ẩn/đóng (pagehide, visibilitychange=hidden) và khi unmount.
 * 2. storage.onChanged (từ lần lưu trước) ghi đè state khi người dùng vẫn đang gõ → ô nhập "giật lùi".
 *    → Khi nhận thay đổi từ bên ngoài, áp lại các thay đổi CHƯA LƯU lên trên.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import {
  loadSettings,
  saveSettings,
  onSettingsChanged,
  type Settings,
  cloneDefaults,
  deepMerge,
} from "./settings";

export interface UseSettingsResult {
  settings: Settings;
  loaded: boolean;
  saving: boolean;
  updateSettings: (partial: Partial<Settings>) => void;
  resetDefaults: (keepApiKey?: boolean) => Promise<void>;
  /** Lưu ngay các thay đổi đang chờ (không chờ debounce) */
  flush: () => Promise<void>;
}

export const SETTINGS_DEBOUNCE_MS = 300;

export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<Settings>(cloneDefaults);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Partial<Settings> | null>(null);
  const settingsRef = useRef<Settings>(settings);
  settingsRef.current = settings;

  const flush = useCallback(async (): Promise<void> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const toSave = pendingRef.current;
    pendingRef.current = null;
    if (!toSave) return;
    try {
      await saveSettings(toSave);
    } finally {
      if (!pendingRef.current) setSaving(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    void loadSettings({ includeApiKey: true }).then((s) => {
      if (!mounted) return;
      // Người dùng có thể đã đổi gì đó trước khi load xong
      setSettings(pendingRef.current ? deepMerge(s, pendingRef.current) : s);
      setLoaded(true);
    });

    const off = onSettingsChanged(
      (newS) => {
        if (!mounted) return;
        setSettings(pendingRef.current ? deepMerge(newS, pendingRef.current) : newS);
      },
      { includeApiKey: true }
    );

    // Popup sắp đóng / tab Options bị ẩn → lưu ngay
    const onHide = () => {
      void flush();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      mounted = false;
      off();
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      void flush();
    };
  }, [flush]);

  const updateSettings = useCallback((partial: Partial<Settings>) => {
    setSettings((prev) => deepMerge(prev, partial));
    pendingRef.current = pendingRef.current ? deepMerge(pendingRef.current, partial) : structuredClone(partial);
    setSaving(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flush();
    }, SETTINGS_DEBOUNCE_MS);
  }, [flush]);

  const resetDefaults = useCallback(async (keepApiKey = true): Promise<void> => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingRef.current = null;
    const fresh = cloneDefaults();
    fresh.gemini.apiKey = keepApiKey ? settingsRef.current.gemini.apiKey : "";
    setSettings(fresh);
    await saveSettings(fresh);
    setSaving(false);
  }, []);

  return { settings, loaded, saving, updateSettings, resetDefaults, flush };
}
