package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Test_MediaServer_TokenAuth_And_RangeRequest kiểm thử HTTP Range Server và bảo mật Token 128-bit
func Test_MediaServer_TokenAuth_And_RangeRequest(t *testing.T) {
	// 1. Tạo file video giả lập 10,000 bytes
	tempDir := t.TempDir()
	dummyFile := filepath.Join(tempDir, "sample_video.mp4")
	dummyData := make([]byte, 10000)
	for i := range dummyData {
		dummyData[i] = byte(i % 256)
	}
	if err := os.WriteFile(dummyFile, dummyData, 0644); err != nil {
		t.Fatalf("Không thể tạo file media mẫu: %v", err)
	}

	// 2. Khởi tạo MediaServer
	ms, err := GetMediaServer()
	if err != nil {
		t.Fatalf("Khởi tạo MediaServer thất bại: %v", err)
	}

	mediaURL, err := ms.SetMediaFile(dummyFile)
	if err != nil {
		t.Fatalf("SetMediaFile thất bại: %v", err)
	}

	if !strings.HasPrefix(mediaURL, "http://127.0.0.1:") {
		t.Fatalf("URL phải trỏ về loopback 127.0.0.1: %s", mediaURL)
	}

	// 3. Test Truy cập sai token -> 403 Forbidden
	invalidURL := fmt.Sprintf("http://127.0.0.1:%d/media/wrongtoken123", ms.port)
	resp, err := http.Get(invalidURL)
	if err != nil {
		t.Fatalf("Request thất bại: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("Kỳ vọng StatusForbidden (403), thực tế nhận được: %d", resp.StatusCode)
	}

	// 4. Test Truy cập đúng token nhưng không Range -> 200 OK
	resp, err = http.Get(mediaURL)
	if err != nil {
		t.Fatalf("Request đúng token thất bại: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Errorf("Kỳ vọng 200 OK, thực tế: %d", resp.StatusCode)
	}
	if resp.Header.Get("Accept-Ranges") != "bytes" {
		t.Errorf("Header Accept-Ranges phải là bytes: %s", resp.Header.Get("Accept-Ranges"))
	}
	resp.Body.Close()

	// 5. Test HTTP Range request: bytes=0-99 (Status 206 Partial Content, Content-Length 100)
	client := &http.Client{}
	req, _ := http.NewRequest("GET", mediaURL, nil)
	req.Header.Set("Range", "bytes=0-99")

	rangeResp, err := client.Do(req)
	if err != nil {
		t.Fatalf("Range request thất bại: %v", err)
	}
	defer rangeResp.Body.Close()

	if rangeResp.StatusCode != http.StatusPartialContent {
		t.Errorf("Kỳ vọng 206 Partial Content, thực tế: %d", rangeResp.StatusCode)
	}

	contentRange := rangeResp.Header.Get("Content-Range")
	expectedRange := "bytes 0-99/10000"
	if contentRange != expectedRange {
		t.Errorf("Content-Range sai: nhận %s, kỳ vọng %s", contentRange, expectedRange)
	}

	bodyBytes, _ := io.ReadAll(rangeResp.Body)
	if len(bodyBytes) != 100 {
		t.Errorf("Độ dài dữ liệu Range sai: nhận %d bytes, kỳ vọng 100 bytes", len(bodyBytes))
	}

	// Xác nhận byte đầu và byte cuối khớp dữ liệu mẫu
	if bodyBytes[0] != dummyData[0] || bodyBytes[99] != dummyData[99] {
		t.Errorf("Nội dung byte Range không khớp dữ liệu gốc")
	}

	// 6. Test HTTP Range request: bytes=9900- (100 bytes cuối cùng)
	reqEnd, _ := http.NewRequest("GET", mediaURL, nil)
	reqEnd.Header.Set("Range", "bytes=9900-")

	rangeRespEnd, err := client.Do(reqEnd)
	if err != nil {
		t.Fatalf("Range request cuối file thất bại: %v", err)
	}
	defer rangeRespEnd.Body.Close()

	if rangeRespEnd.StatusCode != http.StatusPartialContent {
		t.Errorf("Kỳ vọng 206, thực tế: %d", rangeRespEnd.StatusCode)
	}
	if rangeRespEnd.Header.Get("Content-Range") != "bytes 9900-9999/10000" {
		t.Errorf("Content-Range cuối file sai: %s", rangeRespEnd.Header.Get("Content-Range"))
	}
}
