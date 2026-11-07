/**
 * SubTrans Extension — Gốc React của overlay (render trong Shadow DOM)
 */

import { useCallback, useSyncExternalStore } from "react";
import type React from "react";
import type { OverlayStore } from "./store";
import { SubtitleOverlay } from "./SubtitleOverlay";
import { useDraggable } from "./useDraggable";

export interface OverlayAppProps {
  store: OverlayStore;
  getContainerRect: () => DOMRect | null;
  storageKey: string;
}

export function OverlayApp({ store, getContainerRect, storageKey }: OverlayAppProps) {
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

      {s.toast && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 px-3.5 py-1.5 bg-black/90 text-amber-300 border border-amber-500/50 rounded-lg text-xs shadow-2xl font-medium pointer-events-none">
          {s.toast}
        </div>
      )}

      {s.visible && s.message && (
        <div className="absolute top-3 right-3 z-30 max-w-[60%] px-3 py-1.5 bg-black/85 text-neutral-200 border border-white/15 rounded-lg text-[11px] shadow-lg pointer-events-none">
          <span className="text-amber-400 font-semibold mr-1">SubTrans</span>
          {s.message}
        </div>
      )}
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}
