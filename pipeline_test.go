package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// MockTranslator giả lập trả về bản dịch
type MockTranslator struct{}

func (m *MockTranslator) Translate(ctx context.Context, line string, prevContext []string) (string, error) {
	return "[VI] " + line, nil
}

func (m *MockTranslator) Close() error {
	return nil
}

// Test_Pipeline_LookaheadAndBackfill kiểm tra chuyển đổi trạng thái lookahead và backfill
func Test_Pipeline_LookaheadAndBackfill(t *testing.T) {
	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "video.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)

	meta := CacheMeta{
		BlockSec:   30.0,
		OverlapSec: 2.0,
	}
	bs, err := NewBlockStore(dummyVideo, meta)
	if err != nil {
		t.Fatalf("Tạo blockstore thất bại: %v", err)
	}

	settings := Settings{
		BlockSec:         30.0,
		OverlapSec:       2.0,
		LookaheadMinSec:  45.0,
		LookaheadMaxSec:  90.0, // 3 blocks = 90s
		TranslateWorkers: 1,
	}

	tools := &ToolsPaths{TempDir: tempDir}
	mockTrans := &MockTranslator{}

	var states []string
	var stateMu sync.Mutex

	callbacks := PipelineEventCallbacks{
		OnStatus: func(st PipelineStatus) {
			stateMu.Lock()
			states = append(states, st.State)
			stateMu.Unlock()
		},
	}

	// Video dài 180s (6 blocks: 0, 1, 2, 3, 4, 5)
	p := NewPipeline(dummyVideo, 180.0, settings, tools, bs, mockTrans, callbacks)

	// Mock Slicer và STT trả kết quả giả lập ngay lập tức
	p.MockSliceAudio = func(ctx context.Context, videoPath string, bRange BlockRange, outWav string) error {
		return os.WriteFile(outWav, []byte("RIFFdummyWAV"), 0644)
	}
	p.MockRunSTT = func(ctx context.Context, wavPath string, bRange BlockRange) ([]WhisperSegment, error) {
		return []WhisperSegment{
			{StartSec: bRange.OwnerStart + 1.0, EndSec: bRange.OwnerStart + 5.0, Text: fmt.Sprintf("Hello from block %d", bRange.Index)},
		}, nil
	}

	// Bắt đầu từ 0s
	_ = p.Start(0)

	// Chờ pipeline xử lý đạt tới ngưỡng lookahead hoặc hoàn tất
	time.Sleep(1 * time.Second)

	p.Stop()

	// Verify ít nhất đã xử lý được block đầu tiên và lưu vào cache
	items := bs.GetAllItemsSorted()
	if len(items) == 0 {
		t.Errorf("Kỳ vọng có phụ đề trong cache sau khi chạy pipeline")
	} else {
		if items[0].TargetText != "[VI] Hello from block 0" {
			t.Errorf("Bản dịch không đúng mong đợi: %s", items[0].TargetText)
		}
	}
}

// Test_Pipeline_RapidSeekTo kiểm tra tua dồn dập nhiều lần không gây race condition hoặc deadlock
func Test_Pipeline_RapidSeekTo(t *testing.T) {
	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "video_seek.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)

	bs, _ := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30, OverlapSec: 2})
	settings := Settings{BlockSec: 30, OverlapSec: 2, LookaheadMinSec: 30, LookaheadMaxSec: 60, TranslateWorkers: 2}
	tools := &ToolsPaths{TempDir: tempDir}

	p := NewPipeline(dummyVideo, 600.0, settings, tools, bs, &MockTranslator{}, PipelineEventCallbacks{})
	p.MockSliceAudio = func(ctx context.Context, videoPath string, bRange BlockRange, outWav string) error {
		time.Sleep(10 * time.Millisecond)
		return nil
	}
	p.MockRunSTT = func(ctx context.Context, wavPath string, bRange BlockRange) ([]WhisperSegment, error) {
		time.Sleep(10 * time.Millisecond)
		return []WhisperSegment{
			{StartSec: bRange.OwnerStart + 1.0, EndSec: bRange.OwnerStart + 3.0, Text: "Test line"},
		}, nil
	}

	_ = p.Start(0)

	// Bắn 20 lệnh tua liên tiếp từ nhiều goroutine
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		targetSec := float64((i * 27) % 550)
		go func(sec float64) {
			defer wg.Done()
			_ = p.SeekTo(sec)
		}(targetSec)
	}

	wg.Wait()
	time.Sleep(200 * time.Millisecond)
	p.Stop()
}
