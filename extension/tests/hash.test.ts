import { describe, it, expect } from "vitest";
import { fnv1a32 } from "../src/shared/hash";

describe("fnv1a32", () => {
  it("tạo hash hex 8 ký tự nhất quán", () => {
    const h1 = fnv1a32("Hello world");
    const h2 = fnv1a32("Hello world");
    expect(h1).toHaveLength(8);
    expect(h1).toBe(h2);

    const h3 = fnv1a32("Hello world!");
    expect(h1).not.toBe(h3);
  });

  it("chuỗi rỗng trả về offset basis 811c9dc5", () => {
    expect(fnv1a32("")).toBe("811c9dc5");
  });

  it("xử lý tốt ký tự Unicode tiếng Việt", () => {
    const h = fnv1a32("Xin chào Việt Nam");
    expect(h).toHaveLength(8);
  });
});
