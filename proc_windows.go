//go:build windows

package main

import (
	"os/exec"
	"strconv"
	"syscall"
)

const (
	// CREATE_NO_WINDOW ngăn không cho cửa sổ command prompt bật lên
	CREATE_NO_WINDOW = 0x08000000
	// BELOW_NORMAL_PRIORITY_CLASS hạ độ ưu tiên của ffmpeg/whisper/llama để không giật video
	BELOW_NORMAL_PRIORITY_CLASS = 0x00004000
)

// prepareCmdPlatform thiết lập các thuộc tính tiến trình trên Windows
func prepareCmdPlatform(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS
}

// killProcessTree dập tắt toàn bộ cây tiến trình con trên Windows bằng taskkill /T /F
func killProcessTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	pid := cmd.Process.Pid
	if pid <= 0 {
		return
	}
	// Gọi taskkill /T (toàn bộ cây con) /F (cưỡng chế)
	killCmd := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pid))
	killCmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: CREATE_NO_WINDOW}
	_ = killCmd.Run()

	// Đảm bảo kill trực tiếp tiến trình cha
	_ = cmd.Process.Kill()
}

// prepareRestartProcess cấu hình cờ tiến trình độc lập hoàn toàn để khởi động lại app sau update
func prepareRestartProcess(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	// DETACHED_PROCESS (0x00000008) | CREATE_NEW_PROCESS_GROUP (0x00000200)
	cmd.SysProcAttr.CreationFlags |= 0x00000008 | 0x00000200
}

