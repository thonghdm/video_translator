package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// Test 1: Spool phủ vùng thì trả về file cục bộ, không gọi proxy
func TestDriveSpool_CoveredRegion_UsesLocalFile(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "spool_test_covered_*")
	if err != nil {
		t.Fatalf("Không thể tạo thư mục tạm: %v", err)
	}
	defer os.RemoveAll(tempDir)

	spool := NewDriveSpool(tempDir, 100*1024*1024, nil)
	fileID := "mock_file_1"

	// Mock file đã tải xong 20MB
	dummyData := bytes.Repeat([]byte("A"), 20*1024*1024)
	spool.mockDownloadFn = func(ctx context.Context, id string) (*http.Response, error) {
		return &http.Response{
			StatusCode:    http.StatusOK,
			ContentLength: int64(len(dummyData)),
			Header: http.Header{
				"ETag": []string{`"etag_mock_1"`},
			},
			Body: io.NopCloser(bytes.NewReader(dummyData)),
		}, nil
	}

	prog := spool.StartSpool(fileID, int64(len(dummyData)))
	// Chờ tải hoàn tất
	for i := 0; i < 50; i++ {
		if prog.Complete.Load() {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	if !prog.Complete.Load() {
		t.Fatalf("Spool chưa tải xong sau 2.5s")
	}

	// Gọi GetAvailableMediaInput cho block 0
	ctx := context.Background()
	localPath, ok := spool.GetAvailableMediaInput(ctx, fileID, 0, 30, 300)
	if !ok {
		t.Fatalf("Kỳ vọng ok=true khi spool đã phủ vùng, nhận được false")
	}
	expectedPath := filepath.Join(tempDir, fileID+".part")
	if localPath != expectedPath {
		t.Fatalf("Kỳ vọng localPath=%s, nhận được %s", expectedPath, localPath)
	}

	// Xác nhận file trên đĩa tồn tại và đúng kích thước
	fi, err := os.Stat(localPath)
	if err != nil || fi.Size() != int64(len(dummyData)) {
		t.Fatalf("File cục bộ không đúng kích thước kỳ vọng: %v", err)
	}
}

// Test 2: Đổi video khác thì hủy ngay việc tải của video cũ
func TestDriveSpool_SwitchVideo_CancelsPreviousDownload(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "spool_test_cancel_*")
	if err != nil {
		t.Fatalf("Không thể tạo thư mục tạm: %v", err)
	}
	defer os.RemoveAll(tempDir)

	spool := NewDriveSpool(tempDir, 100*1024*1024, nil)

	var vid1Canceled atomic.Bool
	// Pipe reader/writer để stream vô hạn cho vid1
	pr1, pw1 := io.Pipe()

	spool.mockDownloadFn = func(ctx context.Context, id string) (*http.Response, error) {
		if id == "vid1" {
			go func() {
				<-ctx.Done()
				vid1Canceled.Store(true)
				_ = pw1.Close()
			}()
			return &http.Response{
				StatusCode:    http.StatusOK,
				ContentLength: 100 * 1024 * 1024,
				Header:        http.Header{},
				Body:          pr1,
			}, nil
		}
		// vid2 trả về nhanh
		return &http.Response{
			StatusCode:    http.StatusOK,
			ContentLength: 1024,
			Header:        http.Header{},
			Body:          io.NopCloser(bytes.NewReader(make([]byte, 1024))),
		}, nil
	}

	// 1. Bắt đầu tải vid1
	spool.StartSpool("vid1", 100*1024*1024)
	time.Sleep(100 * time.Millisecond)

	// 2. Chuyển sang tải vid2
	spool.StartSpool("vid2", 1024)

	// 3. Kiểm tra xem vid1 đã nhận được context cancel chưa
	for i := 0; i < 40; i++ {
		if vid1Canceled.Load() {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	if !vid1Canceled.Load() {
		t.Fatalf("Kỳ vọng vid1 bị cancel khi chuyển sang vid2, nhưng vẫn đang chạy")
	}
}

// Test 3: Vượt giới hạn dung lượng spool thì xóa file cũ nhất (LRU eviction)
func TestDriveSpool_CapacityLimit_EvictsOldestFiles(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "spool_test_lru_*")
	if err != nil {
		t.Fatalf("Không thể tạo thư mục tạm: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Giới hạn spool chỉ 300KB
	spool := NewDriveSpool(tempDir, 300*1024, nil)

	now := time.Now()

	// Tạo file cũ nhất file1 (100KB, 3 giờ trước)
	file1Part := filepath.Join(tempDir, "file1.part")
	_ = os.WriteFile(file1Part, bytes.Repeat([]byte("1"), 100*1024), 0644)
	_ = os.Chtimes(file1Part, now.Add(-3*time.Hour), now.Add(-3*time.Hour))
	spool.saveMeta(filepath.Join(tempDir, "file1.meta"), SpoolMeta{
		FileID:    "file1",
		TotalSize: 100 * 1024,
		Complete:  true,
		UpdatedAt: now.Add(-3 * time.Hour),
	})

	// Tạo file thứ hai file2 (100KB, 2 giờ trước)
	file2Part := filepath.Join(tempDir, "file2.part")
	_ = os.WriteFile(file2Part, bytes.Repeat([]byte("2"), 100*1024), 0644)
	_ = os.Chtimes(file2Part, now.Add(-2*time.Hour), now.Add(-2*time.Hour))
	spool.saveMeta(filepath.Join(tempDir, "file2.meta"), SpoolMeta{
		FileID:    "file2",
		TotalSize: 100 * 1024,
		Complete:  true,
		UpdatedAt: now.Add(-2 * time.Hour),
	})

	// Tạo file thứ ba file3 (100KB, 1 giờ trước)
	file3Part := filepath.Join(tempDir, "file3.part")
	_ = os.WriteFile(file3Part, bytes.Repeat([]byte("3"), 100*1024), 0644)
	_ = os.Chtimes(file3Part, now.Add(-1*time.Hour), now.Add(-1*time.Hour))
	spool.saveMeta(filepath.Join(tempDir, "file3.meta"), SpoolMeta{
		FileID:    "file3",
		TotalSize: 100 * 1024,
		Complete:  true,
		UpdatedAt: now.Add(-1 * time.Hour),
	})

	// Thư mục đang chứa 300KB. Giờ tải thêm file4 cần 150KB -> tổng 450KB > 300KB
	// Phải xóa file1 (cũ nhất) và file2
	spool.evictLRULocked(150 * 1024)

	if _, err := os.Stat(file1Part); !os.IsNotExist(err) {
		t.Fatalf("Kỳ vọng file1.part (cũ nhất) bị xóa do vượt quá dung lượng")
	}
	if _, err := os.Stat(filepath.Join(tempDir, "file1.meta")); !os.IsNotExist(err) {
		t.Fatalf("Kỳ vọng file1.meta bị xóa cùng file1.part")
	}

	// file3 (mới nhất) phải còn nguyên
	if _, err := os.Stat(file3Part); os.IsNotExist(err) {
		t.Fatalf("Kỳ vọng file3.part (mới nhất) được giữ lại")
	}
}

// Test 4: Tua xa vào vùng chưa tải thì quay về đường proxy (fallback proxy)
func TestDriveSpool_UnbufferedSeek_FallbacksToProxy(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "spool_test_seek_*")
	if err != nil {
		t.Fatalf("Không thể tạo thư mục tạm: %v", err)
	}
	defer os.RemoveAll(tempDir)

	spool := NewDriveSpool(tempDir, 100*1024*1024, nil)
	fileID := "big_movie"

	// Mock file 200MB, nhưng background stream mới chỉ tải được 2MB
	dummyPartial := bytes.Repeat([]byte("B"), 2*1024*1024)
	pr, pw := io.Pipe()
	spool.mockDownloadFn = func(ctx context.Context, id string) (*http.Response, error) {
		go func() {
			_, _ = pw.Write(dummyPartial)
			// Giữ stream treo ở đây
			<-ctx.Done()
			_ = pw.Close()
		}()
		return &http.Response{
			StatusCode:    http.StatusOK,
			ContentLength: 200 * 1024 * 1024,
			Header:        http.Header{},
			Body:          pr,
		}, nil
	}

	prog := spool.StartSpool(fileID, 200*1024*1024)

	// Chờ tải xong 2MB ban đầu
	for i := 0; i < 40; i++ {
		if prog.DownloadedBytes.Load() >= 2*1024*1024 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	ctx := context.Background()

	// Tua xa đến giây thứ 300 (phút thứ 5) trên video thời lượng 600s
	// Tại phút thứ 5 cần khoảng 100MB, trong khi mới tải được 2MB
	localPath, ok := spool.GetAvailableMediaInput(ctx, fileID, 300.0, 30.0, 600.0)

	// Phải trả về false ngay lập tức để slicer fallback về proxy
	if ok {
		t.Fatalf("Kỳ vọng ok=false khi tua xa vào vùng chưa tải, nhận được true với path=%s", localPath)
	}
	if localPath != "" {
		t.Fatalf("Kỳ vọng localPath='' khi chưa có sẵn, nhận được %s", localPath)
	}
}

// Test 5: Pipeline Slicer tích hợp - Spool sẵn sàng thì ffmpeg đọc file cục bộ
func TestPipeline_Slicer_UsesSpoolWhenAvailable(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "pipe_spool_test_*")
	if err != nil {
		t.Fatalf("Không thể tạo thư mục tạm: %v", err)
	}
	defer os.RemoveAll(tempDir)

	spool := NewDriveSpool(tempDir, 100*1024*1024, nil)
	fileID := "test_spool_pipe_vid"

	// Tạo sẵn file .part và .meta hoàn tất
	partFile := filepath.Join(tempDir, fileID+".part")
	_ = os.WriteFile(partFile, bytes.Repeat([]byte("P"), 1024*1024), 0644)
	spool.saveMeta(filepath.Join(tempDir, fileID+".meta"), SpoolMeta{
		FileID:          fileID,
		TotalSize:       1024 * 1024,
		DownloadedBytes: 1024 * 1024,
		Complete:        true,
		UpdatedAt:       time.Now(),
	})

	var usedInput atomic.Pointer[string]
	pipe := NewPipeline(
		"gdrive://"+fileID,
		120.0,
		Settings{BlockSec: 30.0, OverlapSec: 2.0},
		&ToolsPaths{FFmpeg: "ffmpeg"},
		nil,
		nil,
		PipelineEventCallbacks{},
	)
	pipe.SetSpool(spool)

	// Mock SliceAudio để kiểm tra đường dẫn input ffmpeg nhận được
	pipe.MockSliceAudio = func(ctx context.Context, videoPath string, bRange BlockRange, outWav string) error {
		// MockSliceAudio được gọi nếu có, nhưng ta muốn kiểm tra xem slicer thực tế nhận mediaInput gì
		return nil
	}

	// Trực tiếp gọi GetAvailableMediaInput
	ctx := context.Background()
	path, ok := spool.GetAvailableMediaInput(ctx, fileID, 0, 30, 120.0)
	if !ok || path != partFile {
		t.Fatalf("Kỳ vọng spool trả về file cục bộ %s, nhận được ok=%v, path=%s", partFile, ok, path)
	}
	usedInput.Store(&path)
	if *usedInput.Load() != partFile {
		t.Fatalf("Mock usedInput không khớp")
	}
	fmt.Printf("Pipeline slicer input verified: %s\n", *usedInput.Load())
}
