package main

import (
	"context"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func Test_DecidePlayback_Table(t *testing.T) {
	const mp4 = "mov,mp4,m4a,3gp,3g2,mj2"
	const mkv = "matroska,webm"
	cases := []struct {
		name                         string
		ext, format, vc, pix, ac     string
		convert, copyV, copyA, check bool
	}{
		{"h264 8bit mp4 aac -> phát thẳng", ".mp4", mp4, "h264", "yuv420p", "aac", false, false, false, false},
		{"h264 10bit mp4 -> mã hóa lại hình", ".mp4", mp4, "h264", "yuv420p10le", "aac", true, false, true, false},
		{"h264 444 -> mã hóa lại hình", ".mp4", mp4, "h264", "yuv444p", "aac", true, false, true, false},
		{"hevc 8bit mp4 -> phát thẳng nhưng frontend kiểm tra", ".mp4", mp4, "hevc", "yuv420p", "aac", false, false, false, true},
		{"hevc 10bit -> mã hóa lại", ".mp4", mp4, "hevc", "yuv420p10le", "aac", true, false, true, false},
		{"av1 8bit mp4 (yt-dlp) -> kiểm tra", ".mp4", mp4, "av1", "yuv420p", "aac", false, false, false, true},
		{"av1 10bit -> mã hóa lại", ".mp4", mp4, "av1", "yuv420p10le", "opus", true, false, false, false},
		{"h264 trong mkv -> chỉ remux", ".mkv", mkv, "h264", "yuv420p", "aac", true, true, true, false},
		{"h264 mkv ac3 -> copy hình, đổi tiếng", ".mkv", mkv, "h264", "yuv420p", "ac3", true, true, false, false},
		{"mp4 h264 eac3 -> đổi tiếng", ".mp4", mp4, "h264", "yuv420p", "eac3", true, true, false, false},
		{"hevc trong mkv -> mã hóa lại", ".mkv", mkv, "hevc", "yuv420p", "aac", true, false, true, false},
		{"avi mpeg4 mp3 -> mã hóa lại hình", ".avi", "avi", "mpeg4", "yuv420p", "mp3", true, false, true, false},
		{"webm vp9 opus -> phát thẳng", ".webm", mkv, "vp9", "yuv420p", "opus", false, false, false, false},
		{"webm av1 -> kiểm tra", ".webm", mkv, "av1", "yuv420p", "opus", false, false, false, true},
		{"đuôi .webm nhưng h264 -> remux", ".webm", mkv, "h264", "yuv420p", "aac", true, true, true, false},
		{"vp9 10bit (HDR) -> mã hóa lại", ".webm", mkv, "vp9", "yuv420p10le", "opus", true, false, false, false},
		{"mov h264 aac -> phát thẳng", ".mov", mp4, "h264", "yuvj420p", "aac", false, false, false, false},
		{"mp4 chỉ có tiếng", ".mp4", mp4, "", "", "aac", false, false, false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := DecidePlayback(c.ext, c.format, c.vc, c.pix, c.ac)
			if p.NeedConvert != c.convert || p.CopyVideo != c.copyV || p.CopyAudio != c.copyA || (p.CheckMIME != "") != c.check {
				t.Fatalf("plan = %+v; muốn convert=%v copyV=%v copyA=%v check=%v", p, c.convert, c.copyV, c.copyA, c.check)
			}
			if p.NeedConvert && len(p.Reasons) == 0 {
				t.Fatalf("cần chuyển mã nhưng không có lý do hiển thị cho người dùng")
			}
		})
	}
}

func Test_ParseFFmpegProgressLine(t *testing.T) {
	if s, ok := parseFFmpegProgressLine("out_time_us=12500000"); !ok || s != 12.5 {
		t.Fatalf("out_time_us: %v %v", s, ok)
	}
	if s, ok := parseFFmpegProgressLine("out_time_ms=3000000"); !ok || s != 3 {
		t.Fatalf("out_time_ms: %v %v", s, ok)
	}
	for _, l := range []string{"out_time=00:00:01.00", "frame=10", "out_time_us=N/A", "progress=end"} {
		if _, ok := parseFFmpegProgressLine(l); ok {
			t.Fatalf("không được parse %q", l)
		}
	}
}

func Test_BuildTranscodeArgs(t *testing.T) {
	remux := strings.Join(BuildTranscodeArgs("in.mkv", "out.part", PlaybackPlan{NeedConvert: true, CopyVideo: true, CopyAudio: true}, false), " ")
	if !strings.Contains(remux, "-c:v copy") || !strings.Contains(remux, "-c:a copy") || strings.Contains(remux, "libx264") {
		t.Fatalf("remux sai: %s", remux)
	}
	full := strings.Join(BuildTranscodeArgs("http://127.0.0.1/x", "out.part", PlaybackPlan{NeedConvert: true}, true), " ")
	for _, want := range []string{"libx264", "-pix_fmt yuv420p", "-c:a aac", "+faststart", "-map 0:V:0?", "-reconnect 1", "-f mp4"} {
		if !strings.Contains(full, want) {
			t.Fatalf("thiếu %q trong: %s", want, full)
		}
	}
}

func Test_MediaContentType_IgnoresRegistry(t *testing.T) {
	for in, want := range map[string]string{"a.MP4": "video/mp4", "b.mov": "video/mp4", "c.webm": "video/webm", "d.m4v": "video/mp4"} {
		if got := mediaContentType(in); got != want {
			t.Errorf("%s -> %s, muốn %s", in, got, want)
		}
	}
}

// AddMediaFile phải giữ token của file gốc còn hiệu lực (không làm <video> đang phát bị 403),
// còn SetMediaFile (mở video mới) phải vô hiệu mọi token cũ.
func Test_MediaServer_AddMediaFile_KeepsOldToken(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.mp4")
	b := filepath.Join(dir, "b.mp4")
	_ = os.WriteFile(a, []byte("AAAA"), 0644)
	_ = os.WriteFile(b, []byte("BBBB"), 0644)

	ms, err := GetMediaServer()
	if err != nil {
		t.Fatal(err)
	}
	get := func(u string) (int, string) {
		resp, err := http.Get(u)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}

	urlA, _ := ms.SetMediaFile(a)
	urlB, _ := ms.AddMediaFile(b)
	if code, body := get(urlA); code != 200 || body != "AAAA" {
		t.Fatalf("token gốc phải còn hiệu lực: %d %q", code, body)
	}
	if code, body := get(urlB); code != 200 || body != "BBBB" {
		t.Fatalf("token bản chuyển mã: %d %q", code, body)
	}
	_, _ = ms.SetMediaFile(a)
	if code, _ := get(urlB); code != http.StatusForbidden {
		t.Fatalf("mở video mới phải hủy token cũ, nhận %d", code)
	}
}

func Test_CleanupPlaybackCache(t *testing.T) {
	dir := t.TempDir()
	var names []string
	for i := 0; i < 5; i++ {
		p := filepath.Join(dir, string(rune('a'+i))+".mp4")
		_ = os.WriteFile(p, []byte("x"), 0644)
		names = append(names, p)
	}
	cleanupPlaybackCache(dir, 3, names[0])
	left, _ := os.ReadDir(dir)
	if len(left) != 3 {
		t.Fatalf("phải còn 3 file, còn %d", len(left))
	}
	if _, err := os.Stat(names[0]); err != nil {
		t.Fatalf("file đang dùng bị xóa nhầm")
	}
}

// ---------------------------------------------------------------------------
// Tích hợp với ffmpeg thật: tạo các video "khó" giống thực tế rồi kiểm tra probe + chuyển mã
// ---------------------------------------------------------------------------

func realFFTools(t *testing.T) *ToolsPaths {
	t.Helper()
	ff, err1 := exec.LookPath("ffmpeg")
	fp, err2 := exec.LookPath("ffprobe")
	if err1 != nil || err2 != nil {
		t.Skip("không có ffmpeg/ffprobe trong PATH")
	}
	return &ToolsPaths{FFmpeg: ff, FFprobe: fp}
}

func makeSample(t *testing.T, tools *ToolsPaths, out string, enc ...string) {
	t.Helper()
	args := []string{"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15:duration=3",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=3",
		"-shortest"}
	args = append(args, enc...)
	args = append(args, out)
	if b, err := exec.Command(tools.FFmpeg, args...).CombinedOutput(); err != nil {
		t.Skipf("ffmpeg không tạo được mẫu %s (thiếu encoder?): %v %s", filepath.Base(out), err, b)
	}
}

func Test_Playback_RealFFmpeg_ProbeAndConvert(t *testing.T) {
	tools := realFFTools(t)
	dir := t.TempDir()

	samples := []struct {
		name    string
		enc     []string
		convert bool
		check   bool
	}{
		{"ok_h264.mp4", []string{"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"}, false, false},
		{"h264_10bit.mp4", []string{"-c:v", "libx264", "-pix_fmt", "yuv420p10le", "-c:a", "aac"}, true, false},
		{"hevc_10bit.mp4", []string{"-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1", "-c:a", "aac"}, true, false},
		{"hevc_8bit.mp4", []string{"-c:v", "libx265", "-pix_fmt", "yuv420p", "-tag:v", "hvc1", "-c:a", "aac"}, false, true},
		{"av1.mp4", []string{"-c:v", "libaom-av1", "-cpu-used", "8", "-crf", "50", "-pix_fmt", "yuv420p", "-c:a", "aac"}, false, true},
		{"h264_in.mkv", []string{"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"}, true, false},
		{"h264_ac3.mkv", []string{"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "ac3"}, true, false},
		{"mpeg4.avi", []string{"-c:v", "mpeg4", "-c:a", "libmp3lame"}, true, false},
	}

	for _, s := range samples {
		t.Run(s.name, func(t *testing.T) {
			src := filepath.Join(dir, s.name)
			makeSample(t, tools, src, s.enc...)

			probe, err := ProbeMedia(tools, src)
			if err != nil {
				t.Fatalf("probe: %v", err)
			}
			if probe.Plan.NeedConvert != s.convert || (probe.Plan.CheckMIME != "") != s.check {
				t.Fatalf("plan sai cho %s: %+v (codec=%s pix=%s audio=%s format=%s)", s.name, probe.Plan, probe.VideoCodec, probe.PixFmt, probe.AudioCodec, probe.FormatName)
			}
			if !s.convert && !s.check {
				return
			}

			// Mô phỏng PreparePlayback (force khi WebView2 báo lỗi với codec "cần kiểm tra")
			plan := probe.Plan
			if !plan.NeedConvert {
				plan = PlaybackPlan{NeedConvert: true, CopyAudio: probe.AudioCodec == "aac"}
			}
			out := filepath.Join(dir, "out_"+s.name+".mp4")
			var lastPct float64
			if err := RunPlaybackTranscode(context.Background(), tools, src, out, plan, probe.DurationSec, func(p float64) { lastPct = p }); err != nil {
				t.Fatalf("chuyển mã: %v", err)
			}
			if lastPct != 100 {
				t.Errorf("tiến độ cuối phải là 100, nhận %v", lastPct)
			}
			if _, err := os.Stat(out + ".part"); err == nil {
				t.Errorf("còn sót file .part")
			}

			res, err := ProbeMedia(tools, out)
			if err != nil {
				t.Fatalf("probe output: %v", err)
			}
			if res.VideoCodec != "h264" || !pixFmt8bit420(res.PixFmt) || (res.AudioCodec != "aac" && res.AudioCodec != "mp3") {
				t.Fatalf("output chưa tương thích: video=%s pix=%s audio=%s", res.VideoCodec, res.PixFmt, res.AudioCodec)
			}
			if !res.Playable || res.Plan.CheckMIME != "" {
				t.Fatalf("output phải phát thẳng được: %+v", res.Plan)
			}
			if res.DurationSec < 2.5 {
				t.Fatalf("thời lượng output sai: %v", res.DurationSec)
			}
		})
	}
}

// Luồng đầy đủ ở tầng App: PreparePlayback chạy nền -> tạo file cache -> MediaURL mới phục vụ được qua HTTP,
// lần mở sau findCachedPlayback tìm thấy bản đã chuyển mã.
func Test_App_PreparePlayback_EndToEnd(t *testing.T) {
	tools := realFFTools(t)
	dir := t.TempDir()
	src := filepath.Join(dir, "lecture.mkv")
	makeSample(t, tools, src, "-c:v", "libx264", "-pix_fmt", "yuv420p10le", "-c:a", "ac3")

	ms, err := GetMediaServer()
	if err != nil {
		t.Fatal(err)
	}
	origURL, _ := ms.SetMediaFile(src)
	a := &App{tools: tools, mediaServer: ms, currentVideo: src,
		currentInfo: &VideoInfo{Path: src, MediaURL: origURL, DurationSec: 3}}

	if err := a.PreparePlayback("khac.mp4", false); err == nil {
		t.Fatalf("video không đang mở phải bị từ chối")
	}
	if err := a.PreparePlayback(src, false); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(60 * time.Second)
	for {
		a.mu.Lock()
		done := a.currentInfo.Converted
		url := a.currentInfo.MediaURL
		a.mu.Unlock()
		if done {
			resp, err := http.Get(url)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "video/mp4" {
				t.Fatalf("bản chuyển mã phục vụ sai: %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
			}
			// file gốc vẫn còn phục vụ được (không làm <video> đang phát bị 403)
			resp2, _ := http.Get(origURL)
			resp2.Body.Close()
			if resp2.StatusCode != 200 {
				t.Fatalf("token file gốc bị hủy sớm: %d", resp2.StatusCode)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job chuyển mã không xong")
		}
		time.Sleep(100 * time.Millisecond)
	}

	probe, err := ProbeMedia(tools, src)
	if err != nil {
		t.Fatal(err)
	}
	cached, ok := findCachedPlayback(src, probe.Plan)
	if !ok {
		t.Fatalf("lần mở sau phải dùng lại bản trong cache")
	}
	out, _ := ProbeMedia(tools, cached)
	if out.VideoCodec != "h264" || out.PixFmt != "yuv420p" || out.AudioCodec != "aac" {
		t.Fatalf("cache sai codec: %+v", out)
	}
}

func Test_Playback_RealFFmpeg_Cancel(t *testing.T) {
	tools := realFFTools(t)
	dir := t.TempDir()
	src := filepath.Join(dir, "src.mp4")
	makeSample(t, tools, src, "-c:v", "libx264", "-pix_fmt", "yuv420p10le", "-c:a", "aac")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out := filepath.Join(dir, "out.mp4")
	if err := RunPlaybackTranscode(ctx, tools, src, out, PlaybackPlan{NeedConvert: true}, 3, nil); err == nil {
		t.Fatalf("job đã hủy phải trả lỗi")
	}
	for _, p := range []string{out, out + ".part"} {
		if _, err := os.Stat(p); err == nil {
			t.Fatalf("hủy rồi mà vẫn còn file %s", filepath.Base(p))
		}
	}
}

func Test_DiagWrap_LogsRequest(t *testing.T) {
	h := diagWrap("local", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(206)
		_, _ = w.Write([]byte("hello"))
	})
	req, _ := http.NewRequest("GET", "http://x/media/t", nil)
	req.Header.Set("Range", "bytes=0-")
	req.Header.Set("User-Agent", "Mozilla/5.0 Edg/140")
	rec := &fakeRW{h: http.Header{}}
	h(rec, req)
	b, err := os.ReadFile(diagLogPath())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "[http local] video") || !strings.Contains(string(b), "-> 206") || !strings.Contains(string(b), "bytes=5B") {
		t.Fatalf("log thiếu thông tin: %s", b)
	}
}

type fakeRW struct {
	h    http.Header
	code int
}

func (f *fakeRW) Header() http.Header         { return f.h }
func (f *fakeRW) Write(b []byte) (int, error) { return len(b), nil }
func (f *fakeRW) WriteHeader(c int)           { f.code = c }

func Test_PreparePlayback_RejectsGDrive(t *testing.T) {
	a := &App{
		currentVideo: "gdrive://1Lefyhe4lnA8vCLpkEA2NXRB4x6cEyjx7",
	}
	err := a.PreparePlayback("gdrive://1Lefyhe4lnA8vCLpkEA2NXRB4x6cEyjx7", true)
	if err == nil {
		t.Fatal("PreparePlayback phải từ chối video Google Drive")
	}
	if !strings.Contains(err.Error(), "không hỗ trợ chuyển mã cho video Google Drive") {
		t.Fatalf("thông báo lỗi không đúng: %v", err)
	}
}

