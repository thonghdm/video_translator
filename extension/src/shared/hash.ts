/**
 * SubTrans Extension — FNV-1a 32-bit Hash
 * Phù hợp với Mục 6.4 và 7 (Phase 1) của PLAN.md
 */

const FNV_PRIME = 0x01000193;
const FNV_OFFSET_BASIS = 0x811c9dc5;
const encoder = new TextEncoder();

/**
 * Tính hash FNV-1a 32-bit của chuỗi và trả về biểu diễn hex (8 ký tự).
 */
export function fnv1a32(str: string): string {
  let hash = FNV_OFFSET_BASIS;
  const bytes = encoder.encode(str);
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
