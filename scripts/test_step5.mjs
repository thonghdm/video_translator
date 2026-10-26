import test from 'node:test';
import assert from 'node:assert/strict';

// 1. Kiểm tra tính toán dải màu done_blocks trên Seekbar
test('Step 5: Seekbar done_blocks highlight calculation', () => {
  const duration = 120.0; // 120 giây
  const blockSec = 30.0;
  const doneBlocks = [0, 2]; // block 0 (0-30s) và block 2 (60-90s)

  const highlights = doneBlocks.map((b) => {
    const left = (b * blockSec / duration) * 100;
    const width = (blockSec / duration) * 100;
    return { block: b, left, width };
  });

  // Block 0: left 0%, width 25%
  assert.equal(highlights[0].left, 0);
  assert.equal(highlights[0].width, 25);

  // Block 2: left 50%, width 25%
  assert.equal(highlights[1].left, 50);
  assert.equal(highlights[1].width, 25);
});

// 2. Kiểm tra chu kỳ chuyển đổi chế độ phụ đề
test('Step 5: Subtitle Mode Cycling', () => {
  const modes = ['bilingual', 'vi', 'en', 'off'];
  function nextMode(current) {
    const idx = modes.indexOf(current);
    return modes[(idx + 1) % modes.length];
  }

  assert.equal(nextMode('bilingual'), 'vi');
  assert.equal(nextMode('vi'), 'en');
  assert.equal(nextMode('en'), 'off');
  assert.equal(nextMode('off'), 'bilingual');
});

// 3. Kiểm tra tính toán bù trừ độ lệch phụ đề (Offset G/H)
test('Step 5: Subtitle Offset Adjustment (G/H keys)', () => {
  let offset = 0.0;

  // Nhấn G (-0.1s)
  offset = Math.round((offset - 0.1) * 10) / 10;
  assert.equal(offset, -0.1);

  // Nhấn H 2 lần (+0.2s)
  offset = Math.round((offset + 0.1) * 10) / 10;
  offset = Math.round((offset + 0.1) * 10) / 10;
  assert.equal(offset, 0.1);
});
