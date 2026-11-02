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

// MediaServer phục vụ file video nội bộ với HTTP Range hỗ trợ phát trực tiếp.
// Mỗi file được đăng ký nhận 1 token 128-bit riêng. SetMediaFile (mở video mới) xóa toàn bộ token cũ;
// AddMediaFile (bản đã chuyển mã của CÙNG video) thêm token mới nhưng giữ token cũ còn hiệu lực,
// để thẻ <video> đang phát file gốc không bị 403 trong lúc frontend đổi src.
type MediaServer struct {
	mu       sync.RWMutex
	listener net.Listener
	server   *http.Server
	files    map[string]string // token -> đường dẫn file
	port     int
}

var (
	globalMediaServer *MediaServer
	mediaOnce         sync.Once
)

// ProbeResult kết quả trả về từ ffprobe
type ProbeResult struct {
	DurationSec    float64
	VideoCodec     string
	PixFmt         string
	AudioCodec     string
	FormatName     string
	Playable       bool
	PlayableReason string
	Plan           PlaybackPlan
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
			files:    make(map[string]string),
		}

		mux := http.NewServeMux()
		mux.HandleFunc("/media/", diagWrap("local", ms.handleMediaStream))
		mux.HandleFunc("/drive/stream", diagWrap("drive", ServeDriveStream))

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

func newMediaToken() (string, error) {
	tokenBytes := make([]byte, 16)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", fmt.Errorf("không thể sinh token ngẫu nhiên: %w", err)
	}
	return hex.EncodeToString(tokenBytes), nil
}

// SetMediaFile đặt file media đang phát (video mới): hủy mọi token cũ và sinh token 128-bit mới
func (ms *MediaServer) SetMediaFile(filePath string) (string, error) {
	token, err := newMediaToken()
	if err != nil {
		return "", err
	}
	ms.mu.Lock()
	ms.files = map[string]string{token: filePath}
	port := ms.port
	ms.mu.Unlock()
	return fmt.Sprintf("http://127.0.0.1:%d/media/%s", port, token), nil
}

// AddMediaFile đăng ký thêm 1 file cho video hiện tại (ví dụ bản đã chuyển mã) mà không hủy token cũ
func (ms *MediaServer) AddMediaFile(filePath string) (string, error) {
	token, err := newMediaToken()
	if err != nil {
		return "", err
	}
	ms.mu.Lock()
	if ms.files == nil {
		ms.files = make(map[string]string)
	}
	ms.files[token] = filePath
	port := ms.port
	ms.mu.Unlock()
	return fmt.Sprintf("http://127.0.0.1:%d/media/%s", port, token), nil
}

func (ms *MediaServer) lookupToken(reqToken string) (string, bool) {
	ms.mu.RLock()
	defer ms.mu.RUnlock()
	found, path := false, ""
	for tok, p := range ms.files {
		if subtle.ConstantTimeCompare([]byte(reqToken), []byte(tok)) == 1 {
			found, path = true, p
		}
	}
	return path, found
}

// mediaContentType trả về MIME cho thẻ <video>. Ưu tiên bảng cố định vì trên Windows
// mime.TypeByExtension đọc từ registry, có thể trả giá trị lạ do phần mềm khác ghi đè
// (ví dụ ".mp4" -> "application/octet-stream", ".mov" -> "video/quicktime").
func mediaContentType(filePath string) string {
	ext := strings.ToLower(filepath.Ext(filePath))
	switch ext {
	case ".mp4", ".m4v", ".mov":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	case ".mkv":
		return "video/x-matroska"
	case ".m4a":
		return "audio/mp4"
	case ".mp3":
		return "audio/mpeg"
	}
	if t := mime.TypeByExtension(ext); t != "" {
		return t
	}
	return "application/octet-stream"
}

// handleMediaStream xử lý HTTP Range streaming
func (ms *MediaServer) handleMediaStream(w http.ResponseWriter, r *http.Request) {
	// Kiểm tra token bí mật bảo vệ URL
	reqToken := strings.TrimPrefix(r.URL.Path, "/media/")
	filePath, ok := ms.lookupToken(reqToken)
	if reqToken == "" || !ok {
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

	w.Header().Set("Content-Type", mediaContentType(filePath))
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
	w.Header().Set("Accept-Ranges", "bytes")

	// http.ServeContent tự động xử lý các header Range: bytes=start-end (status 206 Partial Content)
	http.ServeContent(w, r, filepath.Base(filePath), fi.ModTime(), file)
}

// FFprobeOutput cấu trúc JSON trích xuất từ ffprobe
type FFprobeOutput struct {
	Streams []struct {
		CodecType   string `json:"codec_type"`
		CodecName   string `json:"codec_name"`
		PixFmt      string `json:"pix_fmt"`
		Duration    string `json:"duration"`
		Disposition struct {
			AttachedPic int `json:"attached_pic"`
		} `json:"disposition"`
	} `json:"streams"`
	Format struct {
		Duration   string `json:"duration"`
		FormatName string `json:"format_name"`
	} `json:"format"`
}

// PlaybackPlan mô tả cách đưa video lên thẻ <video> của WebView2
type PlaybackPlan struct {
	// NeedConvert: file gốc chắc chắn KHÔNG phát được -> phải tạo bản .mp4 tương thích
	NeedConvert bool
	// CopyVideo / CopyAudio: khi chuyển mã, luồng nào được giữ nguyên (-c copy, rất nhanh)
	CopyVideo bool
	CopyAudio bool
	// CheckMIME: codec phụ thuộc máy (AV1, HEVC 8-bit) -> frontend phải hỏi MediaSource.isTypeSupported
	CheckMIME string
	Reasons   []string
}

// pixFmt8bit420 là các định dạng điểm ảnh mà bộ giải mã của Chromium luôn hỗ trợ
func pixFmt8bit420(pix string) bool {
	return pix == "" || pix == "yuv420p" || pix == "yuvj420p" || pix == "nv12"
}

// DecidePlayback quyết định phát thẳng hay phải chuyển mã, dựa trên container + codec + pix_fmt.
//   - ext:        phần mở rộng của file gốc (".mkv", ".mp4"...) để phân biệt mkv với webm
//   - formatName: format_name của ffprobe ("mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm", "avi"...)
func DecidePlayback(ext, formatName, videoCodec, pixFmt, audioCodec string) PlaybackPlan {
	ext = strings.ToLower(ext)
	var plan PlaybackPlan

	isMP4 := strings.Contains(formatName, "mp4") || strings.Contains(formatName, "mov")
	isWebM := strings.Contains(formatName, "webm") && ext == ".webm"

	// --- Video ---
	videoOK := true        // WebView2 giải mã được (hoặc cần frontend kiểm tra qua CheckMIME)
	videoCopyable := false // H.264 8-bit: copy nguyên luồng vào .mp4 khi chỉ cần đổi container/audio
	switch videoCodec {
	case "":
		// file chỉ có âm thanh: không có gì để giải mã hình
	case "h264":
		if pixFmt8bit420(pixFmt) {
			videoCopyable = true
		} else {
			videoOK = false
			plan.Reasons = append(plan.Reasons, fmt.Sprintf("video H.264 dạng '%s' (10-bit/4:2:2/4:4:4) WebView2 không giải mã được", pixFmt))
		}
	case "vp8", "vp9":
		if !pixFmt8bit420(pixFmt) {
			videoOK = false
			plan.Reasons = append(plan.Reasons, fmt.Sprintf("video %s dạng '%s' (10-bit) WebView2 không giải mã ổn định", strings.ToUpper(videoCodec), pixFmt))
		}
	case "av1", "hevc":
		if pixFmt8bit420(pixFmt) {
			// Phụ thuộc phần cứng / extension của Windows (AV1 Video Extension, HEVC Video Extensions)
			if videoCodec == "av1" {
				plan.CheckMIME = `video/mp4; codecs="av01.0.08M.08"`
			} else {
				plan.CheckMIME = `video/mp4; codecs="hvc1.1.6.L120.90"`
			}
		} else {
			videoOK = false
			plan.Reasons = append(plan.Reasons, fmt.Sprintf("video %s 10-bit ('%s') WebView2 không giải mã được", strings.ToUpper(videoCodec), pixFmt))
		}
	default:
		videoOK = false
		plan.Reasons = append(plan.Reasons, fmt.Sprintf("video codec '%s' không được WebView2 hỗ trợ", videoCodec))
	}

	// --- Âm thanh ---
	audioOK := true
	switch audioCodec {
	case "", "aac", "mp3", "opus", "vorbis":
	default:
		audioOK = false
		plan.Reasons = append(plan.Reasons, fmt.Sprintf("audio codec '%s' không được WebView2 hỗ trợ (video sẽ bị câm)", audioCodec))
	}

	// --- Container ---
	containerOK := isMP4 || isWebM
	if isWebM && !(videoCodec == "" || videoCodec == "vp8" || videoCodec == "vp9" || videoCodec == "av1") {
		containerOK = false
	}
	if !containerOK && videoOK && audioOK {
		name := ext
		if name == "" {
			name = formatName
		}
		plan.Reasons = append(plan.Reasons, fmt.Sprintf("container '%s' không phát trực tiếp được trong WebView2", name))
	}

	plan.NeedConvert = !videoOK || !audioOK || !containerOK
	if plan.NeedConvert {
		// Bản chuyển mã luôn là H.264 8-bit + AAC trong .mp4: chỉ copy luồng đã tương thích sẵn
		plan.CopyVideo = videoOK && videoCopyable
		plan.CopyAudio = audioCodec == "aac" || audioCodec == "mp3"
		plan.CheckMIME = ""
	}
	return plan
}

// ProbeMedia sử dụng ffprobe để lấy thời lượng và kiểm tra codec tương thích
func ProbeMedia(tools *ToolsPaths, filePath string) (*ProbeResult, error) {
	return probeMediaWithExt(tools, filePath, filepath.Ext(filePath))
}

// probeMediaWithExt cho phép truyền phần mở rộng riêng (video Drive: input là URL proxy không có đuôi)
func probeMediaWithExt(tools *ToolsPaths, filePath, ext string) (*ProbeResult, error) {
	args := []string{
		"-v", "error",
		"-show_entries", "stream=codec_type,codec_name,pix_fmt,duration:stream_disposition=attached_pic:format=duration,format_name",
		"-of", "json",
	}

	isHTTP := strings.HasPrefix(filePath, "http://") || strings.HasPrefix(filePath, "https://")
	if isHTTP {
		// Bắt buộc bật seekable và giới hạn probesize để ffprobe không bao giờ tải tuần tự cả GB video qua mạng
		args = append(args,
			"-seekable", "1",
			"-probesize", "5000000",
			"-analyzeduration", "5000000",
		)
	}
	args = append(args, filePath)

	probeTimeout := 15 * time.Second
	if isHTTP {
		probeTimeout = 25 * time.Second
	}
	res, err := RunCommand(context.Background(), tools.FFprobe, args, probeTimeout, nil)
	if err != nil {
		stderr := ""
		if res != nil {
			stderr = res.Stderr
		}
		return nil, fmt.Errorf("ffprobe thất bại: %w (stderr: %s)", err, stderr)
	}

	var data FFprobeOutput
	if err := json.Unmarshal([]byte(res.Stdout), &data); err != nil {
		return nil, fmt.Errorf("không thể đọc JSON từ ffprobe: %w", err)
	}

	var durationSec float64
	if data.Format.Duration != "" {
		durationSec, _ = strconv.ParseFloat(data.Format.Duration, 64)
	}

	var videoCodec, pixFmt, audioCodec string
	for _, st := range data.Streams {
		switch st.CodecType {
		case "video":
			// Bỏ qua ảnh bìa (mjpeg/png attached_pic trong mkv/mp4) — không phải luồng hình thật
			if videoCodec == "" && st.Disposition.AttachedPic == 0 {
				videoCodec = strings.ToLower(st.CodecName)
				pixFmt = strings.ToLower(st.PixFmt)
			}
		case "audio":
			if audioCodec == "" {
				audioCodec = strings.ToLower(st.CodecName)
			}
		}
	}

	plan := DecidePlayback(ext, data.Format.FormatName, videoCodec, pixFmt, audioCodec)
	reasons := append([]string{}, plan.Reasons...)
	if audioCodec == "" {
		reasons = append(reasons, "không tìm thấy luồng âm thanh trong tập tin")
	}

	return &ProbeResult{
		DurationSec:    durationSec,
		VideoCodec:     videoCodec,
		PixFmt:         pixFmt,
		AudioCodec:     audioCodec,
		FormatName:     data.Format.FormatName,
		Playable:       !plan.NeedConvert,
		PlayableReason: strings.Join(reasons, "; "),
		Plan:           plan,
	}, nil
}
