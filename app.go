package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"

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
		SourceLang:       "en",
		Translator:       "cli",
	}

	if data, err := os.ReadFile(settingsPath); err == nil {
		_ = json.Unmarshal(data, &defaultSettings)
	}

	return &App{
		settings:     defaultSettings,
		settingsPath: settingsPath,
	}
}

// startup được gọi khi Wails khởi động
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.tools = GetToolsPaths()
	ms, err := GetMediaServer()
	if err == nil {
		a.mediaServer = ms
	}
}

// shutdown được gọi khi Wails đóng ứng dụng
func (a *App) shutdown(ctx context.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.currentPipe != nil {
		a.currentPipe.Stop()
	}
	if a.currentTrans != nil {
		_ = a.currentTrans.Close()
	}
}

// SelectVideoFile mở hộp thoại chọn file video
func (a *App) SelectVideoFile() (string, error) {
	selected, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Chọn tập tin video",
		Filters: []runtime.FileFilter{
			{
				DisplayName: "Video Files (*.mp4;*.mkv;*.webm;*.avi;*.mov)",
				Pattern:     "*.mp4;*.mkv;*.webm;*.avi;*.mov",
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

// OpenVideo nạp video, lấy probe thông tin và chuẩn bị URL streaming
func (a *App) OpenVideo(path string) (VideoInfo, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.currentPipe != nil {
		a.currentPipe.Stop()
		a.currentPipe = nil
	}

	a.currentVideo = path

	// Kiểm tra công cụ phụ trợ
	missing := CheckTools()
	if len(missing) > 0 {
		return VideoInfo{}, fmt.Errorf("thiếu công cụ hoặc model phụ trợ: %s", strings.Join(missing, ", "))
	}

	// Probe thời lượng và codec
	probe, err := ProbeMedia(a.tools, path)
	if err != nil {
		return VideoInfo{}, fmt.Errorf("không thể phân tích file video: %w", err)
	}

	// Đăng ký file vào MediaServer
	mediaURL, err := a.mediaServer.SetMediaFile(path)
	if err != nil {
		return VideoInfo{}, fmt.Errorf("không thể phục vụ file media: %w", err)
	}

	// Khởi tạo BlockStore
	meta := CacheMeta{
		Version:      "2.0",
		BlockSec:     a.settings.BlockSec,
		OverlapSec:   a.settings.OverlapSec,
		WhisperModel: filepath.Base(a.tools.WhisperModel),
		LlamaModel:   filepath.Base(a.tools.LlamaModel),
		DurationSec:  probe.DurationSec,
	}
	bs, err := NewBlockStore(path, meta)
	if err != nil {
		return VideoInfo{}, fmt.Errorf("không thể khởi tạo bộ nhớ cache: %w", err)
	}
	a.currentStore = bs

	totalBlocks := int(math.Ceil(probe.DurationSec / a.settings.BlockSec))
	doneBlocks := bs.GetDoneBlocks()

	info := VideoInfo{
		Path:           path,
		DurationSec:    probe.DurationSec,
		BlockSec:       a.settings.BlockSec,
		TotalBlocks:    totalBlocks,
		MediaURL:       mediaURL,
		Playable:       probe.Playable,
		PlayableReason: probe.PlayableReason,
		DoneBlocks:     doneBlocks,
	}
	a.currentInfo = &info

	return info, nil
}

// StartPipeline khởi chạy quá trình bóc tách và dịch phụ đề
func (a *App) StartPipeline(path string, startSec float64) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.currentVideo != path || a.currentStore == nil {
		return fmt.Errorf("video chưa được mở hoặc không khớp đường dẫn")
	}

	if a.currentPipe != nil {
		a.currentPipe.Stop()
	}

	// Khởi tạo Translator nếu chưa có (ưu tiên llama-server thường trú, fallback llama-cli)
	if a.currentTrans == nil {
		var trans Translator
		var err error
		if a.tools.LlamaServer != "" {
			if _, statErr := os.Stat(a.tools.LlamaServer); statErr == nil {
				trans, err = NewLlamaServerTranslator(a.tools.LlamaModel, a.tools.LlamaServer, 4)
			}
		}
		if trans == nil || err != nil {
			trans, err = NewLlamaCliTranslator(a.tools.LlamaModel, a.tools.LlamaCLI)
		}
		if err != nil {
			return fmt.Errorf("khởi tạo translator thất bại: %w", err)
		}
		a.currentTrans = trans
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

	pipe := NewPipeline(
		path,
		a.currentInfo.DurationSec,
		a.settings,
		a.tools,
		a.currentStore,
		a.currentTrans,
		callbacks,
	)
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

// LoadCachedSubtitles trả về toàn bộ danh sách phụ đề đã có trong cache
func (a *App) LoadCachedSubtitles(path string) ([]SubtitleItem, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.currentVideo != path || a.currentStore == nil {
		return nil, nil
	}
	return a.currentStore.GetAllItemsSorted(), nil
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

// ExportSRT xuất danh sách phụ đề ra file SRT theo 3 chế độ: "source", "target", "bilingual"
func (a *App) ExportSRT(path string, mode string) (string, error) {
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

	savePath, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Xuất phụ đề định dạng SRT",
		DefaultFilename: fmt.Sprintf("%s.srt", strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))),
		Filters: []runtime.FileFilter{
			{DisplayName: "SubRip Subtitle (*.srt)", Pattern: "*.srt"},
		},
	})
	if err != nil || savePath == "" {
		return "", err
	}

	var sb strings.Builder
	idx := 1
	for _, it := range items {
		var text string
		switch mode {
		case "source":
			text = it.SourceText
		case "target":
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
		sb.WriteString(fmt.Sprintf("%s --> %s\n", FormatSRTTime(it.StartSec), FormatSRTTime(it.EndSec)))
		sb.WriteString(fmt.Sprintf("%s\n\n", strings.TrimSpace(text)))
		idx++
	}

	if err := os.WriteFile(savePath, []byte(sb.String()), 0644); err != nil {
		return "", fmt.Errorf("lỗi ghi file SRT: %w", err)
	}

	return savePath, nil
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
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(a.settingsPath, data, 0644)
}
