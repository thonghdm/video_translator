// BUG-08: quyết định có cần báo thời lượng thật của <video> về backend hay không.
// Backend mở video Drive với thời lượng ước lượng (3600s / theo dung lượng) nên cần đồng bộ lại.
export const DURATION_REPORT_EPSILON_SEC = 1;

export function shouldReportDuration(
  real: number,
  known: number | undefined,
  lastReported: number | undefined,
): boolean {
  if (!Number.isFinite(real) || real <= 0) return false;
  // Đã báo đúng giá trị này rồi → không lặp lại (onDurationChange có thể bắn nhiều lần)
  if (lastReported !== undefined && Math.abs(real - lastReported) <= DURATION_REPORT_EPSILON_SEC) {
    return false;
  }
  if (known !== undefined && known > 0 && Math.abs(real - known) <= DURATION_REPORT_EPSILON_SEC) {
    return false;
  }
  return true;
}
