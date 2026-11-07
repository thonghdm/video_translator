/**
 * SubTrans Extension — Kéo thả thanh phụ đề (PLAN 4.8)
 * Port thuật toán từ frontend/src/App.tsx (handleSubPointerDown/Move/Up/DoubleClick):
 * - Vị trí lưu theo % tâm box trong container {xPct, yPct}, làm tròn 0.1.
 * - Chỉ tính là kéo khi di chuyển ≥ 3px; clamp để box nằm trọn trong container.
 * - Nhấp đúp: xóa vị trí đã lưu → về mặc định (giữa, cách đáy 4rem).
 * Khác Desktop: lưu vào chrome.storage.local theo hostname (không dùng localStorage của trang).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";

export interface SubPos {
  xPct: number;
  yPct: number;
}

export interface DragStart {
  pointerStartX: number;
  pointerStartY: number;
  initialCenterX: number;
  initialCenterY: number;
  containerWidth: number;
  containerHeight: number;
  boxWidth: number;
  boxHeight: number;
}

export const DRAG_THRESHOLD_PX = 3;

/**
 * Tính vị trí mới khi con trỏ ở (clientX, clientY).
 * Trả về null nếu chưa vượt ngưỡng 3px (và chưa từng di chuyển).
 */
export function computeDragPosition(
  start: DragStart,
  clientX: number,
  clientY: number,
  hasMoved: boolean
): SubPos | null {
  const deltaX = clientX - start.pointerStartX;
  const deltaY = clientY - start.pointerStartY;
  if (!hasMoved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD_PX) {
    return null;
  }
  const halfW = start.boxWidth / 2;
  const halfH = start.boxHeight / 2;
  const clampedX = Math.max(
    halfW,
    Math.min(start.containerWidth - halfW, start.initialCenterX + deltaX)
  );
  const clampedY = Math.max(
    halfH,
    Math.min(start.containerHeight - halfH, start.initialCenterY + deltaY)
  );
  const w = start.containerWidth || 1;
  const h = start.containerHeight || 1;
  return {
    xPct: Math.round((clampedX / w) * 100 * 10) / 10,
    yPct: Math.round((clampedY / h) * 100 * 10) / 10,
  };
}

export function isValidPos(v: unknown): v is SubPos {
  const p = v as SubPos;
  return (
    !!p &&
    Number.isFinite(p.xPct) &&
    Number.isFinite(p.yPct) &&
    p.xPct >= 0 &&
    p.xPct <= 100 &&
    p.yPct >= 0 &&
    p.yPct <= 100
  );
}

export function overlayPosKey(hostname: string): string {
  return `overlayPos:${hostname}`;
}

function storage(): chrome.storage.LocalStorageArea | null {
  try {
    return typeof chrome !== "undefined" && chrome.storage?.local ? chrome.storage.local : null;
  } catch {
    return null;
  }
}

export interface UseDraggableOptions {
  /** Rect của container (vùng player) — dùng để tính % và clamp */
  getContainerRect: () => DOMRect | null;
  storageKey: string;
  onReset?: () => void;
}

export function useDraggable({ getContainerRect, storageKey, onReset }: UseDraggableOptions) {
  const [pos, setPos] = useState<SubPos | null>(null);
  const posRef = useRef<SubPos | null>(null);
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const startRef = useRef<DragStart | null>(null);

  // Nạp vị trí đã lưu
  useEffect(() => {
    let alive = true;
    const st = storage();
    if (!st) return;
    st.get(storageKey)
      .then((data) => {
        const saved = data?.[storageKey];
        if (alive && isValidPos(saved)) {
          posRef.current = saved;
          setPos(saved);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [storageKey]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      const rect = getContainerRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;
      e.stopPropagation();
      const box = e.currentTarget.getBoundingClientRect();
      startRef.current = {
        pointerStartX: e.clientX,
        pointerStartY: e.clientY,
        initialCenterX: box.left + box.width / 2 - rect.left,
        initialCenterY: box.top + box.height / 2 - rect.top,
        containerWidth: rect.width,
        containerHeight: rect.height,
        boxWidth: box.width,
        boxHeight: box.height,
      };
      draggingRef.current = true;
      movedRef.current = false;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* trình duyệt không hỗ trợ */
      }
    },
    [getContainerRect]
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!draggingRef.current || !startRef.current) return;
    e.stopPropagation();
    const next = computeDragPosition(startRef.current, e.clientX, e.clientY, movedRef.current);
    if (!next) return;
    movedRef.current = true;
    posRef.current = next;
    setPos(next);
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!draggingRef.current) return;
      e.stopPropagation();
      draggingRef.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* đã nhả */
      }
      if (movedRef.current && posRef.current) {
        void storage()
          ?.set({ [storageKey]: posRef.current })
          .catch(() => {});
      }
    },
    [storageKey]
  );

  const onDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      // Chặn để không kích hoạt fullscreen của player (YouTube dblclick = fullscreen)
      e.stopPropagation();
      e.preventDefault();
      posRef.current = null;
      setPos(null);
      void storage()
        ?.remove(storageKey)
        .catch(() => {});
      onReset?.();
    },
    [storageKey, onReset]
  );

  /** Chặn click/mousedown lan ra player (tránh pause video khi bấm vào phụ đề) */
  const stop = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation();
  }, []);

  return {
    pos,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onDoubleClick,
      onClick: stop,
      onMouseDown: stop,
      onMouseUp: stop,
    },
  };
}
