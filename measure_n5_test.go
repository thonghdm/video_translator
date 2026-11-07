package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// Benchmark đo thời gian đến phụ đề tiếng Việt đầu tiên với DriveSpool trên file Drive THẬT.
// Mặc định BỎ QUA. Cách chạy (PowerShell, chạy RIÊNG test này vì DriveManager là singleton):
//
//	$env:SUBTRANS_BENCH = "1"
//	$env:SUBTRANS_BENCH_APPDATA = "$env:LOCALAPPDATA"          # nơi có SubTrans\drive_token.json
//	$env:SUBTRANS_BENCH_FILE_FMP4 = "<fileId video fMP4 nhỏ>"
//	$env:SUBTRANS_BENCH_FILE_MP4  = "<fileId MP4 thường > 100MB>"
//	go test -run TestMeasureN5 -count=1 -v .
//
// Không sao chép token/credentials đi đâu cả: DriveManager đọc trực tiếp từ SUBTRANS_BENCH_APPDATA.

type MeasN5Result struct {
	CaseName       string
	Run            int
	TimeToFirstViS float64
	SliceAudioS    float64
	WhisperSTTS    float64
	TranslateS     float64
	UsedSpool      bool
	FirstViText    string
}

func calcStatsN5(arr []float64) (p50 float64, max float64) {
	if len(arr) == 0 {
		return 0, 0
	}
	cpy := make([]float64, len(arr))
	copy(cpy, arr)
	sort.Float64s(cpy)
	mid := len(cpy) / 2
	if len(cpy)%2 == 0 {
		p50 = (cpy[mid-1] + cpy[mid]) / 2.0
	} else {
		p50 = cpy[mid]
	}
	return p50, cpy[len(cpy)-1]
}

func translateSimpleN5(text string) (string, error) {
	if strings.TrimSpace(text) == "" {
		return "", nil
	}
	u := "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=vi&dt=t&q=" + url.QueryEscape(text)
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var raw []interface{}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return "", err
	}
	if len(raw) > 0 {
		if arr, ok := raw[0].([]interface{}); ok && len(arr) > 0 {
			if seg, ok := arr[0].([]interface{}); ok && len(seg) > 0 {
				if trans, ok := seg[0].(string); ok {
					return trans, nil
				}
			}
		}
	}
	return "", fmt.Errorf("không đọc được kết quả dịch")
}

func TestMeasureN5(t *testing.T) {
	if os.Getenv("SUBTRANS_BENCH") != "1" {
		t.Skip("benchmark thật trên Drive: đặt SUBTRANS_BENCH=1 (xem hướng dẫn ở đầu file)")
	}
	fileFMP4 := os.Getenv("SUBTRANS_BENCH_FILE_FMP4")
	fileMP4 := os.Getenv("SUBTRANS_BENCH_FILE_MP4")
	appData := os.Getenv("SUBTRANS_BENCH_APPDATA")
	if fileFMP4 == "" || fileMP4 == "" || appData == "" {
		t.Skip("thiếu SUBTRANS_BENCH_APPDATA / SUBTRANS_BENCH_FILE_FMP4 / SUBTRANS_BENCH_FILE_MP4")
	}

	// DriveManager là singleton đọc LOCALAPPDATA lần đầu được gọi → đặt trỏ về thư mục thật trước khi gọi
	t.Setenv("LOCALAPPDATA", appData)
	dm := GetDriveManager()
	if !dm.IsLoggedIn() {
		t.Skip("chưa đăng nhập Drive trong " + appData + " (hoặc test khác đã khởi tạo DriveManager trước: chạy riêng -run TestMeasureN5)")
	}

	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("không có ffmpeg trong PATH")
	}
	whisperCLI := `build\bin\tools\whisper\whisper-cli.exe`
	whisperModel := `build\bin\models\ggml-base.bin`
	for _, p := range []string{whisperCLI, whisperModel} {
		if _, err := os.Stat(p); err != nil {
			t.Skip("thiếu " + p + " (chạy từ thư mục gốc dự án sau khi build)")
		}
	}

	runTrial := func(caseName, fileID string, startSec, lenSec, durationSec float64, runIdx int) (MeasN5Result, error) {
		tempDir, err := os.MkdirTemp("", "meas_n5_*")
		if err != nil {
			return MeasN5Result{}, err
		}
		defer os.RemoveAll(tempDir)
		spoolDir := filepath.Join(tempDir, "spool")
		if err := os.MkdirAll(spoolDir, 0755); err != nil {
			return MeasN5Result{}, err
		}
		spool := NewDriveSpool(spoolDir, 1000*1024*1024, dm)
		defer spool.Close()
		wavOut := filepath.Join(tempDir, "block.wav")

		t0 := time.Now()
		spool.StartSpool(fileID, 0) // tải nền như thực tế sau 'playing'

		// Đường cắt audio THẬT của app (spool + kiểm tra WAV + quay về proxy)
		tSlice0 := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
		defer cancel()
		usedSpool, err := sliceBlockAudio(ctx, sliceParams{
			tools:        &ToolsPaths{FFmpeg: ffmpegPath, TempDir: tempDir},
			videoPath:    DrivePathFromID(fileID),
			spool:        spool,
			resolveInput: func(string) string { u, _ := dm.StreamURL(fileID); return u },
			durationSec:  durationSec,
		}, BlockRange{ExtractStart: startSec, ExtractLen: lenSec}, wavOut)
		if err != nil {
			return MeasN5Result{}, fmt.Errorf("cắt audio: %w", err)
		}
		sliceDur := time.Since(tSlice0)
		if got, gerr := wavSecondsFromSize(wavOut); gerr != nil || got < minAcceptableSeconds(lenSec) {
			return MeasN5Result{}, fmt.Errorf("WAV hụt: %.2fs/%.2fs (err=%v)", got, lenSec, gerr)
		}

		tW0 := time.Now()
		outBase := filepath.Join(tempDir, "out")
		if out, err := exec.Command(whisperCLI, "-m", whisperModel, "-f", wavOut, "-l", "en", "-t", "4", "-oj", "-of", outBase).CombinedOutput(); err != nil {
			return MeasN5Result{}, fmt.Errorf("whisper: %w\n%s", err, out)
		}
		whisperDur := time.Since(tW0)

		dataJSON, err := os.ReadFile(outBase + ".json")
		if err != nil {
			return MeasN5Result{}, fmt.Errorf("không có kết quả whisper: %w", err)
		}
		var wOut struct {
			Transcription []struct {
				Text string `json:"text"`
			} `json:"transcription"`
		}
		if err := json.Unmarshal(dataJSON, &wOut); err != nil || len(wOut.Transcription) == 0 {
			return MeasN5Result{}, fmt.Errorf("whisper không ra câu nào (err=%v)", err)
		}
		firstEn := strings.TrimSpace(wOut.Transcription[0].Text)

		tT0 := time.Now()
		firstVi, err := translateSimpleN5(firstEn)
		if err != nil {
			return MeasN5Result{}, fmt.Errorf("dịch: %w", err)
		}
		transDur := time.Since(tT0)

		return MeasN5Result{
			CaseName: caseName, Run: runIdx,
			TimeToFirstViS: time.Since(t0).Seconds(),
			SliceAudioS:    sliceDur.Seconds(),
			WhisperSTTS:    whisperDur.Seconds(),
			TranslateS:     transDur.Seconds(),
			UsedSpool:      usedSpool,
			FirstViText:    firstVi,
		}, nil
	}

	cases := []struct {
		name     string
		file     string
		start    float64
		length   float64
		duration float64
	}{
		{"Ca 1: fMP4 nhỏ, block 0", fileFMP4, 0, 30, 400},
		{"Ca 2: MP4 thường >100MB, block 0", fileMP4, 0, 30, 922},
		{"Ca 3: MP4 thường >100MB, tua xa 150s (kỳ vọng proxy)", fileMP4, 150, 30, 922},
	}
	for _, c := range cases {
		fmt.Printf("\n>>> %s\n", c.name)
		var times []float64
		for i := 1; i <= 5; i++ {
			res, err := runTrial(c.name, c.file, c.start, c.length, c.duration, i)
			if err != nil {
				t.Errorf("%s lần %d: %v", c.name, i, err)
				continue
			}
			times = append(times, res.TimeToFirstViS)
			fmt.Printf("Run #%d: Total=%.2fs (Slice=%.2fs, Whisper=%.2fs, Trans=%.2fs) | UsedSpool=%v | VI: %q\n",
				i, res.TimeToFirstViS, res.SliceAudioS, res.WhisperSTTS, res.TranslateS, res.UsedSpool, res.FirstViText)
			time.Sleep(2 * time.Second)
		}
		p50, mx := calcStatsN5(times)
		fmt.Printf(">> Tổng kết %s: n=%d raw=%v p50=%.2fs max=%.2fs\n", c.name, len(times), times, p50, mx)
	}
}
