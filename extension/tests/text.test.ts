import { describe, it, expect } from "vitest";
import {
  isIgnoredSubtitle,
  normalizeLine,
  isVietnamese,
  decodeHtmlEntities,
} from "../src/shared/text";

describe("Text Utilities", () => {
  it("isIgnoredSubtitle: phát hiện chính xác tiếng động và nốt nhạc", () => {
    // Chuỗi rỗng hoặc chỉ có khoảng trắng
    expect(isIgnoredSubtitle("")).toBe(true);
    expect(isIgnoredSubtitle("   ")).toBe(true);

    // Nằm trọn vẹn trong ngoặc [...] hoặc (...)
    expect(isIgnoredSubtitle("[Music]")).toBe(true);
    expect(isIgnoredSubtitle("[ tiếng cười ]")).toBe(true);
    expect(isIgnoredSubtitle("(Applause)")).toBe(true);
    expect(isIgnoredSubtitle("( tiếng vỗ tay )")).toBe(true);

    // Không bỏ qua nếu có từ bên ngoài ngoặc
    expect(isIgnoredSubtitle("Hello [Music] world")).toBe(false);

    // Nốt nhạc hoặc ký tự gạch nối
    expect(isIgnoredSubtitle("♪")).toBe(true);
    expect(isIgnoredSubtitle("♪ - _ ♪")).toBe(true);
    expect(isIgnoredSubtitle("---")).toBe(true);

    // Câu bình thường không bị bỏ qua
    expect(isIgnoredSubtitle("Hello world")).toBe(false);
    expect(isIgnoredSubtitle("This is a tutorial")).toBe(false);
  });

  it("normalizeLine: gom khoảng trắng thừa giống strings.Fields trong Go", () => {
    expect(normalizeLine("  hello   world  \t\n  how are you ")).toBe("hello world how are you");
    expect(normalizeLine("")).toBe("");
  });

  it("isVietnamese: nhận diện đúng ký tự tiếng Việt có dấu", () => {
    expect(isVietnamese("Xin chào thế giới")).toBe(true);
    expect(isVietnamese("Đà Nẵng")).toBe(true);
    expect(isVietnamese("học lập trình")).toBe(true);
    expect(isVietnamese("Hello world")).toBe(false);
    expect(isVietnamese("12345 !?")).toBe(false);
  });

  it("decodeHtmlEntities: giải mã đúng các entities HTML thường gặp", () => {
    expect(decodeHtmlEntities("Tom &amp; Jerry &#39;run&#39; &quot;fast&quot; &lt;here&gt;")).toBe(
      'Tom & Jerry \'run\' "fast" <here>'
    );
  });
});
