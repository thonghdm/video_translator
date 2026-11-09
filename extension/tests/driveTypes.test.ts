import { describe, it, expect } from "vitest";
import { DRIVE_ID_RE, isDriveLookupReq } from "../src/shared/driveTypes";

describe("Phase 9.5 D2 — driveTypes & isDriveLookupReq", () => {
  it("DRIVE_ID_RE: nhận chuỗi hợp lệ 10–128 ký tự (A-Za-z0-9_-) và từ chối sai quy tắc", () => {
    // Hợp lệ: đủ độ dài, ký tự chuẩn
    expect(DRIVE_ID_RE.test("1a2B3c4D5e")).toBe(true); // 10 chars
    expect(DRIVE_ID_RE.test("1ABC-def_GHI-jkl_MNO1234567890")).toBe(true);
    expect(DRIVE_ID_RE.test("a".repeat(128))).toBe(true);

    // Không hợp lệ: quá ngắn (< 10) hoặc quá dài (> 128)
    expect(DRIVE_ID_RE.test("short_9ch")).toBe(false); // 9 chars
    expect(DRIVE_ID_RE.test("a".repeat(129))).toBe(false);

    // Không hợp lệ: chứa ký tự cấm
    expect(DRIVE_ID_RE.test("has space 12345")).toBe(false);
    expect(DRIVE_ID_RE.test("has.dot.id12345")).toBe(false);
    expect(DRIVE_ID_RE.test("has/slash/12345")).toBe(false);
    expect(DRIVE_ID_RE.test("has@symbol12345")).toBe(false);
  });

  it("isDriveLookupReq: nhận đúng DriveLookupReq hợp lệ (có hoặc không có videoDocId)", () => {
    // Không có videoDocId
    expect(isDriveLookupReq({ type: "drive.lookup" })).toBe(true);

    // Có videoDocId hợp lệ
    expect(
      isDriveLookupReq({
        type: "drive.lookup",
        videoDocId: "1A2b3C4d5E_xyz-99",
      })
    ).toBe(true);
  });

  it("isDriveLookupReq: từ chối khi sai type, docId sai regex, docId không phải string, null, mảng", () => {
    // Sai type
    expect(isDriveLookupReq({ type: "other" })).toBe(false);
    expect(isDriveLookupReq({ type: "drive.sidecar" })).toBe(false);
    expect(isDriveLookupReq({})).toBe(false);

    // docId sai regex (quá ngắn, chứa ký tự cấm)
    expect(isDriveLookupReq({ type: "drive.lookup", videoDocId: "short" })).toBe(false);
    expect(isDriveLookupReq({ type: "drive.lookup", videoDocId: "invalid/id/12345" })).toBe(false);

    // docId không phải string (null, number, boolean, array, object)
    expect(isDriveLookupReq({ type: "drive.lookup", videoDocId: null })).toBe(false);
    expect(isDriveLookupReq({ type: "drive.lookup", videoDocId: 1234567890 })).toBe(false);
    expect(isDriveLookupReq({ type: "drive.lookup", videoDocId: true })).toBe(false);
    expect(isDriveLookupReq({ type: "drive.lookup", videoDocId: ["id123456789"] })).toBe(false);
    expect(isDriveLookupReq({ type: "drive.lookup", videoDocId: {} })).toBe(false);

    // Input không phải object hoặc là null, mảng, primitive
    expect(isDriveLookupReq(null)).toBe(false);
    expect(isDriveLookupReq(undefined)).toBe(false);
    expect(isDriveLookupReq("string")).toBe(false);
    expect(isDriveLookupReq(12345)).toBe(false);
    expect(isDriveLookupReq([])).toBe(false);
    expect(isDriveLookupReq([{ type: "drive.lookup" }])).toBe(false);
  });
});
