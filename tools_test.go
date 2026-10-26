package main

import (
	"bufio"
	"context"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Test_SplitCRLF kiểm tra bộ tách dòng hỗ trợ cả \r (progress của ffmpeg) và \n
func Test_SplitCRLF(t *testing.T) {
	input := "line1\rline2\nline3\r\nline4"
	scanner := bufio.NewScanner(strings.NewReader(input))
	scanner.Split(splitCRLF)

	var lines []string
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}

	expected := []string{"line1", "line2", "line3", "line4"}
	if len(lines) != len(expected) {
		t.Fatalf("Số dòng tách được sai: nhận %d, kỳ vọng %d (%v)", len(lines), len(expected), lines)
	}

	for i := range lines {
		if lines[i] != expected[i] {
			t.Errorf("Dòng %d sai: nhận %q, kỳ vọng %q", i, lines[i], expected[i])
		}
	}
}

// Test_RunCommand_TimeoutAndKill kiểm tra timeout và dọn dẹp tiến trình
func Test_RunCommand_TimeoutAndKill(t *testing.T) {
	ctx := context.Background()

	var bin string
	var args []string

	if runtime.GOOS == "windows" {
		bin = "powershell.exe"
		args = []string{"-Command", "Start-Sleep -Seconds 10"}
	} else {
		bin = "sleep"
		args = []string{"10"}
	}

	start := time.Now()
	// Đặt timeout 1 giây để lệnh 10 giây phải bị ngắt
	_, err := RunCommand(ctx, bin, args, 1*time.Second, nil)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("Kỳ vọng lệnh bị timeout báo lỗi, nhưng lại hoàn thành thành công")
	}

	// Thời gian kết thúc phải xoay quanh 1s (chênh lệch không quá 2s), không được chờ hết 10s
	if elapsed > 4*time.Second {
		t.Errorf("Thời gian chạy vượt quá mong đợi: %v (tiến trình có thể chưa bị kill kịp thời)", elapsed)
	}
}
