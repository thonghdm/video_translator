/**
 * SubTrans Extension — IndexedDB Translation Cache
 * Phù hợp với Mục 6.5 và Phase 3 của PLAN.md
 */

import { openDB, type IDBPDatabase } from "idb";
import type { Cue, TrackRef } from "../../shared/types";

export interface TrackRecord extends TrackRef {
  sourceHash: string;
  cues: Cue[];
  createdAt: number;
  lastOpenedAt: number;
  bytesApprox: number;
}

export interface LinesRecord {
  trackKey: string;
  engineKey: string;
  sourceHash: string;
  lines: (string | null)[];
  updatedAt: number;
}

const DB_NAME = "subtrans";
const DB_VERSION = 1;

export class SubtransDB {
  private dbPromise: Promise<IDBPDatabase> | null = null;

  private getDB(): Promise<IDBPDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB(DB_NAME, DB_VERSION, {
        upgrade(db) {
          // Store 1: tracks (keyPath: trackKey)
          if (!db.objectStoreNames.contains("tracks")) {
            const trackStore = db.createObjectStore("tracks", {
              keyPath: "trackKey",
            });
            trackStore.createIndex("lastOpenedAt", "lastOpenedAt");
          }

          // Store 2: lines (keyPath: [trackKey, engineKey])
          if (!db.objectStoreNames.contains("lines")) {
            const linesStore = db.createObjectStore("lines", {
              keyPath: ["trackKey", "engineKey"],
            });
            linesStore.createIndex("trackKey", "trackKey");
          }
        },
      });
    }
    return this.dbPromise;
  }

  /**
   * Tính toán dung lượng ước tính của một track (bytes)
   */
  private estimateTrackBytes(cues: Cue[], track: TrackRef): number {
    let bytes = JSON.stringify(track).length;
    for (const cue of cues) {
      bytes += cue.text.length * 2 + 16;
    }
    return bytes;
  }

  /**
   * Lấy thông tin track theo trackKey
   */
  public async getTrack(trackKey: string): Promise<TrackRecord | undefined> {
    const db = await this.getDB();
    return await db.get("tracks", trackKey);
  }

  /**
   * Lưu hoặc cập nhật thông tin track
   */
  public async putTrack(
    track: TrackRef,
    cues: Cue[],
    sourceHash: string
  ): Promise<void> {
    const db = await this.getDB();
    const tx = db.transaction(["tracks", "lines"], "readwrite");
    const tracksStore = tx.objectStore("tracks");
    const existing = (await tracksStore.get(track.trackKey)) as TrackRecord | undefined;

    // Nội dung phụ đề gốc đổi (sourceHash khác) → mọi bản dịch cũ lệch chỉ số dòng → xóa hết
    if (existing && existing.sourceHash !== sourceHash) {
      let cursor = await tx.objectStore("lines").index("trackKey").openCursor(track.trackKey);
      while (cursor) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
    }

    const now = Date.now();
    const record: TrackRecord = {
      ...track,
      sourceHash,
      cues,
      createdAt: existing ? existing.createdAt : now,
      lastOpenedAt: now,
      bytesApprox: this.estimateTrackBytes(cues, track),
    };
    await tracksStore.put(record);
    await tx.done;
  }

  /**
   * Cập nhật thời điểm mở gần nhất (lastOpenedAt) cho track
   */
  public async touchTrack(trackKey: string): Promise<void> {
    const db = await this.getDB();
    const tx = db.transaction("tracks", "readwrite");
    const store = tx.objectStore("tracks");
    const record = (await store.get(trackKey)) as TrackRecord | undefined;
    if (record) {
      record.lastOpenedAt = Date.now();
      await store.put(record);
    }
    await tx.done;
  }

  /**
   * Lấy toàn bộ bản dịch các engine của track
   */
  public async getLines(
    trackKey: string,
    sourceHash?: string
  ): Promise<Record<string, (string | null)[]>> {
    const db = await this.getDB();
    const tx = db.transaction("lines", "readonly");
    const index = tx.store.index("trackKey");
    const records = (await index.getAll(trackKey)) as LinesRecord[];
    await tx.done;

    const result: Record<string, (string | null)[]> = {};
    for (const rec of records) {
      // Bản dịch của phiên bản phụ đề khác → bỏ qua (chỉ số dòng không còn khớp)
      if (sourceHash !== undefined && rec.sourceHash !== sourceHash) continue;
      result[rec.engineKey] = rec.lines;
    }
    return result;
  }

  /**
   * Gộp các dòng dịch mới vào bản ghi lines của engineKey
   * Đảm bảo tính toàn vẹn trong 1 transaction và không ghi đè dòng đã dịch bằng null
   */
  public async mergeLines(
    trackKey: string,
    engineKey: string,
    sourceHash: string,
    total: number,
    updates: Array<[number, string]>
  ): Promise<void> {
    if (updates.length === 0 && total <= 0) {
      return;
    }

    const db = await this.getDB();
    const tx = db.transaction(["tracks", "lines"], "readwrite");
    const linesStore = tx.objectStore("lines");
    const tracksStore = tx.objectStore("tracks");

    // Track chưa được lưu / đã bị evict / đã đổi nội dung → không ghi (tránh bản ghi mồ côi, lệch dòng)
    const owner = (await tracksStore.get(trackKey)) as TrackRecord | undefined;
    if (!owner || owner.sourceHash !== sourceHash) {
      await tx.done;
      return;
    }

    // Lấy bản ghi hiện tại
    const existing = (await linesStore.get([
      trackKey,
      engineKey,
    ])) as LinesRecord | undefined;

    let lines: (string | null)[];

    if (existing && existing.sourceHash === sourceHash) {
      // Source hash khớp -> giữ nguyên các dòng cũ và gộp thêm
      lines = existing.lines.slice();
      if (lines.length < total) {
        const extra = new Array(total - lines.length).fill(null);
        lines.push(...extra);
      }
    } else {
      // Chưa có hoặc sourceHash đổi -> khởi tạo mảng mới
      lines = new Array(total).fill(null);
    }

    let addedChars = 0;
    for (const [idx, text] of updates) {
      if (idx >= 0 && idx < total) {
        if (text) {
          if (!lines[idx]) {
            addedChars += text.length * 2;
          }
          lines[idx] = text;
        }
      }
    }

    const updatedRecord: LinesRecord = {
      trackKey,
      engineKey,
      sourceHash,
      lines,
      updatedAt: Date.now(),
    };

    await linesStore.put(updatedRecord);

    // Cập nhật bytesApprox ước tính của track nếu có
    if (addedChars > 0) {
      owner.bytesApprox += addedChars;
      await tracksStore.put(owner);
    }

    await tx.done;
  }

  /**
   * Thống kê số lượng track và tổng dung lượng ước tính
   */
  public async stats(): Promise<{ tracks: number; bytesApprox: number }> {
    const db = await this.getDB();
    const tx = db.transaction("tracks", "readonly");
    const allTracks = (await tx.store.getAll()) as TrackRecord[];
    await tx.done;

    let bytesApprox = 0;
    for (const t of allTracks) {
      bytesApprox += t.bytesApprox || 0;
    }

    return {
      tracks: allTracks.length,
      bytesApprox,
    };
  }

  /**
   * Lấy danh sách tối đa `limit` track được mở gần đây nhất
   */
  public async listRecent(limit = 50): Promise<
    Array<{ trackKey: string; title: string; platform: string; lastOpenedAt: number; linesCount: number }>
  > {
    const db = await this.getDB();
    const tx = db.transaction("tracks", "readonly");
    const allTracks = (await tx.store.getAll()) as TrackRecord[];
    await tx.done;

    allTracks.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
    return allTracks.slice(0, limit).map((t) => ({
      trackKey: t.trackKey,
      title: t.title || "Video",
      platform: t.platform || "web",
      lastOpenedAt: t.lastOpenedAt || 0,
      linesCount: t.cues?.length || 0,
    }));
  }

  /**
   * Xóa track và các bản ghi lines tương ứng. Nếu không truyền trackKey thì xóa toàn bộ.
   */
  public async clear(trackKey?: string): Promise<void> {
    const db = await this.getDB();
    const tx = db.transaction(["tracks", "lines"], "readwrite");
    const tracksStore = tx.objectStore("tracks");
    const linesStore = tx.objectStore("lines");

    if (trackKey) {
      await tracksStore.delete(trackKey);
      // Xóa tất cả các lines thuộc trackKey
      const index = linesStore.index("trackKey");
      let cursor = await index.openCursor(trackKey);
      while (cursor) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
    } else {
      await tracksStore.clear();
      await linesStore.clear();
    }

    await tx.done;
  }

  /**
   * Tự động dọn dẹp các track cũ nhất vượt quá maxTracks hoặc quá maxAgeDays
   */
  public async evict(policy: {
    maxTracks: number;
    maxAgeDays: number;
  }): Promise<number> {
    const maxTracks = policy.maxTracks > 0 ? policy.maxTracks : 200;
    const maxAgeMs = (policy.maxAgeDays > 0 ? policy.maxAgeDays : 30) * 86400 * 1000;
    const now = Date.now();
    const expireBefore = now - maxAgeMs;

    const db = await this.getDB();
    const tx = db.transaction(["tracks", "lines"], "readwrite");
    const tracksStore = tx.objectStore("tracks");
    const index = tracksStore.index("lastOpenedAt");

    // Lấy danh sách track sắp xếp theo lastOpenedAt tăng dần (cũ nhất trước)
    const allTracks = (await index.getAll()) as TrackRecord[];
    let evictedCount = 0;

    const toDeleteKeys: string[] = [];

    // 1. Quét track quá tuổi
    for (const t of allTracks) {
      if (t.lastOpenedAt < expireBefore) {
        toDeleteKeys.push(t.trackKey);
      }
    }

    // 2. Nếu số track còn lại vẫn vượt maxTracks, xóa tiếp các track cũ nhất
    const remainingCount = allTracks.length - toDeleteKeys.length;
    if (remainingCount > maxTracks) {
      const excess = remainingCount - maxTracks;
      let count = 0;
      for (const t of allTracks) {
        if (!toDeleteKeys.includes(t.trackKey)) {
          toDeleteKeys.push(t.trackKey);
          count++;
          if (count >= excess) break;
        }
      }
    }

    // Thực hiện xóa track và lines liên quan
    const linesStore = tx.objectStore("lines");
    const linesTrackIndex = linesStore.index("trackKey");

    for (const key of toDeleteKeys) {
      await tracksStore.delete(key);
      let cursor = await linesTrackIndex.openCursor(key);
      while (cursor) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
      evictedCount++;
    }

    await tx.done;
    return evictedCount;
  }
}
