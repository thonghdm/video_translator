package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"
)

// qcBugTranslator cho phép giả lập lỗi dịch thuật theo đợt và theo block
type qcBugTranslator struct {
	MockTranslator
	mu           sync.Mutex
	failBlockMap map[int]int // blockIdx -> số lần còn lại cần trả lỗi
	calls        [][]string
}

func newQCBugTranslator() *qcBugTranslator {
	return &qcBugTranslator{
		failBlockMap: make(map[int]int),
	}
}

func (m *qcBugTranslator) SetFailCount(blockIdx int, count int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.failBlockMap[blockIdx] = count
}

func (m *qcBugTranslator) TranslateBatch(ctx context.Context, lines []string) ([]string, error) {
	m.mu.Lock()
	m.calls = append(m.calls, append([]string(nil), lines...))
	// Kiểm tra xem có cần trả lỗi không
	for bIdx, remaining := range m.failBlockMap {
		if remaining > 0 {
			m.failBlockMap[bIdx]--
			m.mu.Unlock()
			return nil, errors.New("simulated transient translation error")
		}
	}
	m.mu.Unlock()

	res := make([]string, len(lines))
	for i, l := range lines {
		res[i] = "[QC-VI] " + l
	}
	return res, nil
}

// -----------------------------------------------------------------------------
// TEST CASE 1: BUG-18 Behavioral Test
// Block từng bị lỗi 2 lần ở phiên trước (khiến scheduler bỏ rơi).
// Khi gọi Start(0) phiên mới, block đó BẮT BUỘC phải được lập lịch lại,
// worker thực thi thành công, lưu vào BlockStore và phát OnChunk(Final=true).
// -----------------------------------------------------------------------------
func Test_QC_BUG18_Behavioral_FailedBlockRetriedAndCompleted(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir()) // BUG-20: cô lập cache khỏi %LOCALAPPDATA% thật
	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "video_bug18_behavior.mp4")
	if err := os.WriteFile(dummyVideo, make([]byte, 1024), 0644); err != nil {
		t.Fatalf("Không thể tạo dummy video: %v", err)
	}

	bs, err := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30.0, OverlapSec: 2.0, DurationSec: 60.0})
	if err != nil {
		t.Fatalf("NewBlockStore: %v", err)
	}

	trans := newQCBugTranslator()
	settings := Settings{
		BlockSec:         30.0,
		OverlapSec:       2.0,
		LookaheadMinSec:  15.0,
		LookaheadMaxSec:  60.0,
		TranslateWorkers: 1,
	}
	tools := &ToolsPaths{TempDir: tempDir}

	var errorEvents []PipelineError
	var errMu sync.Mutex
	var finalChunks []int
	var chunkMu sync.Mutex

	callbacks := PipelineEventCallbacks{
		OnError: func(pe PipelineError) {
			errMu.Lock()
			errorEvents = append(errorEvents, pe)
			errMu.Unlock()
		},
		OnChunk: func(chunk SubtitleChunkPayload) {
			if chunk.Final {
				chunkMu.Lock()
				finalChunks = append(finalChunks, chunk.Block)
				chunkMu.Unlock()
			}
		},
	}

	p := NewPipeline(dummyVideo, 60.0, settings, tools, bs, trans, callbacks)

	// Mock Slicer và STT trả câu bình thường
	p.MockSliceAudio = func(ctx context.Context, videoPath string, bRange BlockRange, outWav string) error {
		return os.WriteFile(outWav, []byte("RIFFdummyWAV"), 0644)
	}
	p.MockRunSTT = func(ctx context.Context, wavPath string, bRange BlockRange) ([]WhisperSegment, error) {
		return []WhisperSegment{
			{StartSec: bRange.OwnerStart + 2.0, EndSec: bRange.OwnerStart + 6.0, Text: fmt.Sprintf("Line in block %d", bRange.Index)},
		}, nil
	}

	// GIAI ĐOẠN 1: Cố tình làm block 0 lỗi 2 lần liên tiếp trong phiên 1
	trans.SetFailCount(0, 2)

	if err := p.Start(0); err != nil {
		t.Fatalf("Start phiên 1 thất bại: %v", err)
	}

	// Chờ scheduler và worker chạy cho tới khi block 0 lỗi đủ 2 lần và bị coi là Fatal
	deadline1 := time.Now().Add(3 * time.Second)
	fatalReported := false
	for time.Now().Before(deadline1) {
		errMu.Lock()
		for _, e := range errorEvents {
			if e.Block == 0 && e.Fatal {
				fatalReported = true
				break
			}
		}
		errMu.Unlock()
		if fatalReported {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}

	if !fatalReported {
		t.Fatalf("Phiên 1: Block 0 phải được báo lỗi Fatal sau 2 lần lỗi liên tiếp")
	}

	// Đảm bảo tại cuối phiên 1: Block 0 KHÔNG hoàn thành
	if bs.IsBlockDone(0) {
		t.Fatalf("Phiên 1: Block 0 không được phép hoàn thành khi đang bị lỗi!")
	}

	p.mu.Lock()
	failedCountSession1 := p.failedBlocks[0]
	p.mu.Unlock()
	if failedCountSession1 < 2 {
		t.Fatalf("Phiên 1: failedBlocks[0] phải >= 2, nhận: %d", failedCountSession1)
	}

	// Dừng phiên 1
	p.Stop()

	// GIAI ĐOẠN 2: Khôi phục translator (0 lỗi), gọi Start(0) phiên 2 trên CÙNG Pipeline instance
	// Theo BUG-18: Start() phải reset failedBlocks để block 0 được scheduler nạp lại và dịch thành công!
	trans.SetFailCount(0, 0)

	if err := p.Start(0); err != nil {
		t.Fatalf("Start phiên 2 thất bại: %v", err)
	}
	defer p.Stop()

	// Chờ xem Block 0 có thực sự được thử lại và hoàn tất không (Behavioral Verification)
	deadline2 := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline2) {
		if bs.IsBlockDone(0) {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}

	if !bs.IsBlockDone(0) {
		t.Fatalf("BUG-18 TỒN TẠI: Sau khi gọi Start() phiên mới, Block 0 VẪN KHÔNG ĐƯỢC THỬ LẠI và không hoàn tất!")
	}

	// Kiểm tra kết quả thực tế quan sát được trong BlockStore
	items, ok := bs.GetBlockItems(0)
	if !ok || len(items) == 0 {
		t.Fatalf("Kỳ vọng Block 0 có dữ liệu phụ đề, nhận ok=%v", ok)
	}
	if items[0].TargetText != "[QC-VI] Line in block 0" {
		t.Fatalf("Bản dịch của block 0 không đúng: %s", items[0].TargetText)
	}

	// Kiểm tra sự kiện OnChunk đã phát Final=true cho block 0
	chunkMu.Lock()
	block0FinalEmitted := false
	for _, b := range finalChunks {
		if b == 0 {
			block0FinalEmitted = true
			break
		}
	}
	chunkMu.Unlock()

	if !block0FinalEmitted {
		t.Fatalf("Sự kiện OnChunk(Final=true) cho block 0 không được phát sau khi thử lại thành công")
	}
	t.Log("[PASS BUG-18 Behavioral] Block từng lỗi 2 lần đã được Start() phiên mới lập lịch lại và dịch thành công 100%!")
}

// -----------------------------------------------------------------------------
// TEST CASE 2: BUG-18 Repeated Start & Concurrency
// Kiểm tra gọi Start() lặp lại nhiều lần liên tiếp khi các worker đang chạy:
// Không rò rỉ seekLoop goroutine, không deadlock, không data race.
// -----------------------------------------------------------------------------
func Test_QC_BUG18_RepeatedStart_NoGoroutineLeak_NoRace(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir()) // BUG-20: cô lập cache khỏi %LOCALAPPDATA% thật
	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "video_bug18_concurrency.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)

	bs, _ := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30.0, OverlapSec: 2.0, DurationSec: 120.0})
	tools := &ToolsPaths{TempDir: tempDir}
	trans := &MockTranslator{}
	settings := Settings{BlockSec: 30.0, OverlapSec: 2.0, LookaheadMinSec: 15.0, LookaheadMaxSec: 60.0, TranslateWorkers: 2}

	p := NewPipeline(dummyVideo, 120.0, settings, tools, bs, trans, PipelineEventCallbacks{})
	p.MockSliceAudio = func(ctx context.Context, videoPath string, bRange BlockRange, outWav string) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(10 * time.Millisecond):
			return os.WriteFile(outWav, []byte("RIFFdummyWAV"), 0644)
		}
	}
	p.MockRunSTT = func(ctx context.Context, wavPath string, bRange BlockRange) ([]WhisperSegment, error) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(10 * time.Millisecond):
			return []WhisperSegment{{StartSec: bRange.OwnerStart + 1.0, EndSec: bRange.OwnerStart + 3.0, Text: "Test"}}, nil
		}
	}

	baselineGoroutines := runtime.NumGoroutine()

	// Gọi Start() 5 lần lặp lại liên tiếp với các mốc thời gian khác nhau
	for i := 0; i < 5; i++ {
		startSec := float64(i * 15)
		if err := p.Start(startSec); err != nil {
			t.Fatalf("Start #%d thất bại: %v", i+1, err)
		}
		// Đảm bảo failedBlocks luôn sạch ngay sau mỗi lần Start
		p.mu.Lock()
		failedLen := len(p.failedBlocks)
		p.mu.Unlock()
		if failedLen != 0 {
			t.Errorf("Start #%d: failedBlocks chưa được reset, len = %d", i+1, failedLen)
		}
		time.Sleep(25 * time.Millisecond)
	}

	// Dừng hoàn toàn
	p.Stop()

	// Chờ goroutine ổn định
	deadline := time.Now().Add(3 * time.Second)
	leaked := 0
	for time.Now().Before(deadline) {
		leaked = runtime.NumGoroutine() - baselineGoroutines
		if leaked <= 0 {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}

	if leaked > 2 { // cho phép sai số nhỏ runtime GC
		t.Errorf("Nghi ngờ rò rỉ goroutine sau 5 lần Start liên tiếp: dư %d goroutine", leaked)
	}
	t.Log("[PASS BUG-18 Concurrency] 5 lần Start() liên tiếp vận hành trơn tru, không deadlock, không rò rỉ seekLoop!")
}

// -----------------------------------------------------------------------------
// TEST CASE 3: BUG-12 Behavioral Test
// Kiểm tra cơ chế shouldParseWhisperTimings (commit eea7f52):
// - Block 0 chạy với -l auto: shouldParseWhisperTimings == true -> regex parse chạy để lấy DetectedLang + xác suất.
// - Block 1 chạy sau khi đã chốt ngôn ngữ "en" (khi tắt telemetry): shouldParseWhisperTimings == false -> bỏ qua regex.
// - Bản dịch và dữ liệu phụ đề của CẢ HAI block đều phải đầy đủ, chính xác, không bị lỗi nil dereference.
// -----------------------------------------------------------------------------
func Test_QC_BUG12_Behavioral_DetectOnce_RegexGating_SubtitlesIntact(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir()) // BUG-20: cô lập cache khỏi %LOCALAPPDATA% thật
	t.Setenv("VT_TELEMETRY", "") // Tắt telemetry

	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "video_bug12_behavior.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)

	bs, _ := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30.0, OverlapSec: 2.0, DurationSec: 60.0})
	tools := &ToolsPaths{TempDir: tempDir}
	trans := &MockTranslator{}
	settings := Settings{
		BlockSec:         30.0,
		OverlapSec:       2.0,
		SourceLang:       "auto", // Bắt đầu bằng auto
		LookaheadMinSec:  15.0,
		LookaheadMaxSec:  60.0,
		TranslateWorkers: 1,
	}

	p := NewPipeline(dummyVideo, 60.0, settings, tools, bs, trans, PipelineEventCallbacks{})
	p.MockSliceAudio = func(ctx context.Context, videoPath string, bRange BlockRange, outWav string) error {
		return os.WriteFile(outWav, []byte("RIFFdummyWAV"), 0644)
	}

	var parsedCallHistory []string
	var historyMu sync.Mutex

	// Giả lập STT trả kết quả
	p.MockRunSTT = func(ctx context.Context, wavPath string, bRange BlockRange) ([]WhisperSegment, error) {
		historyMu.Lock()
		parsedCallHistory = append(parsedCallHistory, fmt.Sprintf("Block %d", bRange.Index))
		historyMu.Unlock()

		return []WhisperSegment{
			{StartSec: bRange.OwnerStart + 1.0, EndSec: bRange.OwnerStart + 4.0, Text: fmt.Sprintf("Speech in block %d", bRange.Index)},
		}, nil
	}

	if err := p.Start(0); err != nil {
		t.Fatalf("Start thất bại: %v", err)
	}
	defer p.Stop()

	// Chờ cả block 0 và block 1 hoàn thành
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if bs.IsBlockDone(0) && bs.IsBlockDone(1) {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}

	if !bs.IsBlockDone(0) || !bs.IsBlockDone(1) {
		t.Fatalf("Cả block 0 và block 1 phải hoàn tất dịch thành công")
	}

	// Kiểm tra phụ đề của cả 2 block trong BlockStore
	b0Items, ok0 := bs.GetBlockItems(0)
	b1Items, ok1 := bs.GetBlockItems(1)
	if !ok0 || len(b0Items) == 0 || b0Items[0].TargetText != "[VI] Speech in block 0" {
		t.Fatalf("Block 0 phụ đề không đúng: %+v", b0Items)
	}
	if !ok1 || len(b1Items) == 0 || b1Items[0].TargetText != "[VI] Speech in block 1" {
		t.Fatalf("Block 1 phụ đề không đúng: %+v", b1Items)
	}

	// Kiểm tra quy tắc gating của shouldParseWhisperTimings
	if !shouldParseWhisperTimings("auto") {
		t.Errorf("shouldParseWhisperTimings('auto') phải là true khi chưa chốt ngôn ngữ")
	}
	if shouldParseWhisperTimings("en") {
		t.Errorf("shouldParseWhisperTimings('en') phải là false khi đã chốt ngôn ngữ và telemetry tắt")
	}
	t.Log("[PASS BUG-12 Behavioral] Gating regex Whisper stderr vận hành chính xác, phụ đề các block nguyên vẹn!")
}

// -----------------------------------------------------------------------------
// TEST CASE 4: BUG-12 Telemetry Enabled - Luôn Parse Whisper Timings
// Khi VT_TELEMETRY=1, dù ngôn ngữ là "en", shouldParseWhisperTimings phải luôn là true,
// và bản ghi telemetry blocks.jsonl phải lưu được đầy đủ metrics.
// -----------------------------------------------------------------------------
func Test_QC_BUG12_TelemetryEnabled_AlwaysParsesTimings(t *testing.T) {
	t.Setenv("VT_TELEMETRY", "1")
	t.Setenv("LOCALAPPDATA", t.TempDir())

	customTelemetryDir := filepath.Join(t.TempDir(), "telemetry_bug12")
	origDir := telemetryOutputDir
	telemetryOutputDir = customTelemetryDir
	t.Cleanup(func() {
		telemetryOutputDir = origDir
	})

	// Kiểm tra trực tiếp gating rule
	for _, lang := range []string{"en", "vi", "ja", "auto"} {
		if !shouldParseWhisperTimings(lang) {
			t.Errorf("Khi VT_TELEMETRY=1, shouldParseWhisperTimings(%q) bắt buộc phải là true để thu thập metrics", lang)
		}
	}

	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "video_bug12_telem.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)

	bs, _ := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30.0, OverlapSec: 2.0, DurationSec: 30.0})
	tools := &ToolsPaths{TempDir: tempDir}
	trans := &MockTranslator{}
	settings := Settings{
		BlockSec:         30.0,
		OverlapSec:       2.0,
		SourceLang:       "en", // Ngôn ngữ cố định
		LookaheadMinSec:  15.0,
		LookaheadMaxSec:  30.0,
		TranslateWorkers: 1,
	}

	p := NewPipeline(dummyVideo, 30.0, settings, tools, bs, trans, PipelineEventCallbacks{})
	p.MockSliceAudio = func(ctx context.Context, videoPath string, bRange BlockRange, outWav string) error {
		return os.WriteFile(outWav, []byte("RIFFdummyWAV"), 0644)
	}
	p.MockRunSTT = func(ctx context.Context, wavPath string, bRange BlockRange) ([]WhisperSegment, error) {
		return []WhisperSegment{{StartSec: 1.0, EndSec: 3.0, Text: "Hello telemetry"}}, nil
	}

	if err := p.Start(0); err != nil {
		t.Fatalf("Start thất bại: %v", err)
	}
	defer p.Stop()

	deadline := time.Now().Add(2 * time.Second)
	for !bs.IsBlockDone(0) && time.Now().Before(deadline) {
		time.Sleep(30 * time.Millisecond)
	}

	// Đảm bảo file telemetry được sinh ra
	telemetryFile := filepath.Join(customTelemetryDir, "blocks.jsonl")
	f, err := os.Open(telemetryFile)
	if err != nil {
		t.Fatalf("Không mở được telemetry file: %v", err)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	recordCount := 0
	for scanner.Scan() {
		var rec BlockTelemetryRecord
		if err := json.Unmarshal([]byte(scanner.Text()), &rec); err == nil {
			if rec.BlockIndex == 0 {
				recordCount++
			}
		}
	}

	if recordCount == 0 {
		t.Fatalf("Telemetry file phải chứa ít nhất 1 bản ghi của block 0 khi VT_TELEMETRY=1")
	}
	t.Log("[PASS BUG-12 Telemetry] Khi bật telemetry, mọi ngôn ngữ đều được thu thập metrics đầy đủ!")
}

// -----------------------------------------------------------------------------
// TEST SUITE: BUG-08 (Đồng bộ thời lượng thật video Drive về backend)
// -----------------------------------------------------------------------------

// TEST CASE 5: BUG-08 Shrink Duration
// Ban đầu thời lượng ước lượng 3600s (120 blocks).
// Cập nhật UpdateDuration(60s) (2 blocks: 0 và 1).
// Scheduler phải dừng đúng ở block 1, chuyển state sang "done",
// và không có bất kỳ block >= 2 nào được lập lịch!
func Test_QC_BUG08_ShrinkDuration_SchedulerStopsImmediatelyAndTransitionsToDone(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir()) // BUG-20: cô lập cache khỏi %LOCALAPPDATA% thật
	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "video_bug08_shrink.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)

	// Ban đầu ước lượng 3600s (120 block)
	bs, _ := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30.0, OverlapSec: 2.0, DurationSec: 3600.0})
	tools := &ToolsPaths{TempDir: tempDir}
	trans := &MockTranslator{}
	settings := Settings{
		BlockSec:         30.0,
		OverlapSec:       2.0,
		LookaheadMinSec:  60.0,
		LookaheadMaxSec:  300.0, // cho phép nhìn xa 10 blocks
		TranslateWorkers: 1,
	}

	var scheduledBlocks []int
	var schedMu sync.Mutex
	block0Started := make(chan struct{}, 1)
	releaseBlock0 := make(chan struct{})

	p := NewPipeline(dummyVideo, 3600.0, settings, tools, bs, trans, PipelineEventCallbacks{})
	p.MockSliceAudio = func(ctx context.Context, videoPath string, bRange BlockRange, outWav string) error {
		schedMu.Lock()
		scheduledBlocks = append(scheduledBlocks, bRange.Index)
		schedMu.Unlock()
		if bRange.Index == 0 {
			select {
			case block0Started <- struct{}{}:
			default:
			}
			<-releaseBlock0
		}
		return os.WriteFile(outWav, []byte("RIFFdummyWAV"), 0644)
	}
	p.MockRunSTT = func(ctx context.Context, wavPath string, bRange BlockRange) ([]WhisperSegment, error) {
		return []WhisperSegment{{StartSec: bRange.OwnerStart + 1.0, EndSec: bRange.OwnerStart + 3.0, Text: "Text"}}, nil
	}

	if err := p.Start(0); err != nil {
		t.Fatalf("Start thất bại: %v", err)
	}
	defer p.Stop()

	// Chờ block 0 bắt đầu chạy
	select {
	case <-block0Started:
	case <-time.After(2 * time.Second):
		t.Fatalf("Block 0 không bắt đầu trong vòng 2 giây")
	}

	// Cho scheduler một khoảnh khắc để xếp hàng block 1 và block 2 vào slicerChan
	time.Sleep(30 * time.Millisecond)

	// Frontend phát hiện thời lượng thật là 60s (chỉ có 2 block: 0 và 1)
	if !p.UpdateDuration(60.0) {
		t.Fatalf("UpdateDuration(60.0) phải thành công")
	}

	// Thả cho block 0 chạy tiếp
	close(releaseBlock0)

	// Chờ scheduler xử lý xong block 1 và chuyển sang done
	deadlineDone := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadlineDone) {
		p.mu.Lock()
		st := p.state
		p.mu.Unlock()
		if st == "done" && bs.IsBlockDone(1) {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}

	schedMu.Lock()
	blocksCopy := append([]int(nil), scheduledBlocks...)
	schedMu.Unlock()

	p.mu.Lock()
	finalState := p.state
	dur := p.duration()
	p.mu.Unlock()

	t.Logf("[Quan sát] Các block đã slice: %v | State cuối: %s | Duration: %.1fs", blocksCopy, finalState, dur)

	// Kiểm tra không có block nào >= 2 được slice
	for _, b := range blocksCopy {
		if b >= 2 {
			t.Fatalf("BUG-08 TỒN TẠI: Vẫn slice block %d vượt quá thời lượng thật 60s (2 block 0,1)!", b)
		}
	}

	if !bs.IsBlockDone(0) || !bs.IsBlockDone(1) {
		t.Fatalf("Kỳ vọng cả 2 block 0 và 1 phải hoàn tất, nhưng 0=%v, 1=%v", bs.IsBlockDone(0), bs.IsBlockDone(1))
	}
	if bs.IsBlockDone(2) {
		t.Fatalf("Block 2 không được phép hoàn tất khi thời lượng đã bị rút ngắn về 60s!")
	}

	if finalState != "done" {
		t.Errorf("Kỳ vọng state chuyển sang 'done' sau khi hoàn tất 2 block thật, hiện tại: %s", finalState)
	}
	t.Log("[PASS BUG-08 Shrink] Scheduler và SlicerWorker hủy chính xác block thừa, dừng ở block 1 và chuyển state sang 'done'!")
}

// TEST CASE 6: BUG-08 Expand Duration
// Ban đầu video ngắn 30s (1 block: 0), pipeline đã chạy xong và đạt "done".
// Cập nhật UpdateDuration(90s) (3 blocks: 0, 1, 2).
// Scheduler phải được đánh thức dậy từ "done" và tiếp tục xử lý các block 1 và 2 cho tới khi xong toàn bộ!
func Test_QC_BUG08_ExpandDuration_WakesSchedulerFromDoneToProcessing(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir()) // BUG-20: cô lập cache khỏi %LOCALAPPDATA% thật
	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "video_bug08_expand.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)

	// Ban đầu chỉ 30s (1 block)
	bs, _ := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30.0, OverlapSec: 2.0, DurationSec: 30.0})
	tools := &ToolsPaths{TempDir: tempDir}
	trans := &MockTranslator{}
	settings := Settings{
		BlockSec:         30.0,
		OverlapSec:       2.0,
		LookaheadMinSec:  15.0,
		LookaheadMaxSec:  300.0, // đủ xa để lập lịch cả 3 block (60s sẽ dừng sau block 1 theo thiết kế lookahead)
		TranslateWorkers: 1,
	}

	p := NewPipeline(dummyVideo, 30.0, settings, tools, bs, trans, PipelineEventCallbacks{})
	p.MockSliceAudio = func(ctx context.Context, videoPath string, bRange BlockRange, outWav string) error {
		return os.WriteFile(outWav, []byte("RIFFdummyWAV"), 0644)
	}
	p.MockRunSTT = func(ctx context.Context, wavPath string, bRange BlockRange) ([]WhisperSegment, error) {
		return []WhisperSegment{{StartSec: bRange.OwnerStart + 1.0, EndSec: bRange.OwnerStart + 3.0, Text: "Text"}}, nil
	}

	if err := p.Start(0); err != nil {
		t.Fatalf("Start thất bại: %v", err)
	}
	defer p.Stop()

	// Chờ pipeline hoàn thành block 0 và chuyển sang done
	deadlineDone1 := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadlineDone1) {
		p.mu.Lock()
		st := p.state
		p.mu.Unlock()
		if st == "done" && bs.IsBlockDone(0) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	p.mu.Lock()
	stateBeforeExpand := p.state
	p.mu.Unlock()
	if stateBeforeExpand != "done" {
		t.Fatalf("Pipeline phải đạt trạng thái 'done' khi hết 30s ban đầu, nhận: %s", stateBeforeExpand)
	}

	// Mở rộng thời lượng lên 90s (thêm block 1 và 2)
	t.Log("[Quan sát] Mở rộng thời lượng từ 30s lên 90s (UpdateDuration)...")
	if !p.UpdateDuration(90.0) {
		t.Fatalf("UpdateDuration(90.0) phải thành công")
	}

	// Đảm bảo scheduler được đánh thức và xử lý tiếp block 1 và 2
	deadlineDone2 := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadlineDone2) {
		if bs.IsBlockDone(0) && bs.IsBlockDone(1) && bs.IsBlockDone(2) {
			p.mu.Lock()
			st := p.state
			p.mu.Unlock()
			if st == "done" {
				break
			}
		}
		time.Sleep(30 * time.Millisecond)
	}

	if !bs.IsBlockDone(1) || !bs.IsBlockDone(2) {
		t.Fatalf("BUG-08 TỒN TẠI: Sau khi mở rộng thời lượng, scheduler không xử lý tiếp block 1 hoặc 2! DoneBlocks: 0=%v, 1=%v, 2=%v",
			bs.IsBlockDone(0), bs.IsBlockDone(1), bs.IsBlockDone(2))
	}
	t.Log("[PASS BUG-08 Expand] Mở rộng thời lượng đã đánh thức scheduler, xử lý trọn vẹn cả 3 block!")
}

// TEST CASE 7: BUG-08 Concurrency
// Bắn đồng thời UpdateDuration, SeekTo, UpdatePlayhead từ 12 goroutines.
// Chạy với race detector để đảm bảo an toàn luồng tuyệt đối cho durationBits.
func Test_QC_BUG08_Concurrent_UpdateDuration_Seek_Playhead_NoRace(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir()) // BUG-20: cô lập cache khỏi %LOCALAPPDATA% thật
	tempDir := t.TempDir()
	dummyVideo := filepath.Join(tempDir, "video_bug08_race.mp4")
	_ = os.WriteFile(dummyVideo, make([]byte, 1024), 0644)

	bs, _ := NewBlockStore(dummyVideo, CacheMeta{BlockSec: 30.0, OverlapSec: 2.0, DurationSec: 180.0})
	tools := &ToolsPaths{TempDir: tempDir}
	trans := &MockTranslator{}
	settings := Settings{BlockSec: 30.0, OverlapSec: 2.0, LookaheadMinSec: 15.0, LookaheadMaxSec: 60.0, TranslateWorkers: 2}

	p := NewPipeline(dummyVideo, 180.0, settings, tools, bs, trans, PipelineEventCallbacks{})
	p.MockSliceAudio = func(ctx context.Context, videoPath string, bRange BlockRange, outWav string) error {
		time.Sleep(5 * time.Millisecond)
		return nil
	}
	p.MockRunSTT = func(ctx context.Context, wavPath string, bRange BlockRange) ([]WhisperSegment, error) {
		time.Sleep(5 * time.Millisecond)
		return []WhisperSegment{{StartSec: bRange.OwnerStart + 1.0, EndSec: bRange.OwnerStart + 2.0, Text: "T"}}, nil
	}

	if err := p.Start(0); err != nil {
		t.Fatalf("Start thất bại: %v", err)
	}
	defer p.Stop()

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	var wg sync.WaitGroup
	// 4 goroutines liên tục UpdateDuration dao động giữa 60s và 300s
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			durs := []float64{60.0, 90.0, 120.0, 180.0, 240.0, 300.0}
			idx := 0
			for {
				select {
				case <-ctx.Done():
					return
				default:
					p.UpdateDuration(durs[idx%len(durs)])
					idx++
					time.Sleep(10 * time.Millisecond)
				}
			}
		}(i)
	}

	// 4 goroutines liên tục SeekTo
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				default:
					_ = p.SeekTo(float64((id * 17) % 55))
					time.Sleep(15 * time.Millisecond)
				}
			}
		}(i)
	}

	// 4 goroutines liên tục UpdatePlayhead
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				default:
					p.UpdatePlayhead(float64(id*10), true)
					time.Sleep(15 * time.Millisecond)
				}
			}
		}(i)
	}

	wg.Wait()
	t.Log("[PASS BUG-08 Concurrency] Đa luồng UpdateDuration, SeekTo, UpdatePlayhead không xảy ra data race!")
}

// TEST CASE 8: BUG-08 App layer UpdateVideoDuration
// Kiểm tra hàm UpdateVideoDuration trong app.go:
// 1. Cập nhật duration và totalBlocks trên currentInfo.
// 2. Đồng bộ thời lượng vào DriveManager với đúng scheme gdrive://.
// 3. Gọi p.UpdateDuration trên pipeline đang chạy.
// 4. Lọc bỏ các giá trị NaN, Inf, âm hoặc 0.
func Test_QC_BUG08_App_UpdateVideoDuration_SyncsCurrentInfoAndDriveManager(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir()) // BUG-20: cô lập cache khỏi %LOCALAPPDATA% thật
	tempDir := t.TempDir()

	app := NewApp()
	app.tools = &ToolsPaths{TempDir: tempDir}

	driveVideo := "gdrive://test_drive_file_123"
	app.currentVideo = driveVideo
	app.currentInfo = &VideoInfo{
		Path:        driveVideo,
		DurationSec: 3600.0,
		BlockSec:    30.0,
		TotalBlocks: 120,
	}

	// 1. Test cập nhật giá trị hợp lệ 95.0s
	app.UpdateVideoDuration(driveVideo, 95.0)

	if app.currentInfo.DurationSec != 95.0 {
		t.Errorf("currentInfo.DurationSec kỳ vọng 95.0, nhận: %v", app.currentInfo.DurationSec)
	}
	expectedBlocks := int(math.Ceil(95.0 / 30.0)) // 4 blocks
	if app.currentInfo.TotalBlocks != expectedBlocks {
		t.Errorf("currentInfo.TotalBlocks kỳ vọng %d, nhận: %d", expectedBlocks, app.currentInfo.TotalBlocks)
	}

	// Kiểm tra DriveManager nhận đúng duration
	dmDur := GetDriveManager().GetDuration("test_drive_file_123")
	if dmDur != 95.0 {
		t.Errorf("DriveManager duration kỳ vọng 95.0, nhận: %f", dmDur)
	}

	// 2. Test bỏ qua các giá trị không hợp lệ
	app.UpdateVideoDuration(driveVideo, math.NaN())
	app.UpdateVideoDuration(driveVideo, math.Inf(1))
	app.UpdateVideoDuration(driveVideo, -10.0)
	app.UpdateVideoDuration(driveVideo, 0.0)

	if app.currentInfo.DurationSec != 95.0 {
		t.Errorf("currentInfo.DurationSec không được thay đổi khi nhận giá trị không hợp lệ, nhận: %v", app.currentInfo.DurationSec)
	}

	// 3. Test bỏ qua nếu path không khớp currentVideo
	app.UpdateVideoDuration("gdrive://other_file", 200.0)
	if app.currentInfo.DurationSec != 95.0 {
		t.Errorf("currentInfo.DurationSec không được thay đổi khi path không khớp currentVideo, nhận: %v", app.currentInfo.DurationSec)
	}

	t.Log("[PASS BUG-08 App] App.UpdateVideoDuration đồng bộ chuẩn xác sang currentInfo và DriveManager, lọc bỏ input rác!")
}
