package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
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

// SlicerJob dữ liệu chuyển từ schedulerLoop sang stage Slicer
type SlicerJob struct {
	BlockIdx       int
	ScheduledAt    time.Time
	OrderInSession int
	SessionID      int64
}

// AudioJob dữ liệu chuyển từ stage Slicer sang stage STT
type AudioJob struct {
	BlockIdx       int
	WavPath        string
	UseCachedSTT   bool // true: block đã có STT trong BlockStore, không cắt WAV / không chạy Whisper
	Range          BlockRange
	SliceMs        int64
	ScheduledAt    time.Time
	QueueWaitMs    int64
	OrderInSession int
	SessionID      int64
}

// TextJob dữ liệu chuyển từ stage STT sang stage Translator
type TextJob struct {
	BlockIdx       int
	Items          []SubtitleItem
	Range          BlockRange
	SliceMs        int64
	SttMs          int64
	DetectedLang   string // Ngôn ngữ nhận diện từ Whisper ("vi", "en", ...)
	ScheduledAt    time.Time
	QueueWaitMs    int64
	ComputeWaitMs  int64
	WhisperWallMs  int64
	WhisperTimings WhisperTimings
	OrderInSession int
	SessionID      int64
	WhisperThreads int
	WhisperLangArg string
	VariantName    string
	STTCacheHit    bool // Items lấy từ BlockStore (bỏ qua ffmpeg + Whisper)
}

// PipelineSession đại diện cho một phiên làm việc độc lập của pipeline
type PipelineSession struct {
	id     int64
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

const noPendingSeek = math.MaxUint64

// Pipeline là cỗ máy điều phối xử lý video thời gian thực
type Pipeline struct {
	mu          sync.Mutex
	computeMu   sync.Mutex // Điều phối CPU giữa Whisper và LLM tránh tranh chấp core
	videoPath   string
	durationBits atomic.Uint64 // float64 bits; đọc qua duration(), cập nhật qua UpdateDuration()
	settings    Settings
	tools       *ToolsPaths
	blockStore  *BlockStore
	translator  Translator
	callbacks   PipelineEventCallbacks

	// Session management
	sessionID   int64
	session     *PipelineSession
	seekMu      sync.Mutex
	seekWake    chan struct{}
	seekStop    chan struct{}
	pendingSeek atomic.Uint64

	// Telemetry tracking
	sessionBlockCount    int
	lastSeekTime         time.Time
	lastSeekTargetSec    float64
	lastSeekOldID        int64
	lastSeekComputeDrain int64
	lastSeekWgDrain      int64
	lastSeekNewID        int64
	tier2RunningAtCancel bool
	tier2BlockRunningIdx int
	seekActive           bool
	detectedOnceLang     string

	// Pipeline state
	playheadSec      float64
	playing          bool
	state            string
	wakeSched        chan struct{}
	failedBlocks     map[int]int // blockIdx -> retryCount
	activeJobs       map[int]bool
	tier2Deferred    map[int]bool // blockIdx -> đã xong Tier-1, tạm hoãn Tier-2 khi local_ai/offline
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
	if envB := os.Getenv("VT_BLOCK_SEC"); envB != "" {
		if v, err := strconv.ParseFloat(envB, 64); err == nil && v > 0 {
			settings.BlockSec = v
		}
	}
	if envO := os.Getenv("VT_OVERLAP_SEC"); envO != "" {
		if v, err := strconv.ParseFloat(envO, 64); err == nil && v >= 0 {
			settings.OverlapSec = v
		}
	}
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
	} else if segs := GetDriveSubtitleSegments(videoPath); len(segs) > 0 {
		// Video Google Drive có sẵn file .srt/.vtt đã tải về RAM -> bypass Whisper STT
		extSegs = segs
		if settings.LookaheadMaxSec < 600.0 {
			settings.LookaheadMaxSec = 600.0
		}
	}

	p := &Pipeline{
		videoPath:        videoPath,
		settings:         settings,
		tools:            tools,
		blockStore:       blockStore,
		translator:       translator,
		callbacks:        callbacks,
		state:            "idle",
		wakeSched:        make(chan struct{}, 1),
		seekWake:         make(chan struct{}, 1),
		failedBlocks:     make(map[int]int),
		activeJobs:       make(map[int]bool),
		tier2Deferred:    make(map[int]bool),
		externalSegments: extSegs,
	}
	p.pendingSeek.Store(noPendingSeek)
	p.durationBits.Store(math.Float64bits(durationSec))
	return p
}

// notifyWake Scheduler
func (p *Pipeline) triggerSchedule() {
	select {
	case p.wakeSched <- struct{}{}:
	default:
	}
}

// duration trả về thời lượng video hiện tại (an toàn đa luồng).
func (p *Pipeline) duration() float64 {
	return math.Float64frombits(p.durationBits.Load())
}

// UpdateDuration cập nhật thời lượng thật của video (vd. từ <video>.duration của frontend
// khi nguồn là Google Drive và backend chỉ có giá trị ước lượng). Bỏ qua giá trị không hợp lệ.
// Trả về true nếu giá trị thực sự thay đổi.
func (p *Pipeline) UpdateDuration(sec float64) bool {
	if math.IsNaN(sec) || math.IsInf(sec, 0) || sec <= 0 {
		return false
	}
	old := p.duration()
	if math.Abs(old-sec) < 0.001 {
		return false
	}
	p.durationBits.Store(math.Float64bits(sec))
	select {
	case p.wakeSched <- struct{}{}:
	default:
	}
	return true
}

func (p *Pipeline) emitStatus(block int) {
	p.mu.Lock()

	totalBlocks := int(math.Ceil(p.duration() / p.settings.BlockSec))
	doneBlocks := len(p.blockStore.GetDoneBlocks())

	aheadSec := p.computeAheadSecLocked()

	status := PipelineStatus{
		State:          p.state,
		Message:        fmt.Sprintf("Trạng thái: %s", p.state),
		Block:          block,
		DoneBlocks:     doneBlocks,
		TotalBlocks:    totalBlocks,
		AheadSec:       aheadSec,
		Video:          p.videoPath,
		TranslatorMode: p.currentTranslatorMode(),
	}
	onStatus := p.callbacks.OnStatus
	p.mu.Unlock()

	// Gọi callback (Wails IPC / JSON) NGOÀI khóa p.mu để không chặn scheduler và các worker
	if onStatus != nil {
		onStatus(status)
	}
}

// computeAheadSecLocked tính toán khoảng thời gian đã xong liên tục phía trước playhead
func (p *Pipeline) computeAheadSecLocked() float64 {
	curBlock := int(p.playheadSec / p.settings.BlockSec)
	totalBlocks := int(math.Ceil(p.duration() / p.settings.BlockSec))

	continuousDoneEnd := p.playheadSec

	for b := curBlock; b < totalBlocks; b++ {
		if p.blockStore.IsBlockDone(b) || (p.tier2Deferred[b] && p.isTier2PostponedMode()) {
			bEnd := float64(b+1) * p.settings.BlockSec
			if bEnd > p.duration() {
				bEnd = p.duration()
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
	p.seekMu.Lock()
	defer p.seekMu.Unlock()

	p.stopCurrentSession()

	// Khởi động seekLoop nếu chưa có hoặc đã đóng
	if p.seekStop != nil {
		select {
		case <-p.seekStop:
		default:
			close(p.seekStop)
		}
	}
	p.seekStop = make(chan struct{})
	go p.seekLoop(p.seekStop)

	newSessionID := atomic.AddInt64(&p.sessionID, 1)
	newCtx, newCancel := context.WithCancel(context.Background())
	newSession := &PipelineSession{
		id:     newSessionID,
		ctx:    newCtx,
		cancel: newCancel,
	}

	p.mu.Lock()
	p.session = newSession
	p.playheadSec = startSec
	p.state = "processing"
	p.sessionBlockCount = 0
	p.tier2Deferred = make(map[int]bool)
	p.activeJobs = make(map[int]bool)
	p.failedBlocks = make(map[int]int) // phiên mới: các block từng lỗi ở phiên trước được thử lại
	p.pendingSeek.Store(noPendingSeek)

	p.startSessionWorkers(newSession)
	p.mu.Unlock()
	p.triggerSchedule()
	return nil
}

// RequestSeek yêu cầu tua video đến mốc thời gian sec.
// Non-blocking và gom (coalesce) các lệnh tua dồn dập,
// chỉ để phiên làm việc ở vị trí cuối cùng chạy nhằm giải phóng 100% CPU.
func (p *Pipeline) RequestSeek(sec float64) {
	if sec < 0 {
		sec = 0
	}
	if sec > p.duration() {
		sec = p.duration()
	}

	p.mu.Lock()
	if p.state == "idle" {
		p.playheadSec = sec
		p.mu.Unlock()
		return
	}
	p.mu.Unlock()

	p.pendingSeek.Store(math.Float64bits(sec))
	select {
	case p.seekWake <- struct{}{}:
	default:
	}
}

// SeekTo di chuyển playhead an toàn, hỗ trợ tua dồn dập không làm nghẽn pipeline
func (p *Pipeline) SeekTo(startSec float64) error {
	p.RequestSeek(startSec)
	return nil
}

func (p *Pipeline) seekLoop(stopChan <-chan struct{}) {
	for {
		select {
		case <-stopChan:
			return
		case <-p.seekWake:
		}

		for {
			bits := p.pendingSeek.Swap(noPendingSeek)
			if bits == noPendingSeek {
				break
			}
			targetSec := math.Float64frombits(bits)
			p.doSeek(targetSec)
		}
	}
}

// doSeek thực hiện điều phối phiên làm việc khi tua:
// - Thoát sớm (Fast Path) nếu block đích đã xong trong cache hoặc worker đang chạy ngay tại đó.
// - Thoát p.mu trước khi drain oldSession để tránh contention/deadlock.
// - Hủy phiên nếu phát hiện có lệnh seek mới hơn được xếp hàng trong lúc drain.
func (p *Pipeline) doSeek(startSec float64) {
	p.seekMu.Lock()
	defer p.seekMu.Unlock()

	if startSec < 0 {
		startSec = 0
	}
	if startSec > p.duration() {
		startSec = p.duration()
	}

	p.mu.Lock()
	if p.state == "idle" {
		p.playheadSec = startSec
		p.mu.Unlock()
		return
	}

	targetBlock := int(startSec / p.settings.BlockSec)

	// Reset failed count cho block đích và block kế cận trước tiên (ngay cả khi rơi vào Fast-path)
	delete(p.failedBlocks, targetBlock)
	delete(p.failedBlocks, targetBlock+1)

	// 1. Fast-path: Block đích đã có đầy đủ phụ đề trong cache và session đang chạy
	if p.session != nil && p.blockStore.IsBlockDone(targetBlock) {
		p.playheadSec = startSec
		p.state = "processing"
		p.triggerSchedule()
		p.mu.Unlock()
		return
	}

	// 2. Smart Fast-Path 2: Tua ngắn trong CÙNG block đang được xử lý (không áp dụng cho block kế cận)
	// Chỉ giữ session khi:
	// - Đúng block đích đang active: p.activeJobs[targetBlock] == true
	// - Block chưa từng bị hoãn Tier-2: !p.tier2Deferred[targetBlock]
	// - Đang ở mode "api" (Google GTX dịch 100% toàn bộ batch, không bao giờ break bỏ rơi câu)
	isSameBlockRunning := p.activeJobs[targetBlock] && !p.tier2Deferred[targetBlock]
	if p.session != nil && isSameBlockRunning && !p.isTier2PostponedMode() {
		p.playheadSec = startSec
		p.state = "processing"
		p.triggerSchedule()
		p.mu.Unlock()
		return
	}

	oldSession := p.session
	oldSessionID := int64(0)
	if oldSession != nil {
		oldSessionID = oldSession.id
	}

	tier2WasRunning := false
	tier2BlockIdx := -1
	for b := range p.activeJobs {
		bRange := ComputeBlockRange(b, p.settings.BlockSec, p.settings.OverlapSec, p.duration())
		isTier1 := bRange.OwnerStart <= startSec+15.0 && bRange.OwnerEnd >= startSec
		if !isTier1 {
			tier2WasRunning = true
			tier2BlockIdx = b
			break
		}
	}

	// Tách session cũ ra, dọn sạch activeJobs
	p.session = nil
	p.activeJobs = make(map[int]bool)
	p.tier2Deferred = make(map[int]bool)
	p.playheadSec = startSec
	p.state = "seeking"

	p.lastSeekTime = time.Now()
	p.lastSeekTargetSec = startSec
	p.lastSeekOldID = oldSessionID
	p.tier2RunningAtCancel = tier2WasRunning
	p.tier2BlockRunningIdx = tier2BlockIdx
	p.seekActive = true
	p.mu.Unlock() // <<< Thoát p.mu trước khi drain!

	// DRAIN NGOÀI p.mu: Worker cũ có thể Lock p.mu thoải mái để thoát
	var computeDrainMs, wgDrainMs int64
	if oldSession != nil {
		cancelT0 := time.Now()
		oldSession.cancel()

		drainDone := make(chan int64, 1)
		go func() {
			p.computeMu.Lock()
			d := time.Since(cancelT0).Milliseconds()
			p.computeMu.Unlock()
			drainDone <- d
		}()

		select {
		case computeDrainMs = <-drainDone:
			if IsTelemetryEnabled() {
				log.Printf("[telemetry] session cancel -> computeMu unlocked in %dms\n", computeDrainMs)
			}
		case <-time.After(3 * time.Second):
			computeDrainMs = -1
		}

		wgT0 := time.Now()
		done := make(chan struct{})
		go func() {
			oldSession.wg.Wait()
			close(done)
		}()

		select {
		case <-done:
		case <-time.After(3 * time.Second):
			log.Printf("[WARN] old session %d workers did not finish within 3s timeout", oldSessionID)
		}
		wgDrainMs = time.Since(wgT0).Milliseconds()
	}

	// Sau khi drain xong, gom lấy mốc thời gian tua mới nhất (nếu có lệnh tua mới gửi đến trong lúc drain)
	for {
		latestBits := p.pendingSeek.Swap(noPendingSeek)
		if latestBits == noPendingSeek {
			break
		}
		startSec = math.Float64frombits(latestBits)
		if startSec < 0 {
			startSec = 0
		}
		if startSec > p.duration() {
			startSec = p.duration()
		}
	}

	p.mu.Lock()
	p.lastSeekComputeDrain = computeDrainMs
	p.lastSeekWgDrain = wgDrainMs
	p.lastSeekTargetSec = startSec

	if p.state == "idle" {
		p.mu.Unlock()
		return
	}

	targetBlock = int(startSec / p.settings.BlockSec)
	delete(p.failedBlocks, targetBlock)
	delete(p.failedBlocks, targetBlock+1)

	newSessionID := atomic.AddInt64(&p.sessionID, 1)
	newCtx, newCancel := context.WithCancel(context.Background())
	newSession := &PipelineSession{
		id:     newSessionID,
		ctx:    newCtx,
		cancel: newCancel,
	}
	p.session = newSession
	p.lastSeekNewID = newSessionID
	p.sessionBlockCount = 0
	p.playheadSec = startSec
	p.state = "processing"

	if IsTelemetryEnabled() {
		log.Printf("[telemetry] seek initiated to %.2fs (old session=%d, new session=%d, tier2_was_running=%v, computeMu_drain=%dms, wg_drain=%dms)\n",
			startSec, oldSessionID, newSessionID, tier2WasRunning, computeDrainMs, wgDrainMs)
	}

	p.startSessionWorkers(newSession)
	p.mu.Unlock()
	p.triggerSchedule()
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
	p.seekMu.Lock()
	defer p.seekMu.Unlock()

	if p.seekStop != nil {
		select {
		case <-p.seekStop:
		default:
			close(p.seekStop)
		}
		p.seekStop = nil
	}

	p.stopCurrentSession()

	p.mu.Lock()
	p.state = "idle"
	p.pendingSeek.Store(noPendingSeek)
	p.mu.Unlock()
}

func (p *Pipeline) stopCurrentSession() (int64, int64) {
	p.mu.Lock()
	oldSession := p.session
	p.session = nil
	p.activeJobs = make(map[int]bool)
	p.mu.Unlock()

	var computeDrainMs, wgDrainMs int64
	if oldSession != nil {
		cancelT0 := time.Now()
		oldSession.cancel()

		// Đo thời gian chờ computeMu được nhả sau khi cancel
		drainDone := make(chan int64, 1)
		go func() {
			p.computeMu.Lock()
			d := time.Since(cancelT0).Milliseconds()
			p.computeMu.Unlock()
			drainDone <- d
		}()

		select {
		case computeDrainMs = <-drainDone:
			if IsTelemetryEnabled() {
				log.Printf("[telemetry] session cancel -> computeMu unlocked in %dms\n", computeDrainMs)
			}
		case <-time.After(3 * time.Second):
			computeDrainMs = -1
		}

		// Chờ tối đa 3 giây cho các worker thoát
		wgT0 := time.Now()
		done := make(chan struct{})
		go func() {
			oldSession.wg.Wait()
			close(done)
		}()

		select {
		case <-done:
		case <-time.After(3 * time.Second):
			log.Printf("[WARN] old session %d workers did not finish within 3s timeout", oldSession.id)
		}
		wgDrainMs = time.Since(wgT0).Milliseconds()
	}

	return computeDrainMs, wgDrainMs
}

func (p *Pipeline) LastSeekComputeDrain() int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.lastSeekComputeDrain
}

func (p *Pipeline) LastSeekWgDrain() int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.lastSeekWgDrain
}

// currentTranslatorMode trả về "api", "local_ai", hoặc "offline" để báo cáo lên giao diện người dùng
func (p *Pipeline) currentTranslatorMode() string {
	if m, ok := p.translator.(interface{ CurrentMode() string }); ok {
		return m.CurrentMode()
	}
	return "api"
}

// acquireComputeForLocalLLM giữ computeMu khi bộ dịch đang ở chế độ local_ai (Qwen chạy bằng CPU),
// để Whisper và LLM không chạy song song tranh core. Các chế độ api/cloud/offline không cần khóa.
// Chờ theo kiểu TryLock + ctx để không bị kẹt khi session bị hủy (tua video) trong lúc Whisper đang giữ khóa.
func (p *Pipeline) acquireComputeForLocalLLM(ctx context.Context) (release func(), ok bool) {
	if p.currentTranslatorMode() != "local_ai" {
		return func() {}, true
	}
	for !p.computeMu.TryLock() {
		select {
		case <-ctx.Done():
			return func() {}, false
		case <-time.After(5 * time.Millisecond):
		}
	}
	return p.computeMu.Unlock, true
}

func (p *Pipeline) isTier2PostponedMode() bool {
	m := p.currentTranslatorMode()
	return m == "local_ai" || m == "offline"
}

func (p *Pipeline) isTranslatorBlocked() bool {
	if h, ok := p.translator.(*FastHybridTranslator); ok {
		return h.isGtxBlocked()
	}
	return false
}

// translatorLabel cho biết bộ dịch đang dùng: "fastgtx" hoặc "fastgtx+llama_loaded" nếu fallback LLM đã được khởi động
func (p *Pipeline) translatorLabel() string {
	if h, ok := p.translator.(*FastHybridTranslator); ok && h.FallbackLoaded() {
		return "fastgtx+llama_loaded"
	}
	return "fastgtx"
}

// recordFirstSubLatency ghi seek_latency_ms khi câu phụ đề đầu tiên của session mới được đẩy lên UI (chỉ khi VT_TELEMETRY=1)
func (p *Pipeline) recordFirstSubLatency(sessionID int64, itemCount int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.seekActive || p.lastSeekNewID != sessionID || itemCount == 0 {
		return
	}
	RecordSeekTelemetry(SeekTelemetryRecord{
		Timestamp:          FormatTimeNow(),
		TargetSec:          p.lastSeekTargetSec,
		OldSessionID:       p.lastSeekOldID,
		NewSessionID:       p.lastSeekNewID,
		OldTier2WasRunning: p.tier2RunningAtCancel,
		OldBlockRunningIdx: p.tier2BlockRunningIdx,
		Tier2DrainMs:       p.lastSeekWgDrain,
		ComputeMuDrainMs:   p.lastSeekComputeDrain,
		FirstSubLatencyMs:  time.Since(p.lastSeekTime).Milliseconds(),
	})
	p.seekActive = false
}

func (p *Pipeline) startSessionWorkers(sess *PipelineSession) {
	slicerChan := make(chan SlicerJob, 2)
	audioChan := make(chan AudioJob, 2)
	textChan := make(chan TextJob, 2)

	// 1. Stage Slicer (1 worker)
	sess.wg.Add(1)
	go func() {
		defer sess.wg.Done()
		defer close(audioChan)
		p.slicerWorker(sess.ctx, slicerChan, audioChan)
	}()

	// 2. Stage STT (1 worker)
	sess.wg.Add(1)
	go func() {
		defer sess.wg.Done()
		defer close(textChan)
		p.sttWorker(sess.ctx, audioChan, textChan)
	}()

	// 3. Stage Translator (N workers)
	workers := p.settings.TranslateWorkers
	for i := 0; i < workers; i++ {
		sess.wg.Add(1)
		go func() {
			defer sess.wg.Done()
			p.translatorWorker(sess.ctx, textChan)
		}()
	}

	// 4. Scheduler loop điều phối
	sess.wg.Add(1)
	go func() {
		defer sess.wg.Done()
		defer close(slicerChan)
		p.schedulerLoop(sess.ctx, slicerChan, sess.id)
	}()
}

// schedulerLoop chọn block tiếp theo theo quy tắc lookahead và backfill
func (p *Pipeline) schedulerLoop(ctx context.Context, slicerChan chan<- SlicerJob, sessionID int64) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-p.wakeSched:
		case <-time.After(500 * time.Millisecond):
		}

		// BUG-08: thời lượng có thể được cập nhật giữa chừng (UpdateDuration) → tính lại mỗi vòng
		totalBlocks := int(math.Ceil(p.duration() / p.settings.BlockSec))

		p.mu.Lock()
		playheadBlock := int(p.playheadSec / p.settings.BlockSec)
		aheadSec := p.computeAheadSecLocked()

		// 1. Tìm block tiếp theo từ playheadBlock trở đi
		nextBlock := -1
		for b := playheadBlock; b < totalBlocks; b++ {
			if !p.blockStore.IsBlockDone(b) && !p.activeJobs[b] && p.failedBlocks[b] < 2 {
				// Nếu block đã hoàn thành Tier-1 và đang hoãn Tier-2: không lặp vô tận khi vẫn ở chế độ hoãn
				if p.tier2Deferred[b] && p.isTier2PostponedMode() {
					continue
				}
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
					if p.tier2Deferred[b] && p.isTier2PostponedMode() {
						continue
					}
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
		p.sessionBlockCount++
		orderInSession := p.sessionBlockCount
		p.mu.Unlock()

		p.emitStatus(nextBlock)

		sJob := SlicerJob{
			BlockIdx:       nextBlock,
			ScheduledAt:    time.Now(),
			OrderInSession: orderInSession,
			SessionID:      sessionID,
		}

		select {
		case <-ctx.Done():
			return
		case slicerChan <- sJob:
		}
	}
}

// slicerWorker cắt audio bằng ffmpeg
func (p *Pipeline) slicerWorker(ctx context.Context, inChan <-chan SlicerJob, outChan chan<- AudioJob) {
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
		case sJob, ok := <-inChan:
			if !ok {
				return
			}
			blockIdx := sJob.BlockIdx
			queueWaitMs := time.Since(sJob.ScheduledAt).Milliseconds()

			// BUG-08: thời lượng thật ngắn hơn ước lượng → bỏ các job đã xếp hàng nhưng nằm ngoài video
			if float64(blockIdx)*p.settings.BlockSec >= p.duration() {
				p.mu.Lock()
				delete(p.activeJobs, blockIdx)
				p.mu.Unlock()
				continue
			}

			bRange := ComputeBlockRange(blockIdx, p.settings.BlockSec, p.settings.OverlapSec, p.duration())
			wavPath := filepath.Join(p.tools.TempDir, fmt.Sprintf("block_%d_%d.wav", sJob.SessionID, blockIdx))

			tSlice0 := time.Now()
			var err error
			// Block đã có kết quả STT (ví dụ dịch bù Tier-2 / thử lại sau lỗi dịch): bỏ qua ffmpeg
			useCachedSTT := false
			if len(p.externalSegments) == 0 && p.blockStore != nil {
				_, useCachedSTT = p.blockStore.GetBlockItems(blockIdx)
			}
			if useCachedSTT {
				// không cắt WAV
			} else if len(p.externalSegments) > 0 && p.MockSliceAudio == nil {
				// Đã có sẵn file phụ đề gốc (.srt/.vtt) -> bỏ qua cắt WAV bằng ffmpeg
			} else if p.MockSliceAudio != nil {
				err = p.MockSliceAudio(ctx, p.videoPath, bRange, wavPath)
			} else {
				// Cắt audio bằng ffmpeg tối ưu Fast Seek:
				// ffmpeg -ss {startSec} -i {mediaInput} -t {durationSec} -vn -acodec pcm_s16le -ar 16000 -ac 1 -threads 2 -y {outputWav}
				var args []string
				sliceTimeout := 60 * time.Second
				mediaInput := ResolveMediaInput(p.videoPath)
				if IsDrivePath(p.videoPath) {
					// Đọc từ loopback proxy Drive: bật seekable và reconnect để ffmpeg seek HTTP Range nhanh chóng
					args = append(args, "-seekable", "1", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5")
					sliceTimeout = 120 * time.Second
				}
				args = append(args,
					"-ss", fmt.Sprintf("%.3f", bRange.ExtractStart),
					"-i", mediaInput,
					"-t", fmt.Sprintf("%.3f", bRange.ExtractLen),
					"-vn",
					"-acodec", "pcm_s16le",
					"-ar", "16000",
					"-ac", "1",
					"-threads", "2",
					"-y",
					wavPath,
				)
				_, err = RunCommand(ctx, p.tools.FFmpeg, args, sliceTimeout, nil)
			}
			sliceMs := time.Since(tSlice0).Milliseconds()

			if err != nil {
				if ctx.Err() != nil {
					return
				}
				p.handleBlockFailure(blockIdx, "slice", err, sJob.SessionID)
				continue
			}

			select {
			case <-ctx.Done():
				_ = os.Remove(wavPath)
				return
			case outChan <- AudioJob{
				BlockIdx:       blockIdx,
				WavPath:        wavPath,
				UseCachedSTT:   useCachedSTT,
				Range:          bRange,
				SliceMs:        sliceMs,
				ScheduledAt:    sJob.ScheduledAt,
				QueueWaitMs:    queueWaitMs,
				OrderInSession: sJob.OrderInSession,
				SessionID:      sJob.SessionID,
			}:
			}
		}
	}
}

// shouldParseWhisperTimings: stderr của Whisper chỉ cần phân tích (9 regexp) khi bật telemetry
// hoặc khi còn đang tự nhận diện ngôn ngữ (-l auto) để lấy ngôn ngữ + xác suất cho detect-once.
// Khi đã chốt ngôn ngữ cố định, bỏ qua bước này ở mọi block.
func shouldParseWhisperTimings(lang string) bool {
	return IsTelemetryEnabled() || lang == "auto"
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

			if job.UseCachedSTT {
				cached, ok := p.blockStore.GetBlockItems(job.BlockIdx)
				if !ok {
					p.handleBlockFailure(job.BlockIdx, "stt", errors.New("cached STT result disappeared"), job.SessionID)
					continue
				}
				p.mu.Lock()
				cachedLang := p.detectedOnceLang
				p.mu.Unlock()
				if p.callbacks.OnChunk != nil {
					p.callbacks.OnChunk(SubtitleChunkPayload{
						Video: p.videoPath,
						Block: job.BlockIdx,
						Items: cached,
						Final: false,
					})
					p.recordFirstSubLatency(job.SessionID, len(cached))
				}
				select {
				case <-ctx.Done():
					return
				case outChan <- TextJob{
					BlockIdx:       job.BlockIdx,
					Items:          cached,
					Range:          job.Range,
					SliceMs:        job.SliceMs,
					DetectedLang:   cachedLang,
					ScheduledAt:    job.ScheduledAt,
					QueueWaitMs:    job.QueueWaitMs,
					OrderInSession: job.OrderInSession,
					SessionID:      job.SessionID,
					WhisperLangArg: "cache",
					VariantName:    os.Getenv("VT_VARIANT_NAME"),
					STTCacheHit:    true,
				}:
				}
				continue
			}

			tStt0 := time.Now()
			var segments []WhisperSegment
			var err error

			var detectedLang string
			var computeWaitMs int64
			var whisperWallMs int64
			var whisperTimings WhisperTimings
			var langArg string
			threads := GetWhisperThreadsConfig(p.settings.WhisperThreads)

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
				// Xử lý tùy chọn ngôn ngữ nguồn:
				// - "vi": chạy cờ -l vi
				// - "en": chạy cờ -l en
				// - "auto" (mặc định): chạy cờ -l auto để tự động phát hiện ngôn ngữ
				lang := strings.ToLower(strings.TrimSpace(p.settings.SourceLang))
				switch lang {
				case "vi", "vietnamese":
					lang = "vi"
					detectedLang = "vi"
				case "en", "english":
					lang = "en"
					detectedLang = "en"
				default:
					// "auto" (mặc định): áp dụng cơ chế detect-once
					// Sau khi block đầu tiên phát hiện được ngôn ngữ, truyền thẳng mã ngôn ngữ đó
					// cho các block tiếp theo để loại bỏ bước chạy encode nhận diện ngôn ngữ dư thừa.
					p.mu.Lock()
					if p.detectedOnceLang != "" {
						lang = p.detectedOnceLang
						detectedLang = p.detectedOnceLang
					} else {
						lang = "auto"
					}
					p.mu.Unlock()
				}

				if envLang := strings.ToLower(strings.TrimSpace(os.Getenv("VT_WHISPER_LANG"))); envLang != "" && envLang != "detect-once" {
					lang = envLang
					detectedLang = envLang
				}
				langArg = lang

				jsonOutPath := job.WavPath + ".json"
				args := []string{
					"-m", p.tools.WhisperModel,
					"-f", job.WavPath,
					"-l", lang,
					"-t", fmt.Sprintf("%d", threads),
					"-bs", "1",
					"-bo", "1",
					"-nf",
				}
				if !IsTelemetryEnabled() {
					args = append(args, "-np")
				}
				args = append(args, "-oj", "-of", job.WavPath)

				tAcquire0 := time.Now()
				p.computeMu.Lock()
				computeWaitMs = time.Since(tAcquire0).Milliseconds()

				tWhisper0 := time.Now()
				runRes, cmdErr := RunCommand(ctx, p.tools.WhisperCLI, args, 5*time.Minute, nil)
				whisperWallMs = time.Since(tWhisper0).Milliseconds()
				p.computeMu.Unlock()

				err = cmdErr
				if runRes != nil && runRes.FullStderr != "" && shouldParseWhisperTimings(lang) {
					whisperTimings = ParseWhisperTimings(runRes.FullStderr)
					SaveWhisperStderrSample(runRes.FullStderr)
					if whisperTimings.DetectedLang != "" && (detectedLang == "" || detectedLang == "auto") {
						detectedLang = whisperTimings.DetectedLang
					}
				}

				if err == nil {
					data, readErr := os.ReadFile(jsonOutPath)
					if readErr == nil {
						var parsedLang string
						segments, parsedLang, err = ParseWhisperJSONResult(data, job.Range.ExtractStart)
						if parsedLang != "" {
							detectedLang = parsedLang
						}
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
					RecordBlockTelemetry(BlockTelemetryRecord{
						SessionID:           job.SessionID,
						BlockIndex:          job.BlockIdx,
						BlockStartSec:       job.Range.OwnerStart,
						BlockLenSec:         job.Range.OwnerEnd - job.Range.OwnerStart,
						BlockOrderInSession: job.OrderInSession,
						WhisperThreads:      threads,
						FfmpegCutMs:         job.SliceMs,
						WhisperWallMs:       whisperWallMs,
						QueueWaitMs:         job.QueueWaitMs,
						ComputeWaitMs:       computeWaitMs,
						BlockTotalMs:        time.Since(job.ScheduledAt).Milliseconds(),
						Cancelled:           true,
					})
					return
				}
				p.handleBlockFailure(job.BlockIdx, "stt", err, job.SessionID)
				continue
			}

			// Lọc theo quy tắc điểm giữa, bỏ ảo giác
			filtered := FilterAndDeduplicateSegments(segments, job.Range)

			// Chỉ chốt detectedOnceLang khi block có câu thoại thực sự sau khi lọc ảo giác
			// và xác suất nhận diện ngôn ngữ (nếu có) không quá thấp (>= 0.25), tránh chốt nhầm ngôn ngữ ở block intro nhạc không lời.
			if len(filtered) > 0 && detectedLang != "" && detectedLang != "auto" {
				confident := whisperTimings.DetectedLangP == nil || *whisperTimings.DetectedLangP >= 0.25
				if confident {
					p.mu.Lock()
					if p.detectedOnceLang == "" {
						p.detectedOnceLang = detectedLang
					}
					p.mu.Unlock()
				}
			}

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

				p.recordFirstSubLatency(job.SessionID, len(items))
			}

			select {
			case <-ctx.Done():
				return
			case outChan <- TextJob{
				BlockIdx:       job.BlockIdx,
				Items:          items,
				Range:          job.Range,
				SliceMs:        job.SliceMs,
				SttMs:          sttMs,
				DetectedLang:   detectedLang,
				ScheduledAt:    job.ScheduledAt,
				QueueWaitMs:    job.QueueWaitMs,
				ComputeWaitMs:  computeWaitMs,
				WhisperWallMs:  whisperWallMs,
				WhisperTimings: whisperTimings,
				OrderInSession: job.OrderInSession,
				SessionID:      job.SessionID,
				WhisperThreads: threads,
				WhisperLangArg: langArg,
				VariantName:    os.Getenv("VT_VARIANT_NAME"),
			}:
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

			// ZERO-COST TRANSLATION BYPASS:
			// Nếu ngôn ngữ nguồn được xác định là Tiếng Việt ("vi"), hoặc văn bản nhận diện là tiếng Việt:
			// BỎ QUA 100% bước dịch (tuyệt đối không gọi FastGTX hay Local LLM).
			isVietnamese := strings.ToLower(strings.TrimSpace(p.settings.SourceLang)) == "vi" ||
				job.DetectedLang == "vi"
			if !isVietnamese && len(job.Items) > 0 {
				viCount := 0
				for _, it := range job.Items {
					if IsVietnameseText(it.SourceText) {
						viCount++
					}
				}
				if viCount > 0 && viCount >= (len(job.Items)+1)/2 {
					isVietnamese = true
				}
			}

			if isVietnamese {
				for itemIdx := range translatedItems {
					translatedItems[itemIdx].TargetText = translatedItems[itemIdx].SourceText
					translatedItems[itemIdx].Translated = true
				}

				// Ghi nhận chỉ số: Trans 0ms, 100% on-time
				p.recordBatchMetrics(0, int64(len(job.Items)), int64(len(job.Items)))

				p50, p95, onTimePct := p.getMetricsSummary()
				totalMs := job.SliceMs + job.SttMs
				fmt.Printf("[BLOCK %d | %s] Slice: %dms | STT: %dms (%d lines) | Trans: 0ms (Bypass VN) | Batch p50=%dms p95=%dms | On-time: %.0f%% | Total: %dms\n",
					job.BlockIdx, tierLabel, job.SliceMs, job.SttMs, len(job.Items), p50, p95, onTimePct, totalMs)

				_ = p.blockStore.SaveBlock(job.BlockIdx, translatedItems)

				sourceType := "local"
				if IsDrivePath(p.videoPath) {
					sourceType = "drive"
				}
				tierNum := 2
				if isTier1Block {
					tierNum = 1
				}
				charCount := 0
				for _, it := range job.Items {
					charCount += len(it.SourceText)
				}
				RecordBlockTelemetry(BlockTelemetryRecord{
					SessionID:             job.SessionID,
					BlockIndex:            job.BlockIdx,
					BlockStartSec:         job.Range.OwnerStart,
					BlockLenSec:           job.Range.OwnerEnd - job.Range.OwnerStart,
					OverlapSec:            p.settings.OverlapSec,
					Tier:                  tierNum,
					SourceType:            sourceType,
					BlockOrderInSession:   job.OrderInSession,
					WhisperThreads:        job.WhisperThreads,
					WhisperLangArg:        job.WhisperLangArg,
					VariantName:           job.VariantName,
					CacheHit:              false,
					FfmpegCutMs:           job.SliceMs,
					WhisperWallMs:         job.WhisperWallMs,
					WhisperLoadMs:         job.WhisperTimings.LoadMs,
					WhisperEncodeMs:       job.WhisperTimings.EncodeMs,
					WhisperEncodeRuns:     job.WhisperTimings.Encode.Runs,
					WhisperEncodeMsPerRun: job.WhisperTimings.Encode.MsPerRun,
					WhisperDecodeMs:       job.WhisperTimings.DecodeMs,
					WhisperDecodeRuns:     job.WhisperTimings.Decode.Runs,
					WhisperDecodeMsPerRun: job.WhisperTimings.Decode.MsPerRun,
					WhisperTotalMs:        job.WhisperTimings.TotalMs,
					WhisperLangDetected:   job.WhisperTimings.DetectedLang,
					WhisperLangP:          job.WhisperTimings.DetectedLangP,
					WavLenSec:             job.WhisperTimings.WavLenSec,
					WhisperTimingsParsed:  job.WhisperTimings.Parsed,
					TranslateMs:           0,
					TranslatorUsed:        "bypass_vn",
					SentenceCount:         len(job.Items),
					CharCount:             charCount,
					QueueWaitMs:           job.QueueWaitMs,
					ComputeWaitMs:         job.ComputeWaitMs,
					BlockTotalMs:          time.Since(job.ScheduledAt).Milliseconds(),
					Cancelled:             false,
				})

				p.mu.Lock()
				if p.session != nil && p.session.id == job.SessionID {
					delete(p.activeJobs, job.BlockIdx)
				}
				p.mu.Unlock()

				// Phát phụ đề tiếng Việt hoàn tất ngay lập tức (Final=true)
				if p.callbacks.OnChunk != nil {
					p.callbacks.OnChunk(SubtitleChunkPayload{
						Video: p.videoPath,
						Block: job.BlockIdx,
						Items: translatedItems,
						Final: true,
					})

					p.recordFirstSubLatency(job.SessionID, len(translatedItems))
				}

				p.triggerSchedule()
				continue
			}

			okCount := 0
			// Chỉ dịch những câu chưa có bản dịch (block đọc lại từ BlockStore có thể đã dịch dở Tier-1)
			var pendingIdx []int
			for i, it := range job.Items {
				if it.Translated && it.TargetText != "" {
					if strings.TrimSpace(it.SourceText) != "" && !isIgnoredSubtitle(it.SourceText) {
						okCount++
					}
					continue
				}
				pendingIdx = append(pendingIdx, i)
			}
			if p.translator != nil && len(pendingIdx) > 0 {
				pendingItems := make([]SubtitleItem, len(pendingIdx))
				for k, i := range pendingIdx {
					pendingItems[k] = job.Items[i]
				}
				batches, nTier1 := BuildTwoTierBatches(pendingItems, curPlayhead, isTier1Block)
				for b := range batches {
					for k := range batches[b] {
						batches[b][k] = pendingIdx[batches[b][k]]
					}
				}

				for bIdx := 0; bIdx < len(batches); bIdx++ {
					if ctx.Err() != nil {
						return
					}

					// Pacing theo từng batch: các batch Tier-2 (bIdx >= nTier1) nhường nhịp nghỉ có jitter để chống burst
					if bIdx >= nTier1 {
						// Nếu đang ở chế độ local_ai/offline: hoãn Tier-2 để dành 100% tài nguyên CPU/GPU cho Whisper STT và Tier-1
						if p.isTier2PostponedMode() {
							break
						}
						// Người dùng có thể đã tua ngắn trong block này (Smart Fast-Path 2 giữ nguyên session)
						// kể từ lúc chia batch: đọc lại playhead, đưa batch chứa câu sắp phát lên trước
						// và bỏ nhịp nghỉ để hiện phụ đề ngay.
						p.mu.Lock()
						nowPlayhead := p.playheadSec
						p.mu.Unlock()
						urgent := false
						if k := pickUrgentBatch(job.Items, batches, bIdx, nowPlayhead); k >= 0 {
							if k != bIdx {
								batches[bIdx], batches[k] = batches[k], batches[bIdx]
							}
							urgent = true
						}
						if !urgent && bIdx > 0 && p.MockRunSTT == nil {
							if !sleepCtx(ctx, jitter(300*time.Millisecond)) {
								return
							}
						}
					}
					indices := batches[bIdx]

					batchLines := make([]string, len(indices))
					for k, itemIdx := range indices {
						batchLines[k] = job.Items[itemIdx].SourceText
					}

					// Local LLM chạy trên CPU: xếp hàng sau Whisper qua computeMu để 2 tiến trình
					// không tranh nhau toàn bộ core (nhả ngay khi người dùng tua / hủy session).
					releaseCompute, gotCompute := p.acquireComputeForLocalLLM(ctx)
					if !gotCompute {
						return
					}
					tBatch0 := time.Now()
					targets, _ := p.translator.TranslateBatch(ctx, batchLines)
					batchMs := time.Since(tBatch0).Milliseconds()
					releaseCompute()

					if ctx.Err() != nil {
						return
					}

					p.mu.Lock()
					nowPlayhead := p.playheadSec
					p.mu.Unlock()

					updatedSlice := make([]SubtitleItem, 0, len(indices))
					batchOnTime := int64(0)
					for k, itemIdx := range indices {
						// Giữ kết quả dịch ngay cả khi err != nil (targets vẫn chứa các dòng lấy từ cache)
						if k < len(targets) && targets[k] != "" {
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

						p.recordFirstSubLatency(job.SessionID, len(updatedSlice))
					}
				}
			}
			transMs := time.Since(tTrans0).Milliseconds()

			// Đếm tổng số câu có văn bản cần dịch trong block
			hasTextCount := 0
			for _, it := range job.Items {
				if strings.TrimSpace(it.SourceText) != "" && !isIgnoredSubtitle(it.SourceText) {
					hasTextCount++
				}
			}

			// Nếu chưa dịch xong toàn bộ các câu có text:
			if okCount < hasTextCount {
				p.mu.Lock()
				var retryCount int
				if p.session != nil && p.session.id == job.SessionID {
					if p.isTier2PostponedMode() {
						// Đang ở chế độ hoãn (local_ai/offline): Đánh dấu hoãn block để scheduler không lặp lại vô ích
						p.tier2Deferred[job.BlockIdx] = true
					} else {
						// Đang ở chế độ api/cloud: Tăng failedBlocks để scheduler không lặp vô tận (tối đa 2 lần thử lại)
						p.failedBlocks[job.BlockIdx]++
						retryCount = p.failedBlocks[job.BlockIdx]
					}
				}
				p.mu.Unlock()

				if retryCount > 0 && p.callbacks.OnError != nil {
					p.callbacks.OnError(PipelineError{
						Block:   job.BlockIdx,
						Stage:   "translate",
						Message: fmt.Sprintf("Dịch block %d không đầy đủ ở lần thử %d (%d/%d câu thành công)", job.BlockIdx, retryCount, okCount, hasTextCount),
						Fatal:   retryCount >= 2,
						Video:   p.videoPath,
					})
				}
			} else {
				p.mu.Lock()
				if p.session != nil && p.session.id == job.SessionID {
					delete(p.failedBlocks, job.BlockIdx)
				}
				p.mu.Unlock()
			}

			p50, p95, onTimePct := p.getMetricsSummary()
			totalMs := job.SliceMs + job.SttMs + transMs
			fmt.Printf("[BLOCK %d | %s] Slice: %dms | STT: %dms (%d lines) | Trans: %dms (%d/%d ok) | Batch p50=%dms p95=%dms | On-time: %.0f%% | Total: %dms\n",
				job.BlockIdx, tierLabel, job.SliceMs, job.SttMs, len(job.Items), transMs, okCount, len(job.Items), p50, p95, onTimePct, totalMs)

			if okCount == 0 && len(job.Items) > 0 {
				log.Printf("[WARN] [BLOCK %d] Translation produced 0 successful lines out of %d items (mode=%s, blocked=%v)",
					job.BlockIdx, len(job.Items), p.currentTranslatorMode(), p.isTranslatorBlocked())
			}

			// Lưu vào cache
			_ = p.blockStore.SaveBlock(job.BlockIdx, translatedItems)

			sourceType := "local"
			if IsDrivePath(p.videoPath) {
				sourceType = "drive"
			}
			tierNum := 2
			if isTier1Block {
				tierNum = 1
			}
			charCount := 0
			for _, it := range job.Items {
				charCount += len(it.SourceText)
			}
			RecordBlockTelemetry(BlockTelemetryRecord{
				SessionID:             job.SessionID,
				BlockIndex:            job.BlockIdx,
				BlockStartSec:         job.Range.OwnerStart,
				BlockLenSec:           job.Range.OwnerEnd - job.Range.OwnerStart,
				OverlapSec:            p.settings.OverlapSec,
				Tier:                  tierNum,
				SourceType:            sourceType,
				BlockOrderInSession:   job.OrderInSession,
				WhisperThreads:        job.WhisperThreads,
				WhisperLangArg:        job.WhisperLangArg,
				VariantName:           job.VariantName,
				CacheHit:              job.STTCacheHit,
				FfmpegCutMs:           job.SliceMs,
				WhisperWallMs:         job.WhisperWallMs,
				WhisperLoadMs:         job.WhisperTimings.LoadMs,
				WhisperEncodeMs:       job.WhisperTimings.EncodeMs,
				WhisperEncodeRuns:     job.WhisperTimings.Encode.Runs,
				WhisperEncodeMsPerRun: job.WhisperTimings.Encode.MsPerRun,
				WhisperDecodeMs:       job.WhisperTimings.DecodeMs,
				WhisperDecodeRuns:     job.WhisperTimings.Decode.Runs,
				WhisperDecodeMsPerRun: job.WhisperTimings.Decode.MsPerRun,
				WhisperTotalMs:        job.WhisperTimings.TotalMs,
				WhisperLangDetected:   job.WhisperTimings.DetectedLang,
				WhisperLangP:          job.WhisperTimings.DetectedLangP,
				WavLenSec:             job.WhisperTimings.WavLenSec,
				WhisperTimingsParsed:  job.WhisperTimings.Parsed,
				TranslateMs:           transMs,
				TranslatorUsed:        p.translatorLabel(),
				SentenceCount:         len(job.Items),
				CharCount:             charCount,
				QueueWaitMs:           job.QueueWaitMs,
				ComputeWaitMs:         job.ComputeWaitMs,
				BlockTotalMs:          time.Since(job.ScheduledAt).Milliseconds(),
				Cancelled:             false,
			})

			p.mu.Lock()
			if p.session != nil && p.session.id == job.SessionID {
				if p.blockStore.IsBlockDone(job.BlockIdx) {
					delete(p.tier2Deferred, job.BlockIdx)
				}
				delete(p.activeJobs, job.BlockIdx)
			}
			p.mu.Unlock()

			// Phát bản dịch tiếng Việt hoàn tất (Final=true)
			if p.callbacks.OnChunk != nil {
				p.callbacks.OnChunk(SubtitleChunkPayload{
					Video: p.videoPath,
					Block: job.BlockIdx,
					Items: translatedItems,
					Final: true,
				})

				p.recordFirstSubLatency(job.SessionID, len(translatedItems))
			}

			p.triggerSchedule()
		}
	}
}

func (p *Pipeline) handleBlockFailure(blockIdx int, stage string, err error, sessionID int64) {
	if errors.Is(err, context.Canceled) {
		return
	}

	p.mu.Lock()
	if p.session == nil || p.session.id != sessionID || p.session.ctx.Err() != nil {
		p.mu.Unlock()
		return
	}
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

// inPlayWindow: câu nằm trong vùng ưu tiên Tier-1 [playhead-1s, playhead+15s].
func inPlayWindow(it SubtitleItem, playheadSec float64) bool {
	return it.EndSec >= playheadSec-1.0 && it.StartSec <= playheadSec+15.0
}

// pickUrgentBatch trả về chỉ số batch đầu tiên trong batches[from:] có chứa câu thuộc vùng Tier-1
// tính theo playhead HIỆN TẠI (có thể chính là from), hoặc -1 nếu không có batch nào.
func pickUrgentBatch(items []SubtitleItem, batches [][]int, from int, playheadSec float64) int {
	for k := from; k < len(batches); k++ {
		for _, idx := range batches[k] {
			if inPlayWindow(items[idx], playheadSec) {
				return k
			}
		}
	}
	return -1
}

// BuildTwoTierBatches chia danh sách câu trong block theo mô hình Two-Tier Lookahead:
// - Tier 1 (High Priority): Ưu tiên gom cụm nhỏ (tối đa 3 câu / 240 ký tự) cho các câu nằm trong vùng [playheadSec - 1s, playheadSec + 15s] để hiển thị tức thì.
// - Tier 2 (Low Priority): Các câu phía trước (ahead) dịch trước, các câu đã qua (behind) dịch sau. Giảm batch còn 5 câu / 400 ký tự để giảm tỉ lệ lệch dòng.
// Trả về: danh sách batches và nTier1 (số lượng batch Tier-1 đầu tiên).
func BuildTwoTierBatches(items []SubtitleItem, playheadSec float64, isTier1Block bool) (batches [][]int, nTier1 int) {
	if len(items) == 0 {
		return nil, 0
	}

	var tier1, ahead, behind []int
	for i, it := range items {
		switch {
		case isTier1Block && inPlayWindow(it, playheadSec):
			tier1 = append(tier1, i)
		case isTier1Block && it.EndSec < playheadSec-1.0:
			behind = append(behind, i)
		default:
			ahead = append(ahead, i)
		}
	}
	tier2 := append(ahead, behind...)

	pack := func(idxs []int, maxLines, maxChars int) {
		if len(idxs) == 0 {
			return
		}
		lines := make([]string, len(idxs))
		for k, i := range idxs {
			lines[k] = items[i].SourceText
		}
		for _, sb := range SplitLinesIntoControlledBatches(lines, maxLines, maxChars) {
			real := make([]int, len(sb))
			for k, local := range sb {
				real[k] = idxs[local]
			}
			batches = append(batches, real)
		}
	}

	pack(tier1, 3, 240)
	nTier1 = len(batches)
	pack(tier2, 5, 400)
	return batches, nTier1
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
