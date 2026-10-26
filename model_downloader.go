package main

import (
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// RequiredModel định nghĩa thông tin siêu dữ liệu của từng model AI
type RequiredModel struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	FileName     string `json:"file_name"`
	URL          string `json:"url"`
	MinSize      int64  `json:"min_size"`      // Ngưỡng tối thiểu bytes để xác định model hợp lệ
	ExpectedSize int64  `json:"expected_size"` // Dung lượng ước lượng bytes
	Description  string `json:"description"`
}

// ModelDownloadProgress chứa dữ liệu tiến độ gửi lên React Frontend
type ModelDownloadProgress struct {
	ModelID           string  `json:"model_id"`
	ModelName         string  `json:"model_name"`
	CurrentModelIndex int     `json:"current_model_index"` // 1-based (ví dụ 1/2, 2/2)
	TotalModels       int     `json:"total_models"`
	Progress          float64 `json:"progress"`          // Tiến độ tổng quan (0 - 100%)
	ModelProgress     float64 `json:"model_progress"`    // Tiến độ model hiện tại (0 - 100%)
	DownloadedMB      float64 `json:"downloaded_mb"`     // Đã tải tổng cộng (MB)
	TotalMB           float64 `json:"total_mb"`          // Tổng dung lượng cần tải (MB)
	SpeedMBs          float64 `json:"speed_mbs"`         // Tốc độ tải (MB/s)
	ETASeconds        int     `json:"eta_seconds"`       // Thời gian ước tính còn lại (giây)
	Status            string  `json:"status"`            // "idle" | "downloading" | "completed" | "error" | "cancelled"
	ErrorMessage      string  `json:"error_message,omitempty"`
}

// ModelDownloader quản lý việc lưu trữ, kiểm tra và tải các mô hình AI offline
type ModelDownloader struct {
	ctx           context.Context
	cancelFunc    context.CancelFunc
	modelsDir     string
	models        []RequiredModel
	mu            sync.Mutex
	isDownloading bool
}

// GetAppDataModelsDir trả về đường dẫn chuẩn %LOCALAPPDATA%\SubTrans\models
func GetAppDataModelsDir() string {
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		localAppData = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
	}
	return filepath.Join(localAppData, "SubTrans", "models")
}

// NewModelDownloader khởi tạo ModelDownloader với danh sách model chính thức
func NewModelDownloader() *ModelDownloader {
	modelsDir := GetAppDataModelsDir()
	_ = os.MkdirAll(modelsDir, 0755)

	models := []RequiredModel{
		{
			ID:           "whisper_base",
			Name:         "Whisper Base (Speech-to-Text)",
			FileName:     "ggml-base.bin",
			URL:          "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
			MinSize:      140 * 1024 * 1024, // ~140 MB
			ExpectedSize: 147951433,         // ~141.1 MB
			Description:  "Nhận diện âm thanh đa ngôn ngữ với độ trễ cực thấp",
		},
		{
			ID:           "qwen_1_5b",
			Name:         "Qwen 2.5 1.5B (Offline Translator)",
			FileName:     "qwen2.5-1.5b-instruct-q4_k_m.gguf",
			URL:          "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
			MinSize:      950 * 1024 * 1024,  // ~950 MB
			ExpectedSize: 1034000000,          // ~986.1 MB
			Description:  "Mô hình LLM dịch thuật ngữ cảnh phụ đề tự nhiên",
		},
	}

	return &ModelDownloader{
		modelsDir: modelsDir,
		models:    models,
	}
}

// SetContext gán Wails runtime context
func (d *ModelDownloader) SetContext(ctx context.Context) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ctx = ctx
}

// GetModelsDir trả về thư mục lưu trữ model
func (d *ModelDownloader) GetModelsDir() string {
	return d.modelsDir
}

// GetRequiredModels trả về danh sách model cần thiết cho Frontend
func (d *ModelDownloader) GetRequiredModels() []RequiredModel {
	return d.models
}

// CheckModelsReady kiểm tra sự tồn tại và dung lượng của các file model trong %LOCALAPPDATA%\SubTrans\models
func (d *ModelDownloader) CheckModelsReady() bool {
	d.mu.Lock()
	defer d.mu.Unlock()

	for _, m := range d.models {
		targetFile := filepath.Join(d.modelsDir, m.FileName)
		info, err := os.Stat(targetFile)
		if err == nil && info.Size() >= m.MinSize {
			continue
		}

		// Fallback kiểm tra nếu model đã nằm sẵn ở thư mục cài đặt gốc (legacy / portable mode)
		if globalTools != nil && globalTools.BaseDir != "" {
			legacyFile := filepath.Join(globalTools.BaseDir, "models", m.FileName)
			if lInfo, lErr := os.Stat(legacyFile); lErr == nil && lInfo.Size() >= m.MinSize {
				continue
			}
		}

		return false
	}
	return true
}

// GetModelStatuses trả về trạng thái chi tiết của từng model cho UI
func (d *ModelDownloader) GetModelStatuses() map[string]bool {
	d.mu.Lock()
	defer d.mu.Unlock()

	res := make(map[string]bool)
	for _, m := range d.models {
		targetFile := filepath.Join(d.modelsDir, m.FileName)
		info, err := os.Stat(targetFile)
		ready := (err == nil && info.Size() >= m.MinSize)
		if !ready && globalTools != nil && globalTools.BaseDir != "" {
			legacyFile := filepath.Join(globalTools.BaseDir, "models", m.FileName)
			if lInfo, lErr := os.Stat(legacyFile); lErr == nil && lInfo.Size() >= m.MinSize {
				ready = true
			}
		}
		res[m.ID] = ready
	}
	return res
}

// CancelDownload dừng tiến trình tải hiện tại
func (d *ModelDownloader) CancelDownload() {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.cancelFunc != nil {
		d.cancelFunc()
		d.cancelFunc = nil
	}
	d.isDownloading = false

	if d.ctx != nil {
		runtime.EventsEmit(d.ctx, "model_download_progress", ModelDownloadProgress{
			Status: "cancelled",
		})
	}
}

// StartDownload bắt đầu quy trình tải Resumable tuần tự từng model
func (d *ModelDownloader) StartDownload() error {
	d.mu.Lock()
	if d.isDownloading {
		d.mu.Unlock()
		return fmt.Errorf("tiến trình tải đang chạy")
	}
	d.isDownloading = true

	var parentCtx context.Context = context.Background()
	if d.ctx != nil {
		parentCtx = d.ctx
	}
	downloadCtx, cancel := context.WithCancel(parentCtx)
	d.cancelFunc = cancel
	d.mu.Unlock()

	go func() {
		defer func() {
			d.mu.Lock()
			d.isDownloading = false
			d.cancelFunc = nil
			d.mu.Unlock()
		}()

		err := d.runDownloadPipeline(downloadCtx)
		if err != nil {
			if downloadCtx.Err() != nil {
				// Đã bị huỷ bởi người dùng
				return
			}
			if d.ctx != nil {
				runtime.EventsEmit(d.ctx, "model_download_progress", ModelDownloadProgress{
					Status:       "error",
					ErrorMessage: err.Error(),
				})
			}
		} else {
			// Đảm bảo refresh lại đường dẫn model trong globalTools
			if globalTools != nil {
				globalTools.RefreshModelPaths()
			}
			if d.ctx != nil {
				runtime.EventsEmit(d.ctx, "model_download_progress", ModelDownloadProgress{
					Progress:   100.0,
					Status:     "completed",
					SpeedMBs:   0,
					ETASeconds: 0,
				})
				runtime.EventsEmit(d.ctx, "all_models_ready", true)
			}
		}
	}()

	return nil
}

// runDownloadPipeline thực hiện tải tuần tự các model với HTTP Range Resumable
func (d *ModelDownloader) runDownloadPipeline(ctx context.Context) error {
	_ = os.MkdirAll(d.modelsDir, 0755)

	// Tính tổng dung lượng cần tải của tất cả models
	var totalExpectedBytes int64 = 0
	for _, m := range d.models {
		totalExpectedBytes += m.ExpectedSize
	}

	// Client tuỳ biến hỗ trợ giữ lại HTTP Range khi chuyển hướng CDN (Hugging Face)
	httpClient := &http.Client{
		Timeout: 0, // Không timeout tổng vì file rất lớn
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return fmt.Errorf("quá nhiều chuyển hướng (redirect loop)")
			}
			if len(via) > 0 {
				if rangeHeader := via[0].Header.Get("Range"); rangeHeader != "" {
					req.Header.Set("Range", rangeHeader)
				}
				req.Header.Set("User-Agent", "SubTrans-Desktop/1.0 (Windows NT)")
			}
			return nil
		},
	}

	var cumulativeCompletedBytes int64 = 0

	// Biến thống kê tốc độ (throttled ~300ms)
	var (
		lastEmitTime        = time.Now()
		lastBytesCount      int64 = 0
		smoothedSpeedMBs    float64 = 0
		speedSamplesCount   = 0
	)

	for modelIdx, model := range d.models {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		finalPath := filepath.Join(d.modelsDir, model.FileName)
		partPath := finalPath + ".part"

		// 1. Kiểm tra xem file chính thức đã tồn tại và đủ dung lượng chưa
		if info, err := os.Stat(finalPath); err == nil && info.Size() >= model.MinSize {
			cumulativeCompletedBytes += model.ExpectedSize
			continue
		}

		// 2. Kiểm tra dung lượng hiện có của file .part để Resume
		var existingBytes int64 = 0
		if partInfo, err := os.Stat(partPath); err == nil {
			existingBytes = partInfo.Size()
		}

		// 3. Chuẩn bị HTTP GET Request
		req, err := http.NewRequestWithContext(ctx, "GET", model.URL, nil)
		if err != nil {
			return fmt.Errorf("không thể tạo request tải %s: %w", model.Name, err)
		}
		req.Header.Set("User-Agent", "SubTrans-Desktop/1.0 (Windows NT)")
		if existingBytes > 0 {
			req.Header.Set("Range", fmt.Sprintf("bytes=%d-", existingBytes))
		}

		resp, err := httpClient.Do(req)
		if err != nil {
			return fmt.Errorf("lỗi kết nối mạng khi tải %s: %w", model.Name, err)
		}

		var (
			outFile        *os.File
			modelTotalSize int64
		)

		switch resp.StatusCode {
		case http.StatusPartialContent: // 206 Partial Content: Server chấp nhận tiếp tục Range
			outFile, err = os.OpenFile(partPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
			if err != nil {
				resp.Body.Close()
				return fmt.Errorf("không thể mở file part để ghi tiếp: %w", err)
			}
			modelTotalSize = existingBytes + resp.ContentLength

		case http.StatusOK: // 200 OK: Server không hỗ trợ Range hoặc file part rỗng -> tải từ 0
			outFile, err = os.OpenFile(partPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
			if err != nil {
				resp.Body.Close()
				return fmt.Errorf("không thể tạo file part mới: %w", err)
			}
			existingBytes = 0
			modelTotalSize = resp.ContentLength

		case http.StatusRequestedRangeNotSatisfiable: // 416 Range Not Satisfiable
			resp.Body.Close()
			// Nếu file part đã đủ kích thước tối thiểu, có thể đã tải trọn vẹn
			if existingBytes >= model.MinSize {
				_ = os.Rename(partPath, finalPath)
				cumulativeCompletedBytes += model.ExpectedSize
				continue
			}
			// Nếu file part lỗi, xóa và tải lại từ đầu
			_ = os.Remove(partPath)
			existingBytes = 0
			retryReq, _ := http.NewRequestWithContext(ctx, "GET", model.URL, nil)
			retryReq.Header.Set("User-Agent", "SubTrans-Desktop/1.0 (Windows NT)")
			retryResp, rErr := httpClient.Do(retryReq)
			if rErr != nil || retryResp.StatusCode != http.StatusOK {
				if retryResp != nil {
					retryResp.Body.Close()
				}
				return fmt.Errorf("không thể kết nối lại sau lỗi Range HTTP 416 với %s", model.Name)
			}
			resp = retryResp
			outFile, err = os.OpenFile(partPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
			if err != nil {
				resp.Body.Close()
				return err
			}
			modelTotalSize = resp.ContentLength

		default:
			resp.Body.Close()
			return fmt.Errorf("máy chủ trả về mã HTTP %d khi tải %s", resp.StatusCode, model.Name)
		}

		if modelTotalSize <= 0 {
			modelTotalSize = model.ExpectedSize
		}

		// 4. Stream dữ liệu từ resp.Body vào outFile với Throttle ~300ms
		buf := make([]byte, 64*1024) // Buffer 64KB
		var currentModelDownloaded int64 = existingBytes

		lastEmitTime = time.Now()
		lastBytesCount = existingBytes
		smoothedSpeedMBs = 0
		speedSamplesCount = 0

		readerDone := false
		for !readerDone {
			select {
			case <-ctx.Done():
				outFile.Close()
				resp.Body.Close()
				return ctx.Err()
			default:
			}

			n, readErr := resp.Body.Read(buf)
			if n > 0 {
				if _, writeErr := outFile.Write(buf[:n]); writeErr != nil {
					outFile.Close()
					resp.Body.Close()
					return fmt.Errorf("lỗi ghi đĩa khi tải %s: %w", model.Name, writeErr)
				}
				currentModelDownloaded += int64(n)
			}

			if readErr != nil {
				if readErr == io.EOF {
					readerDone = true
				} else {
					outFile.Close()
					resp.Body.Close()
					return fmt.Errorf("lỗi rớt mạng khi stream dữ liệu %s: %w", model.Name, readErr)
				}
			}

			// Throttle cập nhật tiến độ mỗi 300ms
			now := time.Now()
			elapsedSec := now.Sub(lastEmitTime).Seconds()
			if elapsedSec >= 0.3 || readerDone {
				bytesDelta := currentModelDownloaded - lastBytesCount
				if elapsedSec > 0 {
					currentSpeedMBs := (float64(bytesDelta) / elapsedSec) / (1024 * 1024)
					if speedSamplesCount == 0 || smoothedSpeedMBs <= 0 {
						smoothedSpeedMBs = currentSpeedMBs
					} else {
						// EMA (Exponential Moving Average) làm mượt tốc độ hiển thị
						smoothedSpeedMBs = 0.7*smoothedSpeedMBs + 0.3*currentSpeedMBs
					}
					speedSamplesCount++
				}

				totalDownloadedSoFar := cumulativeCompletedBytes + currentModelDownloaded
				overallProgress := (float64(totalDownloadedSoFar) / float64(totalExpectedBytes)) * 100
				if overallProgress > 100 {
					overallProgress = 100
				}
				modelProgress := (float64(currentModelDownloaded) / float64(modelTotalSize)) * 100
				if modelProgress > 100 {
					modelProgress = 100
				}

				// Tính ETA còn lại theo smoothedSpeed
				bytesRemaining := totalExpectedBytes - totalDownloadedSoFar
				var etaSec int = 0
				if smoothedSpeedMBs > 0.05 && bytesRemaining > 0 {
					etaSec = int(float64(bytesRemaining) / (smoothedSpeedMBs * 1024 * 1024))
				}

				if d.ctx != nil {
					runtime.EventsEmit(d.ctx, "model_download_progress", ModelDownloadProgress{
						ModelID:           model.ID,
						ModelName:         model.Name,
						CurrentModelIndex: modelIdx + 1,
						TotalModels:       len(d.models),
						Progress:          math.Round(overallProgress*10) / 10,
						ModelProgress:     math.Round(modelProgress*10) / 10,
						DownloadedMB:      math.Round((float64(totalDownloadedSoFar)/(1024*1024))*10) / 10,
						TotalMB:           math.Round((float64(totalExpectedBytes)/(1024*1024))*10) / 10,
						SpeedMBs:          math.Round(smoothedSpeedMBs*10) / 10,
						ETASeconds:        etaSec,
						Status:            "downloading",
					})
				}

				lastEmitTime = now
				lastBytesCount = currentModelDownloaded
			}
		}

		outFile.Close()
		resp.Body.Close()

		// 5. Kiểm tra tính toàn vẹn của file .part
		partStat, err := os.Stat(partPath)
		if err != nil || partStat.Size() < model.MinSize {
			return fmt.Errorf("file tải về %s chưa trọn vẹn (kích thước %d < %d)", model.Name, partStat.Size(), model.MinSize)
		}

		// 6. Hoàn tất model: Đổi tên từ .part sang file chính thức
		_ = os.Remove(finalPath) // Xóa file cũ nếu có
		if err := os.Rename(partPath, finalPath); err != nil {
			return fmt.Errorf("không thể đổi tên %s từ file tạm: %w", model.FileName, err)
		}

		cumulativeCompletedBytes += model.ExpectedSize
	}

	return nil
}
