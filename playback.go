package main

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Chuyển mã nền để PHÁT HÌNH trong WebView2. Whisper/ffmpeg cắt audio vẫn đọc từ file gốc,
// nên pipeline phụ đề không phụ thuộc vào bước này.

const playbackCacheKeep = 6 // giữ tối đa N file đã chuyển mã gần nhất (mỗi file có thể vài trăm MB)

// playbackCacheDir trả về %LOCALAPPDATA%\SubTrans\playback
func playbackCacheDir() string {
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		localAppData = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
	}
	return filepath.Join(localAppData, "SubTrans", "playback")
}

// playbackCacheFile trả về đường dẫn file .mp4 đã chuyển mã cho 1 video.
// Khóa gồm đường dẫn + kích thước + mtime (file local) để file gốc thay đổi thì tự tạo bản mới.
// fullVideo=true là bản mã hóa lại H.264; false là bản chỉ copy luồng hình (remux).
func playbackCacheFile(path string, fullVideo bool) string {
	key := path
	if !IsDrivePath(path) {
		if fi, err := os.Stat(path); err == nil {
			key += "|" + strconv.FormatInt(fi.Size(), 10) + "|" + strconv.FormatInt(fi.ModTime().UnixNano(), 10)
		}
	}
	sum := sha1.Sum([]byte(key))
	mode := "remux"
	if fullVideo {
		mode = "h264"
	}
	return filepath.Join(playbackCacheDir(), hex.EncodeToString(sum[:10])+"_"+mode+".mp4")
}

// findCachedPlayback trả về bản chuyển mã có sẵn (ưu tiên bản phù hợp với plan, sau đó bản H.264 đầy đủ)
func findCachedPlayback(path string, plan PlaybackPlan) (string, bool) {
	candidates := []string{playbackCacheFile(path, true)}
	if plan.CopyVideo {
		candidates = append([]string{playbackCacheFile(path, false)}, candidates...)
	}
	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && fi.Size() > 0 {
			now := time.Now()
			_ = os.Chtimes(c, now, now) // đánh dấu vừa dùng cho việc dọn cache theo LRU
			return c, true
		}
	}
	return "", false
}

// BuildTranscodeArgs dựng tham số ffmpeg tạo bản .mp4 (H.264 8-bit 4:2:0 + AAC) phát được trên mọi WebView2
func BuildTranscodeArgs(input, output string, plan PlaybackPlan, isHTTP bool) []string {
	args := []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-nostats", "-progress", "pipe:2"}
	if isHTTP {
		args = append(args, "-seekable", "1", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5")
	}
	args = append(args,
		"-i", input,
		// 0:V (chữ hoa) bỏ qua ảnh bìa attached_pic; dấu ? để file thiếu luồng không bị lỗi
		"-map", "0:V:0?", "-map", "0:a:0?",
		"-sn", "-dn",
	)
	if plan.CopyVideo {
		args = append(args, "-c:v", "copy")
	} else {
		args = append(args,
			"-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
			"-pix_fmt", "yuv420p", "-profile:v", "high",
			// Giới hạn 1080p: video 4K mã hóa lại rất chậm mà khung xem trong app không cần
			"-vf", "scale='min(1920,iw)':-2",
			// Chừa CPU cho Whisper đang chạy song song
			"-threads", "4",
		)
	}
	if plan.CopyAudio {
		args = append(args, "-c:a", "copy")
	} else {
		args = append(args, "-c:a", "aac", "-b:a", "160k", "-ac", "2")
	}
	args = append(args, "-movflags", "+faststart", "-f", "mp4", "-y", output)
	return args
}

// parseFFmpegProgressLine đọc dòng "out_time_us=12345678" (hoặc out_time_ms, cùng đơn vị micro giây) của -progress
func parseFFmpegProgressLine(line string) (float64, bool) {
	for _, key := range []string{"out_time_us=", "out_time_ms="} {
		if strings.HasPrefix(line, key) {
			v, err := strconv.ParseInt(strings.TrimPrefix(line, key), 10, 64)
			if err != nil || v < 0 {
				return 0, false
			}
			return float64(v) / 1e6, true
		}
	}
	return 0, false
}

// RunPlaybackTranscode chạy ffmpeg tạo file output (ghi .part rồi rename để không bao giờ phát file dở dang).
// onProgress nhận phần trăm 0..100 (âm nếu không biết thời lượng).
func RunPlaybackTranscode(ctx context.Context, tools *ToolsPaths, input, output string, plan PlaybackPlan, durationSec float64, onProgress func(float64)) error {
	if tools == nil || tools.FFmpeg == "" {
		return fmt.Errorf("không tìm thấy ffmpeg")
	}
	if err := os.MkdirAll(filepath.Dir(output), 0755); err != nil {
		return fmt.Errorf("không thể tạo thư mục cache phát video: %w", err)
	}
	part := output + ".part"
	isHTTP := strings.HasPrefix(input, "http://") || strings.HasPrefix(input, "https://")
	args := BuildTranscodeArgs(input, part, plan, isHTTP)

	// Timeout rộng: mã hóa lại có thể chậm hơn thời gian thực trên máy yếu
	timeout := 30 * time.Minute
	if durationSec > 0 {
		timeout = time.Duration(durationSec*3)*time.Second + 15*time.Minute
	}

	lastPct := -1.0
	res, err := RunCommand(ctx, tools.FFmpeg, args, timeout, func(line string) {
		sec, ok := parseFFmpegProgressLine(line)
		if !ok || onProgress == nil {
			return
		}
		pct := -1.0
		if durationSec > 0 {
			pct = sec / durationSec * 100
			if pct > 99.5 {
				pct = 99.5
			}
			if pct-lastPct < 0.5 {
				return // không bắn event quá dày
			}
			lastPct = pct
		}
		onProgress(pct)
	})
	if err != nil {
		_ = os.Remove(part)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		detail := ""
		if res != nil {
			detail = lastLines(res.Stderr, 4)
		}
		return fmt.Errorf("ffmpeg chuyển mã thất bại: %w %s", err, detail)
	}
	if fi, statErr := os.Stat(part); statErr != nil || fi.Size() == 0 {
		_ = os.Remove(part)
		return fmt.Errorf("ffmpeg không tạo được file phát video")
	}
	_ = os.Remove(output)
	if err := os.Rename(part, output); err != nil {
		_ = os.Remove(part)
		return fmt.Errorf("không thể lưu file đã chuyển mã: %w", err)
	}
	if onProgress != nil {
		onProgress(100)
	}
	cleanupPlaybackCache(filepath.Dir(output), playbackCacheKeep, output)
	return nil
}

// lastLines lấy vài dòng lỗi cuối (bỏ các dòng key=value của -progress)
func lastLines(s string, n int) string {
	var out []string
	for _, l := range strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n") {
		l = strings.TrimSpace(l)
		if l == "" || (strings.Contains(l, "=") && !strings.Contains(l, " ")) {
			continue
		}
		out = append(out, l)
	}
	if len(out) > n {
		out = out[len(out)-n:]
	}
	if len(out) == 0 {
		return ""
	}
	return "(" + strings.Join(out, " | ") + ")"
}

// cleanupPlaybackCache xóa bớt file cũ nhất (theo mtime) khi vượt quá keep file, không đụng tới except.
// File .part còn sót lại từ lần app bị tắt giữa chừng (cũ hơn 1 ngày) cũng được dọn.
func cleanupPlaybackCache(dir string, keep int, except string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type item struct {
		path string
		mod  time.Time
	}
	var files []item
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		full := filepath.Join(dir, e.Name())
		info, err := e.Info()
		if err != nil {
			continue
		}
		if strings.HasSuffix(e.Name(), ".part") {
			if time.Since(info.ModTime()) > 24*time.Hour {
				_ = os.Remove(full)
			}
			continue
		}
		if !strings.HasSuffix(e.Name(), ".mp4") || full == except {
			continue
		}
		files = append(files, item{full, info.ModTime()})
	}
	limit := keep - 1 // chừa 1 chỗ cho except
	if len(files) <= limit {
		return
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod.After(files[j].mod) })
	for _, f := range files[limit:] {
		_ = os.Remove(f.path)
	}
}
