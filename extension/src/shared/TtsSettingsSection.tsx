/**
 * SubTrans Extension — Khu vực cài đặt Thuyết minh tiếng Việt (Edge Neural TTS)
 * Dùng chung cho Popup.tsx (compact) và Options.tsx (card đầy đủ).
 */

import { useState } from "react";
import { Volume2, Play, RefreshCw, CheckCircle2, XCircle } from "lucide-react";
import type { Settings } from "./settings";
import type { TtsVoice, UiReq } from "./messages";

export interface TtsSettingsSectionProps {
  tts: Settings["tts"];
  onChange: (next: Settings["tts"]) => void;
  compact?: boolean;
}

const VOICE_OPTIONS: Array<{ value: TtsVoice; label: string }> = [
  { value: "vi-VN-HoaiMyNeural", label: "Nữ — Hoài Mỹ (Tự nhiên)" },
  { value: "vi-VN-NamMinhNeural", label: "Nam — Nam Minh (Trầm ấm)" },
];

function formatRate(offset: number): string {
  const rounded = Math.round(offset / 5) * 5;
  const val = rounded === 0 ? 0 : rounded;
  return val >= 0 ? `+${val}%` : `${val}%`;
}

async function playBase64WithWebAudio(
  audioBase64: string,
  volume: number
): Promise<void> {
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const Ctor =
    globalThis.AudioContext ||
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) throw new Error("Trình duyệt không hỗ trợ Web Audio API");

  const ctx = new Ctor();
  try {
    const bufferCopy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(bufferCopy).set(bytes);
    const audioBuffer = await ctx.decodeAudioData(bufferCopy);
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    const gain = ctx.createGain();
    gain.gain.value = Math.min(1, Math.max(0.1, volume));
    gain.connect(ctx.destination);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(gain);

    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start(0);
    });
  } finally {
    void Promise.resolve(ctx.close()).catch(() => {});
  }
}

export function TtsSettingsSection({
  tts,
  onChange,
  compact = false,
}: TtsSettingsSectionProps) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    latencyMs?: number;
    error?: string;
  } | null>(null);

  const handleTestVoice = async () => {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      setTestResult({ ok: false, error: "Không kết nối được background" });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const req: UiReq = {
        type: "tts.test",
        voice: tts.voice,
        rate: formatRate(tts.rateOffset),
      };
      const res = (await chrome.runtime.sendMessage(req)) as {
        ok?: boolean;
        latencyMs?: number;
        audioBase64?: string;
        error?: string;
      };
      if (!res?.ok || !res.audioBase64) {
        setTestResult({ ok: false, error: res?.error || "Không nhận được âm thanh" });
        return;
      }
      setTestResult({ ok: true, latencyMs: res.latencyMs });
      await playBase64WithWebAudio(res.audioBase64, tts.ttsVolume);
    } catch (err) {
      setTestResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div
      className={
        compact
          ? "space-y-2 p-2.5 rounded-lg bg-player-surface border border-player-border"
          : "space-y-4"
      }
    >
      {/* Header + Công tắc Bật/Tắt */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Volume2
            className={`${compact ? "w-3.5 h-3.5" : "w-4 h-4"} text-emerald-400`}
          />
          <span
            className={
              compact
                ? "text-xs font-semibold text-neutral-200 uppercase tracking-wider"
                : "text-sm font-semibold text-white"
            }
          >
            Thuyết minh tiếng Việt (Edge Neural TTS)
          </span>
        </div>

        <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={tts.enabled}
            onChange={(e) => onChange({ ...tts, enabled: e.target.checked })}
            className="w-4 h-4 rounded accent-emerald-500 cursor-pointer"
          />
          <span
            className={`text-xs font-medium ${
              tts.enabled ? "text-emerald-400" : "text-neutral-400"
            }`}
          >
            {tts.enabled ? "Đang bật" : "Đang tắt"}
          </span>
        </label>
      </div>

      {/* Chọn giọng đọc + Nút Nghe thử */}
      <div className="flex items-center gap-2">
        <select
          value={tts.voice}
          onChange={(e) =>
            onChange({ ...tts, voice: e.target.value as TtsVoice })
          }
          className="flex-1 bg-player-bg border border-player-border rounded px-2 py-1 text-xs text-neutral-200 focus:outline-none focus:border-emerald-400"
          aria-label="Chọn giọng thuyết minh"
        >
          {VOICE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => void handleTestVoice()}
          disabled={testing}
          className="px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30 disabled:opacity-50 text-xs font-medium flex items-center gap-1 transition shrink-0"
        >
          {testing ? (
            <RefreshCw className="w-3 h-3 animate-spin" />
          ) : (
            <Play className="w-3 h-3" />
          )}
          <span>Nghe thử</span>
        </button>
      </div>

      {/* Trạng thái nghe thử */}
      {testResult && (
        <div
          className={`flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border ${
            testResult.ok
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
              : "bg-rose-500/10 border-rose-500/30 text-rose-300"
          }`}
        >
          {testResult.ok ? (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span>
                Phát thành công
                {typeof testResult.latencyMs === "number"
                  ? ` (${testResult.latencyMs} ms)`
                  : ""}
              </span>
            </>
          ) : (
            <>
              <XCircle className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{testResult.error}</span>
            </>
          )}
        </div>
      )}

      {/* Các thanh trượt */}
      <div className={compact ? "space-y-2" : "grid grid-cols-1 md:grid-cols-3 gap-4"}>
        {/* Âm lượng giọng đọc */}
        <div className="space-y-1">
          <div className="flex justify-between text-[11px] text-neutral-300">
            <span>Âm lượng giọng đọc</span>
            <span className="text-emerald-300 font-medium">
              {Math.round(tts.ttsVolume * 100)}%
            </span>
          </div>
          <input
            type="range"
            min="0.1"
            max="1"
            step="0.05"
            value={tts.ttsVolume}
            onChange={(e) =>
              onChange({ ...tts, ttsVolume: parseFloat(e.target.value) })
            }
            className="w-full accent-emerald-400 h-1 bg-player-control rounded cursor-pointer"
          />
        </div>

        {/* Audio Ducking */}
        <div className="space-y-1">
          <div className="flex justify-between text-[11px] text-neutral-300">
            <span>Âm lượng video gốc khi đọc</span>
            <span className="text-amber-300 font-medium">
              {Math.round(tts.duckingVolume * 100)}%
            </span>
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={tts.duckingVolume}
            onChange={(e) =>
              onChange({ ...tts, duckingVolume: parseFloat(e.target.value) })
            }
            className="w-full accent-amber-400 h-1 bg-player-control rounded cursor-pointer"
          />
        </div>

        {/* Tốc độ đọc cơ sở */}
        <div className="space-y-1">
          <div className="flex justify-between text-[11px] text-neutral-300">
            <span>Tốc độ đọc cơ sở</span>
            <span className="text-cyan-300 font-medium">
              {formatRate(tts.rateOffset)}
              {tts.rateOffset === 0 ? " (Tự động)" : ""}
            </span>
          </div>
          <input
            type="range"
            min="-20"
            max="50"
            step="5"
            value={tts.rateOffset}
            onChange={(e) =>
              onChange({ ...tts, rateOffset: parseInt(e.target.value, 10) })
            }
            className="w-full accent-cyan-400 h-1 bg-player-control rounded cursor-pointer"
          />
        </div>
      </div>

      {/* Ghi chú minh bạch */}
      <p className="text-[10px] leading-relaxed text-neutral-400">
        Khi bật thuyết minh, văn bản phụ đề tiếng Việt sẽ được gửi tới dịch vụ
        Microsoft Edge Read Aloud (<code>speech.platform.bing.com</code>) để
        tổng hợp giọng nói. Đây là dịch vụ không chính thức, có thể ngừng hoạt
        động bất cứ lúc nào.
      </p>
    </div>
  );
}
