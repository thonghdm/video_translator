package main

// SubtitleItem biểu diễn một đoạn phụ đề đã phân tách thời gian
type SubtitleItem struct {
	ID         int64   `json:"id"` // = block*1000 + seq, ổn định dùng để upsert
	Block      int     `json:"block"`
	StartSec   float64 `json:"start_sec"`
	EndSec     float64 `json:"end_sec"`
	SourceText string  `json:"source_text"`
	TargetText string  `json:"target_text"` // rỗng cho tới khi dịch xong
	Translated bool    `json:"translated"`
}

// VideoInfo trả về bởi OpenVideo khi mở một tập tin media
type VideoInfo struct {
	Path           string  `json:"path"`
	Title          string  `json:"title,omitempty"` // tên hiển thị (dùng cho video Google Drive)
	DurationSec    float64 `json:"duration_sec"`
	BlockSec       float64 `json:"block_sec"`
	TotalBlocks    int     `json:"total_blocks"`
	MediaURL       string  `json:"media_url"`
	Playable       bool    `json:"playable"`
	PlayableReason string  `json:"playable_reason"` // ví dụ "audio codec ac3 không được WebView2 hỗ trợ"
	DoneBlocks     []int   `json:"done_blocks"`     // lấy từ cache có sẵn
	VideoCodec     string  `json:"video_codec,omitempty"`
	AudioCodec     string  `json:"audio_codec,omitempty"`
	// CheckMIME: codec phụ thuộc máy (AV1/HEVC) -> frontend kiểm tra MediaSource.isTypeSupported trước khi phát
	CheckMIME string `json:"check_mime,omitempty"`
	// Converted: media_url đang trỏ tới bản đã chuyển mã có sẵn trong cache
	Converted bool `json:"converted,omitempty"`
}

// PlaybackProgress payload cho sự kiện "playback_progress" (chuyển mã nền để phát hình)
type PlaybackProgress struct {
	Path    string  `json:"path"`
	Percent float64 `json:"percent"` // 0..100, âm nếu chưa biết
	Stage   string  `json:"stage"`   // "probe" | "remux" | "transcode"
}

// PlaybackReady payload cho sự kiện "playback_ready"
type PlaybackReady struct {
	Path     string `json:"path"`
	MediaURL string `json:"media_url"`
}

// PlaybackFailed payload cho sự kiện "playback_error"
type PlaybackFailed struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

// Settings cấu hình ứng dụng lưu trong %LOCALAPPDATA%\SubTrans\settings.json
type Settings struct {
	BlockSec         float64 `json:"block_sec"`
	OverlapSec       float64 `json:"overlap_sec"`
	LookaheadMinSec  float64 `json:"lookahead_min_sec"`
	LookaheadMaxSec  float64 `json:"lookahead_max_sec"`
	TranslateWorkers int     `json:"translate_workers"`
	WhisperThreads   int     `json:"whisper_threads"`
	SourceLang       string  `json:"source_lang"`
	Translator       string  `json:"translator"` // "cli" | "server"
	GeminiAPIKey     string  `json:"gemini_api_key,omitempty"`
	GeminiEnabled    bool    `json:"gemini_enabled,omitempty"`
	GeminiModel      string  `json:"gemini_model,omitempty"`
}

// PipelineStatus payload cho sự kiện pipeline_status
type PipelineStatus struct {
	State       string  `json:"state"` // "idle"|"seeking"|"processing"|"ahead"|"catching_up"|"backfill"|"done"|"error"
	Message     string  `json:"message"`
	Block       int     `json:"block"`
	DoneBlocks  int     `json:"done_blocks"`
	TotalBlocks int     `json:"total_blocks"`
	AheadSec       float64 `json:"ahead_sec"`
	Video          string  `json:"video"`
	TranslatorMode string  `json:"translator_mode,omitempty"`   // "api" | "cloud" | "local_ai"
	TranslatorReason string `json:"translator_reason,omitempty"` // lý do chi tiết khi rớt xuống mode fallback
}

// PipelineError payload cho sự kiện pipeline_error
type PipelineError struct {
	Block   int    `json:"block"`
	Stage   string `json:"stage"` // "slice"|"stt"|"translate"
	Message string `json:"message"`
	Fatal   bool   `json:"fatal"`
	Video   string `json:"video"`
}

// SubtitleChunkPayload payload cho sự kiện new_subtitle_chunk
type SubtitleChunkPayload struct {
	Video string         `json:"video"`
	Block int            `json:"block"`
	Items []SubtitleItem `json:"items"`
	Final bool           `json:"final"`
}

// FolderNode biểu diễn một nút trong cây thư mục khóa học/video (thư mục hoặc file video)
type FolderNode struct {
	Name     string       `json:"name"`
	Path     string       `json:"path"`
	IsDir    bool         `json:"is_dir"`
	HasCache bool         `json:"has_cache,omitempty"`
	Children []FolderNode `json:"children,omitempty"`
}
