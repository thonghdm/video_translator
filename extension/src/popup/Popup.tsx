/**
 * SubTrans Extension — Giao diện Popup (Popup.tsx)
 * Phù hợp với Mục 7 của PLAN.md
 */

import { useEffect, useState, useCallback, useId } from "react";
import { useSettings } from "../shared/useSettings";
import type { SubtitleMode, TranslateMode } from "../shared/types";
import type { BreakerView, TabStatus, UiReq } from "../shared/messages";
import {
  Settings as SettingsIcon,
  Power,
  Globe,
  RefreshCw,
  Check,
  AlertTriangle,
  Eye,
  EyeOff,
  ExternalLink,
  Download,
  CheckCircle2,
  XCircle,
  Tv,
  Subtitles,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

const PRESET_COLORS = [
  { label: "Vàng kim", value: "#fcd34d" },
  { label: "Vàng rực", value: "#facc15" },
  { label: "Xanh dương", value: "#38bdf8" },
  { label: "Xanh lá", value: "#4ade80" },
  { label: "Trắng", value: "#ffffff" },
];

const DEFAULT_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
];

export function Popup() {
  const { settings, loaded, updateSettings } = useSettings();
  const modelListId = useId();

  // Tab & Video State
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [activeHostname, setActiveHostname] = useState<string>("");
  const [tabStatus, setTabStatus] = useState<TabStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  // Breakers from background
  const [breakers, setBreakers] = useState<{
    api: BreakerView;
    cloud: BreakerView;
    deepl?: BreakerView;
  } | null>(null);

  // Gemini State
  const [showApiKey, setShowApiKey] = useState(false);
  const [testResult, setTestResult] = useState<{
    loading: boolean;
    ok?: boolean;
    latencyMs?: number;
    error?: string;
  } | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>(DEFAULT_MODELS);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelFetchMsg, setModelFetchMsg] = useState<string | null>(null);

  // DeepL State
  const [showDeeplConfig, setShowDeeplConfig] = useState(false);
  const [showDeeplApiKey, setShowDeeplApiKey] = useState(false);
  const [deeplTestResult, setDeeplTestResult] = useState<{
    loading: boolean;
    ok?: boolean;
    latencyMs?: number;
    used?: number;
    limit?: number;
    error?: string;
  } | null>(null);

  // Accordion/Collapse toggles
  const [showGeminiConfig, setShowGeminiConfig] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  // Query active tab and initial status
  const refreshTabStatus = useCallback(async () => {
    if (typeof chrome === "undefined" || !chrome.tabs?.query) {
      setStatusLoading(false);
      return;
    }

    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab || !tab.id) {
        setStatusLoading(false);
        return;
      }

      setActiveTabId(tab.id);
      if (tab.url) {
        try {
          const u = new URL(tab.url);
          setActiveHostname(u.hostname);
        } catch {
          setActiveHostname("");
        }
      }

      // 1. Gửi tin nhắn lấy trạng thái từ content script
      chrome.tabs.sendMessage(
        tab.id,
        { type: "tab.status" },
        (res: TabStatus | undefined) => {
          setStatusLoading(false);
          if (chrome.runtime.lastError || !res) {
            setTabStatus(null);
          } else {
            setTabStatus(res);
          }
        }
      );

      // 2. Gửi tin nhắn lấy trạng thái breakers từ background
      chrome.runtime.sendMessage(
        { type: "status" } as UiReq,
        (res: { ok: boolean; breakers?: { api: BreakerView; cloud: BreakerView; deepl?: BreakerView } }) => {
          if (!chrome.runtime.lastError && res?.ok && res.breakers) {
            setBreakers(res.breakers);
          }
        }
      );
    } catch {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshTabStatus();
    // Poll trạng thái tiến độ mỗi 1.5s
    const timer = setInterval(() => {
      void refreshTabStatus();
    }, 1500);
    return () => clearInterval(timer);
  }, [refreshTabStatus]);

  // Host toggle handler
  const isHostDisabled = activeHostname
    ? (settings.disabledHosts || []).includes(activeHostname)
    : false;

  const toggleHost = () => {
    if (!activeHostname) return;
    const current = new Set(settings.disabledHosts || []);
    if (current.has(activeHostname)) {
      current.delete(activeHostname);
    } else {
      current.add(activeHostname);
    }
    updateSettings({ disabledHosts: Array.from(current) });
  };

  // Test Gemini connection
  const handleTestGemini = async () => {
    if (!settings.gemini.apiKey) {
      setTestResult({
        loading: false,
        ok: false,
        error: "Vui lòng nhập API key trước khi kiểm tra",
      });
      return;
    }

    setTestResult({ loading: true });
    try {
      const res = (await chrome.runtime.sendMessage({
        type: "gemini.test",
        apiKey: settings.gemini.apiKey,
        model: settings.gemini.model,
      } as UiReq)) as { ok: boolean; latencyMs?: number; error?: string };

      setTestResult({
        loading: false,
        ok: res.ok,
        latencyMs: res.latencyMs,
        error: res.error,
      });
    } catch (err: unknown) {
      setTestResult({
        loading: false,
        ok: false,
        error: (err as Error)?.message || String(err),
      });
    }
  };

  const formatNumber = (n?: number): string => {
    if (typeof n !== "number") return "0";
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  };

  // Test DeepL connection
  const handleTestDeepl = async () => {
    if (!settings.deepl.apiKey) {
      setDeeplTestResult({
        loading: false,
        ok: false,
        error: "Vui lòng nhập API key trước khi kiểm tra",
      });
      return;
    }

    setDeeplTestResult({ loading: true });
    try {
      const res = (await chrome.runtime.sendMessage({
        type: "deepl.test",
        apiKey: settings.deepl.apiKey,
      } as UiReq)) as {
        ok: boolean;
        latencyMs?: number;
        used?: number;
        limit?: number;
        sample?: string;
        error?: string;
      };

      setDeeplTestResult({
        loading: false,
        ok: res.ok,
        latencyMs: res.latencyMs,
        used: res.used,
        limit: res.limit,
        error: res.error,
      });
    } catch (err: unknown) {
      setDeeplTestResult({
        loading: false,
        ok: false,
        error: (err as Error)?.message || String(err),
      });
    }
  };

  // Fetch list of Gemini models
  const handleFetchModels = async () => {
    if (!settings.gemini.apiKey) {
      setModelFetchMsg("Nhập API key trước");
      return;
    }

    setFetchingModels(true);
    setModelFetchMsg(null);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: "gemini.listModels",
        apiKey: settings.gemini.apiKey,
      } as UiReq)) as { ok: boolean; models?: string[]; error?: string };

      if (res.ok && Array.isArray(res.models) && res.models.length > 0) {
        setAvailableModels(res.models);
        setModelFetchMsg(`Tìm thấy ${res.models.length} model`);
      } else {
        setModelFetchMsg(res.error || "Không lấy được danh sách model");
      }
    } catch (err: unknown) {
      setModelFetchMsg((err as Error)?.message || "Lỗi mạng");
    } finally {
      setFetchingModels(false);
    }
  };

  // Subtitle Export handler
  const handleExportSubtitle = (
    format: "srt" | "vtt",
    mode: "bilingual" | "target" | "source"
  ) => {
    if (!activeTabId) return;
    chrome.tabs.sendMessage(
      activeTabId,
      { type: "tab.export", format, mode },
      (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
          setExportNotice("Xuất file thất bại");
        } else {
          setExportNotice(`Đã tải file .${format}`);
        }
        setTimeout(() => setExportNotice(null), 2500);
      }
    );
  };

  if (!loaded) {
    return (
      <div className="w-[360px] p-6 bg-player-bg text-player-text font-sans flex items-center justify-center">
        <span className="text-neutral-400 text-sm animate-pulse">Đang nạp cài đặt...</span>
      </div>
    );
  }

  const needsKey =
    (settings.mode === "gemini" || settings.mode === "hybrid") &&
    !settings.gemini.apiKey;

  return (
    <div className="w-[360px] bg-player-bg text-player-text font-sans p-3.5 select-none space-y-3.5">
      {/* 1. HEADER */}
      <div className="flex items-center justify-between border-b border-player-border pb-2.5">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-amber-500/20 text-amber-400 flex items-center justify-center font-bold text-xs border border-amber-500/30">
            ST
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight text-white flex items-center gap-1.5">
              SubTrans
              <span className="text-[10px] font-normal px-1 py-0.2 rounded bg-player-surface border border-player-border text-neutral-400">
                v0.1.1
              </span>
            </h1>
          </div>
        </div>

        {/* Global Toggle Button */}
        <button
          onClick={() => updateSettings({ enabled: !settings.enabled })}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all ${
            settings.enabled
              ? "bg-amber-500/20 text-amber-300 border border-amber-500/40 hover:bg-amber-500/30"
              : "bg-player-control text-neutral-400 border border-player-border hover:text-white"
          }`}
          title={settings.enabled ? "Đang bật toàn cục" : "Đang tắt toàn cục"}
        >
          <Power className="w-3.5 h-3.5" />
          <span>{settings.enabled ? "Bật" : "Tắt"}</span>
        </button>
      </div>

      {/* Per-site toggle banner */}
      {activeHostname && (
        <div className="flex items-center justify-between text-xs px-2.5 py-1.5 rounded-md bg-player-surface border border-player-border">
          <div className="flex items-center gap-1.5 text-neutral-300 truncate max-w-[200px]" title={activeHostname}>
            <Globe className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
            <span className="truncate">{activeHostname}</span>
          </div>
          <button
            onClick={toggleHost}
            className={`text-[11px] font-medium px-2 py-0.5 rounded transition ${
              isHostDisabled
                ? "bg-rose-500/20 text-rose-300 hover:bg-rose-500/30"
                : "bg-player-control text-neutral-300 hover:text-white"
            }`}
          >
            {isHostDisabled ? "Bật lại" : "Tắt trên trang này"}
          </button>
        </div>
      )}

      {/* 2. TAB STATUS */}
      <div className="rounded-lg bg-player-surface border border-player-border p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-neutral-300 uppercase tracking-wider flex items-center gap-1">
            <Tv className="w-3.5 h-3.5 text-amber-400" />
            Trạng thái Video
          </span>
          {tabStatus?.platform && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-player-control border border-player-border text-neutral-300 font-medium">
              {tabStatus.platform.toUpperCase()}
            </span>
          )}
        </div>

        {statusLoading ? (
          <div className="text-xs text-neutral-400 animate-pulse py-1">Đang kiểm tra...</div>
        ) : tabStatus?.active ? (
          <div className="space-y-2">
            <div className="text-xs font-medium text-white truncate" title={tabStatus.title || "Video"}>
              {tabStatus.title || "Đang phát video"}
            </div>

            {/* Progress Bar */}
            <div className="space-y-1">
              <div className="flex justify-between text-[11px] text-neutral-400">
                <span>Tiến độ dịch</span>
                <span className="text-amber-300 font-medium">
                  {tabStatus.translated}/{tabStatus.total} câu (
                  {tabStatus.total > 0
                    ? Math.round((tabStatus.translated / tabStatus.total) * 100)
                    : 0}
                  %)
                </span>
              </div>
              <div className="w-full h-1.5 bg-player-control rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-amber-500 to-amber-400 rounded-full transition-all duration-300"
                  style={{
                    width: `${
                      tabStatus.total > 0
                        ? Math.min(100, Math.round((tabStatus.translated / tabStatus.total) * 100))
                        : 0
                    }%`,
                  }}
                />
              </div>
            </div>

            {/* Engine badges count */}
            <div className="flex items-center gap-3 pt-0.5 text-[11px]">
              <span className="inline-flex items-center gap-1 text-emerald-400">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                Google/DeepL: {tabStatus.byEngine.api}
              </span>
              <span className="inline-flex items-center gap-1 text-cyan-400">
                <span className="w-2 h-2 rounded-full bg-cyan-400" />
                Gemini: {tabStatus.byEngine.cloud}
              </span>
            </div>

            {/* Notice / Breaker warnings */}
            {tabStatus.message && (
              <div className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 px-2 py-1 rounded">
                {tabStatus.message}
              </div>
            )}
            {breakers?.api.blocked && (
              <div className="text-[11px] text-rose-400 bg-rose-500/10 border border-rose-500/20 px-2 py-1 rounded">
                Google Translate tạm dừng (rate limit)
              </div>
            )}
            {breakers?.deepl?.blocked && (
              <div className="text-[11px] text-rose-400 bg-rose-500/10 border border-rose-500/20 px-2 py-1 rounded">
                DeepL tạm dừng (hết hạn mức tháng / 429)
              </div>
            )}
            {breakers?.cloud.blocked && (
              <div className="text-[11px] text-rose-400 bg-rose-500/10 border border-rose-500/20 px-2 py-1 rounded">
                Gemini tạm dừng (hết quota / 429)
              </div>
            )}
          </div>
        ) : (
          <div className="text-xs text-neutral-400 py-1.5 text-center bg-player-control/50 rounded border border-dashed border-player-border">
            Trang này chưa có video được hỗ trợ
          </div>
        )}
      </div>

      {/* 3. CHẾ ĐỘ DỊCH */}
      <div className="space-y-1.5">
        <label className="text-xs font-semibold text-neutral-300 uppercase tracking-wider">
          Chế độ dịch
        </label>
        <div className="grid grid-cols-3 gap-1.5">
          {(
            [
              { id: "google", label: "Google", desc: "Siêu tốc" },
              { id: "gemini", label: "Gemini", desc: "Thông minh" },
              { id: "hybrid", label: "Tự động", desc: "Hybrid" },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              onClick={() => updateSettings({ mode: m.id as TranslateMode })}
              className={`py-1.5 px-2 rounded-md border text-center transition flex flex-col items-center justify-center ${
                settings.mode === m.id
                  ? "bg-amber-500/20 border-amber-500/60 text-amber-300"
                  : "bg-player-surface border-player-border text-neutral-300 hover:border-neutral-500"
              }`}
            >
              <span className="text-xs font-semibold">{m.label}</span>
              <span className="text-[10px] text-neutral-400">{m.desc}</span>
            </button>
          ))}
        </div>

        {/* Warning if Gemini/Hybrid selected without API key */}
        {needsKey && (
          <div className="flex items-start gap-1.5 p-2 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs mt-1.5">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
            <div className="flex-1">
              <span>Chưa có Gemini API key. Chế độ này cần API key để hoạt động.</span>
              <button
                onClick={() => setShowGeminiConfig(true)}
                className="ml-1 underline font-semibold text-amber-200 hover:text-white"
              >
                Nhập key ngay
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 4. CẤU HÌNH GEMINI (Accordion / Card) */}
      <div className="rounded-lg bg-player-surface border border-player-border overflow-hidden">
        <button
          onClick={() => setShowGeminiConfig(!showGeminiConfig)}
          className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-neutral-300 hover:text-white transition"
        >
          <span className="flex items-center gap-1.5">
            <span>Cấu hình Gemini</span>
            {settings.gemini.apiKey ? (
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                Đã có key
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-player-control text-neutral-400 border border-player-border">
                Chưa có key
              </span>
            )}
          </span>
          {showGeminiConfig ? (
            <ChevronUp className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" />
          )}
        </button>

        {showGeminiConfig && (
          <div className="p-3 border-t border-player-border space-y-2.5">
            {/* API Key Input */}
            <div className="space-y-1">
              <div className="flex justify-between items-center text-[11px]">
                <span className="text-neutral-300">API Key</span>
                <a
                  href="https://aistudio.google.com/apikey"
                  target="_blank"
                  rel="noreferrer"
                  className="text-amber-400 hover:text-amber-300 inline-flex items-center gap-0.5 text-[10px]"
                >
                  Lấy key miễn phí <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </div>
              <div className="relative">
                <input
                  type={showApiKey ? "text" : "password"}
                  value={settings.gemini.apiKey}
                  onChange={(e) =>
                    updateSettings({
                      gemini: { ...settings.gemini, apiKey: e.target.value.trim() },
                    })
                  }
                  placeholder="AIzaSy..."
                  className="w-full bg-player-bg border border-player-border rounded px-2.5 py-1 text-xs text-white focus:outline-none focus:border-amber-400 pr-8"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-white"
                >
                  {showApiKey ? (
                    <EyeOff className="w-3.5 h-3.5" />
                  ) : (
                    <Eye className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>

            {/* Model input with datalist & refresh */}
            <div className="space-y-1">
              <div className="flex justify-between items-center text-[11px]">
                <span className="text-neutral-300">Model</span>
                {modelFetchMsg && (
                  <span className="text-[10px] text-neutral-400 truncate max-w-[180px]">
                    {modelFetchMsg}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  list={modelListId}
                  value={settings.gemini.model}
                  onChange={(e) =>
                    updateSettings({
                      gemini: { ...settings.gemini, model: e.target.value.trim() },
                    })
                  }
                  placeholder="gemini-3.5-flash-lite"
                  className="flex-1 bg-player-bg border border-player-border rounded px-2.5 py-1 text-xs text-white focus:outline-none focus:border-amber-400"
                />
                <datalist id={modelListId}>
                  {availableModels.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <button
                  type="button"
                  onClick={handleFetchModels}
                  disabled={fetchingModels || !settings.gemini.apiKey}
                  className="p-1 rounded bg-player-control border border-player-border text-neutral-300 hover:text-white disabled:opacity-40"
                  title="Tải danh sách model từ Google AI Studio"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${fetchingModels ? "animate-spin" : ""}`}
                  />
                </button>
              </div>
            </div>

            {/* Test Connection Button */}
            <div className="pt-1">
              <button
                type="button"
                onClick={handleTestGemini}
                disabled={testResult?.loading || !settings.gemini.apiKey}
                className="w-full py-1 rounded bg-player-control border border-player-border text-xs text-neutral-200 hover:bg-player-control/80 hover:text-white disabled:opacity-40 font-medium transition"
              >
                {testResult?.loading ? "Đang kiểm tra kết nối..." : "Kiểm tra kết nối"}
              </button>

              {testResult && !testResult.loading && (
                <div
                  className={`mt-1.5 p-1.5 rounded text-[11px] flex items-center gap-1.5 ${
                    testResult.ok
                      ? "bg-emerald-500/15 border border-emerald-500/30 text-emerald-300"
                      : "bg-rose-500/15 border border-rose-500/30 text-rose-300"
                  }`}
                >
                  {testResult.ok ? (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      <span>Kết nối tốt ({testResult.latencyMs}ms)</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">{testResult.error || "Lỗi kết nối"}</span>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 4b. CẤU HÌNH DEEPL (DỰ PHÒNG) */}
      <div className="rounded-lg bg-player-surface border border-player-border overflow-hidden">
        <button
          onClick={() => setShowDeeplConfig(!showDeeplConfig)}
          className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-neutral-300 hover:text-white transition"
        >
          <span className="flex items-center gap-1.5">
            <span>Cấu hình DeepL (Dự phòng)</span>
            {settings.deepl.apiKey ? (
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                Đã có key
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-player-control text-neutral-400 border border-player-border">
                Chưa có key
              </span>
            )}
          </span>
          {showDeeplConfig ? (
            <ChevronUp className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" />
          )}
        </button>

        {showDeeplConfig && (
          <div className="p-3 border-t border-player-border space-y-2.5">
            {/* API Key Input */}
            <div className="space-y-1">
              <div className="flex justify-between items-center text-[11px]">
                <span className="text-neutral-300">API Key</span>
                <a
                  href="https://www.deepl.com/pro-api"
                  target="_blank"
                  rel="noreferrer"
                  className="text-amber-400 hover:text-amber-300 inline-flex items-center gap-0.5 text-[10px]"
                >
                  Lấy key miễn phí <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </div>
              <div className="relative">
                <input
                  type={showDeeplApiKey ? "text" : "password"}
                  value={settings.deepl.apiKey}
                  onChange={(e) => {
                    // Đổi key → kết quả kiểm tra cũ không còn đúng (tránh hiện ✓ của key trước)
                    setDeeplTestResult(null);
                    updateSettings({
                      deepl: { ...settings.deepl, apiKey: e.target.value.trim() },
                    });
                  }}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx"
                  className="w-full bg-player-bg border border-player-border rounded px-2.5 py-1 text-xs text-white focus:outline-none focus:border-amber-400 pr-8"
                />
                <button
                  type="button"
                  onClick={() => setShowDeeplApiKey(!showDeeplApiKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-white"
                >
                  {showDeeplApiKey ? (
                    <EyeOff className="w-3.5 h-3.5" />
                  ) : (
                    <Eye className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>

            {/* Test Connection Button */}
            <div className="pt-0.5">
              <button
                type="button"
                onClick={handleTestDeepl}
                disabled={deeplTestResult?.loading || !settings.deepl.apiKey}
                className="w-full py-1 rounded bg-player-control border border-player-border text-xs text-neutral-200 hover:bg-player-control/80 hover:text-white disabled:opacity-40 font-medium transition"
              >
                {deeplTestResult?.loading ? "Đang kiểm tra kết nối..." : "Kiểm tra kết nối"}
              </button>

              {deeplTestResult && !deeplTestResult.loading && (
                <div
                  className={`mt-1.5 p-1.5 rounded text-[11px] flex items-center gap-1.5 ${
                    deeplTestResult.ok
                      ? "bg-emerald-500/15 border border-emerald-500/30 text-emerald-300"
                      : "bg-rose-500/15 border border-rose-500/30 text-rose-300"
                  }`}
                >
                  {deeplTestResult.ok ? (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        ✓ {deeplTestResult.latencyMs} ms · đã dùng {formatNumber(deeplTestResult.used)} / {formatNumber(deeplTestResult.limit)} ký tự
                      </span>
                    </>
                  ) : (
                    <>
                      <XCircle className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">{deeplTestResult.error || "Lỗi kết nối"}</span>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Toggles */}
            <div className="space-y-2 pt-1 border-t border-player-border/60">
              <label className="flex items-center justify-between cursor-pointer text-xs text-neutral-300 hover:text-white">
                <span>Dùng DeepL khi Google Translate lỗi</span>
                <input
                  type="checkbox"
                  checked={settings.deepl.enabled}
                  onChange={(e) =>
                    updateSettings({
                      deepl: { ...settings.deepl, enabled: e.target.checked },
                    })
                  }
                  className="w-4 h-4 rounded border-player-border text-amber-500 focus:ring-0 focus:ring-offset-0 bg-player-bg cursor-pointer"
                />
              </label>

              <div className="space-y-0.5">
                <label className="flex items-center justify-between cursor-pointer text-xs text-neutral-300 hover:text-white">
                  <span>Ưu tiên DeepL (dùng trước Google)</span>
                  <input
                    type="checkbox"
                    checked={settings.deepl.prefer}
                    onChange={(e) =>
                      updateSettings({
                        deepl: { ...settings.deepl, prefer: e.target.checked },
                      })
                    }
                    className="w-4 h-4 rounded border-player-border text-amber-500 focus:ring-0 focus:ring-offset-0 bg-player-bg cursor-pointer"
                  />
                </label>
                <p className="text-[10px] text-neutral-400">
                  Tốn hạn mức 500.000 ký tự/tháng nhanh hơn
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 5. HIỂN THỊ & CỠ CHỮ */}
      <div className="space-y-2">
        <label className="text-xs font-semibold text-neutral-300 uppercase tracking-wider flex items-center justify-between">
          <span className="flex items-center gap-1">
            <Subtitles className="w-3.5 h-3.5 text-amber-400" />
            Hiển thị phụ đề
          </span>
          <span className="text-[10px] text-neutral-500">Phím tắt V</span>
        </label>

        {/* 4 Chế độ hiển thị */}
        <div className="grid grid-cols-4 gap-1">
          {(
            [
              { id: "bilingual", label: "Song ngữ" },
              { id: "vi", label: "Chỉ VI" },
              { id: "en", label: "Chỉ EN" },
              { id: "off", label: "Tắt" },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              onClick={() => updateSettings({ subtitleMode: m.id as SubtitleMode })}
              className={`py-1 px-1 rounded text-xs font-medium border text-center transition ${
                settings.subtitleMode === m.id
                  ? "bg-amber-500/20 border-amber-500/60 text-amber-300"
                  : "bg-player-surface border-player-border text-neutral-400 hover:text-white"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Sliders: Cỡ chữ & Độ mờ nền */}
        <div className="space-y-2 pt-1 bg-player-surface border border-player-border rounded-lg p-2.5">
          {/* Cỡ chữ */}
          <div className="space-y-1">
            <div className="flex justify-between text-[11px] text-neutral-300">
              <span>Cỡ chữ</span>
              <span className="text-amber-300 font-medium">
                {Math.round(settings.style.fontScale * 100)}%
              </span>
            </div>
            <input
              type="range"
              min="0.8"
              max="1.8"
              step="0.05"
              value={settings.style.fontScale}
              onChange={(e) =>
                updateSettings({
                  style: { ...settings.style, fontScale: parseFloat(e.target.value) },
                })
              }
              className="w-full accent-amber-400 h-1 bg-player-control rounded cursor-pointer"
            />
          </div>

          {/* Độ mờ nền */}
          <div className="space-y-1">
            <div className="flex justify-between text-[11px] text-neutral-300">
              <span>Độ đậm nền</span>
              <span className="text-amber-300 font-medium">
                {Math.round(settings.style.bgOpacity * 100)}%
              </span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={settings.style.bgOpacity}
              onChange={(e) =>
                updateSettings({
                  style: { ...settings.style, bgOpacity: parseFloat(e.target.value) },
                })
              }
              className="w-full accent-amber-400 h-1 bg-player-control rounded cursor-pointer"
            />
          </div>

          {/* Màu chữ VI */}
          <div className="space-y-1 pt-1">
            <div className="flex justify-between items-center text-[11px] text-neutral-300">
              <span>Màu chữ tiếng Việt</span>
              <input
                type="color"
                value={settings.style.viColor}
                onChange={(e) =>
                  updateSettings({
                    style: { ...settings.style, viColor: e.target.value },
                  })
                }
                className="w-4 h-4 rounded cursor-pointer bg-transparent border-0"
                title="Chọn màu tự do"
              />
            </div>
            <div className="flex items-center gap-1.5">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() =>
                    updateSettings({
                      style: { ...settings.style, viColor: c.value },
                    })
                  }
                  className={`flex-1 h-5 rounded border transition flex items-center justify-center ${
                    settings.style.viColor.toLowerCase() === c.value.toLowerCase()
                      ? "border-white ring-1 ring-white"
                      : "border-player-border"
                  }`}
                  style={{ backgroundColor: c.value }}
                  title={c.label}
                >
                  {settings.style.viColor.toLowerCase() === c.value.toLowerCase() && (
                    <Check className="w-3 h-3 text-black stroke-[3]" />
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 6. XUẤT PHỤ ĐỀ */}
      <div className="space-y-1.5">
        <div className="flex justify-between items-center">
          <label className="text-xs font-semibold text-neutral-300 uppercase tracking-wider flex items-center gap-1">
            <Download className="w-3.5 h-3.5 text-amber-400" />
            Xuất phụ đề
          </label>
          {exportNotice && (
            <span className="text-[11px] text-emerald-400 font-medium">
              {exportNotice}
            </span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-1">
          <button
            onClick={() => handleExportSubtitle("srt", "bilingual")}
            disabled={!tabStatus?.active}
            className="py-1 px-1 rounded bg-player-surface border border-player-border text-[11px] text-neutral-300 hover:text-white hover:border-neutral-500 disabled:opacity-40 transition"
          >
            SRT Song ngữ
          </button>
          <button
            onClick={() => handleExportSubtitle("srt", "target")}
            disabled={!tabStatus?.active}
            className="py-1 px-1 rounded bg-player-surface border border-player-border text-[11px] text-neutral-300 hover:text-white hover:border-neutral-500 disabled:opacity-40 transition"
          >
            SRT Tiếng Việt
          </button>
          <button
            onClick={() => handleExportSubtitle("srt", "source")}
            disabled={!tabStatus?.active}
            className="py-1 px-1 rounded bg-player-surface border border-player-border text-[11px] text-neutral-300 hover:text-white hover:border-neutral-500 disabled:opacity-40 transition"
          >
            SRT Tiếng Anh
          </button>

          <button
            onClick={() => handleExportSubtitle("vtt", "bilingual")}
            disabled={!tabStatus?.active}
            className="py-1 px-1 rounded bg-player-surface border border-player-border text-[11px] text-neutral-300 hover:text-white hover:border-neutral-500 disabled:opacity-40 transition"
          >
            VTT Song ngữ
          </button>
          <button
            onClick={() => handleExportSubtitle("vtt", "target")}
            disabled={!tabStatus?.active}
            className="py-1 px-1 rounded bg-player-surface border border-player-border text-[11px] text-neutral-300 hover:text-white hover:border-neutral-500 disabled:opacity-40 transition"
          >
            VTT Tiếng Việt
          </button>
          <button
            onClick={() => handleExportSubtitle("vtt", "source")}
            disabled={!tabStatus?.active}
            className="py-1 px-1 rounded bg-player-surface border border-player-border text-[11px] text-neutral-300 hover:text-white hover:border-neutral-500 disabled:opacity-40 transition"
          >
            VTT Tiếng Anh
          </button>
        </div>
      </div>

      {/* 7. FOOTER */}
      <div className="pt-2 border-t border-player-border flex items-center justify-between">
        <button
          onClick={() => {
            if (typeof chrome !== "undefined" && chrome.runtime?.openOptionsPage) {
              chrome.runtime.openOptionsPage();
            }
          }}
          className="text-xs text-neutral-400 hover:text-amber-400 transition flex items-center gap-1 font-medium"
        >
          <SettingsIcon className="w-3.5 h-3.5" />
          <span>Cài đặt nâng cao & Cache</span>
        </button>
        <span className="text-[10px] text-neutral-500">SubTrans MVP</span>
      </div>
    </div>
  );
}
