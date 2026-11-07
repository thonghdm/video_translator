package main

import (
	"fmt"
	"os"
	"testing"
)

// BUG-20: lưới an toàn — mọi test (kể cả test quên t.Setenv) đều ghi cache vào thư mục tạm,
// không bao giờ vào %LOCALAPPDATA%\SubTrans\cache thật của người dùng.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "subtrans-test-appdata-")
	if err != nil {
		fmt.Fprintln(os.Stderr, "không tạo được LOCALAPPDATA tạm:", err)
		os.Exit(1)
	}
	os.Setenv("LOCALAPPDATA", dir)
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}
