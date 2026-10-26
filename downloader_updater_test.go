package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestCompareSemVer(t *testing.T) {
	tests := []struct {
		v1       string
		v2       string
		expected int
	}{
		{"1.0.0", "1.0.0", 0},
		{"v1.0.0", "1.0.0", 0},
		{"1.0.0", "1.1.0", -1},
		{"1.2.0", "1.1.9", 1},
		{"2.0.0", "1.99.99", 1},
		{"0.9.5", "1.0.0", -1},
		{"v1.0.1", "v1.0.2", -1},
	}

	for _, tt := range tests {
		got := compareSemVer(tt.v1, tt.v2)
		if got != tt.expected {
			t.Errorf("compareSemVer(%q, %q) = %d; want %d", tt.v1, tt.v2, got, tt.expected)
		}
	}
}

func TestUpdaterCheckForUpdate(t *testing.T) {
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		info := VersionInfo{
			Version:     "2.0.0",
			ReleaseDate: "2026-11-01",
			Changelog:   "- Tối ưu tốc độ dịch\n- Thêm tự động tải model",
			DownloadURL: "https://example.com/SubTrans_2.0.0.exe",
			FileSizeMB:  21.5,
			Mandatory:   false,
		}
		_ = json.NewEncoder(w).Encode(info)
	}))
	defer mockServer.Close()

	updater := NewUpdater()
	updater.SetVersionURL(mockServer.URL)

	res, err := updater.CheckForUpdate()
	if err != nil {
		t.Fatalf("CheckForUpdate failed: %v", err)
	}

	if !res.HasUpdate {
		t.Errorf("Expected HasUpdate = true for version 2.0.0 vs current %s", CurrentVersion)
	}
	if res.LatestVersion != "2.0.0" {
		t.Errorf("LatestVersion = %s, want 2.0.0", res.LatestVersion)
	}
	if res.FileSizeMB != 21.5 {
		t.Errorf("FileSizeMB = %v, want 21.5", res.FileSizeMB)
	}
}

func TestModelDownloaderDirAndCheck(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "subtrans_models_test_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	d := &ModelDownloader{
		modelsDir: tmpDir,
		models: []RequiredModel{
			{
				ID:           "test_model",
				Name:         "Test Model",
				FileName:     "test.bin",
				MinSize:      100,
				ExpectedSize: 200,
			},
		},
	}

	// Initially false
	if d.CheckModelsReady() {
		t.Errorf("CheckModelsReady should be false when files don't exist")
	}

	// Create dummy model file with 50 bytes (less than MinSize 100)
	target := filepath.Join(tmpDir, "test.bin")
	_ = os.WriteFile(target, make([]byte, 50), 0644)
	if d.CheckModelsReady() {
		t.Errorf("CheckModelsReady should be false when file size < MinSize")
	}

	// Create dummy model file with 150 bytes (>= MinSize 100)
	_ = os.WriteFile(target, make([]byte, 150), 0644)
	if !d.CheckModelsReady() {
		t.Errorf("CheckModelsReady should be true when file size >= MinSize")
	}
}
