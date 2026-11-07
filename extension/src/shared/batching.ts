/**
 * SubTrans Extension — Chia batch phụ đề
 * Port 1:1 từ SplitLinesIntoControlledBatches trong translator.go:45
 */

const encoder = new TextEncoder();

/**
 * Chia danh sách câu thành các batch giới hạn theo cả số câu (maxLines) và số byte UTF-8 (maxChars)
 * Trả về mảng các batch, mỗi batch chứa mảng các chỉ số (indices) của lines.
 */
export function splitLinesIntoControlledBatches(
  lines: string[],
  maxLines = 8,
  maxChars = 600
): number[][] {
  if (lines.length === 0) {
    return [];
  }
  if (maxLines <= 0) {
    maxLines = 8;
  }
  if (maxChars <= 0) {
    maxChars = 600;
  }

  const batches: number[][] = [];
  let currentBatch: number[] = [];
  let currentChars = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineLen = encoder.encode(lines[i]).length;
    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= maxLines || currentChars + lineLen > maxChars)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }
    currentBatch.push(i);
    currentChars += lineLen;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}
