import { describe, it, expect } from "vitest";
import { shouldReportDuration } from "./duration";

describe("shouldReportDuration (BUG-08)", () => {
  it("báo khi thời lượng thật lệch ước lượng 3600s", () => {
    expect(shouldReportDuration(90, 3600, undefined)).toBe(true);
  });
  it("không báo khi khớp giá trị backend đã biết (file cục bộ)", () => {
    expect(shouldReportDuration(120.4, 120, undefined)).toBe(false);
  });
  it("không báo lặp lại cùng giá trị", () => {
    expect(shouldReportDuration(90, 3600, 90.2)).toBe(false);
  });
  it("báo lại nếu thời lượng đổi tiếp", () => {
    expect(shouldReportDuration(95, 3600, 90)).toBe(true);
  });
  it("bỏ qua giá trị không hợp lệ", () => {
    expect(shouldReportDuration(NaN, 3600, undefined)).toBe(false);
    expect(shouldReportDuration(Infinity, 3600, undefined)).toBe(false);
    expect(shouldReportDuration(0, 3600, undefined)).toBe(false);
  });
});
