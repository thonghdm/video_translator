import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { SubtransDB } from "../src/background/cache/db";
import type { Cue, TrackRef } from "../src/shared/types";

describe("IndexedDB Translation Cache (Phase 3)", () => {
  let db: SubtransDB;

  const mockTrackRef: TrackRef = {
    trackKey: "yt:video123:en:asr",
    platform: "youtube",
    videoId: "video123",
    title: "Test Video",
    lang: "en",
    kind: "asr",
  };

  const mockCues: Cue[] = [
    { start: 0, end: 3, text: "Hello world" },
    { start: 4, end: 7, text: "How are you" },
    { start: 8, end: 11, text: "Goodbye" },
  ];

  const sourceHash = "hash1234";

  beforeEach(async () => {
    db = new SubtransDB();
    await db.clear(); // Xóa sạch dữ liệu trước mỗi test
  });

  it("lưu track và đọc lại chính xác", async () => {
    await db.putTrack(mockTrackRef, mockCues, sourceHash);

    const saved = await db.getTrack(mockTrackRef.trackKey);
    expect(saved).toBeDefined();
    expect(saved?.trackKey).toBe(mockTrackRef.trackKey);
    expect(saved?.title).toBe("Test Video");
    expect(saved?.sourceHash).toBe(sourceHash);
    expect(saved?.cues).toEqual(mockCues);
    expect(saved?.bytesApprox).toBeGreaterThan(0);
  });

  it("touchTrack cập nhật thời điểm lastOpenedAt", async () => {
    await db.putTrack(mockTrackRef, mockCues, sourceHash);
    const initial = await db.getTrack(mockTrackRef.trackKey);
    const firstOpenedAt = initial!.lastOpenedAt;

    // Chờ 10ms để thời gian thay đổi
    await new Promise((r) => setTimeout(r, 10));
    await db.touchTrack(mockTrackRef.trackKey);

    const updated = await db.getTrack(mockTrackRef.trackKey);
    expect(updated!.lastOpenedAt).toBeGreaterThanOrEqual(firstOpenedAt);
  });

  it("mergeLines: gộp các dòng dịch mới mà không ghi đè dòng đã có bằng null", async () => {
    await db.putTrack(mockTrackRef, mockCues, sourceHash);
    // Lưu lượt dịch 1: dịch câu 0 và câu 2
    await db.mergeLines(
      mockTrackRef.trackKey,
      "api",
      sourceHash,
      3,
      [
        [0, "Xin chào thế giới"],
        [2, "Tạm biệt"],
      ]
    );

    let lines = await db.getLines(mockTrackRef.trackKey);
    expect(lines["api"]).toEqual(["Xin chào thế giới", null, "Tạm biệt"]);

    // Lưu lượt dịch 2: dịch tiếp câu 1 (câu 0 và 2 không được bị mất)
    await db.mergeLines(
      mockTrackRef.trackKey,
      "api",
      sourceHash,
      3,
      [[1, "Bạn khỏe không"]]
    );

    lines = await db.getLines(mockTrackRef.trackKey);
    expect(lines["api"]).toEqual([
      "Xin chào thế giới",
      "Bạn khỏe không",
      "Tạm biệt",
    ]);
  });

  it("sourceHash thay đổi: putTrack xóa bản dịch cũ, lines mới bắt đầu từ mảng rỗng", async () => {
    await db.putTrack(mockTrackRef, mockCues, "oldHash");
    await db.mergeLines(mockTrackRef.trackKey, "api", "oldHash", 2, [[0, "Cũ"]]);
    expect((await db.getLines(mockTrackRef.trackKey, "oldHash"))["api"]).toEqual(["Cũ", null]);

    // Phụ đề gốc đổi nội dung → content lưu lại track với hash mới rồi mới lưu bản dịch
    await db.putTrack(mockTrackRef, mockCues, "newHash");
    expect(await db.getLines(mockTrackRef.trackKey)).toEqual({});
    await db.mergeLines(mockTrackRef.trackKey, "api", "newHash", 2, [[1, "Mới"]]);
    expect((await db.getLines(mockTrackRef.trackKey, "newHash"))["api"]).toEqual([null, "Mới"]);
  });

  it("mergeLines bị bỏ qua khi track chưa lưu hoặc hash không khớp (không tạo bản ghi mồ côi)", async () => {
    await db.mergeLines(mockTrackRef.trackKey, "api", sourceHash, 2, [[0, "x"]]);
    expect(await db.getLines(mockTrackRef.trackKey)).toEqual({});

    await db.putTrack(mockTrackRef, mockCues, sourceHash);
    await db.mergeLines(mockTrackRef.trackKey, "api", "hashKhac", 2, [[0, "lệch dòng"]]);
    expect(await db.getLines(mockTrackRef.trackKey)).toEqual({});
  });

  it("getLines(trackKey, sourceHash) không trả về bản dịch của phiên bản phụ đề khác", async () => {
    await db.putTrack(mockTrackRef, mockCues, sourceHash);
    await db.mergeLines(mockTrackRef.trackKey, "api", sourceHash, 2, [[0, "đúng"]]);
    expect((await db.getLines(mockTrackRef.trackKey, sourceHash))["api"]).toEqual(["đúng", null]);
    expect(await db.getLines(mockTrackRef.trackKey, "hashKhac")).toEqual({});
  });

  it("stats: trả về số lượng track và dung lượng ước tính", async () => {
    await db.putTrack(mockTrackRef, mockCues, sourceHash);
    await db.mergeLines(
      mockTrackRef.trackKey,
      "api",
      sourceHash,
      3,
      [[0, "Xin chào"]]
    );

    const stats = await db.stats();
    expect(stats.tracks).toBe(1);
    expect(stats.bytesApprox).toBeGreaterThan(0);
  });

  it("clear một track thì xóa luôn cả bản ghi lines của track đó", async () => {
    await db.putTrack(mockTrackRef, mockCues, sourceHash);
    await db.mergeLines(
      mockTrackRef.trackKey,
      "api",
      sourceHash,
      3,
      [[0, "Xin chào"]]
    );
    await db.mergeLines(
      mockTrackRef.trackKey,
      "cloud:gemini-3.5-flash-lite",
      sourceHash,
      3,
      [[0, "Xin chào AI"]]
    );

    // Track 2
    const track2: TrackRef = {
      ...mockTrackRef,
      trackKey: "yt:video999:en:manual",
      videoId: "video999",
    };
    await db.putTrack(track2, mockCues, sourceHash);
    await db.mergeLines(track2.trackKey, "api", sourceHash, 3, [[0, "Track 2"]]);

    // Xóa track 1
    await db.clear(mockTrackRef.trackKey);

    expect(await db.getTrack(mockTrackRef.trackKey)).toBeUndefined();
    expect(await db.getLines(mockTrackRef.trackKey)).toEqual({});

    // Track 2 vẫn còn nguyên vẹn
    expect(await db.getTrack(track2.trackKey)).toBeDefined();
    expect(await db.getLines(track2.trackKey)).toEqual({
      api: ["Track 2", null, null],
    });
  });

  it("clear toàn bộ: xóa sạch tracks và lines", async () => {
    await db.putTrack(mockTrackRef, mockCues, sourceHash);
    await db.mergeLines(
      mockTrackRef.trackKey,
      "api",
      sourceHash,
      3,
      [[0, "Xin chào"]]
    );

    await db.clear();

    const stats = await db.stats();
    expect(stats.tracks).toBe(0);
    expect(stats.bytesApprox).toBe(0);
    expect(await db.getLines(mockTrackRef.trackKey)).toEqual({});
  });

  it("evict theo số lượng maxTracks và theo tuổi maxAgeDays", async () => {
    const now = Date.now();

    // Track 1: quá hạn 40 ngày (hơn 30 ngày)
    const t1: TrackRef = { ...mockTrackRef, trackKey: "t1" };
    await db.putTrack(t1, mockCues, "h1");
    // Hack lastOpenedAt vào quá khứ
    const track1Rec = await db.getTrack("t1");
    track1Rec!.lastOpenedAt = now - 40 * 86400 * 1000;
    // Ghi đè lại
    const rawDB = await (db as unknown as { getDB(): Promise<any> }).getDB();
    await rawDB.put("tracks", track1Rec);

    // Track 2: mở cách đây 10 ngày
    const t2: TrackRef = { ...mockTrackRef, trackKey: "t2" };
    await db.putTrack(t2, mockCues, "h2");
    const track2Rec = await db.getTrack("t2");
    track2Rec!.lastOpenedAt = now - 10 * 86400 * 1000;
    await rawDB.put("tracks", track2Rec);

    // Track 3: mở hôm nay
    const t3: TrackRef = { ...mockTrackRef, trackKey: "t3" };
    await db.putTrack(t3, mockCues, "h3");

    // Chính sách: maxTracks = 1, maxAgeDays = 30
    // -> t1 bị xóa vì quá 30 ngày
    // -> sau đó còn t2 và t3 (2 tracks) > maxTracks (1) -> t2 (cũ hơn) bị xóa tiếp -> chỉ còn t3
    const evicted = await db.evict({ maxTracks: 1, maxAgeDays: 30 });
    expect(evicted).toBe(2);

    expect(await db.getTrack("t1")).toBeUndefined();
    expect(await db.getTrack("t2")).toBeUndefined();
    expect(await db.getTrack("t3")).toBeDefined();
  });
});
