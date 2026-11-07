/**
 * SubTrans Extension — Giao diện Cài đặt (Options.tsx)
 * Phù hợp với Mục 7 của PLAN.md
 */

import { useEffect, useState, useCallback } from "react";
import { useSettings } from "../shared/useSettings";
import { NumberField } from "./NumberField";
import type { UiReq } from "../shared/messages";
import {
  Database,
  Trash2,
  RotateCcw,
  RefreshCw,
  CheckCircle2,
  Cpu,
  Zap,
  Video,
  Shield,
  Keyboard,
  HardDrive,
} from "lucide-react";

interface RecentTrackItem {
  trackKey: string;
  title?: string;
  platform?: string;
  lastAccessed: number;
  lineCount?: number;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function formatDate(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("vi-VN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function Options() {
  const { settings, loaded, saving, updateSettings, resetDefaults } = useSettings();

  // Cache stats & recent list
  const [cacheStats, setCacheStats] = useState<{
    trackCount: number;
    estimatedBytes: number;
  }>({ trackCount: 0, estimatedBytes: 0 });
  const [recentTracks, setRecentTracks] = useState<RecentTrackItem[]>([]);
  const [cacheLoading, setCacheLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const fetchCacheData = useCallback(async () => {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
    setCacheLoading(true);
    try {
      const statsRes = (await chrome.runtime.sendMessage({
        type: "cache.stats",
      } as UiReq)) as { trackCount: number; estimatedBytes: number };

      if (statsRes && typeof statsRes.trackCount === "number") {
        setCacheStats(statsRes);
      }

      const listRes = (await chrome.runtime.sendMessage({
        type: "cache.listRecent",
        limit: 50,
      } as UiReq)) as RecentTrackItem[];

      if (Array.isArray(listRes)) {
        setRecentTracks(listRes);
      }
    } catch {
      // Ignored
    } finally {
      setCacheLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchCacheData();
  }, [fetchCacheData]);

  const handleClearAllCache = async () => {
    if (!window.confirm("Bạn có chắc chắn muốn xóa toàn bộ bộ nhớ đệm phụ đề không?")) {
      return;
    }
    try {
      await chrome.runtime.sendMessage({ type: "cache.clear" } as UiReq);
      setStatusMessage("Đã xóa sạch bộ nhớ đệm");
      void fetchCacheData();
      setTimeout(() => setStatusMessage(null), 3000);
    } catch {
      setStatusMessage("Xóa bộ nhớ đệm thất bại");
    }
  };

  const handleDeleteTrack = async (trackKey: string) => {
    try {
      await chrome.runtime.sendMessage({
        type: "cache.clear",
        trackKey,
      } as UiReq);
      setRecentTracks((prev) => prev.filter((t) => t.trackKey !== trackKey));
      void fetchCacheData();
    } catch {
      // Ignored
    }
  };

  const handleResetDefaults = async () => {
    if (
      !window.confirm(
        "Khôi phục tất cả cài đặt về mặc định? (API Key của Gemini sẽ được giữ nguyên)"
      )
    ) {
      return;
    }
    await resetDefaults(true);
    setStatusMessage("Đã khôi phục cài đặt mặc định");
    setTimeout(() => setStatusMessage(null), 3000);
  };

  if (!loaded) {
    return (
      <div className="min-h-screen bg-player-bg text-player-text font-sans flex items-center justify-center">
        <span className="text-neutral-400 text-sm animate-pulse">Đang nạp cài đặt...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-player-bg text-player-text font-sans p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-player-border pb-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center font-bold text-base border border-amber-500/30">
              ST
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
                Cài đặt SubTrans
              </h1>
              <p className="text-xs text-neutral-400">
                Tùy chỉnh thông số dịch, hiệu năng bộ đệm và YouTube
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {saving ? (
              <span className="text-xs text-amber-400 flex items-center gap-1 animate-pulse">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                Đang lưu...
              </span>
            ) : (
              <span className="text-xs text-emerald-400 flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Đã lưu
              </span>
            )}
            <button
              onClick={handleResetDefaults}
              className="ml-3 px-3 py-1.5 rounded-md bg-player-surface border border-player-border text-xs text-neutral-300 hover:text-white hover:border-neutral-500 flex items-center gap-1.5 transition"
              title="Khôi phục tất cả cài đặt về giá trị mặc định ban đầu"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Khôi phục mặc định</span>
            </button>
          </div>
        </div>

        {statusMessage && (
          <div className="p-3 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" />
            <span>{statusMessage}</span>
          </div>
        )}

        {/* 1. GOOGLE TRANSLATE (GTX) */}
        <section className="bg-player-surface border border-player-border rounded-xl p-4 space-y-4">
          <div className="flex items-center gap-2 text-white font-semibold text-sm border-b border-player-border pb-2.5">
            <Zap className="w-4 h-4 text-cyan-400" />
            <span>Google Translate (Siêu tốc - GTX)</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-neutral-300">
                Số kết nối đồng thời (Concurrency)
              </label>
              <NumberField
                limitKey="gtx.concurrency"
                value={settings.gtx.concurrency}
                onCommit={(v) => updateSettings({ gtx: { ...settings.gtx, concurrency: v } })}
                className="w-full bg-player-bg border border-player-border rounded-md px-3 py-1.5 text-xs text-white focus:outline-none focus:border-amber-400"
              />
              <p className="text-[11px] text-neutral-400">Mặc định: 2 kết nối</p>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-neutral-300">
                Khoảng nghỉ giữa các batch (ms)
              </label>
              <NumberField
                limitKey="gtx.gapMs"
                value={settings.gtx.gapMs} step={50}
                onCommit={(v) => updateSettings({ gtx: { ...settings.gtx, gapMs: v } })}
                className="w-full bg-player-bg border border-player-border rounded-md px-3 py-1.5 text-xs text-white focus:outline-none focus:border-amber-400"
              />
              <p className="text-[11px] text-neutral-400">Mặc định: 150ms</p>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-neutral-300">
                Thời gian chờ tối đa Timeout (ms)
              </label>
              <NumberField
                limitKey="gtx.timeoutMs"
                value={settings.gtx.timeoutMs} step={500}
                onCommit={(v) => updateSettings({ gtx: { ...settings.gtx, timeoutMs: v } })}
                className="w-full bg-player-bg border border-player-border rounded-md px-3 py-1.5 text-xs text-white focus:outline-none focus:border-amber-400"
              />
              <p className="text-[11px] text-neutral-400">Mặc định: 5000ms</p>
            </div>
          </div>
        </section>

        {/* 2. GEMINI API */}
        <section className="bg-player-surface border border-player-border rounded-xl p-4 space-y-4">
          <div className="flex items-center gap-2 text-white font-semibold text-sm border-b border-player-border pb-2.5">
            <Cpu className="w-4 h-4 text-emerald-400" />
            <span>Gemini AI (Thông minh)</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-neutral-300">
                Giới hạn RPM (Requests / phút)
              </label>
              <NumberField
                limitKey="gemini.rpm"
                value={settings.gemini.rpm}
                onCommit={(v) => updateSettings({ gemini: { ...settings.gemini, rpm: v } })}
                className="w-full bg-player-bg border border-player-border rounded-md px-3 py-1.5 text-xs text-white focus:outline-none focus:border-amber-400"
              />
              <p className="text-[11px] text-neutral-400">Gói miễn phí: khuyến nghị 12-15</p>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-neutral-300">
                Timeout Tier 1 (Câu đang phát)
              </label>
              <NumberField
                limitKey="gemini.timeoutTier1Ms"
                value={settings.gemini.timeoutTier1Ms} step={500}
                onCommit={(v) => updateSettings({ gemini: { ...settings.gemini, timeoutTier1Ms: v } })}
                className="w-full bg-player-bg border border-player-border rounded-md px-3 py-1.5 text-xs text-white focus:outline-none focus:border-amber-400"
              />
              <p className="text-[11px] text-neutral-400">Mặc định: 3500ms</p>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-neutral-300">
                Timeout Tier 2 (Dịch trước)
              </label>
              <NumberField
                limitKey="gemini.timeoutTier2Ms"
                value={settings.gemini.timeoutTier2Ms} step={1000}
                onCommit={(v) => updateSettings({ gemini: { ...settings.gemini, timeoutTier2Ms: v } })}
                className="w-full bg-player-bg border border-player-border rounded-md px-3 py-1.5 text-xs text-white focus:outline-none focus:border-amber-400"
              />
              <p className="text-[11px] text-neutral-400">Mặc định: 8000ms</p>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-neutral-300">
                Số câu tối đa Tier 1 (Batch)
              </label>
              <NumberField
                limitKey="gemini.maxItemsTier1"
                value={settings.gemini.maxItemsTier1}
                onCommit={(v) => updateSettings({ gemini: { ...settings.gemini, maxItemsTier1: v } })}
                className="w-full bg-player-bg border border-player-border rounded-md px-3 py-1.5 text-xs text-white focus:outline-none focus:border-amber-400"
              />
              <p className="text-[11px] text-neutral-400">Mặc định: 10 câu</p>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-neutral-300">
                Số câu tối đa Tier 2 (Batch)
              </label>
              <NumberField
                limitKey="gemini.maxItemsTier2"
                value={settings.gemini.maxItemsTier2}
                onCommit={(v) => updateSettings({ gemini: { ...settings.gemini, maxItemsTier2: v } })}
                className="w-full bg-player-bg border border-player-border rounded-md px-3 py-1.5 text-xs text-white focus:outline-none focus:border-amber-400"
              />
              <p className="text-[11px] text-neutral-400">Mặc định: 20 câu</p>
            </div>
          </div>
        </section>

        {/* 3. YOUTUBE & HÀNH VI HỆ THỐNG */}
        <section className="bg-player-surface border border-player-border rounded-xl p-4 space-y-4">
          <div className="flex items-center gap-2 text-white font-semibold text-sm border-b border-player-border pb-2.5">
            <Video className="w-4 h-4 text-red-500" />
            <span>YouTube & Hành vi phát Video</span>
          </div>

          <div className="space-y-3">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.youtube.hideNativeCaptions}
                onChange={(e) =>
                  updateSettings({
                    youtube: { ...settings.youtube, hideNativeCaptions: e.target.checked },
                  })
                }
                className="mt-0.5 accent-amber-400 rounded w-4 h-4"
              />
              <div>
                <span className="text-xs font-medium text-white">
                  Ẩn phụ đề mặc định của YouTube khi SubTrans hoạt động
                </span>
                <p className="text-[11px] text-neutral-400">
                  Tránh tình trạng phụ đề gốc của YouTube đè lên phụ đề SubTrans.
                </p>
              </div>
            </label>

            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.youtube.preferManual}
                onChange={(e) =>
                  updateSettings({
                    youtube: { ...settings.youtube, preferManual: e.target.checked },
                  })
                }
                className="mt-0.5 accent-amber-400 rounded w-4 h-4"
              />
              <div>
                <span className="text-xs font-medium text-white">
                  Ưu tiên phụ đề thủ công hơn phụ đề nhận diện giọng nói (ASR)
                </span>
                <p className="text-[11px] text-neutral-400">
                  Nếu video có cả phụ đề do tác giả tải lên và phụ đề tự động, sẽ chọn phụ đề tác giả.
                </p>
              </div>
            </label>

            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.pretranslateWholeTrack}
                onChange={(e) =>
                  updateSettings({
                    pretranslateWholeTrack: e.target.checked,
                  })
                }
                className="mt-0.5 accent-amber-400 rounded w-4 h-4"
              />
              <div>
                <span className="text-xs font-medium text-white">
                  Tự động dịch trước toàn bộ video ở chế độ nền (Lookahead Scheduler)
                </span>
                <p className="text-[11px] text-neutral-400">
                  Dịch trước các câu phía sau để khi tua video phụ đề có sẵn ngay lập tức mà không phải chờ.
                </p>
              </div>
            </label>

            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.shortcuts.enabled}
                onChange={(e) =>
                  updateSettings({
                    shortcuts: { ...settings.shortcuts, enabled: e.target.checked },
                  })
                }
                className="mt-0.5 accent-amber-400 rounded w-4 h-4"
              />
              <div>
                <span className="text-xs font-medium text-white flex items-center gap-1.5">
                  <Keyboard className="w-3.5 h-3.5 text-neutral-400" />
                  Bật phím tắt bàn phím (V: đổi chế độ phụ đề, G/H: chỉnh lệch thời gian)
                </span>
                <p className="text-[11px] text-neutral-400">
                  Phím tắt tự động bỏ qua khi bạn đang nhập văn bản vào ô tìm kiếm hoặc bình luận.
                </p>
              </div>
            </label>
          </div>
        </section>

        {/* 4. CHÍNH SÁCH BỘ NHỚ ĐỆM (CACHE POLICY) */}
        <section className="bg-player-surface border border-player-border rounded-xl p-4 space-y-4">
          <div className="flex items-center gap-2 text-white font-semibold text-sm border-b border-player-border pb-2.5">
            <Shield className="w-4 h-4 text-amber-400" />
            <span>Giới hạn bộ nhớ đệm (Cache Policy)</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-neutral-300">
                Số lượng track tối đa lưu trong đệm (LRU)
              </label>
              <NumberField
                limitKey="cache.maxTracks"
                value={settings.cache.maxTracks} step={10}
                onCommit={(v) => updateSettings({ cache: { ...settings.cache, maxTracks: v } })}
                className="w-full bg-player-bg border border-player-border rounded-md px-3 py-1.5 text-xs text-white focus:outline-none focus:border-amber-400"
              />
              <p className="text-[11px] text-neutral-400">Mặc định: 200 track</p>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-neutral-300">
                Thời hạn tối đa lưu bản dịch (ngày)
              </label>
              <NumberField
                limitKey="cache.maxAgeDays"
                value={settings.cache.maxAgeDays}
                onCommit={(v) => updateSettings({ cache: { ...settings.cache, maxAgeDays: v } })}
                className="w-full bg-player-bg border border-player-border rounded-md px-3 py-1.5 text-xs text-white focus:outline-none focus:border-amber-400"
              />
              <p className="text-[11px] text-neutral-400">Mặc định: 30 ngày</p>
            </div>
          </div>
        </section>

        {/* 5. QUẢN LÝ BỘ NHỚ ĐỆM (INDEXEDDB) */}
        <section className="bg-player-surface border border-player-border rounded-xl p-4 space-y-4">
          <div className="flex items-center justify-between border-b border-player-border pb-2.5">
            <div className="flex items-center gap-2 text-white font-semibold text-sm">
              <Database className="w-4 h-4 text-emerald-400" />
              <span>Quản lý Bộ nhớ đệm (IndexedDB)</span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={fetchCacheData}
                disabled={cacheLoading}
                className="p-1.5 rounded bg-player-control border border-player-border text-neutral-300 hover:text-white disabled:opacity-40"
                title="Làm mới danh sách"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${cacheLoading ? "animate-spin" : ""}`} />
              </button>

              <button
                onClick={handleClearAllCache}
                className="px-2.5 py-1 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 hover:bg-rose-500/30 text-xs font-medium flex items-center gap-1 transition"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Xóa toàn bộ Cache</span>
              </button>
            </div>
          </div>

          {/* Stats Bar */}
          <div className="grid grid-cols-2 gap-3 p-3 rounded-lg bg-player-bg border border-player-border">
            <div className="flex items-center gap-2.5">
              <HardDrive className="w-4 h-4 text-neutral-400" />
              <div>
                <div className="text-xs text-neutral-400">Tổng số track đã lưu</div>
                <div className="text-sm font-bold text-white">
                  {cacheStats.trackCount} track
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <Database className="w-4 h-4 text-neutral-400" />
              <div>
                <div className="text-xs text-neutral-400">Dung lượng ước tính</div>
                <div className="text-sm font-bold text-amber-300">
                  {formatBytes(cacheStats.estimatedBytes)}
                </div>
              </div>
            </div>
          </div>

          {/* List of 50 recent tracks */}
          <div className="space-y-2">
            <div className="text-xs font-medium text-neutral-300">
              Danh sách 50 video đã lưu gần nhất:
            </div>

            {recentTracks.length === 0 ? (
              <div className="text-xs text-neutral-500 text-center py-6 border border-dashed border-player-border rounded-lg">
                Chưa có dữ liệu nào trong bộ nhớ đệm
              </div>
            ) : (
              <div className="max-h-72 overflow-y-auto space-y-1.5 pr-1">
                {recentTracks.map((tr) => (
                  <div
                    key={tr.trackKey}
                    className="flex items-center justify-between p-2 rounded-lg bg-player-bg border border-player-border hover:border-neutral-500 transition group text-xs"
                  >
                    <div className="flex-1 min-w-0 pr-3">
                      <div className="font-medium text-white truncate" title={tr.title || tr.trackKey}>
                        {tr.title || tr.trackKey}
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-neutral-400 mt-0.5">
                        <span className="capitalize">{tr.platform || "Web"}</span>
                        <span>•</span>
                        <span>{formatDate(tr.lastAccessed)}</span>
                        {typeof tr.lineCount === "number" && (
                          <>
                            <span>•</span>
                            <span>{tr.lineCount} câu</span>
                          </>
                        )}
                      </div>
                    </div>

                    <button
                      onClick={() => handleDeleteTrack(tr.trackKey)}
                      className="p-1.5 rounded text-neutral-400 hover:text-rose-400 hover:bg-rose-500/10 transition"
                      title="Xóa track này khỏi cache"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
