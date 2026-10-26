import test from 'node:test';
import assert from 'node:assert/strict';

// 1. Kiểm tra logic toán học của Bộ lập lịch (Scheduler & Lookahead math)
test('Step 3: Scheduler Lookahead & Backfill Algorithm Logic', () => {
  const blockSec = 30.0;
  const lookaheadMaxSec = 90.0; // 3 blocks
  const lookaheadMinSec = 45.0;
  const totalDuration = 300.0; // 10 blocks (0 đến 9)
  const totalBlocks = Math.ceil(totalDuration / blockSec);

  // Giả lập trạng thái cache done_blocks
  const doneBlocks = new Set([2, 3, 4]);

  function computeAheadSec(playheadSec, doneSet) {
    const curBlock = Math.floor(playheadSec / blockSec);
    let continuousDoneEnd = playheadSec;

    for (let b = curBlock; b < totalBlocks; b++) {
      if (doneSet.has(b)) {
        const bEnd = Math.min((b + 1) * blockSec, totalDuration);
        continuousDoneEnd = bEnd;
      } else {
        break;
      }
    }
    return Math.max(0, continuousDoneEnd - playheadSec);
  }

  function getNextBlock(playheadSec, doneSet, activeJobs) {
    const playheadBlock = Math.floor(playheadSec / blockSec);
    const ahead = computeAheadSec(playheadSec, doneSet);

    // 1. Tìm block chưa xong phía trước playhead
    let nextBlock = -1;
    for (let b = playheadBlock; b < totalBlocks; b++) {
      if (!doneSet.has(b) && !activeJobs.has(b)) {
        nextBlock = b;
        break;
      }
    }

    // 2. Nếu phía trước còn block, áp dụng giới hạn lookahead_max
    if (nextBlock !== -1) {
      if (ahead >= lookaheadMaxSec) {
        return { block: -1, state: 'ahead' };
      }
      return { block: nextBlock, state: ahead < lookaheadMinSec ? 'catching_up' : 'processing' };
    }

    // 3. Nếu phía trước đã xong hết tới cuối video, kích hoạt Backfill các block thiếu từ đầu video
    for (let b = 0; b < playheadBlock; b++) {
      if (!doneSet.has(b) && !activeJobs.has(b)) {
        return { block: b, state: 'backfill' };
      }
    }

    return { block: -1, state: 'done' };
  }

  // Trường hợp 1: Playhead ở 60s (block 2), done=[2, 3, 4] -> ahead = 150 - 60 = 90s -> trạng thái 'ahead'
  assert.equal(computeAheadSec(60, doneBlocks), 90);
  const res1 = getNextBlock(60, doneBlocks, new Set());
  assert.equal(res1.state, 'ahead');

  // Trường hợp 2: Playhead ở 75s (giữa block 2) -> ahead = 150 - 75 = 75s < 90s -> tiếp tục lấy block 5
  assert.equal(computeAheadSec(75, doneBlocks), 75);
  const res2 = getNextBlock(75, doneBlocks, new Set());
  assert.equal(res2.block, 5);
  assert.equal(res2.state, 'processing');

  // Trường hợp 3: Khi tất cả block từ playhead đến cuối đã xong, chuyển sang 'backfill' các block [0, 1]
  const allAheadDone = new Set([2, 3, 4, 5, 6, 7, 8, 9]);
  const res3 = getNextBlock(60, allAheadDone, new Set());
  assert.equal(res3.state, 'backfill');
  assert.equal(res3.block, 0); // Lấy block 0 từ đầu video

  // Trường hợp 4: Toàn bộ 10 blocks đã xong -> trạng thái 'done'
  for (let i = 0; i < 10; i++) allAheadDone.add(i);
  const res4 = getNextBlock(60, allAheadDone, new Set());
  assert.equal(res4.state, 'done');
});

// 2. Kiểm tra logic phân loại SeekTo an toàn
test('Step 3: SeekTo Decision Matrix Verification', () => {
  const blockSec = 30.0;
  const doneBlocks = new Set([1, 2]);
  const activeJobs = new Set([3]);

  function evaluateSeek(targetSec) {
    const targetBlock = Math.floor(targetSec / blockSec);

    // 1. Đã done trong cache -> Không cần hủy session
    if (doneBlocks.has(targetBlock)) {
      return { action: 'UPDATE_PLAYHEAD_ONLY', targetBlock };
    }

    // 2. Đang được xử lý -> Giữ nguyên hướng chạy
    if (activeJobs.has(targetBlock) || activeJobs.has(targetBlock + 1)) {
      return { action: 'KEEP_RUNNING', targetBlock };
    }

    // 3. Khác -> Hủy session cũ và tạo session mới
    return { action: 'NEW_SESSION', targetBlock };
  }

  // Tua vào block 1 (35s) đã done
  assert.equal(evaluateSeek(35).action, 'UPDATE_PLAYHEAD_ONLY');

  // Tua vào block 3 (95s) đang active
  assert.equal(evaluateSeek(95).action, 'KEEP_RUNNING');

  // Tua vào block 7 (220s) chưa xử lý
  assert.equal(evaluateSeek(220).action, 'NEW_SESSION');
});
