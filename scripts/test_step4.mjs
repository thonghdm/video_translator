import test from 'node:test';
import assert from 'node:assert/strict';

// 1. Kiểm tra format thời gian SRT chính xác
test('Step 4: FormatSRTTime format verification', () => {
  function formatSRTTime(sec) {
    if (sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.min(999, Math.round((sec - Math.floor(sec)) * 1000));
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }

  assert.equal(formatSRTTime(0), '00:00:00,000');
  assert.equal(formatSRTTime(1.5), '00:00:01,500');
  assert.equal(formatSRTTime(65.42), '00:01:05,420');
  assert.equal(formatSRTTime(3661.05), '01:01:01,050');
});

// 2. Kiểm tra định dạng SRT cho 3 chế độ (source, target, bilingual)
test('Step 4: SRT Exporter Modes (Source, Target, Bilingual)', () => {
  function generateSRT(items, mode) {
    let output = '';
    let idx = 1;
    for (const it of items) {
      let text = '';
      if (mode === 'source') {
        text = it.source_text;
      } else if (mode === 'target') {
        text = it.target_text || it.source_text;
      } else if (mode === 'bilingual') {
        text = it.target_text ? `${it.source_text}\n${it.target_text}` : it.source_text;
      }
      if (!text.trim()) continue;

      output += `${idx}\n00:00:10,000 --> 00:00:15,000\n${text.trim()}\n\n`;
      idx++;
    }
    return output;
  }

  const sampleItems = [
    { source_text: 'Hello world', target_text: 'Xin chào thế giới' },
  ];

  // Mode Source
  const srtSource = generateSRT(sampleItems, 'source');
  assert.ok(srtSource.includes('Hello world'));
  assert.ok(!srtSource.includes('Xin chào'));

  // Mode Target
  const srtTarget = generateSRT(sampleItems, 'target');
  assert.ok(srtTarget.includes('Xin chào thế giới'));
  assert.ok(!srtTarget.includes('Hello world'));

  // Mode Bilingual
  const srtBilingual = generateSRT(sampleItems, 'bilingual');
  assert.ok(srtBilingual.includes('Hello world\nXin chào thế giới'));
});
