package main

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
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
}

// TextJob dữ liệu chuyển từ stage STT sang stage Translator
type TextJob struct {
	BlockIdx int
	Items    []SubtitleItem
	Range    BlockRange
}

// Pipeline là cỗ máy điều phối xử lý video thời gian thực
type Pipeline struct {
	mu           sync.Mutex
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
	playheadSec  float64
	playing      bool
	state        string
	wakeSched    chan struct{}
	failedBlocks map[int]int // blockIdx -> retryCount
	activeJobs   map[int]bool

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

	return &Pipeline{
		videoPath:    videoPath,
		durationSec:  durationSec,
		settings:     settings,
		tools:        tools,
		blockStore:   blockStore,
		translator:   translator,
		callbacks:    callbacks,
		state:        "idle",
		wakeSched:    make(chan struct{}, 1),
		failedBlocks: make(map[int]int),
		activeJobs:   make(map[int]bool),
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

	p.sessionID = atomic.AddInt64(&p.sessionID, 1)
	p.sessionCtx, p.cancelFunc = context.WithCancel(context.Background())
	p.playheadSec = startSec
	p.state = "processing"

	p.startSessionWorkers(p.sessionCtx, p.sessionID)
	return nil
}

// SeekTo di chuyển playhead an toàn, hủy phiên cũ nếu cần
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

	// 1. Nếu block đích đã hoàn thành trong cache -> chỉ cập nhật playhead, đánh thức scheduler
	if p.blockStore.IsBlockDone(targetBlock) {
		p.triggerSchedule()
		return nil
	}

	// 2. Nếu block đích đang được xử lý hoặc ngay sau đó -> giữ nguyên hướng chạy
	if p.activeJobs[targetBlock] || p.activeJobs[targetBlock+1] {
		p.triggerSchedule()
		return nil
	}

	// 3. Cần nhảy phiên mới: Hủy phiên cũ và khởi tạo phiên mới
	p.stopCurrentSessionLocked()

	p.sessionID = atomic.AddInt64(&p.sessionID, 1)
	p.sessionCtx, p.cancelFunc = context.WithCancel(context.Background())
	p.state = "seeking"

	p.startSessionWorkers(p.sessionCtx, p.sessionID)
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

		// 1. Kiểm tra giới hạn đón đầu Lookahead Max
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

		// 2. Tìm block tiếp theo từ playheadBlock trở đi
		nextBlock := -1
		for b := playheadBlock; b < totalBlocks; b++ {
			if !p.blockStore.IsBlockDone(b) && !p.activeJobs[b] && p.failedBlocks[b] < 2 {
				nextBlock = b
				break
			}
		}

		// 3. Nếu phía trước đã xong hết, kiểm tra Backfill phía trước playhead cũ
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

			var err error
			if p.MockSliceAudio != nil {
				err = p.MockSliceAudio(ctx, p.videoPath, bRange, wavPath)
			} else {
				// Cắt audio bằng ffmpeg với seek nhanh trước -i:
				// -ss <extract_start> -t <len> -i video -vn -ar 16000 -ac 1 -c:a pcm_s16le
				args := []string{
					"-y",
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
			case outChan <- AudioJob{BlockIdx: blockIdx, WavPath: wavPath, Range: bRange}:
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

			var segments []WhisperSegment
			var err error

			if p.MockRunSTT != nil {
				segments, err = p.MockRunSTT(ctx, job.WavPath, job.Range)
			} else {
				// whisper-cli gọi với -m model -f wav -l source_lang -oj
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
					"-oj",
					"-of", job.WavPath, // output prefix
				}
				_, err = RunCommand(ctx, p.tools.WhisperCLI, args, 5*time.Minute, nil)
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
			case outChan <- TextJob{BlockIdx: job.BlockIdx, Items: items, Range: job.Range}:
			}
		}
	}
}

// translatorWorker dịch từng câu thoại bằng LLM
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

			var translatedItems []SubtitleItem
			var prevContext []string

			for _, item := range job.Items {
				if ctx.Err() != nil {
					return
				}

				targetText := ""
				if p.translator != nil && item.SourceText != "" {
					var transErr error
					targetText, transErr = p.translator.Translate(ctx, item.SourceText, prevContext)
					if transErr != nil {
						// Một dòng lỗi không làm hỏng cả block, giữ targetText rỗng
						targetText = ""
					}
				}

				item.TargetText = targetText
				item.Translated = (targetText != "")
				translatedItems = append(translatedItems, item)

				if item.SourceText != "" {
					prevContext = append(prevContext, item.SourceText)
					if len(prevContext) > 2 {
						prevContext = prevContext[len(prevContext)-2:]
					}
				}
			}

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
