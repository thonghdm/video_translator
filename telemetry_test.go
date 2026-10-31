package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const variantSample = `whisper_print_timings: load time = 120 ms
whisper_print_timings: fallbacks = 1 p / 2 h
whisper_print_timings: mel time = 10.50 ms
whisper_print_timings: encode time = 2500.0 ms / 2 runs ( 1250.0 ms per run)
whisper_print_timings: decode time = 95.2 ms / 5 runs ( 19.04 ms per run)
whisper_print_timings: total time = 2750.75 ms
`

const invalidSample = `some error occurred in whisper
failed to open file
exit code 1
`

func TestParseWhisperTimings_RealSamples(t *testing.T) {
	files := []struct {
		path         string
		expectedRuns int
		expectedLang string
	}{
		{"telemetry/whisper_stderr_sample.txt", 2, "en"},
		{"telemetry/runs/threads_2/whisper_stderr_sample.txt", 3, "en"},
		{"telemetry/runs/threads_4/whisper_stderr_sample.txt", 3, "en"},
		{"telemetry/runs/threads_6/whisper_stderr_sample.txt", 3, "en"},
	}

	for _, tc := range files {
		data, err := os.ReadFile(tc.path)
		if err != nil {
			t.Logf("file %s chưa có, bỏ qua kiểm tra trực tiếp file", tc.path)
			continue
		}
		timings := ParseWhisperTimings(string(data))
		if !timings.Parsed {
			t.Fatalf("file %s: parse thất bại", tc.path)
		}
		if timings.Encode.Runs != tc.expectedRuns {
			t.Errorf("file %s: expected runs %d, got %d", tc.path, tc.expectedRuns, timings.Encode.Runs)
		}
		if timings.DetectedLang != tc.expectedLang {
			t.Errorf("file %s: expected lang %s, got %s", tc.path, tc.expectedLang, timings.DetectedLang)
		}
		if timings.Encode.MsPerRun == nil || *timings.Encode.MsPerRun <= 0 {
			t.Errorf("file %s: invalid MsPerRun %v", tc.path, timings.Encode.MsPerRun)
		}
		if timings.WavLenSec == nil || *timings.WavLenSec <= 0 {
			t.Errorf("file %s: invalid WavLenSec %v", tc.path, timings.WavLenSec)
		}
	}
}

func TestParseWhisperTimings_VariantSample(t *testing.T) {
	timings := ParseWhisperTimings(variantSample)
	if !timings.Parsed {
		t.Fatalf("expected timings.Parsed to be true")
	}
	if timings.LoadMs == nil || *timings.LoadMs != 120.0 {
		t.Errorf("expected LoadMs 120, got %v", timings.LoadMs)
	}
	if timings.Fallbacks != 3 {
		t.Errorf("expected Fallbacks 1+2=3, got %d", timings.Fallbacks)
	}
	if timings.Encode.Runs != 2 {
		t.Errorf("expected Encode.Runs 2, got %d", timings.Encode.Runs)
	}
	if timings.TotalMs == nil || *timings.TotalMs != 2750.75 {
		t.Errorf("expected TotalMs 2750.75, got %v", timings.TotalMs)
	}
}

func TestParseWhisperTimings_InvalidSample(t *testing.T) {
	timings := ParseWhisperTimings(invalidSample)
	if timings.Parsed {
		t.Fatalf("expected timings.Parsed to be false")
	}
	if timings.LoadMs != nil {
		t.Errorf("expected nil LoadMs, got %v", timings.LoadMs)
	}
	if timings.TotalMs != nil {
		t.Errorf("expected nil TotalMs, got %v", timings.TotalMs)
	}
}

func Test_BUG01_MeasureDetectOnce(t *testing.T) {
	src := os.Getenv("VT_HARNESS_VIDEO")
	if src == "" {
		src = filepath.Join(os.Getenv("LOCALAPPDATA"), "SubTrans", "youtube", "Advanced_Golang_-_Channels_Context_and_Interfaces_Explained_[VkGQFFl66X4].mp4")
	}
	if _, err := os.Stat(src); err != nil {
		t.Skipf("không tìm thấy video mẫu: %v", err)
	}

	repoRoot, _ := os.Getwd()
	binDir := filepath.Join(repoRoot, "build", "bin")
	tools := &ToolsPaths{
		BaseDir:      binDir,
		FFmpeg:       filepath.Join(binDir, "tools", "ffmpeg", "ffmpeg.exe"),
		FFprobe:      filepath.Join(binDir, "tools", "ffmpeg", "ffprobe.exe"),
		WhisperCLI:   filepath.Join(binDir, "tools", "whisper", "whisper-cli.exe"),
		WhisperModel: filepath.Join(binDir, "models", "ggml-base.bin"),
	}

	workDir := t.TempDir()
	t.Setenv("LOCALAPPDATA", filepath.Join(workDir, "appdata"))
	t.Setenv("VT_TELEMETRY", "1")

	runDir := filepath.Join(workDir, "telemetry_out")
	prevDir := telemetryOutputDir
	telemetryOutputDir = runDir
	defer func() { telemetryOutputDir = prevDir }()

	probe, err := ProbeMedia(tools, src)
	if err != nil {
		t.Fatalf("ffprobe error: %v", err)
	}

	meta := CacheMeta{
		BlockSec:     30.0,
		OverlapSec:   2.0,
		DurationSec:  probe.DurationSec,
		WhisperModel: "ggml-base.bin",
	}
	bs, err := NewBlockStore(src, meta)
	if err != nil {
		t.Fatalf("NewBlockStore error: %v", err)
	}

	settings := Settings{
		BlockSec:         30.0,
		OverlapSec:       2.0,
		LookaheadMinSec:  45.0,
		LookaheadMaxSec:  300.0,
		TranslateWorkers: 1,
		WhisperThreads:   4,
		SourceLang:       "auto",
	}

	mockTrans := &MockTranslator{}
	pipe := NewPipeline(src, probe.DurationSec, settings, tools, bs, mockTrans, PipelineEventCallbacks{})
	if err := pipe.Start(0); err != nil {
		t.Fatalf("pipe.Start error: %v", err)
	}

	// Chờ hoàn thành 3 block (block 0, 1, 2)
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if len(bs.GetDoneBlocks()) >= 3 {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	pipe.Stop()

	// Đọc blocks.jsonl
	data, err := os.ReadFile(filepath.Join(runDir, "blocks.jsonl"))
	if err != nil {
		t.Fatalf("không đọc được blocks.jsonl: %v", err)
	}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line == "" {
			continue
		}
		var r BlockTelemetryRecord
		if err := json.Unmarshal([]byte(line), &r); err == nil {
			encMs := 0.0
			if r.WhisperEncodeMs != nil {
				encMs = *r.WhisperEncodeMs
			}
			t.Logf("[MEASURE] Block=%d LangArg=%s WallMs=%d EncodeMs=%.1f Runs=%d",
				r.BlockIndex, r.WhisperLangArg, r.WhisperWallMs, encMs, r.WhisperEncodeRuns)
		}
	}
}
