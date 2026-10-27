package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"
)

// IsTelemetryEnabled kiểm tra cờ môi trường VT_TELEMETRY=1
func IsTelemetryEnabled() bool {
	return os.Getenv("VT_TELEMETRY") == "1"
}

// GetWhisperThreadsConfig lấy số thread cấu hình qua VT_WHISPER_THREADS (Bước 7), mặc định giữ nguyên defaultThreads
func GetWhisperThreadsConfig(defaultThreads int) int {
	if defaultThreads <= 0 {
		defaultThreads = 4
	}
	envVal := os.Getenv("VT_WHISPER_THREADS")
	if envVal != "" {
		if n, err := strconv.Atoi(envVal); err == nil && n > 0 {
			return n
		}
	}
	return defaultThreads
}

// TimingRunWithMs đại diện cho một chỉ số timing có số lần chạy và thời gian mỗi lần chạy
type TimingRunWithMs struct {
	TotalMs  *float64 `json:"total_ms"`
	Runs     int      `json:"runs"`
	MsPerRun *float64 `json:"ms_per_run"`
}

// WhisperTimings chứa các chỉ số đo phân rã từ stderr của whisper_print_timings
type WhisperTimings struct {
	Parsed        bool            `json:"parsed"`
	LoadMs        *float64        `json:"load_ms"`
	MelMs         *float64        `json:"mel_ms"`
	Sample        TimingRunWithMs `json:"sample"`
	Encode        TimingRunWithMs `json:"encode"`
	Decode        TimingRunWithMs `json:"decode"`
	Batchd        TimingRunWithMs `json:"batchd"`
	Prompt        TimingRunWithMs `json:"prompt"`
	TotalMs       *float64        `json:"total_ms"`
	Fallbacks     int             `json:"fallbacks"`
	HasAutoDetect bool            `json:"has_auto_detect"`
	DetectedLang  string          `json:"detected_lang"`
	DetectedLangP *float64        `json:"detected_lang_p"`
	WavSamples    int64           `json:"wav_samples"`
	WavLenSec     *float64        `json:"wav_len_sec"`

	// Trường phẳng hỗ trợ tương thích ngược
	EncodeMs *float64 `json:"encode_ms,omitempty"`
	DecodeMs *float64 `json:"decode_ms,omitempty"`
	BatchdMs *float64 `json:"batchd_ms,omitempty"`
	PromptMs *float64 `json:"prompt_ms,omitempty"`
	SampleMs *float64 `json:"sample_ms,omitempty"`
}

var (
	reTimingLoad      = regexp.MustCompile(`(?i)whisper_print_timings:\s+load time\s*=\s*([\d\.]+)\s*ms`)
	reTimingFallbacks = regexp.MustCompile(`(?i)whisper_print_timings:\s+fallbacks\s*=\s*(\d+)\s*p\s*/\s*(\d+)\s*h`)
	reTimingMel       = regexp.MustCompile(`(?i)whisper_print_timings:\s+mel time\s*=\s*([\d\.]+)\s*ms`)
	reTimingTotal     = regexp.MustCompile(`(?i)whisper_print_timings:\s+total time\s*=\s*([\d\.]+)\s*ms`)

	reTimingSample = regexp.MustCompile(`(?i)whisper_print_timings:\s+sample time\s*=\s*([\d\.]+)\s*ms(?:\s*/\s*(\d+)\s*runs\s*\(\s*([\d\.]+)\s*ms per run\))?`)
	reTimingEncode = regexp.MustCompile(`(?i)whisper_print_timings:\s+encode time\s*=\s*([\d\.]+)\s*ms(?:\s*/\s*(\d+)\s*runs\s*\(\s*([\d\.]+)\s*ms per run\))?`)
	reTimingDecode = regexp.MustCompile(`(?i)whisper_print_timings:\s+decode time\s*=\s*([\d\.]+)\s*ms(?:\s*/\s*(\d+)\s*runs\s*\(\s*([\d\.]+)\s*ms per run\))?`)
	reTimingBatchd = regexp.MustCompile(`(?i)whisper_print_timings:\s+batchd time\s*=\s*([\d\.]+)\s*ms(?:\s*/\s*(\d+)\s*runs\s*\(\s*([\d\.]+)\s*ms per run\))?`)
	reTimingPrompt = regexp.MustCompile(`(?i)whisper_print_timings:\s+prompt time\s*=\s*([\d\.]+)\s*ms(?:\s*/\s*(\d+)\s*runs\s*\(\s*([\d\.]+)\s*ms per run\))?`)

	reWavProcessing  = regexp.MustCompile(`(?i)main:\s+processing\s+'.*?'\s*\((\d+)\s+samples,\s*([\d\.]+)\s+sec\)`)
	reAutoDetectLang = regexp.MustCompile(`(?i)auto-detected\s+language:\s*([a-zA-Z_\-]+)\s*\(p\s*=\s*([\d\.]+)\)`)
)

func parseTimingFloat(re *regexp.Regexp, s string) *float64 {
	m := re.FindStringSubmatch(s)
	if len(m) >= 2 {
		if val, err := strconv.ParseFloat(m[1], 64); err == nil {
			return &val
		}
	}
	return nil
}

func parseTimingRunWithMs(re *regexp.Regexp, s string) TimingRunWithMs {
	m := re.FindStringSubmatch(s)
	if len(m) < 2 {
		return TimingRunWithMs{}
	}
	res := TimingRunWithMs{}
	if val, err := strconv.ParseFloat(m[1], 64); err == nil {
		res.TotalMs = &val
	}
	if len(m) >= 3 && m[2] != "" {
		if runs, err := strconv.Atoi(m[2]); err == nil {
			res.Runs = runs
		}
	}
	if len(m) >= 4 && m[3] != "" {
		if perRun, err := strconv.ParseFloat(m[3], 64); err == nil {
			res.MsPerRun = &perRun
		}
	}
	return res
}

// ParseWhisperTimings trích xuất số liệu thời gian từ khối whisper_print_timings trong stderr (Bước 1)
func ParseWhisperTimings(stderr string) WhisperTimings {
	res := WhisperTimings{
		LoadMs:  parseTimingFloat(reTimingLoad, stderr),
		MelMs:   parseTimingFloat(reTimingMel, stderr),
		Sample:  parseTimingRunWithMs(reTimingSample, stderr),
		Encode:  parseTimingRunWithMs(reTimingEncode, stderr),
		Decode:  parseTimingRunWithMs(reTimingDecode, stderr),
		Batchd:  parseTimingRunWithMs(reTimingBatchd, stderr),
		Prompt:  parseTimingRunWithMs(reTimingPrompt, stderr),
		TotalMs: parseTimingFloat(reTimingTotal, stderr),
	}

	res.SampleMs = res.Sample.TotalMs
	res.EncodeMs = res.Encode.TotalMs
	res.DecodeMs = res.Decode.TotalMs
	res.BatchdMs = res.Batchd.TotalMs
	res.PromptMs = res.Prompt.TotalMs

	if m := reTimingFallbacks.FindStringSubmatch(stderr); len(m) >= 3 {
		p, _ := strconv.Atoi(m[1])
		h, _ := strconv.Atoi(m[2])
		res.Fallbacks = p + h
	}

	if m := reAutoDetectLang.FindStringSubmatch(stderr); len(m) >= 3 {
		res.HasAutoDetect = true
		res.DetectedLang = m[1]
		if pVal, err := strconv.ParseFloat(m[2], 64); err == nil {
			res.DetectedLangP = &pVal
		}
	}

	if m := reWavProcessing.FindStringSubmatch(stderr); len(m) >= 3 {
		if smp, err := strconv.ParseInt(m[1], 10, 64); err == nil {
			res.WavSamples = smp
		}
		if sec, err := strconv.ParseFloat(m[2], 64); err == nil {
			res.WavLenSec = &sec
		}
	}

	if res.LoadMs != nil && res.TotalMs != nil {
		res.Parsed = true
	} else {
		res.Parsed = false
		if IsTelemetryEnabled() {
			log.Printf("[telemetry] WARNING: whisper timings not parsed from stderr")
		}
	}

	return res
}

// BlockTelemetryRecord đại diện cho 1 dòng JSONL trong telemetry/blocks.jsonl (Bước 2)
type BlockTelemetryRecord struct {
	SessionID             int64    `json:"session_id"`
	BlockIndex            int      `json:"block_index"`
	BlockStartSec         float64  `json:"block_start_sec"`
	BlockLenSec           float64  `json:"block_len_sec"`
	OverlapSec            float64  `json:"overlap_sec"`
	Tier                  int      `json:"tier"`        // 1 hoặc 2
	SourceType            string   `json:"source_type"` // "drive" hoặc "local"
	BlockOrderInSession   int      `json:"block_order_in_session"`
	WhisperThreads        int      `json:"whisper_threads"`
	WhisperLangArg        string   `json:"whisper_lang_arg"`
	VariantName           string   `json:"variant_name"`
	CacheHit              bool     `json:"cache_hit"`
	FfmpegCutMs           int64    `json:"ffmpeg_cut_ms"`
	WhisperWallMs         int64    `json:"whisper_wall_ms"`
	WhisperLoadMs         *float64 `json:"whisper_load_ms"`
	WhisperEncodeMs       *float64 `json:"whisper_encode_ms"`
	WhisperEncodeRuns     int      `json:"whisper_encode_runs"`
	WhisperEncodeMsPerRun *float64 `json:"whisper_encode_ms_per_run"`
	WhisperDecodeMs       *float64 `json:"whisper_decode_ms"`
	WhisperDecodeRuns     int      `json:"whisper_decode_runs"`
	WhisperDecodeMsPerRun *float64 `json:"whisper_decode_ms_per_run"`
	WhisperTotalMs        *float64 `json:"whisper_total_ms"`
	WhisperLangDetected   string   `json:"whisper_lang_detected"`
	WhisperLangP          *float64 `json:"whisper_lang_p"`
	WavLenSec             *float64 `json:"wav_len_sec"`
	WhisperTimingsParsed  bool     `json:"whisper_timings_parsed"`
	TranslateMs           int64    `json:"translate_ms"`
	TranslatorUsed        string   `json:"translator_used"`
	SentenceCount         int      `json:"sentence_count"`
	CharCount             int      `json:"char_count"`
	QueueWaitMs           int64    `json:"queue_wait_ms"`
	ComputeWaitMs         int64    `json:"compute_wait_ms"`
	BlockTotalMs          int64    `json:"block_total_ms"`
	Cancelled             bool     `json:"cancelled"`
}

// SeekTelemetryRecord đại diện cho 1 dòng JSONL trong telemetry/seeks.jsonl (Bước 3)
type SeekTelemetryRecord struct {
	Timestamp          string  `json:"timestamp"`
	TargetSec          float64 `json:"target_sec"`
	OldSessionID       int64   `json:"old_session_id"`
	NewSessionID       int64   `json:"new_session_id"`
	OldTier2WasRunning bool    `json:"old_tier2_was_running"`
	OldBlockRunningIdx int     `json:"old_block_running_idx"`
	Tier2DrainMs       int64   `json:"tier2_drain_ms"`
	ComputeMuDrainMs   int64   `json:"compute_mu_drain_ms"`
	FirstSubLatencyMs  int64   `json:"first_sub_latency_ms"` // seek_latency_ms
}

var (
	telemetryMu        sync.Mutex
	telemetryOutputDir = "telemetry"
)

// SaveWhisperStderrSample lưu nguyên văn stderr mẫu vào telemetry/whisper_stderr_sample.txt (Bước 0)
func SaveWhisperStderrSample(rawStderr string) {
	if !IsTelemetryEnabled() || rawStderr == "" {
		return
	}
	telemetryMu.Lock()
	defer telemetryMu.Unlock()
	_ = os.MkdirAll(telemetryOutputDir, 0755)
	path := filepath.Join(telemetryOutputDir, "whisper_stderr_sample.txt")
	if _, err := os.Stat(path); err == nil {
		return
	}
	_ = os.WriteFile(path, []byte(rawStderr), 0644)
}

// RecordBlockTelemetry ghi an toàn một bản ghi vào telemetry/blocks.jsonl
func RecordBlockTelemetry(rec BlockTelemetryRecord) {
	if !IsTelemetryEnabled() {
		return
	}
	telemetryMu.Lock()
	defer telemetryMu.Unlock()

	_ = os.MkdirAll(telemetryOutputDir, 0755)
	filePath := filepath.Join(telemetryOutputDir, "blocks.jsonl")
	data, err := json.Marshal(rec)
	if err != nil {
		return
	}

	f, err := os.OpenFile(filePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return
	}
	defer f.Close()

	_, _ = f.Write(append(data, '\n'))
}

// RecordSeekTelemetry ghi an toàn một bản ghi vào telemetry/seeks.jsonl
func RecordSeekTelemetry(rec SeekTelemetryRecord) {
	if !IsTelemetryEnabled() {
		return
	}
	telemetryMu.Lock()
	defer telemetryMu.Unlock()

	_ = os.MkdirAll(telemetryOutputDir, 0755)
	filePath := filepath.Join(telemetryOutputDir, "seeks.jsonl")
	data, err := json.Marshal(rec)
	if err != nil {
		return
	}

	f, err := os.OpenFile(filePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return
	}
	defer f.Close()

	_, _ = f.Write(append(data, '\n'))
}

// FormatTimeNow trả về RFC3339 string
func FormatTimeNow() string {
	return time.Now().Format(time.RFC3339Nano)
}
