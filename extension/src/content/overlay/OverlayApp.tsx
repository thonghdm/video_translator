/**
 * SubTrans Extension — Gốc React của overlay (render trong Shadow DOM)
 */

import { useCallback, useSyncExternalStore } from "react";
import type React from "react";
import type { OverlayStore } from "./store";
import { SubtitleOverlay } from "./SubtitleOverlay";
import { useDraggable } from "./useDraggable";
import { MiniToolbar } from "./MiniToolbar";

export interface OverlayAppProps {
  store: OverlayStore;
  getContainerRect: () => DOMRect | null;
  storageKey: string;
  onOffsetChange?: (delta: number) => void;
  onOffsetReset?: () => void;
  onImportFile?: (file: File) => void;
  onExport?: (format: "srt" | "vtt", mode: "bilingual" | "target" | "source") => void;
}

export function OverlayApp({
  store,
  getContainerRect,
  storageKey,
  onOffsetChange,
  onOffsetReset,
  onImportFile,
  onExport,
}: OverlayAppProps) {
  const s = useSyncExternalStore(store.subscribe, store.getState);
  const onReset = useCallback(
    () => store.flashToast("Đã đưa vị trí phụ đề về mặc định (dưới cùng)"),
    [store]
  );
  const drag = useDraggable({ getContainerRect, storageKey, onReset });

  const rootStyle = {
    "--st-bg": String(clamp(s.style.bgOpacity, 0, 1)),
    "--st-en": s.style.enColor,
    "--st-vi": s.style.viColor,
    "--st-scale": String(clamp(s.style.fontScale, 0.5, 3)),
  } as React.CSSProperties;

  const showSub = s.visible && !s.nativeFallback && s.mode !== "off" && s.item !== null;

  return (
    <div className="st-root" style={rootStyle}>
      {showSub && s.item && (
        <SubtitleOverlay item={s.item} mode={s.mode} pos={drag.pos} handlers={drag.handlers} />
      )}

      {/* MiniToolbar ở góc trên phải */}
      {s.visible && !s.nativeFallback && (
        <MiniToolbar
          revealed={s.hover}
          offset={s.offset}
          message={s.message}
          hasTrack={s.hasTrack}
          onOffsetChange={onOffsetChange ?? (() => {})}
          onOffsetReset={onOffsetReset ?? (() => {})}
          onImportFile={onImportFile ?? (() => {})}
          onExport={onExport ?? (() => {})}
        />
      )}

      {/* Toast thông báo ở giữa phía trên */}
      {s.toast && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 px-3.5 py-1.5 bg-black/90 text-amber-300 border border-amber-500/50 rounded-lg text-xs shadow-2xl font-medium pointer-events-none">
          {s.toast}
        </div>
      )}
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}
