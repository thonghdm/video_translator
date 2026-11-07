import { describe, it, expect } from "vitest";
import { LRUCache } from "../src/shared/lru";

describe("LRUCache", () => {
  it("lưu và truy vấn các phần tử trong dung lượng", () => {
    const cache = new LRUCache<string, string>(3);
    cache.set("a", "alpha");
    cache.set("b", "beta");

    expect(cache.get("a")).toBe("alpha");
    expect(cache.get("b")).toBe("beta");
    expect(cache.get("c")).toBeUndefined();

    const stats = cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
  });

  it("loại bỏ phần tử cũ nhất khi vượt dung lượng", () => {
    const cache = new LRUCache<string, string>(2);
    cache.set("a", "1");
    cache.set("b", "2");

    // Truy cập 'a' -> 'a' là MRU, 'b' là LRU
    cache.get("a");

    // Thêm 'c' -> 'b' bị loại bỏ
    cache.set("c", "3");

    expect(cache.get("a")).toBe("1");
    expect(cache.get("c")).toBe("3");
    expect(cache.get("b")).toBeUndefined();

    expect(cache.stats().evicts).toBe(1);
    expect(cache.size()).toBe(2);
  });

  it("cập nhật giá trị cho key đã có và đưa lên MRU", () => {
    const cache = new LRUCache<string, string>(2);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("a", "10"); // Cập nhật 'a'

    cache.set("c", "3"); // 'b' phải bị loại bỏ, 'a' vẫn còn
    expect(cache.get("a")).toBe("10");
    expect(cache.get("b")).toBeUndefined();
  });
});
