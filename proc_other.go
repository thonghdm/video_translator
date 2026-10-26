//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

func prepareCmdPlatform(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	// Tạo process group riêng để kill toàn bộ group khi cần
	cmd.SysProcAttr.Setpgid = true
}

func killProcessTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	pid := cmd.Process.Pid
	if pid > 0 {
		// Gửi SIGKILL tới cả process group (âm pid)
		_ = syscall.Kill(-pid, syscall.SIGKILL)
	}
	_ = cmd.Process.Kill()
}

func prepareRestartProcess(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

