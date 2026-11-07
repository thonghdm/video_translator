import { describe, it, expect } from "vitest";
import { splitLinesIntoControlledBatches } from "../src/shared/batching";

describe("splitLinesIntoControlledBatches", () => {
  it("trả về mảng rỗng khi danh sách câu rỗng", () => {
    expect(splitLinesIntoControlledBatches([])).toEqual([]);
  });

  it("chia batch theo số dòng maxLines", () => {
    const lines = ["Line 1", "Line 2", "Line 3", "Line 4", "Line 5"];
    const batches = splitLinesIntoControlledBatches(lines, 2, 1000);
    expect(batches).toEqual([[0, 1], [2, 3], [4]]);
  });

  it("chia batch theo số byte UTF-8 maxChars", () => {
    // Mỗi câu tiếng Việt "Xin chào bạn" khoảng 16 bytes UTF-8
    const lines = [
      "Xin chào bạn", // 16 bytes
      "Tôi là lập trình viên", // 26 bytes
      "Thử nghiệm", // 13 bytes
    ];
    // Giới hạn 20 bytes -> line 0 (16b), line 1 (26b) phải sang batch mới
    const batches = splitLinesIntoControlledBatches(lines, 10, 20);
    expect(batches).toEqual([[0], [1], [2]]);
  });

  it("không bao giờ bỏ sót dòng nào khi chia", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Sentence number ${i} in track`);
    const batches = splitLinesIntoControlledBatches(lines, 8, 200);
    const flattened = batches.flat();
    expect(flattened.length).toBe(50);
    expect(flattened).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });
});
