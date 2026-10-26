package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// EnsureYtDlp kiểm tra yt-dlp đã có sẵn chưa, nếu chưa sẽ tự động tải bản chính thức từ GitHub Releases
func EnsureYtDlp(ctx context.Context, tools *ToolsPaths, onProgress func(string)) (string, error) {
	if tools != nil && tools.YtDlp != "" {
		if _, err := os.Stat(tools.YtDlp); err == nil {
			return tools.YtDlp, nil
		}
	}

	if pathInEnv, err := exec.LookPath("yt-dlp"); err == nil && pathInEnv != "" {
		return pathInEnv, nil
	}

	targetPath := filepath.Join(tools.BaseDir, "tools", "ytdlp", "yt-dlp.exe")
	if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
		return "", fmt.Errorf("không thể tạo thư mục ytdlp: %w", err)
	}

	if onProgress != nil {
		onProgress("Đang tự động tải công cụ yt-dlp lần đầu (~15MB)...")
	}

	dlURL := "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
	req, err := http.NewRequestWithContext(ctx, "GET", dlURL, nil)
	if err != nil {
		return "", err
	}

	client := &http.Client{Timeout: 3 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("không thể tải yt-dlp: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("tải yt-dlp thất bại với HTTP %d", resp.StatusCode)
	}

	tmpPath := targetPath + ".downloading"
	outFile, err := os.Create(tmpPath)
	if err != nil {
		return "", err
	}

	_, copyErr := io.Copy(outFile, resp.Body)
	_ = outFile.Close()
	if copyErr != nil {
		_ = os.Remove(tmpPath)
		return "", copyErr
	}

	if err := os.Rename(tmpPath, targetPath); err != nil {
		_ = os.Remove(tmpPath)
		return "", err
	}

	tools.YtDlp = targetPath
	return targetPath, nil
}

// DownloadYouTubeMedia tải nhanh video + phụ đề tiếng Anh gốc từ YouTube về máy
func DownloadYouTubeMedia(ctx context.Context, tools *ToolsPaths, rawURL string, onProgress func(string)) (string, error) {
	trimmedURL := strings.TrimSpace(rawURL)
	if trimmedURL == "" || (!strings.HasPrefix(trimmedURL, "http://") && !strings.HasPrefix(trimmedURL, "https://")) {
		return "", fmt.Errorf("đường dẫn YouTube không hợp lệ")
	}

	ytdlpBin, err := EnsureYtDlp(ctx, tools, onProgress)
	if err != nil {
		return "", err
	}

	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		localAppData = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
	}
	outDir := filepath.Join(localAppData, "SubTrans", "youtube")
	if err := os.MkdirAll(outDir, 0755); err != nil {
		return "", fmt.Errorf("không thể tạo thư mục lưu video YouTube: %w", err)
	}

	if onProgress != nil {
		onProgress("Đang phân tích link YouTube và tách phụ đề gốc...")
	}

	outTemplate := filepath.Join(outDir, "%(title).70s_[%(id)s].%(ext)s")
	args := []string{
		"--no-playlist",
		"--write-subs",
		"--write-auto-subs",
		"--sub-langs", "en.*,en",
		"--convert-subs", "srt",
		"-f", "bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/best[ext=mp4]/best",
		"--merge-output-format", "mp4",
		"--restrict-filenames",
		"--no-mtime",
		"--newline",
		"--print", "after_move:filepath",
		"-o", outTemplate,
	}

	if tools != nil && tools.FFmpeg != "" {
		if _, err := os.Stat(tools.FFmpeg); err == nil {
			args = append(args, "--ffmpeg-location", filepath.Dir(tools.FFmpeg))
		}
	}

	args = append(args, trimmedURL)

	res, err := RunCommand(ctx, ytdlpBin, args, 10*time.Minute, func(line string) {
		if onProgress != nil && (strings.Contains(line, "[download]") || strings.Contains(line, "[info]")) {
			onProgress(line)
		}
	})
	if err != nil {
		return "", fmt.Errorf("tải video YouTube thất bại: %w", err)
	}

	// Tìm đường dẫn file cuối cùng từ stdout của --print after_move:filepath
	lines := strings.Split(strings.ReplaceAll(res.Stdout, "\r\n", "\n"), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		candidate := strings.TrimSpace(lines[i])
		if candidate == "" {
			continue
		}
		if fi, statErr := os.Stat(candidate); statErr == nil && !fi.IsDir() {
			return candidate, nil
		}
	}

	// Fallback: tìm file .mp4 mới nhất trong thư mục youtube
	entries, readErr := os.ReadDir(outDir)
	if readErr == nil {
		var newestPath string
		var newestTime time.Time
		for _, e := range entries {
			if e.IsDir() || !isSupportedVideoExt(e.Name()) {
				continue
			}
			full := filepath.Join(outDir, e.Name())
			if fi, err := os.Stat(full); err == nil {
				if fi.ModTime().After(newestTime) {
					newestTime = fi.ModTime()
					newestPath = full
				}
			}
		}
		if newestPath != "" {
			return newestPath, nil
		}
	}

	return "", fmt.Errorf("không tìm thấy file video sau khi tải từ YouTube")
}
