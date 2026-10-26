package main

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// PipelineEventCallbacks chứa các hàm callback để phát sự kiện sang Wails runtime
type PipelineEventCallbacks struct {
	OnStatus func(status PipelineStatus)
	OnChunk  func(chunk SubtitleChunkPayload)
	OnError  func(err PipelineError)
}

// AudioJob dữ liệu chuyển từ stage Slicer sang stage STT
type AudioJob struct {
	BlockIdx int
	WavPath  string
	Range    BlockRange
	SliceMs  int64
}

// TextJob dữ liệu chuyển từ stage STT sang stage Translator
type TextJob struct {
	BlockIdx int
	Items    []SubtitleItem
	Range    BlockRange
	SliceMs  int64
	SttMs    int64
}

// Pipeline là cỗ máy điều phối xử lý video thời gian thực
type Pipeline struct {
	mu           sync.Mutex
	computeMu    sync.Mutex // Điều phối CPU giữa Whisper và LLM tránh tranh chấp core
	videoPath    string
	durationSec  float64
	settings     Settings
	tools        *ToolsPaths
	blockStore   *BlockStore
	translator   Translator
	callbacks    PipelineEventCallbacks

	// Session management
	sessionID    int64
	sessionCtx   context.Context
	cancelFunc   context.CancelFunc
	wg           sync.WaitGroup

	// Pipeline state
	playheadSec      float64
	playing          bool
	state            string
	wakeSched        chan struct{}
	failedBlocks     map[int]int // blockIdx -> retryCount
	activeJobs       map[int]bool
	externalSegments []WhisperSegment

	// Metrics đo p50/p95 latency và tỷ lệ phụ đề sẵn sàng trước thời điểm phát
	metricsMu        sync.Mutex
	batchLatenciesMs []int64
	onTimeCount      int64
	totalTransCount  int64

	// Custom runners hỗ trợ Mock trong Test tự động
	MockSliceAudio func(ctx context.Context, videoPath string, bRange BlockRange, outWav string) error
	MockRunSTT     func(ctx context.Context, wavPath string, bRange BlockRange) ([]WhisperSegment, error)
}

// NewPipeline tạo một thực thể Pipeline mới
func NewPipeline(
	videoPath string,
	durationSec float64,
	settings Settings,
	tools *ToolsPaths,
	blockStore *BlockStore,
	translator Translator,
	callbacks PipelineEventCallbacks,
) *Pipeline {
	if settings.BlockSec <= 0 {
		settings.BlockSec = 30.0
	}
	if settings.OverlapSec <= 0 {
		settings.OverlapSec = 2.0
	}
	if settings.LookaheadMinSec <= 0 {
		settings.LookaheadMinSec = 45.0
	}
	if settings.LookaheadMaxSec <= 0 {
		settings.LookaheadMaxSec = 180.0
	}
	if settings.TranslateWorkers <= 0 {
		settings.TranslateWorkers = 1
	}

	var extSegs []WhisperSegment
	if subFile := FindExternalSubtitleFile(videoPath); subFile != "" {
		if loaded, err := LoadExternalSubtitles(subFile); err == nil && len(loaded) > 0 {
			extSegs = loaded
			// Khi đã có sẵn _en.srt, cho phép dịch đón đầu xa hơn (10 phút = 600s) vì không tốn CPU chạy Whisper
			if settings.LookaheadMaxSec < 600.0 {
				settings.LookaheadMaxSec = 600.0
			}
		}
	}

	return &Pipeline{
		videoPath:        videoPath,
		durationSec:      durationSec,
		settings:         settings,
		tools:            tools,
		blockStore:       blockStore,
		translator:       translator,
		callbacks:        callbacks,
		state:            "idle",
		wakeSched:        make(chan struct{}, 1),
		failedBlocks:     make(map[int]int),
		activeJobs:       make(map[int]bool),
		externalSegments: extSegs,
	}
}

// notifyWake Scheduler
func (p *Pipeline) triggerSchedule() {
	select {
	case p.wakeSched <- struct{}{}:
	default:
	}
}

func (p *Pipeline) emitStatus(block int) {
	p.mu.Lock()
	defer p.mu.Unlock()

	totalBlocks := int(math.Ceil(p.durationSec / p.settings.BlockSec))
	doneBlocks := len(p.blockStore.GetDoneBlocks())

	aheadSec := p.computeAheadSecLocked()

	status := PipelineStatus{
		State:       p.state,
		Message:     fmt.Sprintf("Trạng thái: %s", p.state),
		Block:       block,
		DoneBlocks:  doneBlocks,
		TotalBlocks: totalBlocks,
		AheadSec:    aheadSec,
		Video:       p.videoPath,
	}

	if p.callbacks.OnStatus != nil {
		p.callbacks.OnStatus(status)
	}
}

// computeAheadSecLocked tính toán khoảng thời gian đã xong liên tục phía trước playhead
func (p *Pipeline) computeAheadSecLocked() float64 {
	curBlock := int(p.playheadSec / p.settings.BlockSec)
	totalBlocks := int(math.Ceil(p.durationSec / p.settings.BlockSec))

	continuousDoneEnd := p.playheadSec

	for b := curBlock; b < totalBlocks; b++ {
		if p.blockStore.IsBlockDone(b) {
			bEnd := float64(b+1) * p.settings.BlockSec
			if bEnd > p.durationSec {
				bEnd = p.durationSec
			}
			continuousDoneEnd = bEnd
		} else {
			break
		}
	}

	ahead := continuousDoneEnd - p.playheadSec
	if ahead < 0 {
		return 0
	}
	return ahead
}

// Start bắt đầu pipeline từ vị trí startSec
func (p *Pipeline) Start(startSec float64) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.stopCurrentSessionLocked()

	newSessionID := atomic.AddInt64(&p.sessionID, 1)
	p.sessionCtx, p.cancelFunc = context.WithCancel(context.Background())
	p.playheadSec = startSec
	p.state = "processing"

	p.startSessionWorkers(p.sessionCtx, newSessionID)
	return nil
}

// SeekTo di chuyển playhead an toàn, hủy ngay phiên cũ nếu bị lệch vị trí
func (p *Pipeline) SeekTo(startSec float64) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if startSec < 0 {
		startSec = 0
	}
	if startSec > p.durationSec {
		startSec = p.durationSec
	}

	p.playheadSec = startSec
	targetBlock := int(startSec / p.settings.BlockSec)

	// Kiểm tra xem worker hiện tại có đang xử lý đúng ngay tại targetBlock hoặc block kế tiếp không
	isProcessingTarget := p.activeJobs[targetBlock] || p.activeJobs[targetBlock+1]

	// 1. Nếu block đích đã có trong cache VÀ các worker đang chạy gần đó -> chỉ dời playhead
	if p.blockStore.IsBlockDone(targetBlock) && isProcessingTarget {
		p.triggerSchedule()
		return nil
	}

	// 2. Nếu block đích chưa có trong cache nhưng worker đang xử lý đúng nó -> giữ nguyên hướng chạy
	if !p.blockStore.IsBlockDone(targetBlock) && isProcessingTarget {
		p.triggerSchedule()
		return nil
	}

	// 3. Tua nhảy cóc hoặc tua lùi xa vị trí cũ:
	// Hủy ngay lập tức phiên cũ để giải phóng 100% CPU cho block vừa tua tới
	p.stopCurrentSessionLocked()

	newSessionID := atomic.AddInt64(&p.sessionID, 1)
	p.sessionCtx, p.cancelFunc = context.WithCancel(context.Background())
	p.state = "seeking"

	p.startSessionWorkers(p.sessionCtx, newSessionID)
	return nil
}

// UpdatePlayhead cập nhật vị trí phát hiện tại từ frontend
func (p *Pipeline) UpdatePlayhead(sec float64, playing bool) {
	p.mu.Lock()
	p.playheadSec = sec
	p.playing = playing
	p.mu.Unlock()

	p.triggerSchedule()
}

// Stop dừng hoàn toàn pipeline
func (p *Pipeline) Stop() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.stopCurrentSessionLocked()
	p.state = "idle"
}

func (p *Pipeline) stopCurrentSessionLocked() {
	if p.cancelFunc != nil {
		p.cancelFunc()
		p.cancelFunc = nil
	}

	// Chờ tối đa 3 giây cho các worker thoát
	done := make(chan struct{})
	go func() {
		p.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		// Timeout chờ worker cũ
	}

	// Xóa danh sách activeJobs
	p.activeJobs = make(map[int]bool)
}

func (p *Pipeline) startSessionWorkers(ctx context.Context, sessionID int64) {
	slicerChan := make(chan int, 2)
	audioChan := make(chan AudioJob, 2)
	textChan := make(chan TextJob, 2)

	// 1. Stage Slicer (1 worker)
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		defer close(audioChan)
		p.slicerWorker(ctx, slicerChan, audioChan)
	}()

	// 2. Stage STT (1 worker)
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		defer close(textChan)
		p.sttWorker(ctx, audioChan, textChan)
	}()

	// 3. Stage Translator (N workers)
	workers := p.settings.TranslateWorkers
	var transWg sync.WaitGroup
	for i := 0; i < workers; i++ {
		transWg.Add(1)
		p.wg.Add(1)
		go func() {
			defer p.wg.Done()
			defer transWg.Done()
			p.translatorWorker(ctx, textChan)
		}()
	}

	// 4. Scheduler loop điều phối
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		defer close(slicerChan)
		p.schedulerLoop(ctx, slicerChan)
	}()
}

// schedulerLoop chọn block tiếp theo theo quy tắc lookahead và backfill
func (p *Pipeline) schedulerLoop(ctx context.Context, slicerChan chan<- int) {
	totalBlocks := int(math.Ceil(p.durationSec / p.settings.BlockSec))

	for {
		select {
		case <-ctx.Done():
			return
		case <-p.wakeSched:
		case <-time.After(500 * time.Millisecond):
		}

		p.mu.Lock()
		playheadBlock := int(p.playheadSec / p.settings.BlockSec)
		aheadSec := p.computeAheadSecLocked()

		// 1. Tìm block tiếp theo từ playheadBlock trở đi
		nextBlock := -1
		for b := playheadBlock; b < totalBlocks; b++ {
			if !p.blockStore.IsBlockDone(b) && !p.activeJobs[b] && p.failedBlocks[b] < 2 {
				nextBlock = b
				break
			}
		}

		// 2. Nếu phía trước playhead còn block cần làm, áp dụng chặn đón đầu Lookahead Max
		if nextBlock != -1 {
			if aheadSec >= p.settings.LookaheadMaxSec {
				p.state = "ahead"
				p.mu.Unlock()
				p.emitStatus(-1)
				continue
			}

			if p.playing && aheadSec < p.settings.LookaheadMinSec {
				p.state = "catching_up"
			} else {
				p.state = "processing"
			}
		}

		// 3. Nếu phía trước đã xong hết tới cuối video, kích hoạt Backfill các block thiếu từ đầu video
		isBackfill := false
		if nextBlock == -1 {
			for b := 0; b < playheadBlock; b++ {
				if !p.blockStore.IsBlockDone(b) && !p.activeJobs[b] && p.failedBlocks[b] < 2 {
					nextBlock = b
					isBackfill = true
					break
				}
			}
		}

		// 4. Kiểm tra nếu tất cả block đã hoàn thành
		if nextBlock == -1 {
			if len(p.activeJobs) == 0 {
				p.state = "done"
			}
			p.mu.Unlock()
			p.emitStatus(-1)
			continue
		}

		if isBackfill {
			p.state = "backfill"
		}

		p.activeJobs[nextBlock] = true
		p.mu.Unlock()

		p.emitStatus(nextBlock)

		select {
		case <-ctx.Done():
			return
		case slicerChan <- nextBlock:
		}
	}
}

// slicerWorker cắt audio bằng ffmpeg
func (p *Pipeline) slicerWorker(ctx context.Context, inChan <-chan int, outChan chan<- AudioJob) {
	defer func() {
		if r := recover(); r != nil {
			if p.callbacks.OnError != nil {
				p.callbacks.OnError(PipelineError{Stage: "slice", Message: fmt.Sprintf("panic in slicer: %v", r), Fatal: false, Video: p.videoPath})
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return
		case blockIdx, ok := <-inChan:
			if !ok {
				return
			}

			bRange := ComputeBlockRange(blockIdx, p.settings.BlockSec, p.settings.OverlapSec, p.durationSec)
			wavPath := filepath.Join(p.tools.TempDir, fmt.Sprintf("block_%d_%d.wav", p.sessionID, blockIdx))

			tSlice0 := time.Now()
			var err error
			if len(p.externalSegments) > 0 && p.MockSliceAudio == nil {
				// Đã có sẵn file phụ đề gốc (.srt/.vtt) -> bỏ qua cắt WAV bằng ffmpeg
			} else if p.MockSliceAudio != nil {
				err = p.MockSliceAudio(ctx, p.videoPath, bRange, wavPath)
			} else {
				// Cắt audio bằng ffmpeg với seek nhanh trước -i:
				// -ss <extract_start> -t <len> -i video -vn -ar 16000 -ac 1 -c:a pcm_s16le
				args := []string{
					"-y",
					"-threads", "2",
					"-ss", fmt.Sprintf("%.3f", bRange.ExtractStart),
					"-t", fmt.Sprintf("%.3f", bRange.ExtractLen),
					"-i", p.videoPath,
					"-vn",
					"-ar", "16000",
					"-ac", "1",
					"-c:a", "pcm_s16le",
					wavPath,
				}
				_, err = RunCommand(ctx, p.tools.FFmpeg, args, 60*time.Second, nil)
			}
			sliceMs := time.Since(tSlice0).Milliseconds()

			if err != nil {
				if ctx.Err() != nil {
					return
				}
				p.handleBlockFailure(blockIdx, "slice", err)
				continue
			}

			select {
			case <-ctx.Done():
				_ = os.Remove(wavPath)
				return
			case outChan <- AudioJob{BlockIdx: blockIdx, WavPath: wavPath, Range: bRange, SliceMs: sliceMs}:
			}
		}
	}
}

// sttWorker chạy Whisper CLI
func (p *Pipeline) sttWorker(ctx context.Context, inChan <-chan AudioJob, outChan chan<- TextJob) {
	defer func() {
		if r := recover(); r != nil {
			if p.callbacks.OnError != nil {
				p.callbacks.OnError(PipelineError{Stage: "stt", Message: fmt.Sprintf("panic in stt: %v", r), Fatal: false, Video: p.videoPath})
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return
		case job, ok := <-inChan:
			if !ok {
				return
			}

			tStt0 := time.Now()
			var segments []WhisperSegment
			var err error

			if len(p.externalSegments) > 0 && p.MockRunSTT == nil {
				// Trích xuất trực tiếp từ file phụ đề .srt/.vtt đi kèm (0ms STT, không tốn CPU/RAM)
				for _, seg := range p.externalSegments {
					if seg.EndSec >= job.Range.ExtractStart && seg.StartSec <= job.Range.ExtractEnd {
						segments = append(segments, seg)
					}
				}
			} else if p.MockRunSTT != nil {
				segments, err = p.MockRunSTT(ctx, job.WavPath, job.Range)
			} else {
				// whisper-cli gọi với greedy decoding (-bs 1 -bo 1 -nf -np) để tối ưu tốc độ gấp 3 lần và giảm RAM
				threads := p.settings.WhisperThreads
				if threads <= 0 {
					threads = 4
				}
				jsonOutPath := job.WavPath + ".json"
				args := []string{
					"-m", p.tools.WhisperModel,
					"-f", job.WavPath,
					"-l", p.settings.SourceLang,
					"-t", fmt.Sprintf("%d", threads),
					"-bs", "1",
					"-bo", "1",
					"-nf",
					"-np",
					"-oj",
					"-of", job.WavPath, // output prefix
				}
				p.computeMu.Lock()
				_, err = RunCommand(ctx, p.tools.WhisperCLI, args, 5*time.Minute, nil)
				p.computeMu.Unlock()
				if err == nil {
					data, readErr := os.ReadFile(jsonOutPath)
					if readErr == nil {
						segments, err = ParseWhisperJSON(data, job.Range.ExtractStart)
						_ = os.Remove(jsonOutPath)
					} else {
						err = readErr
					}
				}
			}

			sttMs := time.Since(tStt0).Milliseconds()

			// Dọn file wav tạm
			_ = os.Remove(job.WavPath)

			if err != nil {
				if ctx.Err() != nil {
					return
				}
				p.handleBlockFailure(job.BlockIdx, "stt", err)
				continue
			}

			// Lọc theo quy tắc điểm giữa, bỏ ảo giác
			filtered := FilterAndDeduplicateSegments(segments, job.Range)

			var items []SubtitleItem
			for seq, s := range filtered {
				items = append(items, SubtitleItem{
					ID:         int64(job.BlockIdx)*1000 + int64(seq),
					Block:      job.BlockIdx,
					StartSec:   s.StartSec,
					EndSec:     s.EndSec,
					SourceText: s.Text,
					TargetText: "",
					Translated: false,
				})
			}

			// Phát ngay phụ đề tiếng Anh cho frontend hiển thị trước
			if p.callbacks.OnChunk != nil {
				p.callbacks.OnChunk(SubtitleChunkPayload{
					Video: p.videoPath,
					Block: job.BlockIdx,
					Items: items,
					Final: false,
				})
			}

			select {
			case <-ctx.Done():
				return
			case outChan <- TextJob{BlockIdx: job.BlockIdx, Items: items, Range: job.Range, SliceMs: job.SliceMs, SttMs: sttMs}:
			}
		}
	}
}

// translatorWorker dịch toàn bộ câu trong block bằng TranslateBatch siêu tốc
func (p *Pipeline) translatorWorker(ctx context.Context, inChan <-chan TextJob) {
	defer func() {
		if r := recover(); r != nil {
			if p.callbacks.OnError != nil {
				p.callbacks.OnError(PipelineError{Stage: "translate", Message: fmt.Sprintf("panic in translator: %v", r), Fatal: false, Video: p.videoPath})
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return
		case job, ok := <-inChan:
			if !ok {
				return
			}

			tTrans0 := time.Now()
			translatedItems := make([]SubtitleItem, len(job.Items))
			copy(translatedItems, job.Items)

			p.mu.Lock()
			curPlayhead := p.playheadSec
			p.mu.Unlock()

			// Xác định Tầng ưu tiên (Two-Tier Lookahead Buffer):
			// - Tier 1 (High Priority): Block chứa playhead hoặc nằm trong 15 giây sắp phát
			// - Tier 2 (Low Priority): Các block nền từ +15s đến LookaheadMaxSec
			isTier1Block := job.Range.OwnerStart <= curPlayhead+15.0 && job.Range.OwnerEnd >= curPlayhead
			tierLabel := "TIER-2:BG"
			if isTier1Block {
				tierLabel = "TIER-1:HIGH"
			}

			okCount := 0
			if p.translator != nil && len(job.Items) > 0 {
				batches := BuildTwoTierBatches(job.Items, curPlayhead, isTier1Block)

				for bIdx, indices := range batches {
					if ctx.Err() != nil {
						return
					}

					// Ở Tier 2 (Low Priority), nhường nhịp nhỏ giữa các batch nền để tránh dồn request (dùng timer có drain sạch)
					if !isTier1Block && bIdx > 0 && p.MockRunSTT == nil {
						timer := time.NewTimer(25 * time.Millisecond)
						select {
						case <-ctx.Done():
							if !timer.Stop() {
								select {
								case <-timer.C:
								default:
								}
							}
							return
						case <-timer.C:
						}
					}

					batchLines := make([]string, len(indices))
					for k, itemIdx := range indices {
						batchLines[k] = job.Items[itemIdx].SourceText
					}

					tBatch0 := time.Now()
					if p.MockRunSTT == nil {
						p.computeMu.Lock()
					}
					targets, err := p.translator.TranslateBatch(ctx, batchLines)
					if p.MockRunSTT == nil {
						p.computeMu.Unlock()
					}
					batchMs := time.Since(tBatch0).Milliseconds()

					if ctx.Err() != nil {
						return
					}

					p.mu.Lock()
					nowPlayhead := p.playheadSec
					p.mu.Unlock()

					updatedSlice := make([]SubtitleItem, 0, len(indices))
					batchOnTime := int64(0)
					for k, itemIdx := range indices {
						if err == nil && k < len(targets) && targets[k] != "" {
							translatedItems[itemIdx].TargetText = targets[k]
							translatedItems[itemIdx].Translated = true
							okCount++
							// P1: Chỉ tính On-time nếu câu hoàn tất TRƯỚC mốc StartSec hiển thị của câu
							if nowPlayhead < translatedItems[itemIdx].StartSec {
								batchOnTime++
							}
						} else {
							translatedItems[itemIdx].TargetText = ""
							translatedItems[itemIdx].Translated = false
						}
						updatedSlice = append(updatedSlice, translatedItems[itemIdx])
					}

					p.recordBatchMetrics(batchMs, batchOnTime, int64(len(indices)))

					// Phát cập nhật theo từng cụm batch lên giao diện
					if p.callbacks.OnChunk != nil {
						p.callbacks.OnChunk(SubtitleChunkPayload{
							Video: p.videoPath,
							Block: job.BlockIdx,
							Items: updatedSlice,
							Final: false,
						})
					}
				}
			}
			transMs := time.Since(tTrans0).Milliseconds()

			p50, p95, onTimePct := p.getMetricsSummary()
			totalMs := job.SliceMs + job.SttMs + transMs
			fmt.Printf("[BLOCK %d | %s] Slice: %dms | STT: %dms (%d lines) | Trans: %dms (%d/%d ok) | Batch p50=%dms p95=%dms | On-time: %.0f%% | Total: %dms\n",
				job.BlockIdx, tierLabel, job.SliceMs, job.SttMs, len(job.Items), transMs, okCount, len(job.Items), p50, p95, onTimePct, totalMs)

			// Lưu vào cache
			_ = p.blockStore.SaveBlock(job.BlockIdx, translatedItems)

			p.mu.Lock()
			delete(p.activeJobs, job.BlockIdx)
			p.mu.Unlock()

			// Phát bản dịch tiếng Việt hoàn tất (Final=true)
			if p.callbacks.OnChunk != nil {
				p.callbacks.OnChunk(SubtitleChunkPayload{
					Video: p.videoPath,
					Block: job.BlockIdx,
					Items: translatedItems,
					Final: true,
				})
			}

			p.triggerSchedule()
		}
	}
}

func (p *Pipeline) handleBlockFailure(blockIdx int, stage string, err error) {
	p.mu.Lock()
	delete(p.activeJobs, blockIdx)
	p.failedBlocks[blockIdx]++
	retryCount := p.failedBlocks[blockIdx]
	p.mu.Unlock()

	fatal := (retryCount >= 2)
	if p.callbacks.OnError != nil {
		p.callbacks.OnError(PipelineError{
			Block:   blockIdx,
			Stage:   stage,
			Message: fmt.Sprintf("Lỗi block %d tại stage %s: %v", blockIdx, stage, err),
			Fatal:   fatal,
			Video:   p.videoPath,
		})
	}

	p.triggerSchedule()
}

// BuildTwoTierBatches chia danh sách câu trong block theo mô hình Two-Tier Lookahead:
// - Tier 1 (High Priority): Ưu tiên gom cụm nhỏ (tối đa 3 câu / 240 ký tự) cho các câu nằm trong vùng [playheadSec - 1s, playheadSec + 15s] để hiển thị tức thì.
// - Tier 2 (Low Priority): Gom các câu còn lại thành các batch lớn (tối đa 8 câu / 600 ký tự) để tối ưu số lượng request HTTP.
func BuildTwoTierBatches(items []SubtitleItem, playheadSec float64, isTier1Block bool) [][]int {
	if len(items) == 0 {
		return nil
	}

	var tier1Indices []int
	var tier2Indices []int

	if isTier1Block {
		for i, it := range items {
			// Các câu sắp phát trong vòng 15 giây tới tính từ playhead được đưa vào Tier 1
			if it.EndSec >= playheadSec-1.0 && it.StartSec <= playheadSec+15.0 {
				tier1Indices = append(tier1Indices, i)
			} else {
				tier2Indices = append(tier2Indices, i)
			}
		}
	} else {
		for i := range items {
			tier2Indices = append(tier2Indices, i)
		}
	}

	var result [][]int

	// 1. Chia batch cho Tier 1: batch đầu tiên cực gọn (tối đa 3 câu / 240 ký tự) để trả kết quả nhanh nhất
	if len(tier1Indices) > 0 {
		tier1Lines := make([]string, len(tier1Indices))
		for k, idx := range tier1Indices {
			tier1Lines[k] = items[idx].SourceText
		}
		subBatches := SplitLinesIntoControlledBatches(tier1Lines, 3, 240)
		for _, sb := range subBatches {
			mapped := make([]int, len(sb))
			for k, relIdx := range sb {
				mapped[k] = tier1Indices[relIdx]
			}
			result = append(result, mapped)
		}
	}

	// 2. Chia batch cho Tier 2: gom tối đa 8 câu hoặc 600 ký tự mỗi request
	if len(tier2Indices) > 0 {
		tier2Lines := make([]string, len(tier2Indices))
		for k, idx := range tier2Indices {
			tier2Lines[k] = items[idx].SourceText
		}
		subBatches := SplitLinesIntoControlledBatches(tier2Lines, 8, 600)
		for _, sb := range subBatches {
			mapped := make([]int, len(sb))
			for k, relIdx := range sb {
				mapped[k] = tier2Indices[relIdx]
			}
			result = append(result, mapped)
		}
	}

	return result
}

func (p *Pipeline) recordBatchMetrics(latencyMs int64, onTime int64, total int64) {
	p.metricsMu.Lock()
	defer p.metricsMu.Unlock()

	if len(p.batchLatenciesMs) >= 500 {
		p.batchLatenciesMs = p.batchLatenciesMs[1:]
	}
	p.batchLatenciesMs = append(p.batchLatenciesMs, latencyMs)
	p.onTimeCount += onTime
	p.totalTransCount += total
}

func (p *Pipeline) getMetricsSummary() (p50 int64, p95 int64, onTimePct float64) {
	p.metricsMu.Lock()
	defer p.metricsMu.Unlock()

	p50, p95 = ComputeLatencyPercentiles(p.batchLatenciesMs)
	if p.totalTransCount > 0 {
		onTimePct = (float64(p.onTimeCount) / float64(p.totalTransCount)) * 100.0
	} else {
		onTimePct = 100.0
	}
	return p50, p95, onTimePct
}

// ComputeLatencyPercentiles tính độ trễ trung vị p50 và p95 (ms) từ danh sách mẫu đo thực tế
func ComputeLatencyPercentiles(samples []int64) (p50 int64, p95 int64) {
	n := len(samples)
	if n == 0 {
		return 0, 0
	}
	sorted := make([]int64, n)
	copy(sorted, samples)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i] < sorted[j]
	})

	idx50 := (n - 1) * 50 / 100
	idx95 := (n - 1) * 95 / 100
	return sorted[idx50], sorted[idx95]
}
