package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestTelemetryHarness chạy pipeline thật (ffmpeg + whisper-cli + FastGTX) không cần giao diện để thu số đo.
// Chỉ chạy khi đặt VT_HARNESS_VIDEO=<đường dẫn video>. Các biến tùy chọn:
//
//	VT_HARNESS_THREADS  danh sách số thread whisper, ví dụ "2,4,6" (mặc định "4")
//	VT_HARNESS_OUT      thư mục ghi kết quả (mặc định "telemetry/runs")
func TestTelemetryHarness(t *testing.T) {
	src := os.Getenv("VT_HARNESS_VIDEO")
	if src == "" {
		t.Skip("đặt VT_HARNESS_VIDEO để chạy harness đo đạc thực tế")
	}

	outRoot := os.Getenv("VT_HARNESS_OUT")
	if outRoot == "" {
		outRoot = filepath.Join("telemetry", "runs")
	}
	absOut, err := filepath.Abs(outRoot)
	if err != nil {
		t.Fatal(err)
	}

	threadsEnv := os.Getenv("VT_HARNESS_THREADS")
	if threadsEnv == "" {
		threadsEnv = "4"
	}

	repoRoot, _ := os.Getwd()
	binDir := filepath.Join(repoRoot, "build", "bin")
	tools := &ToolsPaths{
		BaseDir:      binDir,
		FFmpeg:       filepath.Join(binDir, "tools", "ffmpeg", "ffmpeg.exe"),
		FFprobe:      filepath.Join(binDir, "tools", "ffmpeg", "ffprobe.exe"),
		WhisperCLI:   filepath.Join(binDir, "tools", "whisper", "whisper-cli.exe"),
		LlamaCLI:     filepath.Join(binDir, "tools", "llama", "llama-cli.exe"),
		LlamaServer:  filepath.Join(binDir, "tools", "llama", "llama-server.exe"),
		WhisperModel: filepath.Join(binDir, "models", "ggml-base.bin"),
		LlamaModel:   filepath.Join(binDir, "models", "qwen2.5-1.5b-instruct-q4_k_m.gguf"),
	}
	for _, p := range []string{tools.FFmpeg, tools.FFprobe, tools.WhisperCLI, tools.WhisperModel} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("thiếu file cần thiết: %s", p)
		}
	}

	for _, part := range strings.Split(threadsEnv, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || n <= 0 {
			t.Fatalf("VT_HARNESS_THREADS không hợp lệ: %q", part)
		}
		runDir := filepath.Join(absOut, fmt.Sprintf("threads_%d", n))
		runHarnessOnce(t, tools, src, n, runDir)
	}
}

func copyFile(dst, src string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func waitUntil(timeout time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(200 * time.Millisecond)
	}
	return cond()
}

func runHarnessOnce(t *testing.T, tools *ToolsPaths, src string, threads int, runDir string) {
	t.Helper()
	_ = os.RemoveAll(runDir)
	workDir := filepath.Join(runDir, "work")
	if err := os.MkdirAll(workDir, 0755); err != nil {
		t.Fatal(err)
	}

	// Sao chép video sang thư mục riêng KHÔNG có file .srt đi kèm để buộc chạy Whisper thật
	videoPath := filepath.Join(workDir, "video.mp4")
	if err := copyFile(videoPath, src); err != nil {
		t.Fatalf("không sao chép được video: %v", err)
	}

	runTools := *tools
	runTools.TempDir = filepath.Join(workDir, "tmp")
	_ = os.MkdirAll(runTools.TempDir, 0755)

	// Cache BlockStore riêng cho mỗi lần chạy (luôn bắt đầu từ trạng thái trống)
	t.Setenv("LOCALAPPDATA", filepath.Join(workDir, "appdata"))
	t.Setenv("VT_TELEMETRY", "1")
	t.Setenv("VT_WHISPER_THREADS", strconv.Itoa(threads))

	prevDir := telemetryOutputDir
	telemetryOutputDir = runDir
	defer func() { telemetryOutputDir = prevDir }()

	probe, err := ProbeMedia(&runTools, videoPath)
	if err != nil {
		t.Fatalf("ffprobe lỗi: %v", err)
	}
	dur := probe.DurationSec
	log.Printf("[harness] threads=%d video=%s duration=%.1fs", threads, src, dur)

	settings := Settings{
		BlockSec:         30.0,
		OverlapSec:       2.0,
		LookaheadMinSec:  45.0,
		LookaheadMaxSec:  3600.0, // không chặn đón đầu để các block chạy liên tiếp
		TranslateWorkers: 1,
		WhisperThreads:   4,
		SourceLang:       "auto",
	}

	meta := CacheMeta{
		Version:      "2.0",
		BlockSec:     settings.BlockSec,
		OverlapSec:   settings.OverlapSec,
		WhisperModel: filepath.Base(runTools.WhisperModel),
		LlamaModel:   filepath.Base(runTools.LlamaModel),
		DurationSec:  dur,
	}
	bs, err := NewBlockStore(videoPath, meta)
	if err != nil {
		t.Fatal(err)
	}

	trans := NewFastHybridTranslator(runTools.LlamaModel, runTools.LlamaServer, runTools.LlamaCLI)
	defer trans.Close()

	var chunksWithItems int64
	callbacks := PipelineEventCallbacks{
		OnStatus: func(PipelineStatus) {},
		OnChunk: func(c SubtitleChunkPayload) {
			if len(c.Items) > 0 {
				atomic.AddInt64(&chunksWithItems, 1)
			}
		},
		OnError: func(e PipelineError) {
			log.Printf("[harness] pipeline error stage=%s block=%d fatal=%v: %s", e.Stage, e.Block, e.Fatal, e.Message)
		},
	}

	pipe := NewPipeline(videoPath, dur, settings, &runTools, bs, trans, callbacks)
	if err := pipe.Start(0); err != nil {
		t.Fatal(err)
	}
	pipe.UpdatePlayhead(0, true)
	defer pipe.Stop()

	doneCount := func() int { return len(bs.GetDoneBlocks()) }

	// Pha A: xử lý liên tục từ đầu video (block 1 nguội, các block sau ấm)
	if !waitUntil(4*time.Minute, func() bool { return doneCount() >= 4 }) {
		t.Fatalf("pha A: quá thời gian chờ 4 block đầu (done=%d)", doneCount())
	}

	// Pha B: tua nhảy cóc 3 lần tới vùng chưa xử lý, khi pipeline đang chạy block nền
	for _, frac := range []float64{0.80, 0.55, 0.30} {
		target := float64(int(dur * frac))
		before := atomic.LoadInt64(&chunksWithItems)
		doneBefore := doneCount()
		if err := pipe.SeekTo(target); err != nil {
			t.Fatal(err)
		}
		pipe.UpdatePlayhead(target, true)
		log.Printf("[harness] seek -> %.0fs", target)
		if !waitUntil(2*time.Minute, func() bool { return atomic.LoadInt64(&chunksWithItems) > before }) {
			log.Printf("[harness] cảnh báo: không thấy phụ đề sau khi tua tới %.0fs trong 2 phút", target)
		}
		// Cho pipeline chạy thêm vài block nền trước lần tua kế tiếp
		waitUntil(90*time.Second, func() bool { return doneCount() >= doneBefore+2 })
	}

	// Pha C: chạy tiếp cho đủ mẫu (tối đa 150 giây hoặc ≥ 16 block)
	waitUntil(150*time.Second, func() bool { return doneCount() >= 16 })
	log.Printf("[harness] threads=%d hoàn tất, done_blocks=%d", threads, doneCount())
}

// S1Variant cấu hình cho một biến thể thử nghiệm A/B
type S1Variant struct {
	Name       string
	Lang       string
	BlockSec   float64
	OverlapSec float64
}

// TestS1Harness chạy kịch bản S1 liên tục (5 block liên tiếp) cho các biến thể A, B, C, C2, D, D2
// Chạy 3 vòng (rounds) với thứ tự đảo phiên để kiểm soát nhiễu nhiệt CPU.
func TestS1Harness(t *testing.T) {
	src := os.Getenv("VT_HARNESS_VIDEO")
	if src == "" {
		t.Skip("đặt VT_HARNESS_VIDEO để chạy S1 harness")
	}

	variants := map[string]S1Variant{
		"A":  {Name: "A", Lang: "auto", BlockSec: 30.0, OverlapSec: 2.0},
		"B":  {Name: "B", Lang: "en", BlockSec: 30.0, OverlapSec: 2.0},
		"C":  {Name: "C", Lang: "auto", BlockSec: 28.0, OverlapSec: 2.0},
		"C2": {Name: "C2", Lang: "auto", BlockSec: 25.0, OverlapSec: 2.0},
		"D":  {Name: "D", Lang: "en", BlockSec: 25.0, OverlapSec: 2.0},
		"D2": {Name: "D2", Lang: "detect-once", BlockSec: 25.0, OverlapSec: 2.0},
	}

	orders := [][]string{
		{"A", "B", "C", "C2", "D", "D2"},
		{"D2", "D", "C2", "C", "B", "A"},
		{"B", "D", "A", "C2", "D2", "C"},
	}

	repoRoot, _ := os.Getwd()
	binDir := filepath.Join(repoRoot, "build", "bin")
	tools := &ToolsPaths{
		BaseDir:      binDir,
		FFmpeg:       filepath.Join(binDir, "tools", "ffmpeg", "ffmpeg.exe"),
		FFprobe:      filepath.Join(binDir, "tools", "ffmpeg", "ffprobe.exe"),
		WhisperCLI:   filepath.Join(binDir, "tools", "whisper", "whisper-cli.exe"),
		LlamaCLI:     filepath.Join(binDir, "tools", "llama", "llama-cli.exe"),
		LlamaServer:  filepath.Join(binDir, "tools", "llama", "llama-server.exe"),
		WhisperModel: filepath.Join(binDir, "models", "ggml-base.bin"),
		LlamaModel:   filepath.Join(binDir, "models", "qwen2.5-1.5b-instruct-q4_k_m.gguf"),
	}

	outRoot := filepath.Join(repoRoot, "telemetry", "runs_s1")
	_ = os.MkdirAll(outRoot, 0755)

	for roundIdx, roundOrder := range orders {
		roundNum := roundIdx + 1
		for _, varKey := range roundOrder {
			v := variants[varKey]
			runDir := filepath.Join(outRoot, fmt.Sprintf("%s_r%d", v.Name, roundNum))
			runS1Once(t, tools, src, v, roundNum, runDir)
		}
	}
}

func runS1Once(t *testing.T, tools *ToolsPaths, src string, v S1Variant, round int, runDir string) {
	t.Helper()
	_ = os.RemoveAll(runDir)
	workDir := filepath.Join(runDir, "work")
	if err := os.MkdirAll(workDir, 0755); err != nil {
		t.Fatal(err)
	}

	videoPath := filepath.Join(workDir, "video.mp4")
	if err := copyFile(videoPath, src); err != nil {
		t.Fatalf("không sao chép được video: %v", err)
	}

	runTools := *tools
	runTools.TempDir = filepath.Join(workDir, "tmp")
	_ = os.MkdirAll(runTools.TempDir, 0755)

	t.Setenv("LOCALAPPDATA", filepath.Join(workDir, "appdata"))
	t.Setenv("VT_TELEMETRY", "1")
	t.Setenv("VT_WHISPER_THREADS", "4")
	t.Setenv("VT_WHISPER_LANG", v.Lang)
	t.Setenv("VT_BLOCK_SEC", fmt.Sprintf("%.1f", v.BlockSec))
	t.Setenv("VT_OVERLAP_SEC", fmt.Sprintf("%.1f", v.OverlapSec))
	t.Setenv("VT_VARIANT_NAME", v.Name)

	prevDir := telemetryOutputDir
	telemetryOutputDir = runDir
	defer func() { telemetryOutputDir = prevDir }()

	probe, err := ProbeMedia(&runTools, videoPath)
	if err != nil {
		t.Fatalf("ffprobe lỗi: %v", err)
	}
	dur := probe.DurationSec
	log.Printf("[S1-harness] variant=%s round=%d lang=%s block=%.1fs overlap=%.1fs", v.Name, round, v.Lang, v.BlockSec, v.OverlapSec)

	settings := Settings{
		BlockSec:         v.BlockSec,
		OverlapSec:       v.OverlapSec,
		LookaheadMinSec:  45.0,
		LookaheadMaxSec:  3600.0, // kịch bản S1 liên tục
		TranslateWorkers: 1,
		WhisperThreads:   4,
		SourceLang:       "auto",
	}

	meta := CacheMeta{
		Version:      "2.0",
		BlockSec:     settings.BlockSec,
		OverlapSec:   settings.OverlapSec,
		WhisperModel: filepath.Base(runTools.WhisperModel),
		LlamaModel:   filepath.Base(runTools.LlamaModel),
		DurationSec:  dur,
	}
	bs, err := NewBlockStore(videoPath, meta)
	if err != nil {
		t.Fatal(err)
	}

	trans := NewFastHybridTranslator(runTools.LlamaModel, runTools.LlamaServer, runTools.LlamaCLI)
	defer trans.Close()

	callbacks := PipelineEventCallbacks{
		OnStatus: func(PipelineStatus) {},
		OnChunk:  func(SubtitleChunkPayload) {},
		OnError: func(e PipelineError) {
			log.Printf("[S1-harness] error stage=%s block=%d: %s", e.Stage, e.Block, e.Message)
		},
	}

	pipe := NewPipeline(videoPath, dur, settings, &runTools, bs, trans, callbacks)
	if err := pipe.Start(0); err != nil {
		t.Fatal(err)
	}
	pipe.UpdatePlayhead(0, true)
	defer pipe.Stop()

	doneCount := func() int { return len(bs.GetDoneBlocks()) }

	// Chờ đúng 5 block liên tiếp hoàn thành
	if !waitUntil(5*time.Minute, func() bool { return doneCount() >= 5 }) {
		t.Fatalf("S1 variant=%s round=%d: quá thời gian chờ 5 block đầu (done=%d)", v.Name, round, doneCount())
	}
	pipe.Stop()

	// Lưu transcript đầy đủ (json + txt)
	items := bs.GetAllItemsSorted()
	jsonData, _ := json.MarshalIndent(items, "", "  ")
	_ = os.WriteFile(filepath.Join(runDir, "transcript.json"), jsonData, 0644)

	var txtSb strings.Builder
	for _, it := range items {
		fmt.Fprintf(&txtSb, "[%.2f --> %.2f] %s\n", it.StartSec, it.EndSec, it.SourceText)
	}
	_ = os.WriteFile(filepath.Join(runDir, "transcript.txt"), []byte(txtSb.String()), 0644)

	// Xóa thư mục tmp & appdata của workDir để giải phóng dung lượng
	_ = os.RemoveAll(workDir)
	log.Printf("[S1-harness] variant=%s round=%d HOÀN TẤT (5 blocks, %d subtitles)", v.Name, round, len(items))
}
