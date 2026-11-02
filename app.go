package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App struct chính được bind với Wails frontend
type App struct {
	ctx            context.Context
	mu             sync.Mutex
	settings       Settings
	settingsPath   string
	tools          *ToolsPaths
	mediaServer    *MediaServer
	currentVideo   string
	currentInfo    *VideoInfo
	currentStore   *BlockStore
	currentPipe    *Pipeline
	currentTrans   Translator
	downloader     *ModelDownloader
	updater        *Updater

	// Chuyển mã nền để phát hình (xem playback.go). Bảo vệ bởi mu.
	playbackCancel context.CancelFunc
	playbackPath   string
	spool          *DriveSpool
}

// NewApp tạo struct App và nạp cấu hình settings
func NewApp() *App {
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		localAppData = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
	}
	subtransDir := filepath.Join(localAppData, "SubTrans")
	_ = os.MkdirAll(subtransDir, 0755)

	settingsPath := filepath.Join(subtransDir, "settings.json")
	defaultSettings := Settings{
		BlockSec:         30.0,
		OverlapSec:       2.0,
		LookaheadMinSec:  45.0,
		LookaheadMaxSec:  180.0,
		TranslateWorkers: 1,
		WhisperThreads:   4,
		SourceLang:       "auto",
		Translator:       "cli",
		GeminiModel:      DefaultGeminiModel,
	}

	if data, err := os.ReadFile(settingsPath); err == nil {
		_ = json.Unmarshal(data, &defaultSettings)
	}
	if defaultSettings.SourceLang == "" {
		defaultSettings.SourceLang = "auto"
	}
	if defaultSettings.GeminiModel == "" {
		defaultSettings.GeminiModel = DefaultGeminiModel
	}
	if defaultSettings.GeminiAPIKey == "" {
		if envKey := strings.TrimSpace(os.Getenv("GEMINI_API_KEY")); envKey != "" {
			defaultSettings.GeminiAPIKey = envKey
		}
	}
	if !defaultSettings.GeminiEnabled {
		if envEnabled := os.Getenv("GEMINI_ENABLED"); envEnabled == "true" || envEnabled == "1" {
			defaultSettings.GeminiEnabled = true
		}
	}

	return &App{
		settings:     defaultSettings,
		settingsPath: settingsPath,
		downloader:   NewModelDownloader(),
		updater:      NewUpdater(),
		spool:        NewDriveSpool("", 0, GetDriveManager()),
	}
}

// startup được gọi khi Wails khởi động
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.tools = GetToolsPaths()
	if a.downloader != nil {
		a.downloader.SetContext(ctx)
	}
	if a.updater != nil {
		a.updater.SetContext(ctx)
	}
	ms, err := GetMediaServer()
	if err == nil {
		a.mediaServer = ms
	}
	GetDriveManager().SetContext(ctx)
	// Dọn dẹp ngầm các thư mục cache phụ đề cũ quá 30 ngày không sử dụng
	go CleanupOldCaches(30 * 24 * time.Hour)
}

// shutdown được gọi khi Wails đóng ứng dụng
func (a *App) shutdown(ctx context.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.cancelPlaybackLocked()
	if a.currentPipe != nil {
		a.currentPipe.Stop()
	}
	if a.currentTrans != nil {
		_ = a.currentTrans.Close()
	}
	if a.spool != nil {
		a.spool.Close()
	}
}

// SelectVideoFile mở hộp thoại chọn file video
func (a *App) SelectVideoFile() (string, error) {
	selected, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Chọn tập tin video",
		Filters: []runtime.FileFilter{
			{
				DisplayName: "Video & Subtitle Files (*.mp4;*.mkv;*.webm;*.avi;*.mov;*.srt;*.vtt)",
				Pattern:     "*.mp4;*.mkv;*.webm;*.avi;*.mov;*.srt;*.vtt",
			},
			{
				DisplayName: "All Files (*.*)",
				Pattern:     "*.*",
			},
		},
	})
	if err != nil {
		return "", fmt.Errorf("không thể mở hộp thoại chọn file: %w", err)
	}
	return selected, nil
}

// SelectVideoFolder mở hộp thoại chọn thư mục khóa học/video và quét cây thư mục
func (a *App) SelectVideoFolder() (*FolderNode, error) {
	selected, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Chọn thư mục chứa video / khóa học",
	})
	if err != nil {
		return nil, fmt.Errorf("không thể mở hộp thoại chọn thư mục: %w", err)
	}
	if selected == "" {
		return nil, nil
	}
	return a.ScanVideoFolder(selected)
}

// ScanVideoFolder quét đệ quy thư mục (hoặc file đơn lẻ, hoặc thư mục Drive) để dựng cây bài học video
func (a *App) ScanVideoFolder(targetPath string) (*FolderNode, error) {
	if strings.HasPrefix(targetPath, "gdrive_folder://") {
		folderID := strings.TrimPrefix(targetPath, "gdrive_folder://")
		return a.ScanDriveFolder(folderID, "")
	}

	cleaned := filepath.Clean(targetPath)
	fi, err := os.Stat(cleaned)
	if err != nil {
		return nil, fmt.Errorf("không thể truy cập đường dẫn: %w", err)
	}

	if !fi.IsDir() {
		cleaned = ResolveVideoFromSubtitlePath(cleaned)
		if !isSupportedVideoExt(cleaned) {
			return nil, fmt.Errorf("tập tin không phải định dạng video hỗ trợ")
		}
		return &FolderNode{
			Name:     filepath.Base(cleaned),
			Path:     cleaned,
			IsDir:    false,
			HasCache: HasCachedSubtitles(cleaned) || FindExternalSubtitleFile(cleaned) != "" || FindExternalVietnameseSubtitleFile(cleaned) != "",
		}, nil
	}

	node, ok := scanDirRecursive(cleaned, 0)
	if !ok {
		return nil, fmt.Errorf("không tìm thấy tập tin video nào trong thư mục: %s", filepath.Base(cleaned))
	}
	return &node, nil
}

func isSupportedVideoExt(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".mp4", ".mkv", ".webm", ".avi", ".mov":
		return true
	default:
		return false
	}
}

func scanDirRecursive(dirPath string, depth int) (FolderNode, bool) {
	node := FolderNode{
		Name:  filepath.Base(dirPath),
		Path:  dirPath,
		IsDir: true,
	}
	if depth > 8 {
		return node, false
	}

	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return node, false
	}

	var dirs []FolderNode
	var files []FolderNode

	// BUG-10: dùng danh sách entries đã đọc để tra phụ đề đi kèm, không os.Stat/os.ReadDir lại cho từng video
	subIdx := newExternalSubtitleIndex(dirPath, entries)

	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		fullPath := filepath.Join(dirPath, name)
		if entry.IsDir() {
			lower := strings.ToLower(name)
			if lower == "node_modules" || lower == "$recycle.bin" || lower == "system volume information" {
				continue
			}
			if childDir, hasVideo := scanDirRecursive(fullPath, depth+1); hasVideo {
				dirs = append(dirs, childDir)
			}
		} else if isSupportedVideoExt(name) {
			files = append(files, FolderNode{
				Name:     name,
				Path:     fullPath,
				IsDir:    false,
				HasCache: HasCachedSubtitles(fullPath) || subIdx.HasExternalSubtitle(name),
			})
		}
	}

	sort.Slice(dirs, func(i, j int) bool {
		return naturalLess(dirs[i].Name, dirs[j].Name)
	})
	sort.Slice(files, func(i, j int) bool {
		return naturalLess(files[i].Name, files[j].Name)
	})

	node.Children = append(dirs, files...)
	return node, len(node.Children) > 0
}

// naturalLess so sánh chuỗi theo thứ tự tự nhiên (ví dụ: "Bài 2" đứng trước "Bài 10")
func naturalLess(a, b string) bool {
	ra := []rune(strings.ToLower(a))
	rb := []rune(strings.ToLower(b))
	ia, ib := 0, 0

	for ia < len(ra) && ib < len(rb) {
		if unicode.IsDigit(ra[ia]) && unicode.IsDigit(rb[ib]) {
			ja := ia
			for ja < len(ra) && unicode.IsDigit(ra[ja]) {
				ja++
			}
			jb := ib
			for jb < len(rb) && unicode.IsDigit(rb[jb]) {
				jb++
			}
			na, _ := strconv.ParseUint(string(ra[ia:ja]), 10, 64)
			nb, _ := strconv.ParseUint(string(rb[ib:jb]), 10, 64)
			if na != nb {
				return na < nb
			}
			ia = ja
			ib = jb
			continue
		}
		if ra[ia] != rb[ib] {
			return ra[ia] < rb[ib]
		}
		ia++
		ib++
	}
	return len(ra) < len(rb)
}

// OpenVideo nạp video, lấy probe thông tin và chuẩn bị URL streaming (hỗ trợ cả file local và link gdrive://)
func (a *App) OpenVideo(path string) (VideoInfo, error) {
	// Video Google Drive từ cây bài học: đi chung đường với mở trực tiếp (OpenDriveVideo),
	// các lệnh gọi mạng (phụ đề, thời lượng) chạy NGOÀI a.mu để không khoá app.
	if IsDrivePath(path) {
		fileID := DriveFileIDFromPath(path)
		dm := GetDriveManager()
		return a.OpenDriveVideo(fileID, DriveDisplayName(path), dm.SubtitleIDFor(fileID))
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	path = ResolveVideoFromSubtitlePath(path)

	return a.openMediaLocked(path, path, "", "", 0)
}

// openMediaLocked là lõi chung của OpenVideo / OpenDriveVideo (caller phải giữ a.mu).
//   - path:          định danh video (đường dẫn local hoặc gdrive://<id>), dùng cho BlockStore/Pipeline
//   - probeInput:    đầu vào cho ffprobe (đường dẫn local hoặc URL proxy)
//   - directURL:     URL phát sẵn cho thẻ <video>; rỗng thì đăng ký file local vào MediaServer
//   - title:         tên hiển thị tùy chọn
//   - knownDuration: thời lượng đã biết (ví dụ từ metadata Google Drive); nếu > 0 sẽ bypass ffprobe
func (a *App) openMediaLocked(path, probeInput, directURL, title string, knownDuration float64) (VideoInfo, error) {
	if a.currentPipe != nil {
		tStop := time.Now()
		a.currentPipe.Stop()
		a.currentPipe = nil
		if ms := time.Since(tStop).Milliseconds(); ms > 200 {
			DiagLog("[open] dừng pipeline của video trước mất %dms", ms)
		}
	}

	// Hủy job chuyển mã của video trước (nếu đang chạy)
	a.cancelPlaybackLocked()
	if a.spool != nil {
		a.spool.CancelActive()
	}

	a.currentVideo = path

	// Kiểm tra công cụ phụ trợ
	missing := CheckTools()
	if len(missing) > 0 {
		return VideoInfo{}, fmt.Errorf("thiếu công cụ hoặc model phụ trợ: %s", strings.Join(missing, ", "))
	}

	var durationSec float64
	playable := true
	playableReason := ""
	var probe *ProbeResult

	if knownDuration > 0 {
		durationSec = knownDuration
	} else if IsDrivePath(path) {
		// Video Google Drive: tuyệt đối KHÔNG gọi ffprobe làm nghẽn mạng / timeout!
		// Trình duyệt (thẻ <video>) sẽ phát qua HTTP Range và lấy duration chính xác qua loadedmetadata.
		// Nếu codec không phát được, frontend nhận lỗi MediaError và gọi PreparePlayback.
		durationSec = 3600
		playable = true
	} else {
		// Probe thời lượng và codec cho file cục bộ
		var err error
		tProbe := time.Now()
		probe, err = ProbeMedia(a.tools, probeInput)
		if probe != nil {
			DiagLog("[open local] %s: ffprobe=%dms video=%s/%s audio=%s format=%s convert=%v check=%q",
				filepath.Base(path), time.Since(tProbe).Milliseconds(), probe.VideoCodec, probe.PixFmt,
				probe.AudioCodec, probe.FormatName, probe.Plan.NeedConvert, probe.Plan.CheckMIME)
		}
		if err != nil {
			return VideoInfo{}, fmt.Errorf("không thể phân tích file video: %w", err)
		}
		durationSec = probe.DurationSec
		playable = probe.Playable
		playableReason = probe.PlayableReason
	}

	// Đăng ký file vào MediaServer. Nếu file gốc không phát được mà đã có bản chuyển mã trong cache
	// từ lần mở trước -> phát bản đó luôn, không bắt người dùng chờ chuyển mã lại.
	mediaURL := directURL
	converted := false
	if mediaURL == "" {
		servePath := path
		if probe != nil && probe.Plan.NeedConvert {
			if cached, ok := findCachedPlayback(path, probe.Plan); ok {
				servePath = cached
				converted = true
				playable = true
			}
		}
		var err error
		mediaURL, err = a.mediaServer.SetMediaFile(servePath)
		if err != nil {
			return VideoInfo{}, fmt.Errorf("không thể phục vụ file media: %w", err)
		}
	}

	// Khởi tạo BlockStore
	meta := CacheMeta{
		Version:      "2.0",
		BlockSec:     a.settings.BlockSec,
		OverlapSec:   a.settings.OverlapSec,
		WhisperModel: filepath.Base(a.tools.WhisperModel),
		LlamaModel:   filepath.Base(a.tools.LlamaModel),
		DurationSec:  durationSec,
	}
	bs, err := NewBlockStore(path, meta)
	if err != nil {
		return VideoInfo{}, fmt.Errorf("không thể khởi tạo bộ nhớ cache: %w", err)
	}
	// Nếu có sẵn file phụ đề Tiếng Việt (_vi.srt / .vi.srt / _vn.srt...), nạp trực tiếp (và ghép cặp với _en.srt nếu có)
	PopulateStoreFromVietnameseSRT(bs, path, durationSec, a.settings.BlockSec, a.settings.OverlapSec)
	a.currentStore = bs

	totalBlocks := int(math.Ceil(durationSec / a.settings.BlockSec))
	doneBlocks := bs.GetDoneBlocks()

	info := VideoInfo{
		Path:           path,
		Title:          title,
		DurationSec:    durationSec,
		BlockSec:       a.settings.BlockSec,
		TotalBlocks:    totalBlocks,
		MediaURL:       mediaURL,
		Playable:       playable,
		PlayableReason: playableReason,
		DoneBlocks:     doneBlocks,
		Converted:      converted,
	}
	if probe != nil {
		info.VideoCodec = probe.VideoCodec
		info.AudioCodec = probe.AudioCodec
		if !converted {
			info.CheckMIME = probe.Plan.CheckMIME
		}
	}
	a.currentInfo = &info

	return info, nil
}

// cancelPlaybackLocked hủy job chuyển mã đang chạy (caller giữ a.mu)
func (a *App) cancelPlaybackLocked() {
	if a.playbackCancel != nil {
		a.playbackCancel()
		a.playbackCancel = nil
	}
	a.playbackPath = ""
}

// CancelPlayback hủy chuyển mã nền theo yêu cầu người dùng
func (a *App) CancelPlayback() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cancelPlaybackLocked()
}

func (a *App) emit(event string, payload interface{}) {
	if a.ctx != nil {
		runtime.EventsEmit(a.ctx, event, payload)
	}
}

// PreparePlayback tạo bản .mp4 phát được (H.264 8-bit + AAC) cho video đang mở, chạy nền.
//   - force=false: theo kết quả ffprobe (chỉ remux / đổi audio nếu được -> vài giây)
//   - force=true:  WebView2 đã báo lỗi giải mã -> luôn mã hóa lại hình bằng libx264
//
// Tiến độ qua event "playback_progress"; xong bắn "playback_ready" {path, media_url};
// lỗi bắn "playback_error". Pipeline phụ đề không bị ảnh hưởng (vẫn đọc audio từ file gốc).
func (a *App) PreparePlayback(path string, force bool) error {
	a.mu.Lock()
	if a.currentVideo != path {
		a.mu.Unlock()
		return fmt.Errorf("video này không còn đang mở")
	}
	if IsDrivePath(path) {
		a.mu.Unlock()
		return fmt.Errorf("không hỗ trợ chuyển mã cho video Google Drive")
	}
	if a.tools == nil {
		a.mu.Unlock()
		return fmt.Errorf("chưa khởi tạo công cụ ffmpeg")
	}
	a.cancelPlaybackLocked()
	ctx, cancel := context.WithCancel(context.Background())
	a.playbackCancel = cancel
	a.playbackPath = path
	tools := a.tools
	durationSec := 0.0
	if a.currentInfo != nil {
		durationSec = a.currentInfo.DurationSec
	}
	a.mu.Unlock()

	go a.runPlaybackJob(ctx, cancel, tools, path, force, durationSec)
	return nil
}

func (a *App) runPlaybackJob(ctx context.Context, cancel context.CancelFunc, tools *ToolsPaths, path string, force bool, durationSec float64) {
	defer cancel()

	fail := func(err error) {
		if ctx.Err() != nil {
			return // bị hủy (mở video khác / người dùng bấm hủy): không báo lỗi
		}
		a.emit("playback_error", PlaybackFailed{Path: path, Error: err.Error()})
	}

	a.emit("playback_progress", PlaybackProgress{Path: path, Percent: 0, Stage: "probe"})

	input := ResolveMediaInput(path)
	ext := filepath.Ext(path)
	if IsDrivePath(path) {
		ext = filepath.Ext(DriveDisplayName(path))
	}
	probe, err := probeMediaWithExt(tools, input, ext)
	if err != nil {
		fail(err)
		return
	}
	if probe.DurationSec > 0 {
		durationSec = probe.DurationSec
	}

	plan := probe.Plan
	if !plan.NeedConvert || force {
		// Probe nói phát được nhưng WebView2 vẫn lỗi (AV1/HEVC thiếu extension, file hỏng nhẹ...)
		// -> mã hóa lại toàn bộ hình là cách chắc chắn nhất
		plan.NeedConvert = true
		plan.CopyVideo = false
		plan.CopyAudio = probe.AudioCodec == "aac" || probe.AudioCodec == "mp3"
	}

	output := playbackCacheFile(path, !plan.CopyVideo)
	if fi, statErr := os.Stat(output); statErr != nil || fi.Size() == 0 {
		stage := "transcode"
		if plan.CopyVideo {
			stage = "remux"
		}
		err = RunPlaybackTranscode(ctx, tools, input, output, plan, durationSec, func(pct float64) {
			a.emit("playback_progress", PlaybackProgress{Path: path, Percent: pct, Stage: stage})
		})
		if err != nil {
			fail(err)
			return
		}
	}

	a.mu.Lock()
	if ctx.Err() != nil || a.currentVideo != path || a.mediaServer == nil {
		a.mu.Unlock()
		return
	}
	mediaURL, err := a.mediaServer.AddMediaFile(output)
	if err != nil {
		a.mu.Unlock()
		fail(err)
		return
	}
	if a.currentInfo != nil {
		a.currentInfo.MediaURL = mediaURL
		a.currentInfo.Playable = true
		a.currentInfo.Converted = true
		a.currentInfo.CheckMIME = ""
	}
	a.playbackCancel = nil
	a.playbackPath = ""
	a.mu.Unlock()

	a.emit("playback_ready", PlaybackReady{Path: path, MediaURL: mediaURL})
}

// StartPipeline khởi chạy quá trình bóc tách và dịch phụ đề
func (a *App) StartPipeline(path string, startSec float64) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	path = ResolveVideoFromSubtitlePath(path)

	if a.currentVideo != path || a.currentStore == nil {
		return fmt.Errorf("video chưa được mở hoặc không khớp đường dẫn")
	}

	if a.currentPipe != nil {
		a.currentPipe.Stop()
	}

	// Nếu 100% các block đã hoàn thành (từ cache hoặc từ file _vi.srt có sẵn), không cần bật llama-server tốn RAM
	doneCount := len(a.currentStore.GetDoneBlocks())
	if a.currentInfo != nil && a.currentInfo.TotalBlocks > 0 && doneCount >= a.currentInfo.TotalBlocks {
		if a.ctx != nil {
			runtime.EventsEmit(a.ctx, "pipeline_status", PipelineStatus{
				State:       "done",
				Message:     "Đã có sẵn toàn bộ phụ đề Tiếng Việt",
				Block:       -1,
				DoneBlocks:  doneCount,
				TotalBlocks: a.currentInfo.TotalBlocks,
				AheadSec:    a.currentInfo.DurationSec,
				Video:       path,
			})
		}
		return nil
	}

	// Khởi tạo Translator nếu chưa có (sử dụng FastHybridTranslator: siêu tốc ~120ms/block, tiết kiệm 1.2GB RAM, tự fallback Local LLM khi offline)
	if a.currentTrans == nil {
		trans := NewFastHybridTranslator(a.tools.LlamaModel, a.tools.LlamaServer, a.tools.LlamaCLI)
		a.setupGemini(trans)
		a.currentTrans = trans
	} else if trans, ok := a.currentTrans.(*FastHybridTranslator); ok {
		a.setupGemini(trans)
	}

	callbacks := PipelineEventCallbacks{
		OnStatus: func(st PipelineStatus) {
			runtime.EventsEmit(a.ctx, "pipeline_status", st)
		},
		OnChunk: func(chunk SubtitleChunkPayload) {
			runtime.EventsEmit(a.ctx, "new_subtitle_chunk", chunk)
		},
		OnError: func(err PipelineError) {
			runtime.EventsEmit(a.ctx, "pipeline_error", err)
		},
	}

	if IsDrivePath(path) && a.spool != nil {
		fileID := DriveFileIDFromPath(path)
		a.spool.StartSpool(fileID, 0)
	}

	pipe := NewPipeline(
		path,
		a.currentInfo.DurationSec,
		a.settings,
		a.tools,
		a.currentStore,
		a.currentTrans,
		callbacks,
	)
	if a.spool != nil {
		pipe.SetSpool(a.spool)
	}
	a.currentPipe = pipe

	return pipe.Start(startSec)
}

// SeekTo chuyển hướng bóc tách phụ đề đến mốc thời gian startSec
func (a *App) SeekTo(path string, startSec float64) error {
	a.mu.Lock()
	pipe := a.currentPipe
	curVideo := a.currentVideo
	a.mu.Unlock()

	if pipe == nil || curVideo != path {
		return nil
	}
	return pipe.SeekTo(startSec)
}

// UpdatePlayhead cập nhật vị trí đang xem hiện tại
func (a *App) UpdatePlayhead(path string, sec float64, playing bool) {
	a.mu.Lock()
	pipe := a.currentPipe
	curVideo := a.currentVideo
	a.mu.Unlock()

	if pipe == nil || curVideo != path {
		return
	}
	pipe.UpdatePlayhead(sec, playing)
}

// UpdateVideoDuration nhận thời lượng thật của video từ frontend (<video>.duration).
// Video Google Drive được mở với thời lượng ước lượng (3600s hoặc theo dung lượng) nên
// backend cần sửa lại để không lập lịch/hiển thị các block nằm ngoài video.
func (a *App) UpdateVideoDuration(path string, sec float64) {
	if math.IsNaN(sec) || math.IsInf(sec, 0) || sec <= 0 {
		return
	}
	a.mu.Lock()
	pipe := a.currentPipe
	if a.currentVideo != path {
		a.mu.Unlock()
		return
	}
	if a.currentInfo != nil {
		a.currentInfo.DurationSec = sec
		if bs := a.currentInfo.BlockSec; bs > 0 {
			a.currentInfo.TotalBlocks = int(math.Ceil(sec / bs))
		}
	}
	a.mu.Unlock()

	if IsDrivePath(path) {
		GetDriveManager().SetDuration(DriveFileIDFromPath(path), sec)
	}
	if pipe != nil {
		pipe.UpdateDuration(sec)
	}
}

// StopPipeline dừng xử lý video hiện tại
func (a *App) StopPipeline() error {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.currentPipe != nil {
		a.currentPipe.Stop()
		a.currentPipe = nil
	}
	return nil
}

// LoadCachedSubtitles trả về toàn bộ danh sách phụ đề đã có trong cache (kết hợp nạp trước phụ đề gốc _en.srt nếu có)
func (a *App) LoadCachedSubtitles(path string) ([]SubtitleItem, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	path = ResolveVideoFromSubtitlePath(path)
	if a.currentVideo != path || a.currentStore == nil {
		return nil, nil
	}

	cachedItems := a.currentStore.GetAllItemsSorted()
	if a.currentInfo == nil {
		return cachedItems, nil
	}

	var extSegs []WhisperSegment
	if driveSegs := GetDriveSubtitleSegments(path); len(driveSegs) > 0 {
		extSegs = driveSegs // phụ đề .srt/.vtt tải từ Google Drive (đang nằm trong RAM)
	} else {
		subFile := FindExternalSubtitleFile(path)
		if subFile == "" {
			return cachedItems, nil
		}
		loaded, err := LoadExternalSubtitles(subFile)
		if err != nil {
			return cachedItems, nil
		}
		extSegs = loaded
	}
	if len(extSegs) == 0 {
		return cachedItems, nil
	}

	blockSec := a.settings.BlockSec
	if blockSec <= 0 {
		blockSec = 30.0
	}
	overlapSec := a.settings.OverlapSec
	if overlapSec <= 0 {
		overlapSec = 2.0
	}
	totalBlocks := int(math.Ceil(a.currentInfo.DurationSec / blockSec))

	var allItems []SubtitleItem
	allItems = append(allItems, cachedItems...)

	for b := 0; b < totalBlocks; b++ {
		if a.currentStore.IsBlockDone(b) {
			continue
		}
		bRange := ComputeBlockRange(b, blockSec, overlapSec, a.currentInfo.DurationSec)
		var rawBlockSegs []WhisperSegment
		for _, seg := range extSegs {
			if seg.EndSec >= bRange.ExtractStart && seg.StartSec <= bRange.ExtractEnd {
				rawBlockSegs = append(rawBlockSegs, seg)
			}
		}
		filtered := FilterAndDeduplicateSegments(rawBlockSegs, bRange)
		for seq, s := range filtered {
			allItems = append(allItems, SubtitleItem{
				ID:         int64(b)*1000 + int64(seq),
				Block:      b,
				StartSec:   s.StartSec,
				EndSec:     s.EndSec,
				SourceText: s.Text,
				TargetText: "",
				Translated: false,
			})
		}
	}

	sort.Slice(allItems, func(i, j int) bool {
		return allItems[i].StartSec < allItems[j].StartSec
	})
	return allItems, nil
}

// FormatSRTTime chuyển đổi float64 giây sang định dạng HH:MM:SS,mmm của file SRT
func FormatSRTTime(sec float64) string {
	if sec < 0 {
		sec = 0
	}
	h := int(sec / 3600)
	m := int(math.Mod(sec, 3600) / 60)
	s := int(math.Mod(sec, 60))
	ms := int(math.Round((sec - math.Floor(sec)) * 1000))
	if ms >= 1000 {
		ms = 999
	}
	return fmt.Sprintf("%02d:%02d:%02d,%03d", h, m, s, ms)
}

// FormatVTTTime chuyển đổi float64 giây sang định dạng HH:MM:SS.mmm của file WebVTT
func FormatVTTTime(sec float64) string {
	if sec < 0 {
		sec = 0
	}
	h := int(sec / 3600)
	m := int(math.Mod(sec, 3600) / 60)
	s := int(math.Mod(sec, 60))
	ms := int(math.Round((sec - math.Floor(sec)) * 1000))
	if ms >= 1000 {
		ms = 999
	}
	return fmt.Sprintf("%02d:%02d:%02d.%03d", h, m, s, ms)
}

// BuildSubtitleContent tạo chuỗi nội dung file .srt hoặc .vtt theo 3 chế độ: "target" (Chỉ Tiếng Việt), "bilingual" (Song ngữ Anh-Việt), "source" (Chỉ Tiếng Anh)
func BuildSubtitleContent(items []SubtitleItem, format string, mode string) string {
	isVTT := strings.ToLower(strings.TrimSpace(format)) == "vtt"
	var sb strings.Builder
	if isVTT {
		sb.WriteString("WEBVTT\n\n")
	}

	idx := 1
	for _, it := range items {
		var text string
		switch mode {
		case "source", "en":
			text = it.SourceText
		case "target", "vi":
			text = it.TargetText
			if text == "" {
				text = it.SourceText
			}
		case "bilingual":
			if it.TargetText != "" {
				text = fmt.Sprintf("%s\n%s", it.SourceText, it.TargetText)
			} else {
				text = it.SourceText
			}
		default:
			text = it.TargetText
		}

		if strings.TrimSpace(text) == "" {
			continue
		}

		sb.WriteString(fmt.Sprintf("%d\n", idx))
		if isVTT {
			sb.WriteString(fmt.Sprintf("%s --> %s\n", FormatVTTTime(it.StartSec), FormatVTTTime(it.EndSec)))
		} else {
			sb.WriteString(fmt.Sprintf("%s --> %s\n", FormatSRTTime(it.StartSec), FormatSRTTime(it.EndSec)))
		}
		sb.WriteString(fmt.Sprintf("%s\n\n", strings.TrimSpace(text)))
		idx++
	}

	return sb.String()
}

// ExportSRT xuất danh sách phụ đề ra file SRT theo 3 chế độ: "source", "target", "bilingual"
func (a *App) ExportSRT(path string, mode string) (string, error) {
	return a.ExportSubtitle(path, "srt", mode)
}

// ExportSubtitle xuất danh sách phụ đề ra file .srt hoặc .vtt độc lập ("target", "bilingual", "source")
func (a *App) ExportSubtitle(path string, format string, mode string) (string, error) {
	a.mu.Lock()
	store := a.currentStore
	a.mu.Unlock()

	if store == nil {
		return "", fmt.Errorf("không có dữ liệu phụ đề để xuất")
	}

	items := store.GetAllItemsSorted()
	if len(items) == 0 {
		return "", fmt.Errorf("chưa có dòng phụ đề nào được ghi nhận")
	}

	ext := "srt"
	filterName := "SubRip Subtitle (*.srt)"
	filterPattern := "*.srt"
	if strings.ToLower(strings.TrimSpace(format)) == "vtt" {
		ext = "vtt"
		filterName = "WebVTT Subtitle (*.vtt)"
		filterPattern = "*.vtt"
	}

	modeSuffix := "vi"
	switch mode {
	case "bilingual":
		modeSuffix = "bilingual"
	case "source", "en":
		modeSuffix = "en"
	}

	baseName := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	if name := DriveDisplayName(path); name != "" {
		baseName = strings.TrimSuffix(name, filepath.Ext(name))
	}
	savePath, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           fmt.Sprintf("Xuất phụ đề định dạng .%s", strings.ToUpper(ext)),
		DefaultFilename: fmt.Sprintf("%s.%s.%s", baseName, modeSuffix, ext),
		Filters: []runtime.FileFilter{
			{DisplayName: filterName, Pattern: filterPattern},
		},
	})
	if err != nil || savePath == "" {
		return "", err
	}

	content := BuildSubtitleContent(items, ext, mode)
	if err := os.WriteFile(savePath, []byte(content), 0644); err != nil {
		return "", fmt.Errorf("lỗi ghi file phụ đề: %w", err)
	}

	return savePath, nil
}

// DownloadYouTubeVideo tải nhanh video và phụ đề gốc từ link YouTube bằng yt-dlp để phát và dịch ngay
func (a *App) DownloadYouTubeVideo(rawURL string) (string, error) {
	a.mu.Lock()
	tools := a.tools
	ctx := a.ctx
	a.mu.Unlock()

	if ctx == nil {
		ctx = context.Background()
	}

	videoPath, err := DownloadYouTubeMedia(ctx, tools, rawURL, func(msg string) {
		if a.ctx != nil {
			runtime.EventsEmit(a.ctx, "youtube_progress", msg)
		}
	})
	if err != nil {
		return "", err
	}
	return videoPath, nil
}

// ---------------------------------------------------------------------------
// Google Drive bindings (logic nằm trong drive_manager.go)
// ---------------------------------------------------------------------------

// LoginGoogleDrive mở trình duyệt đăng nhập Google, chặn đến khi hoàn tất; bắn event "drive_auth_success"
func (a *App) LoginGoogleDrive() error {
	return GetDriveManager().Login()
}

// IsGoogleDriveLoggedIn kiểm tra drive_token.json còn hợp lệ
func (a *App) IsGoogleDriveLoggedIn() bool {
	return GetDriveManager().IsLoggedIn()
}

// LogoutGoogleDrive xóa token (RAM + file)
func (a *App) LogoutGoogleDrive() error {
	return GetDriveManager().Logout()
}

// ListDriveItems liệt kê thư mục con + video trong folderID ("" = My Drive)
func (a *App) ListDriveItems(folderID string) ([]DriveItem, error) {
	return GetDriveManager().ListDriveItems(folderID)
}

// ScanDriveFolder quét đệ quy một thư mục Google Drive để đưa vào cây bài học
func (a *App) ScanDriveFolder(folderID, folderName string) (*FolderNode, error) {
	return GetDriveManager().ScanDriveFolder(folderID, folderName)
}

// ResolveDriveLink phân giải link Google Drive (thư mục hoặc video) do người dùng dán vào
func (a *App) ResolveDriveLink(link string) (*DriveLinkInfo, error) {
	return GetDriveManager().ResolveDriveLink(link)
}

// StartDriveFolderScan quét thư mục Drive ở nền và trả về ngay. Mỗi khi liệt kê xong một thư mục,
// backend bắn event "drive_tree_update" {node, done} để UI hiển thị dần (xem được video ngay).
func (a *App) StartDriveFolderScan(folderID, folderName string) error {
	dm := GetDriveManager()
	if !dm.IsLoggedIn() {
		return ErrDriveNotLoggedIn
	}
	if folderName == "" && (folderID == "" || folderID == "root") {
		folderName = "Google Drive"
	}
	ctx := a.ctx
	go func() {
		if folderName == "" {
			folderName = dm.FolderName(folderID)
		}
		dm.ScanDriveFolderProgressive(folderID, folderName, func(node FolderNode, done bool) {
			if ctx != nil {
				runtime.EventsEmit(ctx, "drive_tree_update", map[string]interface{}{"node": node, "done": done})
			}
		})
	}()
	return nil
}

// OpenDriveVideo mở video Google Drive để phát qua loopback proxy và dịch realtime (không tải file về đĩa).
// subtitleID (tùy chọn) là file .srt/.vtt cùng thư mục: được tải vào RAM để bỏ qua Whisper STT.
func (a *App) OpenDriveVideo(fileID, name, subtitleID string) (VideoInfo, error) {
	dm := GetDriveManager()
	streamURL, err := dm.StreamURL(fileID)
	if err != nil {
		return VideoInfo{}, err
	}
	if !dm.IsLoggedIn() {
		return VideoInfo{}, ErrDriveNotLoggedIn
	}
	t0 := time.Now()
	dm.PrepareVideo(fileID, name, subtitleID) // tải phụ đề ngoài lock, lỗi thì tự fallback Whisper
	prepMs := time.Since(t0).Milliseconds()

	// Lấy thời lượng trực tiếp từ metadata Google Drive (đã nạp từ ListDriveItems hoặc query 50ms)
	// Bỏ qua ffprobe qua mạng để mở video ngay lập tức trong 0.05s
	t1 := time.Now()
	durationSec := dm.GetDuration(fileID)
	if durationSec <= 0 {
		durationSec = dm.FetchDurationFromDrive(fileID)
	}
	durMs := time.Since(t1).Milliseconds()
	if durationSec <= 0 {
		durationSec = 3600
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	t2 := time.Now()
	info, err := a.openMediaLocked(DrivePathFromID(fileID), streamURL, streamURL, name, durationSec)
	DiagLog("[open drive] %s: tải phụ đề Drive=%dms, lấy thời lượng=%dms, mở cache/pipeline=%dms, tổng=%dms (có phụ đề sẵn: %v)",
		name, prepMs, durMs, time.Since(t2).Milliseconds(), time.Since(t0).Milliseconds(), subtitleID != "")
	return info, err
}

// GetSettings trả về cấu hình hiện tại
func (a *App) GetSettings() Settings {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.settings
}

// SaveSettings lưu cấu hình mới vào %LOCALAPPDATA%\SubTrans\settings.json
func (a *App) SaveSettings(settings Settings) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.settings = settings
	if trans, ok := a.currentTrans.(*FastHybridTranslator); ok {
		a.setupGemini(trans)
	}
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(a.settingsPath, data, 0644)
}

// SetGeminiConfig cập nhật cấu hình Gemini Cloud và lưu vào %LOCALAPPDATA%\SubTrans\settings.json
func (a *App) SetGeminiConfig(apiKey string, enabled bool, model string) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.settings.GeminiAPIKey = strings.TrimSpace(apiKey)
	a.settings.GeminiEnabled = enabled
	if strings.TrimSpace(model) != "" {
		a.settings.GeminiModel = strings.TrimSpace(model)
	} else if a.settings.GeminiModel == "" {
		a.settings.GeminiModel = DefaultGeminiModel
	}

	if trans, ok := a.currentTrans.(*FastHybridTranslator); ok {
		a.setupGemini(trans)
	}

	data, err := json.MarshalIndent(a.settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(a.settingsPath, data, 0644)
}

// setupGemini cấu hình hoặc hủy GeminiClient cho FastHybridTranslator dựa trên Settings và biến môi trường
func (a *App) setupGemini(trans *FastHybridTranslator) {
	if trans == nil {
		return
	}
	apiKey := strings.TrimSpace(a.settings.GeminiAPIKey)
	if apiKey == "" {
		apiKey = strings.TrimSpace(os.Getenv("GEMINI_API_KEY"))
	}
	enabled := a.settings.GeminiEnabled
	if !enabled {
		if envEnabled := os.Getenv("GEMINI_ENABLED"); envEnabled == "true" || envEnabled == "1" {
			enabled = true
		}
	}
	if enabled && apiKey != "" {
		model := strings.TrimSpace(a.settings.GeminiModel)
		if model == "" {
			model = DefaultGeminiModel
		}
		// Nếu đã có GeminiClient với cùng cấu hình, giữ nguyên để không làm gián đoạn breaker và token bucket
		if cur := trans.gemini.Load(); cur != nil {
			if cur.cfg.Enabled && cur.cfg.APIKey == apiKey && cur.cfg.Model == model {
				return
			}
		}
		cfg := DefaultGeminiConfig()
		cfg.Enabled = true
		cfg.APIKey = apiKey
		cfg.Model = model
		trans.SetGemini(NewGeminiClient(cfg, nil))
	} else {
		trans.SetGemini(nil)
	}
}

// SetSourceLang cập nhật và lưu ngôn ngữ nguồn ("auto", "en", "vi")
func (a *App) SetSourceLang(lang string) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	lang = strings.ToLower(strings.TrimSpace(lang))
	if lang != "vi" && lang != "en" && lang != "auto" {
		lang = "auto"
	}
	a.settings.SourceLang = lang
	data, err := json.MarshalIndent(a.settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(a.settingsPath, data, 0644)
}

// GetSourceLang trả về ngôn ngữ nguồn hiện tại ("auto", "en", "vi")
func (a *App) GetSourceLang() string {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.settings.SourceLang == "" {
		return "auto"
	}
	return a.settings.SourceLang
}

// CheckModelsReady kiểm tra xem các model AI đã sẵn sàng offline hay chưa
func (a *App) CheckModelsReady() bool {
	if a.downloader == nil {
		return false
	}
	ready := a.downloader.CheckModelsReady()
	if ready && a.tools != nil {
		a.tools.RefreshModelPaths()
	}
	return ready
}

// GetModelStatuses lấy trạng thái sẵn sàng của từng model
func (a *App) GetModelStatuses() map[string]bool {
	if a.downloader == nil {
		return map[string]bool{}
	}
	return a.downloader.GetModelStatuses()
}

// StartModelDownload kích hoạt tải các model AI offline
func (a *App) StartModelDownload() error {
	if a.downloader == nil {
		return fmt.Errorf("downloader chưa được khởi tạo")
	}
	return a.downloader.StartDownload()
}

// CancelModelDownload hủy tiến trình tải model
func (a *App) CancelModelDownload() {
	if a.downloader != nil {
		a.downloader.CancelDownload()
	}
}

// CheckForUpdate kiểm tra phiên bản mới từ GitHub
func (a *App) CheckForUpdate() (*UpdateCheckResult, error) {
	if a.updater == nil {
		return nil, fmt.Errorf("updater chưa được khởi tạo")
	}
	return a.updater.CheckForUpdate()
}

// ApplyUpdate tải bản cập nhật và hoán đổi an toàn file exe
func (a *App) ApplyUpdate(downloadURL string) error {
	if a.updater == nil {
		return fmt.Errorf("updater chưa được khởi tạo")
	}
	return a.updater.ApplyUpdate(downloadURL)
}

// RestartApp khởi động lại phiên bản mới sau khi update
func (a *App) RestartApp() error {
	if a.updater == nil {
		return fmt.Errorf("updater chưa được khởi tạo")
	}
	return a.updater.RestartApp()
}

// GetCurrentVersion trả về phiên bản hiện tại của app
func (a *App) GetCurrentVersion() string {
	return CurrentVersion
}

