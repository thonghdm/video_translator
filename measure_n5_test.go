package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

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
	max = cpy[len(cpy)-1]
	return p50, max
}

func TestMeasureN5(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping slow benchmark in short mode")
	}

	// Sao chép drive_token.json và drive_credentials.json từ UserProfile AppData vào test directory
	userAppData := filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local", "SubTrans")
	testSubTransDir := filepath.Join(os.Getenv("LOCALAPPDATA"), "SubTrans")
	_ = os.MkdirAll(testSubTransDir, 0755)

	if tokData, err := os.ReadFile(filepath.Join(userAppData, "drive_token.json")); err == nil {
		_ = os.WriteFile(filepath.Join(testSubTransDir, "drive_token.json"), tokData, 0600)
	}
	if credsData, err := os.ReadFile(filepath.Join(userAppData, "drive_credentials.json")); err == nil {
		_ = os.WriteFile(filepath.Join(testSubTransDir, "drive_credentials.json"), credsData, 0600)
	}

	dm := GetDriveManager()
	if !dm.IsLoggedIn() {
		t.Fatalf("Chưa đăng nhập Google Drive")
	}

	ffmpegPath, _ := exec.LookPath("ffmpeg")
	if ffmpegPath == "" {
		ffmpegPath = "ffmpeg"
	}
	whisperCLI := `build\bin\tools\whisper\whisper-cli.exe`
	whisperModel := `build\bin\models\ggml-base.bin`

	translateSimple := func(text string) string {
		if strings.TrimSpace(text) == "" {
			return ""
		}
		u := "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=vi&dt=t&q=" + strings.ReplaceAll(text, " ", "%20")
		req, _ := http.NewRequest("GET", u, nil)
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return "(lỗi kết nối dịch)"
		}
		defer resp.Body.Close()
		var raw []interface{}
		if err := json.NewDecoder(resp.Body).Decode(&raw); err == nil && len(raw) > 0 {
			if arr, ok := raw[0].([]interface{}); ok && len(arr) > 0 {
				if seg, ok := arr[0].([]interface{}); ok && len(seg) > 0 {
					if trans, ok := seg[0].(string); ok {
						return trans
					}
				}
			}
		}
		return "(dịch fallback)"
	}

	runTrial := func(caseName, fileID string, startSec, lenSec, durationSec float64, runIdx int) MeasN5Result {
		tempDir, _ := os.MkdirTemp("", "meas_n5_*")
		defer os.RemoveAll(tempDir)
		spoolDir := filepath.Join(tempDir, "spool")
		_ = os.MkdirAll(spoolDir, 0755)

		spool := NewDriveSpool(spoolDir, 1000*1024*1024, dm)
		wavOut := filepath.Join(tempDir, "block.wav")
		proxyStreamURL, _ := dm.StreamURL(fileID)

		t0 := time.Now()

		// 1. Khởi động spool (tải nền tuần tự như thực tế sau 'playing')
		spool.StartSpool(fileID, 0)

		// 2. Slicer lấy media input (ưu tiên spool cục bộ, nếu chưa có thì fallback proxy)
		tSlice0 := time.Now()
		ctxSlice, cancelSlice := context.WithTimeout(context.Background(), 120*time.Second)
		defer cancelSlice()

		mediaInput, usedSpool := spool.GetAvailableMediaInput(ctxSlice, fileID, startSec, lenSec, durationSec)
		if !usedSpool {
			mediaInput = proxyStreamURL
		}

		var args []string
		if !usedSpool {
			args = append(args, "-seekable", "1", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5")
		}
		args = append(args,
			"-ss", fmt.Sprintf("%.3f", startSec),
			"-i", mediaInput,
			"-t", fmt.Sprintf("%.3f", lenSec),
			"-vn",
			"-acodec", "pcm_s16le",
			"-ar", "16000",
			"-ac", "1",
			"-threads", "2",
			"-y",
			wavOut,
		)

		cmdFF := exec.CommandContext(ctxSlice, ffmpegPath, args...)
		_ = cmdFF.Run()
		sliceDur := time.Since(tSlice0)

		// 3. Whisper STT
		tWhisper0 := time.Now()
		outTxtPath := filepath.Join(tempDir, "out")
		cmdWhisper := exec.Command(whisperCLI,
			"-m", whisperModel,
			"-f", wavOut,
			"-l", "en",
			"-t", "4",
			"-oj",
			"-of", outTxtPath,
		)
		_ = cmdWhisper.Run()
		whisperDur := time.Since(tWhisper0)

		firstEn := "Hello"
		dataJSON, errJSON := os.ReadFile(outTxtPath + ".json")
		if errJSON == nil {
			var wOut struct {
				Transcription []struct {
					Text string `json:"text"`
				} `json:"transcription"`
			}
			_ = json.Unmarshal(dataJSON, &wOut)
			if len(wOut.Transcription) > 0 {
				firstEn = strings.TrimSpace(wOut.Transcription[0].Text)
			}
		}

		// 4. Translate first sentence
		tTrans0 := time.Now()
		firstVi := translateSimple(firstEn)
		transDur := time.Since(tTrans0)

		total := time.Since(t0)

		return MeasN5Result{
			CaseName:       caseName,
			Run:            runIdx,
			TimeToFirstViS: total.Seconds(),
			SliceAudioS:    sliceDur.Seconds(),
			WhisperSTTS:    whisperDur.Seconds(),
			TranslateS:     transDur.Seconds(),
			UsedSpool:      usedSpool,
			FirstViText:    firstVi,
		}
	}

	fmt.Println("\n================================================================================")
	fmt.Println("   DO N>=5 THOI GIAN DEN PHU DE TIENG VIET DAU TIEN VOI DRIVESPOOL")
	fmt.Println("================================================================================")

	// Ca 1: Video fMP4 002 (13.74MB)
	fmt.Println("\n>>> CA 1: Video fMP4 (002 Higher-level Managed Services.mp4, 13.74MB)")
	var c1Times []float64
	for i := 1; i <= 5; i++ {
		res := runTrial("Ca 1: fMP4 002", "1zwsPkR1N09gh_0nNpha5BiQW51iNF3sL", 0, 30, 400, i)
		c1Times = append(c1Times, res.TimeToFirstViS)
		fmt.Printf("Run #%d: Total=%.2fs (SliceFFmpeg=%.2fs, Whisper=%.2fs, Trans=%.2fs) | UsedSpool=%v | VI: %q\n",
			i, res.TimeToFirstViS, res.SliceAudioS, res.WhisperSTTS, res.TranslateS, res.UsedSpool, res.FirstViText)
		time.Sleep(2 * time.Second)
	}
	p50_1, max_1 := calcStatsN5(c1Times)
	fmt.Printf(">> Tong ket Ca 1: raw=%v, p50=%.2fs, max=%.2fs\n", c1Times, p50_1, max_1)

	// Ca 2: Video MP4 thuong >100MB (104.86MB)
	fmt.Println("\n>>> CA 2: Video MP4 thuong >100MB (002 AWS Compute.mp4, 104.86MB)")
	var c2Times []float64
	for i := 1; i <= 5; i++ {
		res := runTrial("Ca 2: MP4 >100MB", "1IS1RMJmbyPPj754VNb8sWFHex50hLIU7", 0, 30, 922, i)
		c2Times = append(c2Times, res.TimeToFirstViS)
		fmt.Printf("Run #%d: Total=%.2fs (SliceFFmpeg=%.2fs, Whisper=%.2fs, Trans=%.2fs) | UsedSpool=%v | VI: %q\n",
			i, res.TimeToFirstViS, res.SliceAudioS, res.WhisperSTTS, res.TranslateS, res.UsedSpool, res.FirstViText)
		time.Sleep(2 * time.Second)
	}
	p50_2, max_2 := calcStatsN5(c2Times)
	fmt.Printf(">> Tong ket Ca 2: raw=%v, p50=%.2fs, max=%.2fs\n", c2Times, p50_2, max_2)

	// Ca 3: Tua xa vao vung chua tai (Seek to 150s tren video >100MB -> fallback proxy)
	fmt.Println("\n>>> CA 3: Tua xa vao vung chua tai (Seek startSec=150.0s -> Fallback Proxy)")
	var c3Times []float64
	for i := 1; i <= 5; i++ {
		res := runTrial("Ca 3: Seek 150s (Fallback Proxy)", "1IS1RMJmbyPPj754VNb8sWFHex50hLIU7", 150.0, 30.0, 922, i)
		c3Times = append(c3Times, res.TimeToFirstViS)
		fmt.Printf("Run #%d: Total=%.2fs (SliceFFmpeg=%.2fs, Whisper=%.2fs, Trans=%.2fs) | UsedSpool=%v | VI: %q\n",
			i, res.TimeToFirstViS, res.SliceAudioS, res.WhisperSTTS, res.TranslateS, res.UsedSpool, res.FirstViText)
		time.Sleep(2 * time.Second)
	}
	p50_3, max_3 := calcStatsN5(c3Times)
	fmt.Printf(">> Tong ket Ca 3: raw=%v, p50=%.2fs, max=%.2fs\n", c3Times, p50_3, max_3)
}
