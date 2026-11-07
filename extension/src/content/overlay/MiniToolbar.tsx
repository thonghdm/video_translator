/**
 * SubTrans Extension — MiniToolbar trong Shadow DOM overlay
 * Phù hợp với Mục 7 (Phase 8) của PLAN.md
 */

import React, { useState, useRef, useEffect } from "react";
import {
  Upload,
  Download,
  ChevronDown,
  Keyboard,
  Info,
  Plus,
  Minus,
} from "lucide-react";

export interface MiniToolbarProps {
  /** Hiện toolbar (chuột trên video hoặc có thông báo). Ẩn thì không chặn click của trang. */
  revealed?: boolean;
  offset: number;
  message: string | null;
  hasTrack: boolean;
  onOffsetChange: (delta: number) => void;
  onOffsetReset: () => void;
  onImportFile: (file: File) => void;
  onExport: (format: "srt" | "vtt", mode: "bilingual" | "target" | "source") => void;
}

export function MiniToolbar({
  revealed = true,
  offset,
  message,
  hasTrack,
  onOffsetChange,
  onOffsetReset,
  onImportFile,
  onExport,
}: MiniToolbarProps) {
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Đóng menu export khi click ra ngoài
  useEffect(() => {
    if (!showExportMenu && !showShortcutsHelp) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
        setShowShortcutsHelp(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [showExportMenu, showShortcutsHelp]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onImportFile(file);
    }
    // Reset value để có thể chọn lại cùng 1 file
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const formattedOffset = `${offset > 0 ? "+" : ""}${offset.toFixed(1)}s`;

  return (
    <div
      ref={menuRef}
      data-testid="st-toolbar"
      data-revealed={revealed || showExportMenu || showShortcutsHelp || Boolean(message) ? "true" : "false"}
      className={`absolute top-3 right-3 z-30 flex flex-col items-end gap-1.5 select-none transition-opacity duration-200 ${
        revealed || showExportMenu || showShortcutsHelp || message
          ? "opacity-100 pointer-events-auto"
          : "opacity-0 pointer-events-none"
      }`}
    >
      {/* Thanh công cụ chính */}
      <div className="flex items-center gap-1.5 bg-black/85 hover:bg-black/95 backdrop-blur-md border border-white/15 rounded-lg px-2 py-1 shadow-2xl text-xs text-neutral-200 transition-all opacity-80 hover:opacity-100">
        {/* Nút ẩn input file */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".srt,.vtt"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />

        {/* Nút Nhập File */}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-white/10 hover:text-amber-300 transition text-[11px] font-medium"
          title="Nhập file phụ đề .srt hoặc .vtt cho video này"
        >
          <Upload className="w-3.5 h-3.5 text-amber-400" />
          <span>Nhập</span>
        </button>

        {/* Nút Xuất File */}
        <div className="relative">
          <button
            onClick={() => {
              setShowExportMenu(!showExportMenu);
              setShowShortcutsHelp(false);
            }}
            disabled={!hasTrack}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-white/10 hover:text-amber-300 disabled:opacity-40 transition text-[11px] font-medium"
            title={hasTrack ? "Xuất phụ đề video này" : "Chưa có phụ đề để xuất"}
          >
            <Download className="w-3.5 h-3.5 text-cyan-400" />
            <span>Xuất</span>
            <ChevronDown className="w-3 h-3 text-neutral-400" />
          </button>

          {/* Menu Dropdown Xuất phụ đề */}
          {showExportMenu && (
            <div className="absolute top-full right-0 mt-1.5 w-44 bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl p-1.5 z-40 text-xs space-y-1">
              <div className="px-1.5 py-0.5 text-[10px] uppercase font-bold text-neutral-400 border-b border-neutral-800">
                Định dạng SRT
              </div>
              <button
                onClick={() => {
                  onExport("srt", "bilingual");
                  setShowExportMenu(false);
                }}
                className="w-full text-left px-2 py-1 rounded hover:bg-white/10 text-neutral-200 transition"
              >
                SRT Song ngữ
              </button>
              <button
                onClick={() => {
                  onExport("srt", "target");
                  setShowExportMenu(false);
                }}
                className="w-full text-left px-2 py-1 rounded hover:bg-white/10 text-neutral-200 transition"
              >
                SRT Tiếng Việt
              </button>
              <button
                onClick={() => {
                  onExport("srt", "source");
                  setShowExportMenu(false);
                }}
                className="w-full text-left px-2 py-1 rounded hover:bg-white/10 text-neutral-200 transition"
              >
                SRT Tiếng Anh
              </button>

              <div className="px-1.5 py-0.5 text-[10px] uppercase font-bold text-neutral-400 border-b border-neutral-800 pt-1">
                Định dạng WebVTT
              </div>
              <button
                onClick={() => {
                  onExport("vtt", "bilingual");
                  setShowExportMenu(false);
                }}
                className="w-full text-left px-2 py-1 rounded hover:bg-white/10 text-neutral-200 transition"
              >
                VTT Song ngữ
              </button>
              <button
                onClick={() => {
                  onExport("vtt", "target");
                  setShowExportMenu(false);
                }}
                className="w-full text-left px-2 py-1 rounded hover:bg-white/10 text-neutral-200 transition"
              >
                VTT Tiếng Việt
              </button>
              <button
                onClick={() => {
                  onExport("vtt", "source");
                  setShowExportMenu(false);
                }}
                className="w-full text-left px-2 py-1 rounded hover:bg-white/10 text-neutral-200 transition"
              >
                VTT Tiếng Anh
              </button>
            </div>
          )}
        </div>

        {/* Đường kẻ phân cách */}
        <div className="w-[1px] h-3.5 bg-white/20 my-auto" />

        {/* Chỉnh lệch thời gian (Offset) */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => onOffsetChange(-0.1)}
            className="p-0.5 rounded hover:bg-white/10 text-neutral-300 hover:text-white transition"
            title="Lùi 0.1 giây (phím G)"
          >
            <Minus className="w-3 h-3" />
          </button>

          <button
            onClick={onOffsetReset}
            className={`font-mono text-[11px] px-1 py-0.5 rounded hover:bg-white/10 transition ${
              offset !== 0 ? "text-amber-300 font-bold" : "text-neutral-400"
            }`}
            title="Độ lệch thời gian hiện tại. Bấm để đặt lại về 0s (Phím G: -0.1s, H: +0.1s)"
          >
            {formattedOffset}
          </button>

          <button
            onClick={() => onOffsetChange(0.1)}
            className="p-0.5 rounded hover:bg-white/10 text-neutral-300 hover:text-white transition"
            title="Tiến 0.1 giây (phím H)"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>

        {/* Phím tắt trợ giúp */}
        <button
          onClick={() => {
            setShowShortcutsHelp(!showShortcutsHelp);
            setShowExportMenu(false);
          }}
          className="p-0.5 rounded hover:bg-white/10 text-neutral-400 hover:text-white transition ml-0.5"
          title="Phím tắt: V (chế độ phụ đề), G/H (chỉnh lệch thời gian)"
        >
          <Keyboard className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Popover trợ giúp phím tắt */}
      {showShortcutsHelp && (
        <div className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl p-2.5 text-xs text-neutral-300 space-y-1.5 w-52">
          <div className="font-semibold text-white border-b border-neutral-800 pb-1 flex items-center gap-1.5">
            <Keyboard className="w-3.5 h-3.5 text-amber-400" />
            <span>Phím tắt SubTrans</span>
          </div>
          <div className="flex justify-between items-center text-[11px]">
            <span className="font-mono bg-neutral-800 px-1.5 py-0.5 rounded text-amber-300 font-bold">
              V
            </span>
            <span>Chuyển chế độ phụ đề</span>
          </div>
          <div className="flex justify-between items-center text-[11px]">
            <span className="font-mono bg-neutral-800 px-1.5 py-0.5 rounded text-amber-300 font-bold">
              G
            </span>
            <span>Lùi phụ đề 0.1s</span>
          </div>
          <div className="flex justify-between items-center text-[11px]">
            <span className="font-mono bg-neutral-800 px-1.5 py-0.5 rounded text-amber-300 font-bold">
              H
            </span>
            <span>Tiến phụ đề 0.1s</span>
          </div>
        </div>
      )}

      {/* Vùng thông báo trạng thái */}
      {message && (
        <div className="flex items-center gap-1.5 max-w-[280px] px-2.5 py-1 bg-black/90 text-neutral-200 border border-amber-500/30 rounded-lg text-[11px] shadow-lg">
          <Info className="w-3 h-3 text-amber-400 shrink-0" />
          <span className="truncate">{message}</span>
        </div>
      )}
    </div>
  );
}
