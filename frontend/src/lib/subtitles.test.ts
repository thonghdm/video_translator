import { describe, it, expect } from 'vitest';
import { upsertSubtitles, findSubtitleAtTime, SubtitleItem } from './subtitles';

describe('Subtitle Engine - Pure Logic Tests', () => {
  it('upsertSubtitles: thêm mới và duy trì mảng sắp xếp theo start_sec', () => {
    const existing: SubtitleItem[] = [
      { id: 1001, block: 1, start_sec: 10.0, end_sec: 15.0, source_text: 'First', target_text: '', translated: false },
      { id: 1003, block: 1, start_sec: 30.0, end_sec: 35.0, source_text: 'Third', target_text: '', translated: false },
    ];

    const incoming: SubtitleItem[] = [
      { id: 1002, block: 1, start_sec: 20.0, end_sec: 25.0, source_text: 'Second', target_text: '', translated: false },
    ];

    const result = upsertSubtitles(existing, incoming);
    expect(result.length).toBe(3);
    expect(result[0].id).toBe(1001);
    expect(result[1].id).toBe(1002);
    expect(result[2].id).toBe(1003);
  });

  it('upsertSubtitles: ghi đè item có cùng id khi bản dịch tiếng Việt cập nhật', () => {
    const existing: SubtitleItem[] = [
      { id: 1001, block: 1, start_sec: 10.0, end_sec: 15.0, source_text: 'Hello world', target_text: '', translated: false },
    ];

    const translatedChunk: SubtitleItem[] = [
      { id: 1001, block: 1, start_sec: 10.0, end_sec: 15.0, source_text: 'Hello world', target_text: 'Xin chào thế giới', translated: true },
    ];

    const result = upsertSubtitles(existing, translatedChunk);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe(1001);
    expect(result[0].target_text).toBe('Xin chào thế giới');
    expect(result[0].translated).toBe(true);
  });

  it('findSubtitleAtTime: tìm kiếm nhị phân chính xác thời điểm hiển thị phụ đề', () => {
    const items: SubtitleItem[] = [
      { id: 1, block: 0, start_sec: 5.0, end_sec: 8.0, source_text: 'A', target_text: 'A', translated: true },
      { id: 2, block: 0, start_sec: 10.0, end_sec: 14.0, source_text: 'B', target_text: 'B', translated: true },
      { id: 3, block: 0, start_sec: 20.0, end_sec: 25.0, source_text: 'C', target_text: 'C', translated: true },
    ];

    // Khớp bên trong khoảng
    expect(findSubtitleAtTime(items, 6.5)?.id).toBe(1);
    // Khớp ngay tại biên bắt đầu
    expect(findSubtitleAtTime(items, 10.0)?.id).toBe(2);
    // Khớp ngay tại biên kết thúc
    expect(findSubtitleAtTime(items, 14.0)?.id).toBe(2);
    // Khớp phần tử cuối
    expect(findSubtitleAtTime(items, 22.0)?.id).toBe(3);

    // Thời gian trong khoảng lặng giữa các câu
    expect(findSubtitleAtTime(items, 9.0)).toBeNull();
    expect(findSubtitleAtTime(items, 16.0)).toBeNull();
    // Trước phần tử đầu tiên
    expect(findSubtitleAtTime(items, 2.0)).toBeNull();
    // Sau phần tử cuối cùng
    expect(findSubtitleAtTime(items, 30.0)).toBeNull();
    // Mảng rỗng
    expect(findSubtitleAtTime([], 5.0)).toBeNull();
  });
});
