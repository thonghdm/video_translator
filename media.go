package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// MediaServer phục vụ file video nội bộ với HTTP Range hỗ trợ phát trực tiếp
type MediaServer struct {
	mu          sync.RWMutex
	listener    net.Listener
	server      *http.Server
	currentPath string
	token       string
	port        int
}

var (
	globalMediaServer *MediaServer
	mediaOnce         sync.Once
)

// ProbeResult kết quả trả về từ ffprobe
type ProbeResult struct {
	DurationSec    float64
	VideoCodec     string
	AudioCodec     string
	Playable       bool
	PlayableReason string
}

// GetMediaServer trả về singleton MediaServer
func GetMediaServer() (*MediaServer, error) {
	var initErr error
	mediaOnce.Do(func() {
		// Mở cổng ngẫu nhiên trên loopback 127.0.0.1
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			initErr = fmt.Errorf("không thể bind loopback media server: %w", err)
			return
		}

		ms := &MediaServer{
			listener: ln,
			port:     ln.Addr().(*net.TCPAddr).Port,
		}

		mux := http.NewServeMux()
		mux.HandleFunc("/media/", ms.handleMediaStream)

		ms.server = &http.Server{
			Handler:           mux,
			ReadHeaderTimeout: 15 * time.Second,
			IdleTimeout:       120 * time.Second,
		}

		go func() {
			_ = ms.server.Serve(ln)
		}()

		globalMediaServer = ms
	})

	if initErr != nil {
		return nil, initErr
	}
	return globalMediaServer, nil
}

// SetMediaFile cập nhật file media đang phát và sinh token 128-bit mới
func (ms *MediaServer) SetMediaFile(filePath string) (string, error) {
	tokenBytes := make([]byte, 16)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", fmt.Errorf("không thể sinh token ngẫu nhiên: %w", err)
	}
	token := hex.EncodeToString(tokenBytes)

	ms.mu.Lock()
	ms.currentPath = filePath
	ms.token = token
	port := ms.port
	ms.mu.Unlock()

	return fmt.Sprintf("http://127.0.0.1:%d/media/%s", port, token), nil
}

// handleMediaStream xử lý HTTP Range streaming
func (ms *MediaServer) handleMediaStream(w http.ResponseWriter, r *http.Request) {
	// Kiểm tra token bí mật bảo vệ URL
	reqToken := strings.TrimPrefix(r.URL.Path, "/media/")

	ms.mu.RLock()
	expectedToken := ms.token
	filePath := ms.currentPath
	ms.mu.RUnlock()

	if expectedToken == "" || subtle.ConstantTimeCompare([]byte(reqToken), []byte(expectedToken)) != 1 {
		http.Error(w, "Unauthorized media access", http.StatusForbidden)
		return
	}

	file, err := os.Open(filePath)
	if err != nil {
		http.Error(w, "Media file not found or inaccessible", http.StatusNotFound)
		return
	}
	defer file.Close()

	fi, err := file.Stat()
	if err != nil {
		http.Error(w, "Cannot stat media file", http.StatusInternalServerError)
		return
	}

	// Đặt Content-Type theo định dạng video
	ext := strings.ToLower(filepath.Ext(filePath))
	mimeType := mime.TypeByExtension(ext)
	if mimeType == "" {
		switch ext {
		case ".mp4":
			mimeType = "video/mp4"
		case ".webm":
			mimeType = "video/webm"
		case ".mkv":
			mimeType = "video/x-matroska"
		default:
			mimeType = "application/octet-stream"
		}
	}

	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
	w.Header().Set("Accept-Ranges", "bytes")

	// http.ServeContent tự động xử lý các header Range: bytes=start-end (status 206 Partial Content)
	http.ServeContent(w, r, filepath.Base(filePath), fi.ModTime(), file)
}

// FFprobeOutput cấu trúc JSON trích xuất từ ffprobe
type FFprobeOutput struct {
	Streams []struct {
		CodecType string `json:"codec_type"`
		CodecName string `json:"codec_name"`
		Duration  string `json:"duration"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

// ProbeMedia sử dụng ffprobe để lấy thời lượng và kiểm tra codec tương thích
func ProbeMedia(tools *ToolsPaths, filePath string) (*ProbeResult, error) {
	args := []string{
		"-v", "error",
		"-show_entries", "stream=codec_type,codec_name,duration:format=duration",
		"-of", "json",
		filePath,
	}

	res, err := RunCommand(context.Background(), tools.FFprobe, args, 15*time.Second, nil)
	if err != nil {
		return nil, fmt.Errorf("ffprobe thất bại: %w (stderr: %s)", err, res.Stderr)
	}

	var data FFprobeOutput
	if err := json.Unmarshal([]byte(res.Stdout), &data); err != nil {
		return nil, fmt.Errorf("không thể đọc JSON từ ffprobe: %w", err)
	}

	var durationSec float64
	if data.Format.Duration != "" {
		durationSec, _ = strconv.ParseFloat(data.Format.Duration, 64)
	}

	var videoCodec, audioCodec string
	for _, st := range data.Streams {
		if st.CodecType == "video" && videoCodec == "" {
			videoCodec = strings.ToLower(st.CodecName)
		} else if st.CodecType == "audio" && audioCodec == "" {
			audioCodec = strings.ToLower(st.CodecName)
		}
	}

	// Đánh giá chính sách codec phát trực tiếp trong WebView2
	playable := true
	var reasons []string

	supportedVideo := map[string]bool{"h264": true, "vp8": true, "vp9": true, "av1": true}
	supportedAudio := map[string]bool{"aac": true, "mp3": true, "opus": true, "vorbis": true}

	if videoCodec != "" && !supportedVideo[videoCodec] {
		playable = false
		reasons = append(reasons, fmt.Sprintf("video codec '%s' không được WebView2 hỗ trợ trực tiếp", videoCodec))
	}
	if audioCodec != "" && !supportedAudio[audioCodec] {
		playable = false
		reasons = append(reasons, fmt.Sprintf("audio codec '%s' không được WebView2 hỗ trợ trực tiếp", audioCodec))
	}
	if audioCodec == "" {
		reasons = append(reasons, "không tìm thấy luồng âm thanh trong tập tin")
	}

	return &ProbeResult{
		DurationSec:    durationSec,
		VideoCodec:     videoCodec,
		AudioCodec:     audioCodec,
		Playable:       playable,
		PlayableReason: strings.Join(reasons, "; "),
	}, nil
}
