package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Nhật ký chẩn đoán thời gian tải video ("video hiện rất chậm trong khi phụ đề đã dịch xong").
// Ghi vào %LOCALAPPDATA%\SubTrans\logs\playback_timing.log, tự xoay vòng khi vượt 2MB.
// Mỗi dòng: giờ | nguồn | nội dung. Chi phí rất nhỏ: chỉ ghi theo từng HTTP request / sự kiện UI.

var diagMu sync.Mutex

func diagLogPath() string {
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		localAppData = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
	}
	return filepath.Join(localAppData, "SubTrans", "logs", "playback_timing.log")
}

// DiagLog ghi 1 dòng vào nhật ký chẩn đoán (lỗi ghi file bị bỏ qua, không bao giờ làm hỏng luồng chính)
func DiagLog(format string, args ...interface{}) {
	diagMu.Lock()
	defer diagMu.Unlock()
	p := diagLogPath()
	_ = os.MkdirAll(filepath.Dir(p), 0755)
	if fi, err := os.Stat(p); err == nil && fi.Size() > 2<<20 {
		_ = os.Remove(p + ".old")
		_ = os.Rename(p, p+".old")
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().Format("15:04:05.000"), fmt.Sprintf(format, args...))
}

// diagResponseWriter đếm byte và đo thời gian tới byte đầu tiên của 1 response
type diagResponseWriter struct {
	http.ResponseWriter
	start     time.Time
	status    int
	bytes     int64
	firstByte time.Duration
}

func (d *diagResponseWriter) WriteHeader(code int) {
	if d.status == 0 {
		d.status = code
	}
	d.ResponseWriter.WriteHeader(code)
}

func (d *diagResponseWriter) Write(b []byte) (int, error) {
	if d.status == 0 {
		d.status = http.StatusOK
	}
	if d.bytes == 0 && len(b) > 0 {
		d.firstByte = time.Since(d.start)
	}
	n, err := d.ResponseWriter.Write(b)
	d.bytes += int64(n)
	return n, err
}

func (d *diagResponseWriter) Flush() {
	if fl, ok := d.ResponseWriter.(http.Flusher); ok {
		fl.Flush()
	}
}

// requestAgent phân biệt ai đang đọc: thẻ <video> của WebView2 hay ffmpeg/ffprobe của pipeline
func requestAgent(r *http.Request) string {
	ua := r.Header.Get("User-Agent")
	switch {
	case strings.HasPrefix(ua, "Lavf"):
		return "ffmpeg"
	case strings.Contains(ua, "Mozilla"):
		return "video"
	case ua == "":
		return "?"
	default:
		if len(ua) > 16 {
			ua = ua[:16]
		}
		return ua
	}
}

func fmtBytes(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1fMB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.0fKB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%dB", n)
	}
}

// diagWrap bọc handler HTTP để ghi: ai gọi, Range, status, thời gian tới byte đầu (TTFB), số byte, tốc độ
func diagWrap(source string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dw := &diagResponseWriter{ResponseWriter: w, start: time.Now()}
		h(dw, r)
		dur := time.Since(dw.start)
		rate := ""
		if dur > 200*time.Millisecond && dw.bytes > 0 {
			rate = fmt.Sprintf(" %.2fMB/s", float64(dw.bytes)/(1<<20)/dur.Seconds())
		}
		aborted := ""
		if r.Context().Err() != nil {
			aborted = " (client ngắt)"
		}
		rng := r.Header.Get("Range")
		if rng == "" {
			rng = "-"
		}
		DiagLog("[http %s] %-6s %s range=%s -> %d ttfb=%dms bytes=%s dur=%dms%s%s",
			source, requestAgent(r), r.Method, rng, dw.status,
			dw.firstByte.Milliseconds(), fmtBytes(dw.bytes), dur.Milliseconds(), rate, aborted)
	}
}

// LogPlaybackEvent nhận mốc thời gian từ frontend (ms tính từ lúc bấm mở video)
func (a *App) LogPlaybackEvent(path, event string, ms float64) {
	name := filepath.Base(path)
	if IsDrivePath(path) {
		if n := DriveDisplayName(path); n != "" {
			name = "drive:" + n
		}
	}
	DiagLog("[ui] +%6.0fms %-28s %s", ms, event, name)
}
