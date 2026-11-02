package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// Mặc định giới hạn tổng dung lượng thư mục spool: 2GB
	defaultMaxSpoolBytes = 2 * 1024 * 1024 * 1024
	// File <= 150MB: tải toàn bộ nền ngay sau 'playing'
	maxFullSpoolSize = 150 * 1024 * 1024
	// Vùng đệm tối thiểu cần cho block 0 (15MB)
	minBlock0BufferBytes = 15 * 1024 * 1024
)

// SpoolMeta lưu metadata của file spool để kiểm tra tính hợp lệ (ETag, size) và LRU
type SpoolMeta struct {
	FileID          string    `json:"file_id"`
	ETag            string    `json:"etag"`
	TotalSize       int64     `json:"total_size"`
	DownloadedBytes int64     `json:"downloaded_bytes"`
	Complete        bool      `json:"complete"`
	UpdatedAt       time.Time `json:"updated_at"`
}

// SpoolProgress theo dõi tiến độ tải của một file spool đang hoạt động
type SpoolProgress struct {
	FileID          string
	PartPath        string
	MetaPath        string
	DownloadedBytes atomic.Int64
	TotalSize       atomic.Int64
	Complete        atomic.Bool
	ETag            atomic.Pointer[string]

	readyCond *sync.Cond
	cancel    context.CancelFunc
}

// DriveSpool quản lý việc tải tuần tự file Drive về đĩa cục bộ phục vụ ffmpeg slicer
type DriveSpool struct {
	mu            sync.Mutex
	spoolDir      string
	maxSpoolBytes int64
	dm            *DriveManager

	activeID   string
	activeProg *SpoolProgress

	// Hook cho unit test: giả lập upstream download
	mockDownloadFn func(ctx context.Context, fileID string) (*http.Response, error)
}

// NewDriveSpool khởi tạo DriveSpool
func NewDriveSpool(spoolDir string, maxBytes int64, dm *DriveManager) *DriveSpool {
	if spoolDir == "" {
		localAppData := os.Getenv("LOCALAPPDATA")
		if localAppData == "" {
			localAppData = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
		}
		spoolDir = filepath.Join(localAppData, "SubTrans", "spool")
	}
	_ = os.MkdirAll(spoolDir, 0755)

	if maxBytes <= 0 {
		maxBytes = defaultMaxSpoolBytes
	}

	return &DriveSpool{
		spoolDir:      spoolDir,
		maxSpoolBytes: maxBytes,
		dm:            dm,
	}
}

// StartSpool bắt đầu tải tuần tự một file Drive về thư mục spool (Player-First, 1 kết nối duy nhất)
func (s *DriveSpool) StartSpool(fileID string, knownSize int64) *SpoolProgress {
	s.mu.Lock()
	defer s.mu.Unlock()

	if fileID == "" {
		return nil
	}

	// Nếu video đang được tải chính là file này: trả về tiến độ hiện tại
	if s.activeID == fileID && s.activeProg != nil {
		return s.activeProg
	}

	// Nếu đổi video khác: hủy ngay tiến trình tải của video cũ
	if s.activeProg != nil && s.activeProg.cancel != nil {
		s.activeProg.cancel()
		s.activeProg = nil
		s.activeID = ""
	}

	partPath := filepath.Join(s.spoolDir, fileID+".part")
	metaPath := filepath.Join(s.spoolDir, fileID+".meta")

	prog := &SpoolProgress{
		FileID:    fileID,
		PartPath:  partPath,
		MetaPath:  metaPath,
		readyCond: sync.NewCond(&sync.Mutex{}),
	}
	prog.TotalSize.Store(knownSize)

	// Kiểm tra xem file đã có sẵn trên đĩa và đã hoàn thành chưa
	if meta, err := s.readMeta(metaPath); err == nil && meta.Complete {
		if fi, err := os.Stat(partPath); err == nil && fi.Size() == meta.TotalSize && meta.TotalSize > 0 {
			// Đã có sẵn toàn bộ file hợp lệ
			prog.DownloadedBytes.Store(meta.TotalSize)
			prog.TotalSize.Store(meta.TotalSize)
			prog.Complete.Store(true)
			etagCopy := meta.ETag
			prog.ETag.Store(&etagCopy)
			s.touchMeta(metaPath, meta)

			s.activeID = fileID
			s.activeProg = prog
			return prog
		}
	}

	// Dọn dẹp LRU nếu vượt giới hạn dung lượng trước khi tải file mới
	s.evictLRULocked(knownSize)

	ctx, cancel := context.WithCancel(context.Background())
	prog.cancel = cancel

	s.activeID = fileID
	s.activeProg = prog

	go s.runDownload(ctx, prog)

	return prog
}

// runDownload thực hiện tải tuần tự từ đầu file qua 1 kết nối duy nhất
func (s *DriveSpool) runDownload(ctx context.Context, prog *SpoolProgress) {
	defer func() {
		prog.readyCond.L.Lock()
		prog.readyCond.Broadcast()
		prog.readyCond.L.Unlock()
	}()

	var resp *http.Response
	var err error

	if s.mockDownloadFn != nil {
		resp, err = s.mockDownloadFn(ctx, prog.FileID)
	} else if s.dm != nil {
		// Gọi trực tiếp upstreamGet của DriveManager (tự Bearer token, tự refresh 401)
		resp, err = s.dm.upstreamGet(ctx, http.MethodGet, prog.FileID, "bytes=0-", "")
	} else {
		return
	}

	if err != nil {
		if !errorsIsCanceled(err) {
			log.Printf("[DriveSpool] Lỗi kết nối tải file %s: %v", prog.FileID, err)
		}
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		log.Printf("[DriveSpool] Google Drive trả về HTTP status %d cho file %s", resp.StatusCode, prog.FileID)
		return
	}

	etag := resp.Header.Get("ETag")
	prog.ETag.Store(&etag)

	totalSize := resp.ContentLength
	if cr := resp.Header.Get("Content-Range"); cr != "" {
		if parts := strings.Split(cr, "/"); len(parts) == 2 {
			if sz, err := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64); err == nil && sz > 0 {
				totalSize = sz
			}
		}
	}
	if totalSize > 0 {
		prog.TotalSize.Store(totalSize)
	}

	f, err := os.OpenFile(prog.PartPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		log.Printf("[DriveSpool] Không thể mở file ghi spool %s: %v", prog.PartPath, err)
		return
	}
	defer f.Close()

	buf := make([]byte, 64*1024) // 64KB buffer
	var downloaded int64
	lastSync := time.Now()

	for {
		if ctx.Err() != nil {
			return
		}

		n, rErr := resp.Body.Read(buf)
		if n > 0 {
			if _, wErr := f.Write(buf[:n]); wErr != nil {
				log.Printf("[DriveSpool] Lỗi ghi file spool %s: %v", prog.PartPath, wErr)
				return
			}
			downloaded += int64(n)
			prog.DownloadedBytes.Store(downloaded)

			// Đánh thức các goroutine đang chờ dữ liệu
			prog.readyCond.L.Lock()
			prog.readyCond.Broadcast()
			prog.readyCond.L.Unlock()

			// Sync định kỳ mỗi 500ms để đảm bảo các tiến trình khác đọc được dữ liệu mới
			if time.Since(lastSync) > 500*time.Millisecond {
				_ = f.Sync()
				lastSync = time.Now()
			}
		}

		if rErr != nil {
			if rErr == io.EOF {
				_ = f.Sync()
				prog.Complete.Store(true)
				s.saveMeta(prog.MetaPath, SpoolMeta{
					FileID:          prog.FileID,
					ETag:            etag,
					TotalSize:       downloaded,
					DownloadedBytes: downloaded,
					Complete:        true,
					UpdatedAt:       time.Now(),
				})
				log.Printf("[DriveSpool] Đã tải hoàn tất file %s (%d bytes)", prog.FileID, downloaded)
			} else if !errorsIsCanceled(rErr) {
				log.Printf("[DriveSpool] Kết thúc tải file %s có lỗi: %v", prog.FileID, rErr)
			}
			return
		}
	}
}

// GetAvailableMediaInput kiểm tra xem vùng cần cắt audio đã sẵn sàng trong file spool cục bộ chưa.
// - Nếu đã có sẵn: trả về (localPartPath, true).
// - Nếu là block 0: chờ tối đa waitTimeout cho vùng đầu có sẵn; nếu kịp trả về (localPartPath, true).
// - Nếu tua xa vào vùng chưa tải: không chờ, trả về ("", false) để slicer quay về đường proxy.
func (s *DriveSpool) GetAvailableMediaInput(
	ctx context.Context,
	fileID string,
	extractStartSec float64,
	extractLenSec float64,
	totalDurationSec float64,
) (string, bool) {
	s.mu.Lock()
	prog := s.activeProg
	if prog == nil || prog.FileID != fileID {
		// Kiểm tra xem file hoàn chỉnh đã có sẵn trên đĩa từ phiên trước không
		partPath := filepath.Join(s.spoolDir, fileID+".part")
		metaPath := filepath.Join(s.spoolDir, fileID+".meta")
		if meta, err := s.readMeta(metaPath); err == nil && meta.Complete {
			if fi, err := os.Stat(partPath); err == nil && fi.Size() == meta.TotalSize {
				s.mu.Unlock()
				return partPath, true
			}
		}
		s.mu.Unlock()
		return "", false
	}
	s.mu.Unlock()

	// 1. Nếu file đã tải hoàn tất 100%: mọi vị trí đều đọc trực tiếp từ đĩa
	if prog.Complete.Load() {
		return prog.PartPath, true
	}

	// 2. Ước lượng số byte cần thiết cho đoạn thời gian [startSec, startSec + lenSec]
	totalSize := prog.TotalSize.Load()
	if totalDurationSec <= 0 {
		totalDurationSec = 300.0 // giá trị an toàn nếu chưa rõ duration
	}
	avgBytePerSec := 0.0
	if totalSize > 0 && totalDurationSec > 0 {
		avgBytePerSec = float64(totalSize) / totalDurationSec
	}

	neededEndSec := extractStartSec + extractLenSec + 10.0 // biên độ an toàn 10s
	var neededBytes int64
	if avgBytePerSec > 0 {
		neededBytes = int64(neededEndSec * avgBytePerSec * 1.35) // hệ số an toàn 1.35x cho VBR
	} else {
		neededBytes = minBlock0BufferBytes
	}

	if extractStartSec == 0 {
		// Block 0: yêu cầu tối thiểu minBlock0BufferBytes (15MB) hoặc toàn bộ file nếu file nhỏ hơn
		if totalSize > 0 && totalSize < minBlock0BufferBytes {
			neededBytes = totalSize
		} else if neededBytes < minBlock0BufferBytes {
			neededBytes = minBlock0BufferBytes
		}
	}

	// 3. Nếu là block 0: chờ tải đủ neededBytes (chờ tối đa 6s)
	if extractStartSec == 0 {
		ok := s.waitForBytes(ctx, prog, neededBytes, 6*time.Second)
		if ok {
			return prog.PartPath, true
		}
		// Hết thời gian chờ mà chưa đủ: fallback proxy để không nghẽn pipeline
		return "", false
	}

	// 4. Nếu là ca tua (extractStartSec > 0):
	currentDownloaded := prog.DownloadedBytes.Load()
	if currentDownloaded >= neededBytes && neededBytes > 0 {
		// Đã tải sẵn đến vị trí này
		return prog.PartPath, true
	}

	// Chưa tải đến vị trí tua xa: quay về đường proxy hiện tại ngay lập tức, không chờ
	return "", false
}

// waitForBytes chờ cho đến khi spool tải đạt ít nhất targetBytes hoặc timeout/cancel
func (s *DriveSpool) waitForBytes(ctx context.Context, prog *SpoolProgress, targetBytes int64, timeout time.Duration) bool {
	if prog.DownloadedBytes.Load() >= targetBytes || prog.Complete.Load() {
		return true
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	prog.readyCond.L.Lock()
	defer prog.readyCond.L.Unlock()

	for prog.DownloadedBytes.Load() < targetBytes && !prog.Complete.Load() {
		// Kiểm tra context cancel
		if ctx.Err() != nil {
			return false
		}

		doneChan := make(chan struct{})
		go func() {
			select {
			case <-timer.C:
				prog.readyCond.L.Lock()
				prog.readyCond.Broadcast()
				prog.readyCond.L.Unlock()
			case <-ctx.Done():
				prog.readyCond.L.Lock()
				prog.readyCond.Broadcast()
				prog.readyCond.L.Unlock()
			case <-doneChan:
			}
		}()

		prog.readyCond.Wait()
		close(doneChan)

		select {
		case <-timer.C:
			return prog.DownloadedBytes.Load() >= targetBytes || prog.Complete.Load()
		case <-ctx.Done():
			return false
		default:
		}
	}

	return prog.DownloadedBytes.Load() >= targetBytes || prog.Complete.Load()
}

// CancelActive hủy việc tải video hiện tại (khi chuyển video)
func (s *DriveSpool) CancelActive() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.activeProg != nil && s.activeProg.cancel != nil {
		s.activeProg.cancel()
		s.activeProg = nil
		s.activeID = ""
	}
}

// Close dọn dẹp khi app thoát
func (s *DriveSpool) Close() {
	s.CancelActive()
}

// evictLRULocked xóa các file spool cũ nhất khi tổng dung lượng thư mục vượt quá giới hạn
func (s *DriveSpool) evictLRULocked(incomingBytes int64) {
	entries, err := os.ReadDir(s.spoolDir)
	if err != nil {
		return
	}

	type fileItem struct {
		path    string
		size    int64
		modTime time.Time
		fileID  string
	}

	var files []fileItem
	var totalSize int64

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}

		fullPath := filepath.Join(s.spoolDir, entry.Name())
		totalSize += info.Size()

		fileID := strings.TrimSuffix(strings.TrimSuffix(entry.Name(), ".part"), ".meta")
		files = append(files, fileItem{
			path:    fullPath,
			size:    info.Size(),
			modTime: info.ModTime(),
			fileID:  fileID,
		})
	}

	if totalSize+incomingBytes <= s.maxSpoolBytes {
		return
	}

	// Sắp xếp tăng dần theo ModTime (cũ nhất đứng trước)
	sort.Slice(files, func(i, j int) bool {
		return files[i].modTime.Before(files[j].modTime)
	})

	for _, item := range files {
		if totalSize+incomingBytes <= s.maxSpoolBytes {
			break
		}
		// Không xóa file của video đang mở / đang phát
		if item.fileID == s.activeID {
			continue
		}

		if err := os.Remove(item.path); err == nil {
			totalSize -= item.size
			// Xóa kèm file meta nếu có
			metaFile := filepath.Join(s.spoolDir, item.fileID+".meta")
			_ = os.Remove(metaFile)
		}
	}
}

func (s *DriveSpool) saveMeta(path string, meta SpoolMeta) {
	meta.UpdatedAt = time.Now()
	data, err := json.MarshalIndent(meta, "", "  ")
	if err == nil {
		_ = os.WriteFile(path, data, 0644)
	}
}

func (s *DriveSpool) readMeta(path string) (SpoolMeta, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return SpoolMeta{}, err
	}
	var meta SpoolMeta
	err = json.Unmarshal(data, &meta)
	return meta, err
}

func (s *DriveSpool) touchMeta(path string, meta SpoolMeta) {
	meta.UpdatedAt = time.Now()
	s.saveMeta(path, meta)
	// Cập nhật cả modtime của file .part
	partPath := strings.TrimSuffix(path, ".meta") + ".part"
	now := time.Now()
	_ = os.Chtimes(partPath, now, now)
}

func errorsIsCanceled(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "context canceled") || strings.Contains(err.Error(), "operation was canceled")
}
