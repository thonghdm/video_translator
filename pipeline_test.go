package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// MockTranslator giả lập trả về bản dịch
type MockTranslator struct{}

func (m *MockTranslator) Translate(ctx context.Context, line string, prevContext []string) (string, error) {
	return "[VI] " + line, nil
}

func (m *MockTranslator) TranslateBatch(ctx context.Context, lines []string) ([]string, error) {
	var res []string
	for _, l := range lines {
		res = append(res, "[VI] "+l)
	}
	return res, nil
}

func (m *MockTranslator) Close() error {
	return nil
}

// Test_Pipeline_LookaheadAndBackfill kiểm tra chuyển đổi trạng thái lookahead và backfill
func Test_Pipeline_LookaheadAndBackfill(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
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
// và đo lường thời gian drain computeMu và drain WaitGroup theo session
func Test_Pipeline_RapidSeekTo(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "video_seek.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)

	bs, _ := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30, OverlapSec: 2})
	settings := Settings{BlockSec: 30, OverlapSec: 2, LookaheadMinSec: 30, LookaheadMaxSec: 60, TranslateWorkers: 2}
	tools := &ToolsPaths{TempDir: tempDir}

	p := NewPipeline(dummyVideo, 600.0, settings, tools, bs, &MockTranslator{}, PipelineEventCallbacks{})
	p.MockSliceAudio = func(ctx context.Context, videoPath string, bRange BlockRange, outWav string) error {
		time.Sleep(15 * time.Millisecond)
		return nil
	}
	p.MockRunSTT = func(ctx context.Context, wavPath string, bRange BlockRange) ([]WhisperSegment, error) {
		time.Sleep(15 * time.Millisecond)
		return []WhisperSegment{
			{StartSec: bRange.OwnerStart + 1.0, EndSec: bRange.OwnerStart + 3.0, Text: "Test line"},
		}, nil
	}

	_ = p.Start(0)
	time.Sleep(20 * time.Millisecond)

	// Pha 1: Thực hiện 10 cú tua liên tiếp và đo lường chính xác computeDrainMs và wgDrainMs
	for i := 0; i < 10; i++ {
		targetSec := float64((i+1)*45 % 550)
		p.doSeek(targetSec)
		computeDrain := p.LastSeekComputeDrain()
		wgDrain := p.LastSeekWgDrain()
		t.Logf("[Measured RapidSeek #%02d] target=%.1fs | computeDrain=%dms | wgDrain=%dms",
			i+1, targetSec, computeDrain, wgDrain)
	}

	// Pha 2: Bắn 20 lệnh tua đồng thời từ nhiều goroutine qua RequestSeek / SeekTo
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

// Test_Pipeline_CoalescingSeek kiểm tra bắn 20 lệnh RequestSeek dồn dập:
// Bộ điều phối coalescing phải gom các lệnh lại và chỉ hội tụ xử lý vị trí đích cuối cùng.
func Test_Pipeline_CoalescingSeek(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "video_coalesce.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)

	bs, _ := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30, OverlapSec: 2})
	settings := Settings{BlockSec: 30, OverlapSec: 2, LookaheadMinSec: 30, LookaheadMaxSec: 60, TranslateWorkers: 2}
	tools := &ToolsPaths{TempDir: tempDir}

	var scheduledBlocks []int
	var schedMu sync.Mutex

	p := NewPipeline(dummyVideo, 600.0, settings, tools, bs, &MockTranslator{}, PipelineEventCallbacks{})
	p.MockSliceAudio = func(ctx context.Context, videoPath string, bRange BlockRange, outWav string) error {
		schedMu.Lock()
		scheduledBlocks = append(scheduledBlocks, bRange.Index)
		schedMu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(30 * time.Millisecond):
			return nil
		}
	}
	p.MockRunSTT = func(ctx context.Context, wavPath string, bRange BlockRange) ([]WhisperSegment, error) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(30 * time.Millisecond):
			return []WhisperSegment{
				{StartSec: bRange.OwnerStart + 1.0, EndSec: bRange.OwnerStart + 3.0, Text: "Line from block"},
			}, nil
		}
	}

	_ = p.Start(0)
	time.Sleep(10 * time.Millisecond)

	finalTargetSec := 420.0 // targetBlock = 14 (420 / 30)

	// Bắn 20 lệnh tua cực nhanh từ nhiều goroutine
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		sec := float64((i + 1) * 20)
		go func(s float64) {
			defer wg.Done()
			p.RequestSeek(s)
		}(sec)
	}
	wg.Wait()

	// Lệnh tua cuối cùng chốt hạ ở 420.0s
	p.RequestSeek(finalTargetSec)

	// Chờ coalescing loop xử lý lệnh chốt hạ
	time.Sleep(300 * time.Millisecond)

	p.mu.Lock()
	currentPlayhead := p.playheadSec
	activeCount := len(p.activeJobs)
	p.mu.Unlock()

	p.Stop()

	if currentPlayhead != finalTargetSec {
		t.Errorf("Playhead không hội tụ tại vị trí cuối %.1fs, hiện tại là: %.1fs", finalTargetSec, currentPlayhead)
	}

	schedMu.Lock()
	countScheduled := len(scheduledBlocks)
	blocksCopy := append([]int(nil), scheduledBlocks...)
	schedMu.Unlock()

	t.Logf("Coalescing thành công: 20 lệnh tua dồn dập chỉ sinh ra %d block slices (%v), playhead hội tụ đúng %.1fs (block %d)",
		countScheduled, blocksCopy, currentPlayhead, int(currentPlayhead/30))

	// Đảm bảo không spawn bừa bãi toàn bộ 20 phiên worker
	if countScheduled > 6 {
		t.Errorf("Coalescing thất bại: có tới %d block slices được kích hoạt thay vì bị triệt tiêu", countScheduled)
	}
	_ = activeCount
}

// Test_Pipeline_HandleBlockFailure_DeadlineExceeded kiểm tra:
// 1. context.DeadlineExceeded (lệnh ngoài timeout khi session còn sống) phải xóa activeJobs và tăng failedBlocks
// 2. context.Canceled (session bị hủy) KHÔNG được tăng failedBlocks
func Test_Pipeline_HandleBlockFailure_DeadlineExceeded(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "video_timeout.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)

	bs, _ := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30, OverlapSec: 2})
	settings := Settings{BlockSec: 30, OverlapSec: 2, LookaheadMinSec: 30, LookaheadMaxSec: 60, TranslateWorkers: 1}
	tools := &ToolsPaths{TempDir: tempDir}

	p := NewPipeline(dummyVideo, 300.0, settings, tools, bs, &MockTranslator{}, PipelineEventCallbacks{})
	_ = p.Start(0)
	defer p.Stop()

	p.mu.Lock()
	sessID := p.session.id
	p.activeJobs[2] = true
	p.mu.Unlock()

	// 1. Gặp DeadlineExceeded khi session đang sống: phải coi là lỗi của block
	p.handleBlockFailure(2, "slice", context.DeadlineExceeded, sessID)

	p.mu.Lock()
	failedCount := p.failedBlocks[2]
	isActive := p.activeJobs[2]
	p.mu.Unlock()

	if failedCount != 1 {
		t.Errorf("Kỳ vọng failedBlocks[2] == 1 sau DeadlineExceeded, nhận: %d", failedCount)
	}
	if isActive {
		t.Errorf("Kỳ vọng block 2 đã bị xóa khỏi activeJobs sau failure")
	}

	// 2. Gặp context.Canceled: không được tăng failedBlocks
	p.mu.Lock()
	p.activeJobs[2] = true
	p.mu.Unlock()

	p.handleBlockFailure(2, "slice", context.Canceled, sessID)

	p.mu.Lock()
	failedCountAfterCancel := p.failedBlocks[2]
	p.mu.Unlock()

	if failedCountAfterCancel != 1 {
		t.Errorf("context.Canceled không được tăng failedBlocks: kỳ vọng 1, nhận: %d", failedCountAfterCancel)
	}
}

// Test_Pipeline_FastPath_RequiresLiveSession kiểm tra:
// Khi tua dồn làm phiên cũ bị hủy và p.session == nil (chưa kịp spawn worker mới),
// nếu lệnh tua tiếp theo trúng block đã xong trong cache, hệ thống KHÔNG được return chay
// mà phải tạo session mới để worker sống tiếp tục xử lý các block phía sau.
func Test_Pipeline_FastPath_RequiresLiveSession(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "video_fastpath.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)

	bs, _ := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30, OverlapSec: 2})
	// Đánh dấu block 3 đã dịch xong trong cache
	_ = bs.SaveBlock(3, []SubtitleItem{
		{ID: 3001, Block: 3, StartSec: 90.0, EndSec: 95.0, SourceText: "Done", TargetText: "Đã dịch", Translated: true},
	})

	settings := Settings{BlockSec: 30, OverlapSec: 2, LookaheadMinSec: 30, LookaheadMaxSec: 60, TranslateWorkers: 1}
	tools := &ToolsPaths{TempDir: tempDir}

	p := NewPipeline(dummyVideo, 300.0, settings, tools, bs, &MockTranslator{}, PipelineEventCallbacks{})
	_ = p.Start(0)
	defer p.Stop()

	// Giả lập trạng thái p.session == nil (do phiên trước đó bị drain hủy giữa chừng)
	p.mu.Lock()
	if p.session != nil {
		p.session.cancel()
		p.session = nil
	}
	p.state = "processing"
	p.mu.Unlock()

	// Tua tới 95.0s (thuộc block 3 đã xong trong cache)
	p.doSeek(95.0)

	p.mu.Lock()
	hasSession := (p.session != nil)
	p.mu.Unlock()

	if !hasSession {
		t.Errorf("Lỗi: Fast-path khi p.session == nil đã không khởi tạo session mới, khiến pipeline chết!")
	}
}

// Test_Pipeline_SeekUnfinishedBlock_AlwaysRestartsSessionAndClearsFailures kiểm tra:
// Khi tua vào block chưa xong (dù worker đang chạy ở block đó hoặc block kế cận):
// Hệ thống PHẢI hủy session cũ, tạo session mới để ưu tiên dịch Tier-1 mốc thời gian vừa tua,
// đồng thời xóa failedBlocks của block đích về 0.
func Test_Pipeline_SeekUnfinishedBlock_AlwaysRestartsSessionAndClearsFailures(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "video_restart.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)

	bs, _ := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30, OverlapSec: 2})
	settings := Settings{BlockSec: 30, OverlapSec: 2, LookaheadMinSec: 30, LookaheadMaxSec: 60, TranslateWorkers: 1}
	tools := &ToolsPaths{TempDir: tempDir}

	p := NewPipeline(dummyVideo, 300.0, settings, tools, bs, &MockTranslator{}, PipelineEventCallbacks{})
	_ = p.Start(0)
	defer p.Stop()

	targetBlock := 2 // 60.0s - 90.0s
	nextBlock := 3

	p.mu.Lock()
	oldSessionID := p.session.id
	p.failedBlocks[targetBlock] = 2 // block 2 từng bị lỗi 2 lần
	p.activeJobs[nextBlock] = true  // worker đang xử lý block 3 (kế cận)
	p.mu.Unlock()

	// Tua tới 65.0s (thuộc block 2 chưa xong)
	p.doSeek(65.0)

	p.mu.Lock()
	newSessionID := p.session.id
	failedCount := p.failedBlocks[targetBlock]
	state := p.state
	playhead := p.playheadSec
	p.mu.Unlock()

	if newSessionID == oldSessionID {
		t.Errorf("Lỗi: Khi tua vào block chưa hoàn tất, session cũ không được tái sử dụng mà phải tạo session mới!")
	}
	if failedCount != 0 {
		t.Errorf("Kỳ vọng failedBlocks[%d] được xóa về 0 khi tua tới, nhận: %d", targetBlock, failedCount)
	}
	if state != "processing" {
		t.Errorf("Kỳ vọng state là 'processing', nhận: %s", state)
	}
	if playhead != 65.0 {
		t.Errorf("Kỳ vọng playheadSec là 65.0, nhận: %.1f", playhead)
	}
}

type modeAwareTranslator struct {
	MockTranslator
	mode string
}

func (m *modeAwareTranslator) CurrentMode() string {
	return m.mode
}

// Test_Pipeline_SmartFastPath2_ApiMode_PreservesSession kiểm tra:
// Khi ở mode "api", tua ngắn trong CÙNG block đang active (activeJobs[targetBlock] == true)
// và block chưa bị hoãn Tier-2, hệ thống PHẢI giữ nguyên session (không hủy Whisper)
// và chỉ dịch chuyển playheadSec.
func Test_Pipeline_SmartFastPath2_ApiMode_PreservesSession(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "video_fastpath2.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)

	bs, _ := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30, OverlapSec: 2})
	settings := Settings{BlockSec: 30, OverlapSec: 2, LookaheadMinSec: 30, LookaheadMaxSec: 60, TranslateWorkers: 1}
	tools := &ToolsPaths{TempDir: tempDir}

	trans := &modeAwareTranslator{mode: "api"}
	p := NewPipeline(dummyVideo, 300.0, settings, tools, bs, trans, PipelineEventCallbacks{})
	_ = p.Start(0)
	defer p.Stop()

	targetBlock := 2 // [60.0s - 90.0s]

	p.mu.Lock()
	oldSessionID := p.session.id
	p.activeJobs[targetBlock] = true // block 2 đang được worker xử lý
	p.tier2Deferred[targetBlock] = false
	p.mu.Unlock()

	// Người dùng đang ở 70s và bấm mũi tên lùi 5s về 65s (trong cùng block 2)
	p.doSeek(65.0)

	p.mu.Lock()
	newSessionID := p.session.id
	state := p.state
	playhead := p.playheadSec
	p.mu.Unlock()

	if newSessionID != oldSessionID {
		t.Fatalf("Smart Fast-Path 2 THẤT BẠI: Ở mode api khi tua trong cùng block đang chạy, kỳ vọng giữ nguyên session (%d), nhận session mới: %d",
			oldSessionID, newSessionID)
	}
	if playhead != 65.0 {
		t.Errorf("Kỳ vọng playheadSec cập nhật thành 65.0, nhận: %.1f", playhead)
	}
	if state != "processing" {
		t.Errorf("Kỳ vọng state là 'processing', nhận: %s", state)
	}
}

// Test_Pipeline_SmartFastPath2_LocalAiMode_ForcesRestart kiểm tra:
// Khi ở mode "local_ai", dù tua trong cùng block đang active, hệ thống BẮT BUỘC phải tạo session mới
// để tránh việc các câu tại mốc tua mới bị coi là Tier-2 và bị lệnh break bỏ rơi.
func Test_Pipeline_SmartFastPath2_LocalAiMode_ForcesRestart(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "video_localai_restart.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)

	bs, _ := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30, OverlapSec: 2})
	settings := Settings{BlockSec: 30, OverlapSec: 2, LookaheadMinSec: 30, LookaheadMaxSec: 60, TranslateWorkers: 1}
	tools := &ToolsPaths{TempDir: tempDir}

	trans := &modeAwareTranslator{mode: "local_ai"}
	p := NewPipeline(dummyVideo, 300.0, settings, tools, bs, trans, PipelineEventCallbacks{})
	_ = p.Start(0)
	defer p.Stop()

	targetBlock := 2 // [60.0s - 90.0s]

	p.mu.Lock()
	oldSessionID := p.session.id
	p.activeJobs[targetBlock] = true
	p.tier2Deferred[targetBlock] = false
	p.mu.Unlock()

	// Tua trong cùng block 2 nhưng đang ở local_ai
	p.doSeek(65.0)

	p.mu.Lock()
	newSessionID := p.session.id
	p.mu.Unlock()

	if newSessionID == oldSessionID {
		t.Fatalf("Lỗi: Ở mode local_ai, Fast-Path 2 không được phép kích hoạt để tránh nuốt Tier-1!")
	}
}

// Test_Pipeline_SmartFastPath2_Tier2Deferred_ForcesRestart kiểm tra:
// Khi ở mode "api", nhưng block đích đã từng bị hoãn Tier-2 (tier2Deferred[targetBlock] == true),
// hệ thống BẮT BUỘC phải tạo session mới để dịch bù toàn bộ câu còn thiếu.
func Test_Pipeline_SmartFastPath2_Tier2Deferred_ForcesRestart(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "video_tier2def_restart.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)

	bs, _ := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30, OverlapSec: 2})
	settings := Settings{BlockSec: 30, OverlapSec: 2, LookaheadMinSec: 30, LookaheadMaxSec: 60, TranslateWorkers: 1}
	tools := &ToolsPaths{TempDir: tempDir}

	trans := &modeAwareTranslator{mode: "api"}
	p := NewPipeline(dummyVideo, 300.0, settings, tools, bs, trans, PipelineEventCallbacks{})
	_ = p.Start(0)
	defer p.Stop()

	targetBlock := 2

	p.mu.Lock()
	oldSessionID := p.session.id
	p.activeJobs[targetBlock] = true
	p.tier2Deferred[targetBlock] = true // Đã bị hoãn Tier-2
	p.mu.Unlock()

	p.doSeek(65.0)

	p.mu.Lock()
	newSessionID := p.session.id
	p.mu.Unlock()

	if newSessionID == oldSessionID {
		t.Fatalf("Lỗi: Khi block đã bị tier2Deferred, không được dùng Fast-Path 2 mà phải tạo session mới để dịch bù!")
	}
}

// Test_Pipeline_WorkerTimeout_TriggersFailure kiểm tra:
// Khi RunCommand gặp timeout và trả về lỗi tiến trình timeout (trong khi session vẫn sống),
// worker phải kích hoạt handleBlockFailure, tăng failedBlocks và giải phóng activeJobs.
func Test_Pipeline_WorkerTimeout_TriggersFailure(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "video_timeout_real.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)

	bs, _ := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30, OverlapSec: 2})
	settings := Settings{BlockSec: 30, OverlapSec: 2, LookaheadMinSec: 30, LookaheadMaxSec: 60, TranslateWorkers: 1}
	tools := &ToolsPaths{TempDir: tempDir}

	var errCount int
	var errMu sync.Mutex
	callbacks := PipelineEventCallbacks{
		OnError: func(err PipelineError) {
			errMu.Lock()
			if err.Block == 0 {
				errCount++
			}
			errMu.Unlock()
		},
	}

	p := NewPipeline(dummyVideo, 300.0, settings, tools, bs, &MockTranslator{}, callbacks)
	p.MockSliceAudio = func(ctx context.Context, videoPath string, bRange BlockRange, outWav string) error {
		return fmt.Errorf("tiến trình ffmpeg.exe bị timeout sau 60s: timed out")
	}

	_ = p.Start(0)
	defer p.Stop()

	time.Sleep(100 * time.Millisecond)

	p.mu.Lock()
	failedCount := p.failedBlocks[0]
	isActive := p.activeJobs[0]
	p.mu.Unlock()

	errMu.Lock()
	ec := errCount
	errMu.Unlock()

	if failedCount < 1 {
		t.Errorf("Kỳ vọng block 0 bị ghi nhận thất bại (failedBlocks[0] >= 1), nhận: %d", failedCount)
	}
	if ec < 1 {
		t.Errorf("Kỳ vọng OnError được gọi ít nhất 1 lần, nhận: %d", ec)
	}
	if isActive {
		t.Errorf("Kỳ vọng block 0 không còn nằm trong activeJobs")
	}
}

// Test_Pipeline_RealFFmpeg_RapidSeek sử dụng ffmpeg thật (không mock slice):
// Sinh video mẫu và đo lường computeDrainMs và wgDrainMs thực tế khi tua dồn dập trong lúc ffmpeg thật đang chạy cắt âm thanh.
func Test_Pipeline_RealFFmpeg_RapidSeek(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	repoRoot, _ := os.Getwd()
	binDir := filepath.Join(repoRoot, "build", "bin")
	ffmpegPath := filepath.Join(binDir, "tools", "ffmpeg", "ffmpeg.exe")
	if _, err := os.Stat(ffmpegPath); os.IsNotExist(err) {
		t.Skip("ffmpeg.exe không tồn tại trong build/bin/tools/ffmpeg")
	}

	tempDir := t.TempDir()
	videoPath := filepath.Join(tempDir, "sample.mp4")
	genCmd := exec.Command(ffmpegPath, "-f", "lavfi", "-i", "sine=frequency=1000:duration=30", "-f", "lavfi", "-i", "testsrc=duration=30:size=320x240:rate=15", "-c:v", "libx264", "-c:a", "aac", "-shortest", "-y", videoPath)
	if err := genCmd.Run(); err != nil {
		t.Skipf("Không thể sinh video mẫu bằng ffmpeg: %v", err)
	}

	bs, _ := NewBlockStore(videoPath, CacheMeta{BlockSec: 10, OverlapSec: 1})
	settings := Settings{BlockSec: 10, OverlapSec: 1, LookaheadMinSec: 10, LookaheadMaxSec: 20, TranslateWorkers: 1}
	tools := &ToolsPaths{
		BaseDir: binDir,
		FFmpeg:  ffmpegPath,
		TempDir: tempDir,
	}

	p := NewPipeline(videoPath, 30.0, settings, tools, bs, &MockTranslator{}, PipelineEventCallbacks{})
	p.MockRunSTT = func(ctx context.Context, wavPath string, bRange BlockRange) ([]WhisperSegment, error) {
		return []WhisperSegment{
			{StartSec: bRange.OwnerStart + 0.5, EndSec: bRange.OwnerStart + 2.5, Text: "Test speech audio"},
		}, nil
	}

	_ = p.Start(0)
	time.Sleep(30 * time.Millisecond)

	// Bắn 10 cú tua liên tục trong lúc ffmpeg thật đang chạy cắt âm thanh
	for i := 0; i < 10; i++ {
		targetSec := float64((i + 1) * 2)
		p.doSeek(targetSec)
		computeDrain := p.LastSeekComputeDrain()
		wgDrain := p.LastSeekWgDrain()
		t.Logf("[Real FFmpeg RapidSeek #%02d] target=%.1fs | computeDrain=%dms | wgDrain=%dms",
			i+1, targetSec, computeDrain, wgDrain)
	}

	p.Stop()
}

// Test_Pipeline_Benchmark_ThreeSeekScenarios đo lường thời gian xử lý thực tế của 3 kịch bản tua:
// - Kịch bản 1: Tua vào đoạn đã có phụ đề (Fast-Path 1: IsBlockDone)
// - Kịch bản 2: Tua ngắn 5s trong cùng block đang chạy ở mode "api" (Smart Fast-Path 2)
// - Kịch bản 3: Tua nhảy xa sang block chưa xử lý (Slow-Path: hủy session cũ, drain, tạo session mới)
func Test_Pipeline_Benchmark_ThreeSeekScenarios(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "video_scenarios.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)

	bs, _ := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30, OverlapSec: 2, DurationSec: 300})
	settings := Settings{BlockSec: 30, OverlapSec: 2, LookaheadMinSec: 30, LookaheadMaxSec: 60, TranslateWorkers: 1}
	tools := &ToolsPaths{TempDir: tempDir}

	// Giả lập block 0 đã hoàn tất đầy đủ phụ đề trong kho
	_ = bs.SaveBlock(0, []SubtitleItem{
		{ID: 1, Block: 0, StartSec: 5.0, EndSec: 10.0, SourceText: "Hello", TargetText: "Xin chào", Translated: true},
		{ID: 2, Block: 0, StartSec: 15.0, EndSec: 20.0, SourceText: "World", TargetText: "Thế giới", Translated: true},
	})

	trans := &modeAwareTranslator{mode: "api"}
	p := NewPipeline(dummyVideo, 300.0, settings, tools, bs, trans, PipelineEventCallbacks{})
	_ = p.Start(0)
	defer p.Stop()

	// --- KỊCH BẢN 1: Tua vào đoạn đã có phụ đề (Fast-Path 1) ---
	t0 := time.Now()
	p.doSeek(12.0) // 12s thuộc block 0 đã hoàn tất
	durScenario1 := time.Since(t0)
	t.Logf("[Kịch bản 1 - Fast-Path 1 Cache Hit] Tua vào block 0 đã có sẵn phụ đề: %v (computeDrain=%dms, wgDrain=%dms)",
		durScenario1, p.LastSeekComputeDrain(), p.LastSeekWgDrain())

	// --- KỊCH BẢN 2: Tua ngắn 5s trong cùng block đang chạy (Smart Fast-Path 2) ---
	// Giả lập block 2 đang được worker xử lý ở mode api
	p.mu.Lock()
	targetBlock := 2 // [60s - 90s]
	p.activeJobs[targetBlock] = true
	p.tier2Deferred[targetBlock] = false
	p.mu.Unlock()

	t1 := time.Now()
	p.doSeek(65.0) // Tua tới 65s (trong block 2)
	durScenario2 := time.Since(t1)
	t.Logf("[Kịch bản 2 - Smart Fast-Path 2] Tua ngắn trong cùng block đang xử lý (mode api): %v (computeDrain=%dms, wgDrain=%dms)",
		durScenario2, p.LastSeekComputeDrain(), p.LastSeekWgDrain())

	// --- KỊCH BẢN 3: Tua nhảy xa sang block chưa xử lý (Slow-Path restart session) ---
	// Tua tới giây 240.0s (block 8) chưa có worker nào làm
	t2 := time.Now()
	p.doSeek(240.0)
	durScenario3 := time.Since(t2)
	t.Logf("[Kịch bản 3 - Slow-Path Tua xa] Tua nhảy cóc tới 240s (block 8 chưa có phụ đề): %v (computeDrain=%dms, wgDrain=%dms)",
		durScenario3, p.LastSeekComputeDrain(), p.LastSeekWgDrain())

	if durScenario1 > 10*time.Millisecond {
		t.Errorf("Kịch bản 1 phải hoàn tất tức thì (<10ms), đo được: %v", durScenario1)
	}
	if durScenario2 > 10*time.Millisecond {
		t.Errorf("Kịch bản 2 phải hoàn tất tức thì (<10ms), đo được: %v", durScenario2)
	}
}

type emptyResponseTranslator struct {
	mode string
}

func (m *emptyResponseTranslator) Translate(ctx context.Context, line string, prevContext []string) (string, error) {
	return "", nil
}

func (m *emptyResponseTranslator) TranslateBatch(ctx context.Context, lines []string) ([]string, error) {
	// Giả lập tầng dịch ở mode api/cloud trả về chuỗi rỗng
	res := make([]string, len(lines))
	for i := range res {
		res[i] = ""
	}
	return res, nil
}

func (m *emptyResponseTranslator) Close() error {
	return nil
}

func (m *emptyResponseTranslator) CurrentMode() string {
	return m.mode
}

// Test_BUG02_InfiniteLoop_WhenTranslateReturnsEmptyInAPIMode tái hiện lỗi BUG-02:
// Khi TranslateBatch trả về câu rỗng ở mode api, scheduler bị lặp vô tận vì okCount < hasTextCount
// không tăng failedBlocks và không set tier2Deferred.
func Test_BUG02_InfiniteLoop_WhenTranslateReturnsEmptyInAPIMode(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "dummy_bug02.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)

	bs, err := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30, OverlapSec: 2, DurationSec: 30})
	if err != nil {
		t.Fatalf("NewBlockStore error: %v", err)
	}

	settings := Settings{
		BlockSec:         30.0,
		OverlapSec:       2.0,
		LookaheadMinSec:  10.0,
		LookaheadMaxSec:  30.0,
		TranslateWorkers: 1,
	}
	tools := &ToolsPaths{TempDir: tempDir}
	trans := &emptyResponseTranslator{mode: "api"}

	p := NewPipeline(dummyVideo, 30.0, settings, tools, bs, trans, PipelineEventCallbacks{})

	var scheduleCount atomic.Int32
	p.MockSliceAudio = func(ctx context.Context, videoPath string, bRange BlockRange, outWav string) error {
		if bRange.Index == 0 {
			scheduleCount.Add(1)
		}
		return nil
	}
	p.MockRunSTT = func(ctx context.Context, wavPath string, bRange BlockRange) ([]WhisperSegment, error) {
		return []WhisperSegment{
			{StartSec: 1.0, EndSec: 3.0, Text: "This is a test line"},
		}, nil
	}

	_ = p.Start(0)
	defer p.Stop()

	// Chờ scheduler xử lý hoặc phát hiện lặp lại > 2 lần
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if scheduleCount.Load() > 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	count := scheduleCount.Load()
	if count > 2 {
		t.Fatalf("BUG-02 THẤT BẠI (ĐÃ TÁI HIỆN): Block 0 bị lặp vô tận, đã được scheduler chọn lại %d lần (> 2 lần)", count)
	}
	if bs.IsBlockDone(0) {
		t.Fatalf("Block 0 chưa dịch được câu nào thì IsBlockDone(0) phải là false để cho phép thử lại khi người dùng tua (Seek)")
	}
}

// computeProbeTranslator ghi lại thời điểm TranslateBatch được gọi đầu tiên.
type computeProbeTranslator struct {
	MockTranslator
	mode      string
	firstCall atomic.Int64 // UnixNano, 0 = chưa gọi
}

func (m *computeProbeTranslator) CurrentMode() string { return m.mode }
func (m *computeProbeTranslator) TranslateBatch(ctx context.Context, lines []string) ([]string, error) {
	m.firstCall.CompareAndSwap(0, time.Now().UnixNano())
	return m.MockTranslator.TranslateBatch(ctx, lines)
}

func newComputeProbePipeline(t *testing.T, mode string) (*Pipeline, *computeProbeTranslator) {
	t.Helper()
	t.Setenv("LOCALAPPDATA", t.TempDir())
	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "dummy_bug07.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)
	bs, err := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30, OverlapSec: 2, DurationSec: 30})
	if err != nil {
		t.Fatalf("NewBlockStore error: %v", err)
	}
	settings := Settings{BlockSec: 30.0, OverlapSec: 2.0, LookaheadMinSec: 10.0, LookaheadMaxSec: 30.0, TranslateWorkers: 1}
	trans := &computeProbeTranslator{mode: mode}
	p := NewPipeline(dummyVideo, 30.0, settings, &ToolsPaths{TempDir: tempDir}, bs, trans, PipelineEventCallbacks{})
	p.MockSliceAudio = func(ctx context.Context, videoPath string, bRange BlockRange, outWav string) error { return nil }
	p.MockRunSTT = func(ctx context.Context, wavPath string, bRange BlockRange) ([]WhisperSegment, error) {
		return []WhisperSegment{{StartSec: 1.0, EndSec: 3.0, Text: "This is a test line"}}, nil
	}
	return p, trans
}

// BUG-07: ở chế độ local_ai, TranslateBatch phải chờ Whisper nhả computeMu.
func Test_BUG07_LocalAI_TranslateWaitsForWhisperComputeMu(t *testing.T) {
	p, trans := newComputeProbePipeline(t, "local_ai")
	p.computeMu.Lock() // giả lập Whisper đang chạy
	_ = p.Start(0)
	defer p.Stop()

	time.Sleep(300 * time.Millisecond)
	released := time.Now()
	if c := trans.firstCall.Load(); c != 0 {
		t.Fatalf("BUG-07: local LLM chạy song song với Whisper (gọi sau %dms khi Whisper còn giữ computeMu)", (c-released.Add(-300*time.Millisecond).UnixNano())/1e6)
	}
	p.computeMu.Unlock()

	deadline := time.Now().Add(2 * time.Second)
	for trans.firstCall.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if trans.firstCall.Load() == 0 {
		t.Fatalf("TranslateBatch phải chạy sau khi computeMu được nhả")
	}
}

// Đối chứng: chế độ api không bị khóa bởi computeMu.
func Test_BUG07_ApiMode_NotBlockedByComputeMu(t *testing.T) {
	p, trans := newComputeProbePipeline(t, "api")
	p.computeMu.Lock()
	_ = p.Start(0)
	defer p.Stop()
	defer p.computeMu.Unlock() // chạy trước Stop (LIFO) để Stop không chờ hết 3s drain

	deadline := time.Now().Add(2 * time.Second)
	for trans.firstCall.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if trans.firstCall.Load() == 0 {
		t.Fatalf("chế độ api không được phụ thuộc computeMu")
	}
}

// Hủy session (tua video) khi worker dịch đang chờ computeMu: worker phải thoát dù khóa vẫn bị giữ.
func Test_BUG07_LocalAI_CancelWhileWaitingForComputeMu_WorkerExits(t *testing.T) {
	p, trans := newComputeProbePipeline(t, "local_ai")
	p.computeMu.Lock()
	defer p.computeMu.Unlock()
	_ = p.Start(0)
	time.Sleep(150 * time.Millisecond)
	if trans.firstCall.Load() != 0 {
		t.Fatalf("worker lẽ ra phải đang chờ computeMu")
	}

	p.mu.Lock()
	sess := p.session
	p.mu.Unlock()
	sess.cancel()

	exited := make(chan struct{})
	go func() { sess.wg.Wait(); close(exited) }()
	select {
	case <-exited:
	case <-time.After(2 * time.Second):
		t.Fatalf("translatorWorker không thoát sau khi session bị hủy (kẹt chờ computeMu)")
	}
}

func Test_BUG09_PickUrgentBatch(t *testing.T) {
	items := make([]SubtitleItem, 0, 10)
	for i := 0; i < 10; i++ {
		items = append(items, SubtitleItem{StartSec: float64(i) * 10, EndSec: float64(i)*10 + 8})
	}
	batches := [][]int{{0, 1}, {2, 3}, {4, 5}, {8, 9}}
	// playhead 82s -> vùng [81, 97] chỉ chạm item 8 (80-88) và 9 (90-98) -> batch số 3
	if k := pickUrgentBatch(items, batches, 1, 82.0); k != 3 {
		t.Fatalf("kỳ vọng batch 3, nhận %d", k)
	}
	// batch hiện tại đã là batch cần gấp -> trả về chính nó
	if k := pickUrgentBatch(items, batches, 3, 82.0); k != 3 {
		t.Fatalf("kỳ vọng 3, nhận %d", k)
	}
	// không có câu nào trong vùng
	if k := pickUrgentBatch(items, batches, 0, 500.0); k != -1 {
		t.Fatalf("kỳ vọng -1, nhận %d", k)
	}
}

// orderRecordingTranslator ghi lại thứ tự các batch được dịch và gọi hook trước mỗi batch.
type orderRecordingTranslator struct {
	MockTranslator
	mu     sync.Mutex
	calls  [][]string
	onCall func(n int)
}

func (m *orderRecordingTranslator) CurrentMode() string { return "api" }
func (m *orderRecordingTranslator) TranslateBatch(ctx context.Context, lines []string) ([]string, error) {
	m.mu.Lock()
	m.calls = append(m.calls, append([]string(nil), lines...))
	n := len(m.calls)
	m.mu.Unlock()
	if m.onCall != nil {
		m.onCall(n)
	}
	return m.MockTranslator.TranslateBatch(ctx, lines)
}

// BUG-09: tua ngắn trong block đang dịch -> batch Tier-2 chứa câu tại playhead mới phải được dịch trước.
func Test_BUG09_ShortSeekReprioritizesTier2Batch(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "dummy_bug09.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)
	bs, err := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30, OverlapSec: 2, DurationSec: 30})
	if err != nil {
		t.Fatalf("NewBlockStore error: %v", err)
	}
	settings := Settings{BlockSec: 30.0, OverlapSec: 2.0, LookaheadMinSec: 10.0, LookaheadMaxSec: 30.0, TranslateWorkers: 1}

	var p *Pipeline
	trans := &orderRecordingTranslator{}
	p = NewPipeline(dummyVideo, 30.0, settings, &ToolsPaths{TempDir: tempDir}, bs, trans, PipelineEventCallbacks{})
	p.MockSliceAudio = func(ctx context.Context, videoPath string, bRange BlockRange, outWav string) error { return nil }
	p.MockRunSTT = func(ctx context.Context, wavPath string, bRange BlockRange) ([]WhisperSegment, error) {
		segs := make([]WhisperSegment, 0, 15)
		for i := 0; i < 15; i++ {
			segs = append(segs, WhisperSegment{StartSec: float64(i) * 2, EndSec: float64(i)*2 + 1.5, Text: fmt.Sprintf("Sentence number %02d.", i*2)})
		}
		return segs, nil
	}
	// Tier-1 = các câu <= 15s (3 batch). Khi batch Tier-1 cuối cùng được dịch, người dùng tua tới 28s.
	trans.onCall = func(n int) {
		if n == 3 {
			p.mu.Lock()
			p.playheadSec = 28.0
			p.mu.Unlock()
		}
	}

	_ = p.Start(0)
	defer p.Stop()

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		trans.mu.Lock()
		n := len(trans.calls)
		trans.mu.Unlock()
		if n >= 5 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	trans.mu.Lock()
	defer trans.mu.Unlock()
	if len(trans.calls) < 4 {
		t.Fatalf("chưa đủ batch: %v", trans.calls)
	}
	first := trans.calls[3] // batch Tier-2 đầu tiên
	found := false
	for _, l := range first {
		if l == "Sentence number 28." {
			found = true
		}
	}
	t.Logf("batch Tier-2 đầu tiên: %v", first)
	if !found {
		t.Fatalf("BUG-09: batch Tier-2 đầu tiên %v không chứa câu tại playhead mới (Sentence number 28.)", first)
	}
}

// BUG-03: block đã có STT trong BlockStore -> không cắt WAV, không chạy Whisper, chỉ dịch câu còn thiếu.
func Test_BUG03_ReusesStoredSTT_NoSliceNoWhisper_OnlyTranslatesMissing(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "dummy_bug03.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)
	bs, err := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30, OverlapSec: 2, DurationSec: 30})
	if err != nil {
		t.Fatalf("NewBlockStore error: %v", err)
	}
	// Lần chạy trước: STT xong, Tier-1 dịch dở (câu 1 đã dịch, câu 2-3 chưa)
	_ = bs.SaveBlock(0, []SubtitleItem{
		{ID: 0, Block: 0, StartSec: 1, EndSec: 3, SourceText: "First line.", TargetText: "Dòng một.", Translated: true},
		{ID: 1, Block: 0, StartSec: 4, EndSec: 6, SourceText: "Second line.", Translated: false},
		{ID: 2, Block: 0, StartSec: 7, EndSec: 9, SourceText: "Third line.", Translated: false},
	})

	settings := Settings{BlockSec: 30.0, OverlapSec: 2.0, LookaheadMinSec: 10.0, LookaheadMaxSec: 30.0, TranslateWorkers: 1}
	trans := &orderRecordingTranslator{}
	p := NewPipeline(dummyVideo, 30.0, settings, &ToolsPaths{TempDir: tempDir}, bs, trans, PipelineEventCallbacks{})

	var sliceCalls, sttCalls atomic.Int32
	p.MockSliceAudio = func(ctx context.Context, videoPath string, bRange BlockRange, outWav string) error {
		sliceCalls.Add(1)
		return nil
	}
	p.MockRunSTT = func(ctx context.Context, wavPath string, bRange BlockRange) ([]WhisperSegment, error) {
		sttCalls.Add(1)
		return []WhisperSegment{{StartSec: 1, EndSec: 3, Text: "First line."}}, nil
	}

	_ = p.Start(0)
	defer p.Stop()

	deadline := time.Now().Add(2 * time.Second)
	for !bs.IsBlockDone(0) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !bs.IsBlockDone(0) {
		t.Fatalf("block 0 phải hoàn tất")
	}

	trans.mu.Lock()
	var translated []string
	for _, c := range trans.calls {
		translated = append(translated, c...)
	}
	trans.mu.Unlock()
	t.Logf("ffmpeg=%d whisper=%d, câu gửi đi dịch=%v", sliceCalls.Load(), sttCalls.Load(), translated)

	if sliceCalls.Load() != 0 || sttCalls.Load() != 0 {
		t.Fatalf("BUG-03: không được chạy lại ffmpeg/Whisper (slice=%d, stt=%d)", sliceCalls.Load(), sttCalls.Load())
	}
	if len(translated) != 2 {
		t.Fatalf("chỉ 2 câu chưa dịch được gửi đi, nhận: %v", translated)
	}
	items, _ := bs.GetBlockItems(0)
	if len(items) != 3 || items[0].TargetText != "Dòng một." || !items[1].Translated || !items[2].Translated {
		t.Fatalf("kết quả cuối không đúng: %+v", items)
	}
}

func Test_BUG12_ShouldParseWhisperTimings(t *testing.T) {
	t.Setenv("VT_TELEMETRY", "")
	if !shouldParseWhisperTimings("auto") {
		t.Fatalf("-l auto cần parse để lấy ngôn ngữ cho detect-once")
	}
	for _, l := range []string{"en", "vi", "ja"} {
		if shouldParseWhisperTimings(l) {
			t.Fatalf("ngôn ngữ cố định %q + telemetry tắt thì không cần parse", l)
		}
	}
	t.Setenv("VT_TELEMETRY", "1")
	if !shouldParseWhisperTimings("en") {
		t.Fatalf("bật telemetry thì luôn phải parse")
	}
}
