package main

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ToolsPaths lưu đường dẫn đầy đủ tới các file thực thi và models
type ToolsPaths struct {
	BaseDir      string
	FFmpeg       string
	FFprobe      string
	WhisperCLI   string
	LlamaCLI     string
	LlamaServer  string
	WhisperModel string
	LlamaModel   string
	TempDir      string
}

var (
	globalTools *ToolsPaths
	toolsOnce   sync.Once
)

// GetToolsPaths trả về đường dẫn tới các công cụ phụ thuộc
func GetToolsPaths() *ToolsPaths {
	toolsOnce.Do(func() {
		// Thư mục chứa file exe đang chạy
		exePath, err := os.Executable()
		var baseDir string
		if err == nil {
			baseDir = filepath.Dir(exePath)
		} else {
			baseDir, _ = os.Getwd()
		}

		// Nếu đang trong môi trường dev (chạy bằng wails dev hoặc go run)
		candidateBin := filepath.Join(baseDir, "build", "bin")
		if _, err := os.Stat(candidateBin); err == nil {
			baseDir = candidateBin
		}

		// Xác định thư mục tạm ASCII an toàn
		tempDir := getSafeASCIITempDir()

		globalTools = &ToolsPaths{
			BaseDir:      baseDir,
			FFmpeg:       filepath.Join(baseDir, "tools", "ffmpeg", "ffmpeg.exe"),
			FFprobe:      filepath.Join(baseDir, "tools", "ffmpeg", "ffprobe.exe"),
			WhisperCLI:   filepath.Join(baseDir, "tools", "whisper", "whisper-cli.exe"),
			LlamaCLI:     filepath.Join(baseDir, "tools", "llama", "llama-cli.exe"),
			LlamaServer:  filepath.Join(baseDir, "tools", "llama", "llama-server.exe"),
			WhisperModel: filepath.Join(baseDir, "models", "ggml-base.bin"),
			LlamaModel:   filepath.Join(baseDir, "models", "qwen2.5-1.5b-instruct-q4_k_m.gguf"),
			TempDir:      tempDir,
		}

		// Dọn dẹp thư mục tạm cũ khi khởi động
		_ = os.RemoveAll(tempDir)
		_ = os.MkdirAll(tempDir, 0755)
	})
	return globalTools
}

// getSafeASCIITempDir tìm kiếm thư mục tạm có đường dẫn ASCII an toàn
func getSafeASCIITempDir() string {
	candidates := []string{
		os.Getenv("TEMP"),
		os.Getenv("PUBLIC"),
		os.Getenv("ProgramData"),
		"C:\\Temp",
	}

	for _, c := range candidates {
		if c == "" {
			continue
		}
		// Kiểm tra nếu đường dẫn thuần ASCII
		isASCII := true
		for _, r := range c {
			rInt := int(r)
			if rInt > 127 {
				isASCII = false
				break
			}
		}
		if isASCII {
			p := filepath.Join(c, "SubTrans")
			if err := os.MkdirAll(p, 0755); err == nil {
				return p
			}
		}
	}
	return filepath.Join(os.TempDir(), "SubTrans")
}

// CheckTools kiểm tra sự tồn tại của các công cụ và models bắt buộc
func CheckTools() []string {
	tools := GetToolsPaths()
	var missing []string

	check := func(name, path string) {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			missing = append(missing, fmt.Sprintf("%s (%s)", name, path))
		}
	}

	check("ffmpeg", tools.FFmpeg)
	check("ffprobe", tools.FFprobe)
	check("whisper-cli", tools.WhisperCLI)
	check("llama-cli", tools.LlamaCLI)
	check("Whisper Model (ggml-base.bin)", tools.WhisperModel)
	check("Llama Model (qwen2.5-1.5b-instruct-q4_k_m.gguf)", tools.LlamaModel)

	return missing
}

// RunCommandResult lưu kết quả thực thi
type RunCommandResult struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

// splitCRLF là SplitFunc cho bufio.Scanner để tách theo cả \r và \n (cần thiết cho ffmpeg)
func splitCRLF(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	for i := 0; i < len(data); i++ {
		if data[i] == '\r' || data[i] == '\n' {
			// Bỏ qua cụm \r\n
			if data[i] == '\r' && i+1 < len(data) && data[i+1] == '\n' {
				return i + 2, data[0:i], nil
			}
			return i + 1, data[0:i], nil
		}
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil
}

// RunCommand thực thi tiến trình với timeout, ẩn console và kill cây tiến trình khi hủy
func RunCommand(ctx context.Context, bin string, args []string, timeout time.Duration, onStderrLine func(string)) (*RunCommandResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	var cmdCtx context.Context
	var cancel context.CancelFunc

	if timeout > 0 {
		cmdCtx, cancel = context.WithTimeout(ctx, timeout)
	} else {
		cmdCtx, cancel = context.WithCancel(ctx)
	}
	defer cancel()

	cmd := exec.CommandContext(cmdCtx, bin, args...)
	prepareCmdPlatform(cmd)

	var stdoutBuf bytes.Buffer
	cmd.Stdout = &stdoutBuf

	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("không thể tạo pipe stderr: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("lỗi khởi chạy %s: %w", bin, err)
	}

	// Đảm bảo kill triệt để cây tiến trình nếu context bị hủy
	doneChan := make(chan struct{})
	defer close(doneChan)

	go func() {
		select {
		case <-cmdCtx.Done():
			killProcessTree(cmd)
		case <-doneChan:
		}
	}()

	// Đọc stderr real-time và lưu lại vài dòng cuối
	var recentStderrLines []string
	var recentMu sync.Mutex

	scanner := bufio.NewScanner(stderrPipe)
	scanner.Split(splitCRLF)

	go func() {
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			if onStderrLine != nil {
				onStderrLine(line)
			}
			recentMu.Lock()
			recentStderrLines = append(recentStderrLines, line)
			if len(recentStderrLines) > 10 {
				recentStderrLines = recentStderrLines[1:]
			}
			recentMu.Unlock()
		}
	}()

	cmdErr := cmd.Wait()

	recentMu.Lock()
	recentStderr := strings.Join(recentStderrLines, "\n")
	recentMu.Unlock()

	exitCode := 0
	if cmdErr != nil {
		if exitErr, ok := cmdErr.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}

		if cmdCtx.Err() == context.DeadlineExceeded {
			return &RunCommandResult{
				Stdout:   stdoutBuf.String(),
				Stderr:   recentStderr,
				ExitCode: exitCode,
			}, fmt.Errorf("tiến trình %s bị timeout sau %v: %s", filepath.Base(bin), timeout, recentStderr)
		}
		if cmdCtx.Err() == context.Canceled {
			return &RunCommandResult{
				Stdout:   stdoutBuf.String(),
				Stderr:   recentStderr,
				ExitCode: exitCode,
			}, fmt.Errorf("tiến trình %s bị hủy: %w", filepath.Base(bin), context.Canceled)
		}

		return &RunCommandResult{
			Stdout:   stdoutBuf.String(),
			Stderr:   recentStderr,
			ExitCode: exitCode,
		}, fmt.Errorf("tiến trình %s thoát mã lỗi %d: %s", filepath.Base(bin), exitCode, recentStderr)
	}

	return &RunCommandResult{
		Stdout:   stdoutBuf.String(),
		Stderr:   recentStderr,
		ExitCode: 0,
	}, nil
}
