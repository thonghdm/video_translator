package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// Phục vụ HTTP Range cho trình phát (<video>) trực tiếp từ file spool cục bộ.
//
// Vì sao: trình phát WebView2 đọc MP4 bằng ~20 request Range nhỏ, mỗi request lên Google Drive tốn ~0,75s
// chờ phản hồi đầu (TTFB) → khung hình đầu tiên mất ~20s. DriveSpool đã tải file về đĩa bằng MỘT kết nối
// liên tục; nếu trình phát đọc từ file đó thì mọi request chỉ còn là đọc đĩa, không còn độ trễ theo từng request.

const (
	// Chỉ phục vụ từ spool khi vị trí bắt đầu không xa hơn phần đã tải quá ngần này (tua xa → đi thẳng Drive)
	spoolServeFrontierWindow = 6 << 20
	spoolServeChunk          = 256 << 10
	spoolServeTotalWait      = 3 * time.Second
)

var driveSpoolServer atomic.Pointer[DriveSpool]

// SetDriveSpoolServer đăng ký spool dùng để phục vụ route /drive/stream (nil = tắt, mọi request đi thẳng Drive).
func SetDriveSpoolServer(s *DriveSpool) { driveSpoolServer.Store(s) }

// serveFromSpool thử phục vụ request từ spool; trả về true nếu đã xử lý xong (kể cả khi bị ngắt giữa chừng).
func serveFromSpool(w http.ResponseWriter, r *http.Request, fileID string) bool {
	s := driveSpoolServer.Load()
	if s == nil {
		return false
	}
	return s.ServeRange(w, r, fileID)
}

// parseSingleRange phân tích "bytes=a-b" / "bytes=a-" / "bytes=-n" (một khoảng duy nhất) trên file dài total byte.
func parseSingleRange(h string, total int64) (start, end int64, ok bool) {
	if total <= 0 || !strings.HasPrefix(h, "bytes=") || strings.Contains(h, ",") {
		return 0, 0, false
	}
	a, b, found := strings.Cut(strings.TrimPrefix(h, "bytes="), "-")
	if !found {
		return 0, 0, false
	}
	a, b = strings.TrimSpace(a), strings.TrimSpace(b)
	switch {
	case a == "" && b != "": // suffix: n byte cuối
		n, err := strconv.ParseInt(b, 10, 64)
		if err != nil || n <= 0 {
			return 0, 0, false
		}
		if n > total {
			n = total
		}
		return total - n, total - 1, true
	case a != "":
		st, err := strconv.ParseInt(a, 10, 64)
		if err != nil || st < 0 || st >= total {
			return 0, 0, false
		}
		en := total - 1
		if b != "" {
			e, err := strconv.ParseInt(b, 10, 64)
			if err != nil || e < st {
				return 0, 0, false
			}
			if e < en {
				en = e
			}
		}
		return st, en, true
	}
	return 0, 0, false
}

func (s *DriveSpool) progressFor(fileID string) *SpoolProgress {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.activeProg != nil && s.activeProg.FileID == fileID {
		return s.activeProg
	}
	return nil
}

// ServeRange phục vụ request Range của fileID từ file spool. Trả về false (chưa ghi gì vào w) khi không thể/không nên
// phục vụ từ spool — người gọi khi đó đi thẳng Drive như cũ. Đã ghi header thì luôn trả true.
func (s *DriveSpool) ServeRange(w http.ResponseWriter, r *http.Request, fileID string) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	rangeHdr := r.Header.Get("Range")
	if rangeHdr == "" {
		return false
	}
	prog := s.progressFor(fileID)
	if prog == nil || (prog.Failed.Load() && !prog.Complete.Load()) {
		return false
	}
	// If-Range khác ETag đang giữ → để Drive quyết định (có thể trả cả file mới)
	if ir := r.Header.Get("If-Range"); ir != "" {
		if e := prog.ETag.Load(); e == nil || *e != ir {
			return false
		}
	}

	// Chờ response đầu của spool cho biết tổng kích thước (≈ 1 TTFB của Drive, chỉ một lần)
	// (và file .part đã được tạo — spool công bố TotalSize trước khi mở file ghi)
	s.waitFor(r.Context(), spoolServeTotalWait, func() bool {
		if prog.Failed.Load() && !prog.Complete.Load() {
			return true
		}
		if prog.TotalSize.Load() <= 0 {
			return false
		}
		_, err := os.Stat(prog.PartPath)
		return err == nil
	})
	if prog.Failed.Load() && !prog.Complete.Load() {
		return false
	}
	total := prog.TotalSize.Load()
	start, end, ok := parseSingleRange(rangeHdr, total)
	if !ok {
		return false
	}

	limit := total // phần có thể có trên đĩa: toàn bộ, hoặc prefix với file lớn
	if t := prog.TargetBytes.Load(); t > 0 && t < total {
		limit = t
	}
	if start >= limit {
		return false
	}
	if end >= limit {
		end = limit - 1
	}
	if !prog.Complete.Load() && start > prog.DownloadedBytes.Load()+spoolServeFrontierWindow {
		return false
	}

	f, err := os.Open(prog.PartPath)
	if err != nil {
		return false
	}
	defer f.Close()

	h := w.Header()
	ct := "video/mp4"
	if c := prog.ContentType.Load(); c != nil && *c != "" {
		ct = *c
	}
	h.Set("Content-Type", ct)
	h.Set("Accept-Ranges", "bytes")
	h.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, total))
	h.Set("Content-Length", strconv.FormatInt(end-start+1, 10))
	if e := prog.ETag.Load(); e != nil && *e != "" {
		h.Set("ETag", *e)
	}
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusPartialContent)
	if r.Method == http.MethodHead {
		return true
	}

	t0 := time.Now()
	sent, aborted := s.copyFromSpool(r.Context(), w, f, prog, start, end, total)
	DiagLog("[http spool] video GET range=%s -> 206 bytes=%dKB dur=%dms đã tải=%dMB%s",
		rangeHdr, sent/1024, time.Since(t0).Milliseconds(), prog.DownloadedBytes.Load()>>20, map[bool]string{true: " (dừng giữa chừng)", false: ""}[aborted])
	return true
}

// copyFromSpool chép [start,end] từ file spool ra w, đợi phần chưa tải xong. Dừng khi client ngắt, spool hỏng
// hoặc quá lâu không có byte mới (trình phát sẽ tự gửi request mới và lúc đó đi thẳng Drive).
func (s *DriveSpool) copyFromSpool(ctx context.Context, w http.ResponseWriter, f *os.File, prog *SpoolProgress, start, end, total int64) (sent int64, aborted bool) {
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, spoolServeChunk)
	pos := start
	lastData := time.Now()
	idleMax := s.stallTimeout
	if idleMax <= 0 {
		idleMax = defaultStallTimeout
	}
	for pos <= end {
		avail := prog.DownloadedBytes.Load()
		if prog.Complete.Load() {
			avail = total
		}
		if avail > end+1 {
			avail = end + 1
		}
		if avail <= pos {
			if ctx.Err() != nil || (prog.Failed.Load() && !prog.Complete.Load()) || time.Since(lastData) > idleMax {
				return sent, true
			}
			select {
			case <-ctx.Done():
				return sent, true
			case <-time.After(15 * time.Millisecond):
			}
			continue
		}
		n := avail - pos
		if n > int64(len(buf)) {
			n = int64(len(buf))
		}
		m, err := f.ReadAt(buf[:n], pos)
		if m > 0 {
			if _, werr := w.Write(buf[:m]); werr != nil {
				return sent, true // client ngắt: bình thường khi tua
			}
			pos += int64(m)
			sent += int64(m)
			lastData = time.Now()
			if flusher != nil {
				flusher.Flush()
			}
			continue
		}
		if err != nil && err != io.EOF {
			return sent, true
		}
		// m == 0: file trên đĩa ngắn hơn số byte ghi nhận (hiếm) → đợi tiếp nhưng không quá idleMax
		if time.Since(lastData) > idleMax {
			return sent, true
		}
		select {
		case <-ctx.Done():
			return sent, true
		case <-time.After(15 * time.Millisecond):
		}
	}
	return sent, false
}
