/**
 * SubTrans Extension — Hộp phụ đề song ngữ (PLAN 4.7)
 * Port JSX từ frontend/src/App.tsx (overlay phong cách VLC, kéo thả tự do).
 * Khác Desktop: chấm chỉ báo engine theo TỪNG DÒNG (item.engine), bỏ nhánh Local AI.
 */

import type React from "react";
import { GripHorizontal } from "lucide-react";
import type { SubtitleItem, SubtitleMode } from "../../shared/types";
import type { SubPos } from "./useDraggable";

export interface SubtitleOverlayProps {
  item: SubtitleItem;
  mode: SubtitleMode;
  pos: SubPos | null;
  handlers: React.HTMLAttributes<HTMLDivElement>;
}

function EngineBadge({ engine }: { engine: SubtitleItem["engine"] }) {
  if (!engine) return null;
  const isCloud = engine === "cloud";
  const isFile = engine === "file";
  const title = isCloud
    ? "Dịch bằng Gemini Cloud"
    : isFile
    ? "Phụ đề nhập từ file"
    : "Dịch bằng API Google siêu tốc";
  const label = isCloud ? "Cloud" : isFile ? "File" : "API";
  const dotColor = isCloud
    ? "bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.9)]"
    : isFile
    ? "bg-neutral-400 shadow-[0_0_6px_rgba(163,163,163,0.9)]"
    : "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]";
  const textColor = isCloud
    ? "text-cyan-300"
    : isFile
    ? "text-neutral-300"
    : "text-emerald-300";

  return (
    <div
      className="absolute -top-2 right-2.5 flex items-center gap-1 bg-black/85 border border-white/10 rounded-full px-1.5 py-0.5 text-[9px] pointer-events-none shadow-sm"
      title={title}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
      <span className={`font-semibold text-[8px] uppercase tracking-wider ${textColor}`}>
        {label}
      </span>
    </div>
  );
}

export function SubtitleOverlay({ item, mode, pos, handlers }: SubtitleOverlayProps) {
  const style: React.CSSProperties = pos
    ? {
        position: "absolute",
        left: `${pos.xPct}%`,
        top: `${pos.yPct}%`,
        transform: "translate(-50%, -50%)",
        maxWidth: "min(768px, calc(100% - 32px))",
      }
    : {
        position: "absolute",
        left: "50%",
        bottom: "64px",
        transform: "translateX(-50%)",
        maxWidth: "min(768px, calc(100% - 32px))",
      };

  const showEn = mode === "en" || mode === "bilingual";
  const showVi = mode === "vi" || mode === "bilingual";

  return (
    <div
      {...handlers}
      style={style}
      data-testid="st-subtitle"
      className="st-box group/sub z-20 px-5 py-2.5 rounded-xl text-center shadow-2xl backdrop-blur-md border border-white/10 hover:border-amber-400/40 transition-colors cursor-grab active:cursor-grabbing select-none pointer-events-auto touch-none space-y-1"
      title="Kéo thả để di chuyển vị trí phụ đề • Nhấp đúp để đặt lại vị trí mặc định"
    >
      {/* Tooltip tay kéo */}
      <div className="absolute -top-3 left-1/2 -translate-x-1/2 opacity-0 group-hover/sub:opacity-100 transition-opacity flex items-center justify-center bg-neutral-900/95 border border-white/20 rounded-full px-2.5 py-0.5 text-[10px] text-neutral-300 pointer-events-none shadow-md whitespace-nowrap gap-1">
        <GripHorizontal className="w-3.5 h-3.5 text-amber-400" />
        <span>Kéo thả vị trí • Nhấp đúp đặt lại</span>
      </div>

      <EngineBadge engine={item.engine} />

      {showEn && item.source_text && (
        <div className="st-text st-en font-medium leading-relaxed pointer-events-none">
          {item.source_text}
        </div>
      )}
      {showVi &&
        (item.target_text ? (
          <div className="st-text st-vi font-bold leading-relaxed pointer-events-none">
            {item.target_text}
          </div>
        ) : mode === "vi" ? (
          <div className="st-text st-pending text-neutral-400 italic flex items-center justify-center gap-1.5 pointer-events-none">
            <span className="inline-block w-2 h-2 rounded-full bg-amber-400/60 animate-pulse" />
            <span>{item.source_text}</span>
          </div>
        ) : null)}
    </div>
  );
}
