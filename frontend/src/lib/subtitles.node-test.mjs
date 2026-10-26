import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Upsert các phụ đề mới vào danh sách hiện tại.
 */
function upsertSubtitles(existing, incoming) {
  if (incoming.length === 0) {
    return existing;
  }

  const map = new Map();
  for (const item of existing) {
    map.set(item.id, item);
  }
  for (const item of incoming) {
    map.set(item.id, item);
  }

  const result = Array.from(map.values());
  result.sort((a, b) => a.start_sec - b.start_sec);
  return result;
}

/**
 * Tìm kiếm nhị phân phụ đề tương ứng với mốc thời gian currentTime (giây).
 */
function findSubtitleAtTime(subtitles, currentTime) {
  if (subtitles.length === 0) {
    return null;
  }

  let left = 0;
  let right = subtitles.length - 1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const item = subtitles[mid];

    if (currentTime >= item.start_sec && currentTime <= item.end_sec) {
      return item;
    }

    if (currentTime < item.start_sec) {
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }

  return null;
}

test('Subtitle Engine: upsertSubtitles thêm mới và duy trì mảng sắp xếp theo start_sec', () => {
  const existing = [
    { id: 1001, block: 1, start_sec: 10.0, end_sec: 15.0, source_text: 'First', target_text: '', translated: false },
    { id: 1003, block: 1, start_sec: 30.0, end_sec: 35.0, source_text: 'Third', target_text: '', translated: false },
  ];

  const incoming = [
    { id: 1002, block: 1, start_sec: 20.0, end_sec: 25.0, source_text: 'Second', target_text: '', translated: false },
  ];

  const result = upsertSubtitles(existing, incoming);
  assert.equal(result.length, 3);
  assert.equal(result[0].id, 1001);
  assert.equal(result[1].id, 1002);
  assert.equal(result[2].id, 1003);
});

test('Subtitle Engine: upsertSubtitles ghi đè item có cùng id khi bản dịch tiếng Việt cập nhật', () => {
  const existing = [
    { id: 1001, block: 1, start_sec: 10.0, end_sec: 15.0, source_text: 'Hello world', target_text: '', translated: false },
  ];

  const translatedChunk = [
    { id: 1001, block: 1, start_sec: 10.0, end_sec: 15.0, source_text: 'Hello world', target_text: 'Xin chào thế giới', translated: true },
  ];

  const result = upsertSubtitles(existing, translatedChunk);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 1001);
  assert.equal(result[0].target_text, 'Xin chào thế giới');
  assert.equal(result[0].translated, true);
});

test('Subtitle Engine: findSubtitleAtTime tìm kiếm nhị phân chính xác thời điểm hiển thị phụ đề', () => {
  const items = [
    { id: 1, block: 0, start_sec: 5.0, end_sec: 8.0, source_text: 'A', target_text: 'A', translated: true },
    { id: 2, block: 0, start_sec: 10.0, end_sec: 14.0, source_text: 'B', target_text: 'B', translated: true },
    { id: 3, block: 0, start_sec: 20.0, end_sec: 25.0, source_text: 'C', target_text: 'C', translated: true },
  ];

  assert.equal(findSubtitleAtTime(items, 6.5)?.id, 1);
  assert.equal(findSubtitleAtTime(items, 10.0)?.id, 2);
  assert.equal(findSubtitleAtTime(items, 14.0)?.id, 2);
  assert.equal(findSubtitleAtTime(items, 22.0)?.id, 3);

  // Khoảng lặng
  assert.equal(findSubtitleAtTime(items, 9.0), null);
  assert.equal(findSubtitleAtTime(items, 16.0), null);
  assert.equal(findSubtitleAtTime(items, 2.0), null);
  assert.equal(findSubtitleAtTime(items, 30.0), null);
  assert.equal(findSubtitleAtTime([], 5.0), null);
});
