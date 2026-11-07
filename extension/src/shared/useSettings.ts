/**
 * SubTrans Extension — Hook React quản lý Settings với debounce 300ms
 * Phù hợp với Mục 6.3 và Phase 7 của PLAN.md
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
}

export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<Settings>(cloneDefaults);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Partial<Settings>>({});

  useEffect(() => {
    let mounted = true;
    void loadSettings({ includeApiKey: true }).then((s) => {
      if (mounted) {
        setSettings(s);
        setLoaded(true);
      }
    });

    const off = onSettingsChanged(
      (newS) => {
        if (mounted) {
          setSettings(newS);
        }
      },
      { includeApiKey: true }
    );

    return () => {
      mounted = false;
      off();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const updateSettings = useCallback((partial: Partial<Settings>) => {
    // 1. Cập nhật ngay UI để người dùng không cảm thấy độ trễ
    setSettings((prev) => deepMerge(prev, partial));

    // 2. Tích luỹ các thay đổi và debounce lưu sau 300ms
    pendingRef.current = deepMerge(pendingRef.current, partial);
    setSaving(true);

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(async () => {
      const toSave = pendingRef.current;
      pendingRef.current = {};
      try {
        await saveSettings(toSave);
      } finally {
        setSaving(false);
      }
    }, 300);
  }, []);

  const resetDefaults = useCallback(
    async (keepApiKey = true): Promise<void> => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        pendingRef.current = {};
      }
      const apiKey = keepApiKey ? settings.gemini.apiKey : "";
      const fresh = cloneDefaults();
      fresh.gemini.apiKey = apiKey;

      setSettings(fresh);
      await saveSettings(fresh);
      setSaving(false);
    },
    [settings.gemini.apiKey]
  );

  return {
    settings,
    loaded,
    saving,
    updateSettings,
    resetDefaults,
  };
}
