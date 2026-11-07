/**
 * SubTrans Extension — Ô nhập số cho trang Options.
 * - Cho gõ tự do (kể cả xóa trắng để gõ số mới); CHỈ lưu khi rời ô hoặc bấm Enter.
 * - Kẹp giá trị theo SETTING_LIMITS (min/max của HTML không chặn được giá trị gõ tay).
 * - Esc: bỏ thay đổi, trả về giá trị đang lưu.
 */
import { useEffect, useRef, useState } from "react";
import { SETTING_LIMITS, clampSetting, type LimitKey } from "../shared/settings";

export interface NumberFieldProps {
  limitKey: LimitKey;
  value: number;
  step?: number;
  /** Số nguyên (mặc định) hay số thực */
  integer?: boolean;
  onCommit: (value: number) => void;
  className?: string;
}

export function commitNumber(raw: string, limitKey: LimitKey, current: number, integer = true): number {
  const n = clampSetting(limitKey, raw.trim() === "" ? NaN : Number(raw.replace(",", ".")), current);
  return integer ? Math.round(n) : n;
}

export function NumberField({ limitKey, value, step, integer = true, onCommit, className }: NumberFieldProps) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  const [lo, hi] = SETTING_LIMITS[limitKey];
  const cancelRef = useRef(false);

  // Đồng bộ khi giá trị thay đổi từ nơi khác (không ghi đè lúc người dùng đang gõ)
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);

  const commit = () => {
    const v = commitNumber(text, limitKey, value, integer);
    setText(String(v));
    if (v !== value) onCommit(v);
  };

  return (
    <input
      type="number"
      inputMode={integer ? "numeric" : "decimal"}
      min={lo}
      max={hi}
      step={step ?? (integer ? 1 : 0.05)}
      value={text}
      onFocus={() => setFocused(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setFocused(false);
        if (cancelRef.current) {
          cancelRef.current = false;
          setText(String(value));
          return;
        }
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          cancelRef.current = true;
          (e.target as HTMLInputElement).blur();
        }
      }}
      title={`Từ ${lo} đến ${hi}`}
      className={className}
    />
  );
}
