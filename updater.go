package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// CurrentVersion phiên bản hiện tại của ứng dụng SubTrans
const CurrentVersion = "1.0.0"

// DefaultVersionURL địa chỉ file version.json trên GitHub raw
const DefaultVersionURL = "https://raw.githubusercontent.com/thonghdm/video_translator/main/version.json"

// VersionInfo cấu trúc dữ liệu file version.json từ máy chủ GitHub
type VersionInfo struct {
	Version     string  `json:"version"`
	ReleaseDate string  `json:"release_date"`
	Changelog   string  `json:"changelog"`
	DownloadURL string  `json:"download_url"`
	FileSizeMB  float64 `json:"file_size_mb"`
	Mandatory   bool    `json:"mandatory"`
}

// UpdateCheckResult kết quả kiểm tra cập nhật gửi cho Frontend
type UpdateCheckResult struct {
	HasUpdate      bool    `json:"has_update"`
	CurrentVersion string  `json:"current_version"`
	LatestVersion  string  `json:"latest_version"`
	ReleaseDate    string  `json:"release_date"`
	Changelog      string  `json:"changelog"`
	DownloadURL    string  `json:"download_url"`
	FileSizeMB     float64 `json:"file_size_mb"`
	Mandatory      bool    `json:"mandatory"`
}

// UpdateDownloadProgress tiến độ tải file exe cập nhật
type UpdateDownloadProgress struct {
	DownloadedMB float64 `json:"downloaded_mb"`
	TotalMB      float64 `json:"total_mb"`
	Progress     float64 `json:"progress"`
	SpeedMBs     float64 `json:"speed_mbs"`
	Status       string  `json:"status"` // "downloading" | "installing" | "ready" | "error"
	ErrorMessage string  `json:"error_message,omitempty"`
}

// Updater quản lý kiểm tra và cập nhật nhị phân in-app
type Updater struct {
	ctx        context.Context
	mu         sync.Mutex
	versionURL string
	isUpdating bool
}

// NewUpdater khởi tạo Updater
func NewUpdater() *Updater {
	return &Updater{
		versionURL: DefaultVersionURL,
	}
}

// SetContext gán Wails context
func (u *Updater) SetContext(ctx context.Context) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.ctx = ctx
}

// SetVersionURL cho phép cấu hình URL kiểm tra phiên bản (dùng cho testing/custom release)
func (u *Updater) SetVersionURL(url string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.versionURL = url
}

// compareSemVer so sánh 2 chuỗi phiên bản chuẩn SemVer (vd: "v1.0.0", "1.1.0")
// Trả về: -1 nếu v1 < v2, 0 nếu v1 == v2, 1 nếu v1 > v2
func compareSemVer(v1, v2 string) int {
	v1 = strings.TrimPrefix(strings.TrimSpace(v1), "v")
	v2 = strings.TrimPrefix(strings.TrimSpace(v2), "v")

	parts1 := strings.Split(v1, ".")
	parts2 := strings.Split(v2, ".")

	maxLen := len(parts1)
	if len(parts2) > maxLen {
		maxLen = len(parts2)
	}

	for i := 0; i < maxLen; i++ {
		var n1, n2 int
		if i < len(parts1) {
			n1, _ = strconv.Atoi(parts1[i])
		}
		if i < len(parts2) {
			n2, _ = strconv.Atoi(parts2[i])
		}
		if n1 < n2 {
			return -1
		} else if n1 > n2 {
			return 1
		}
	}
	return 0
}

// CheckForUpdate kiểm tra xem có bản cập nhật mới trên GitHub hay không
func (u *Updater) CheckForUpdate() (*UpdateCheckResult, error) {
	u.mu.Lock()
	targetURL := u.versionURL
	u.mu.Unlock()

	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequest("GET", targetURL, nil)
	if err != nil {
		return nil, fmt.Errorf("không thể tạo HTTP request: %w", err)
	}
	req.Header.Set("User-Agent", "SubTrans-Desktop-Updater/1.0")
	// Cache-busting để luôn nhận bản cập nhật mới nhất từ GitHub raw
	req.Header.Set("Cache-Control", "no-cache, no-store, must-revalidate")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("không thể kết nối kiểm tra cập nhật: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("máy chủ cập nhật trả về mã HTTP %d", resp.StatusCode)
	}

	var remote VersionInfo
	if err := json.NewDecoder(resp.Body).Decode(&remote); err != nil {
		return nil, fmt.Errorf("không thể phân tích dữ liệu version.json: %w", err)
	}

	hasUpdate := compareSemVer(CurrentVersion, remote.Version) < 0

	result := &UpdateCheckResult{
		HasUpdate:      hasUpdate,
		CurrentVersion: CurrentVersion,
		LatestVersion:  remote.Version,
		ReleaseDate:    remote.ReleaseDate,
		Changelog:      remote.Changelog,
		DownloadURL:    remote.DownloadURL,
		FileSizeMB:     remote.FileSizeMB,
		Mandatory:      remote.Mandatory,
	}

	return result, nil
}

// ApplyUpdate tải bản cập nhật mới và hoán đổi an toàn file thực thi trên Windows
func (u *Updater) ApplyUpdate(downloadURL string) error {
	u.mu.Lock()
	if u.isUpdating {
		u.mu.Unlock()
		return fmt.Errorf("tiến trình cập nhật đang diễn ra")
	}
	u.isUpdating = true
	defer func() {
		u.mu.Lock()
		u.isUpdating = false
		u.mu.Unlock()
	}()
	u.mu.Unlock()

	if downloadURL == "" {
		return fmt.Errorf("URL tải về trống")
	}

	// 1. Tải file SubTrans_new.exe về thư mục %TEMP%
	tempExePath := filepath.Join(os.TempDir(), fmt.Sprintf("SubTrans_new_%d.exe", time.Now().UnixNano()))
	defer func() {
		// Dọn file tạm nếu còn sót lại
		_ = os.Remove(tempExePath)
	}()

	client := &http.Client{Timeout: 0}
	req, err := http.NewRequest("GET", downloadURL, nil)
	if err != nil {
		return fmt.Errorf("lỗi khởi tạo request tải exe: %w", err)
	}
	req.Header.Set("User-Agent", "SubTrans-Desktop-Updater/1.0 (Windows NT)")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("không thể tải file cập nhật: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("máy chủ tải exe trả về mã HTTP %d", resp.StatusCode)
	}

	outFile, err := os.OpenFile(tempExePath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		return fmt.Errorf("không thể tạo file tạm %s: %w", tempExePath, err)
	}

	totalBytes := resp.ContentLength
	totalMB := float64(totalBytes) / (1024 * 1024)
	var downloadedBytes int64 = 0

	buf := make([]byte, 64*1024)
	lastEmit := time.Now()
	lastBytes := int64(0)

	for {
		n, rErr := resp.Body.Read(buf)
		if n > 0 {
			if _, wErr := outFile.Write(buf[:n]); wErr != nil {
				outFile.Close()
				return fmt.Errorf("lỗi ghi file cập nhật: %w", wErr)
			}
			downloadedBytes += int64(n)
		}

		if rErr != nil {
			if rErr == io.EOF {
				break
			}
			outFile.Close()
			return fmt.Errorf("lỗi gián đoạn mạng khi tải file cập nhật: %w", rErr)
		}

		now := time.Now()
		elapsed := now.Sub(lastEmit).Seconds()
		if elapsed >= 0.25 {
			speedMBs := (float64(downloadedBytes-lastBytes) / elapsed) / (1024 * 1024)
			var progress float64 = 0
			if totalBytes > 0 {
				progress = (float64(downloadedBytes) / float64(totalBytes)) * 100
			}

			if u.ctx != nil {
				runtime.EventsEmit(u.ctx, "update_download_progress", UpdateDownloadProgress{
					DownloadedMB: float64(downloadedBytes) / (1024 * 1024),
					TotalMB:      totalMB,
					Progress:     progress,
					SpeedMBs:     speedMBs,
					Status:       "downloading",
				})
			}
			lastEmit = now
			lastBytes = downloadedBytes
		}
	}
	outFile.Close()

	// 2. Kiểm tra tính toàn vẹn cơ bản của file exe mới (phải lớn hơn 10MB)
	stat, err := os.Stat(tempExePath)
	if err != nil || stat.Size() < 10*1024*1024 {
		return fmt.Errorf("file thực thi tải về không hợp lệ hoặc dung lượng quá nhỏ (%d bytes)", stat.Size())
	}

	if u.ctx != nil {
		runtime.EventsEmit(u.ctx, "update_download_progress", UpdateDownloadProgress{
			Progress: 100,
			Status:   "installing",
		})
	}

	// 3. Cơ chế Safe Binary Replacement trên Windows:
	// Hệ điều hành Windows NT KHÔNG cho phép ghi/xóa file .exe đang chạy,
	// NHƯNG CHO PHÉP ĐỔI TÊN (Rename) file thực thi đang chạy!
	currentExe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("không lấy được đường dẫn exe hiện tại: %w", err)
	}
	currentExe, err = filepath.EvalSymlinks(currentExe)
	if err != nil {
		return fmt.Errorf("không phân giải được đường dẫn symlink: %w", err)
	}

	backupExe := currentExe + ".old"
	_ = os.Remove(backupExe) // Xoá bản backup cũ nếu đã tồn tại

	// Đổi tên file đang chạy thành .old
	if err := os.Rename(currentExe, backupExe); err != nil {
		return fmt.Errorf("không thể đổi tên file thực thi đang chạy: %w", err)
	}

	// Di chuyển file mới thế chỗ file cũ
	moveErr := moveOrCopyFile(tempExePath, currentExe)
	if moveErr != nil {
		// Rollback khôi phục lại file gốc nếu lỗi
		_ = os.Rename(backupExe, currentExe)
		return fmt.Errorf("thay thế file thực thi mới thất bại (đã khôi phục file cũ): %w", moveErr)
	}

	// 4. Bắn event thông báo cập nhật đã sẵn sàng
	if u.ctx != nil {
		runtime.EventsEmit(u.ctx, "update_download_progress", UpdateDownloadProgress{
			Progress: 100,
			Status:   "ready",
		})
		runtime.EventsEmit(u.ctx, "update_downloaded", true)
	}

	return nil
}

// moveOrCopyFile hỗ trợ di chuyển file cả khi 2 thư mục nằm ở 2 phân vùng ổ cứng khác nhau
func moveOrCopyFile(src, dst string) error {
	// Thử Rename trước (siêu tốc nếu cùng ổ đĩa)
	err := os.Rename(src, dst)
	if err == nil {
		return nil
	}

	// Nếu khác phân vùng ổ đĩa (cross-device link), thực hiện Copy rồi Xóa
	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	dstFile, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		return err
	}
	defer dstFile.Close()

	if _, err := io.Copy(dstFile, srcFile); err != nil {
		return err
	}

	_ = os.Remove(src)
	return nil
}

// RestartApp spawn file exe mới trong một tiến trình hoàn toàn độc lập và đóng tiến trình cũ
func (u *Updater) RestartApp() error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("không lấy được đường dẫn exe: %w", err)
	}
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		return fmt.Errorf("không phân giải được đường dẫn exe: %w", err)
	}

	cmd := exec.Command(exePath)
	cmd.Dir = filepath.Dir(exePath)

	// Cấu hình tiến trình độc lập (detached) trên Windows / Unix
	prepareRestartProcess(cmd)

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("không thể khởi động phiên bản mới: %w", err)
	}

	// Đóng ứng dụng hiện tại an toàn
	os.Exit(0)
	return nil
}
