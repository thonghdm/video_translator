package main

import (
	"os"
	"strings"
	"testing"
)

func TestDriveListQuery(t *testing.T) {
	cases := map[string]string{
		"shared_with_me": "sharedWithMe = true and trashed = false",
		"abc123":         "'abc123' in parents and trashed = false",
		"it's":           `'it\'s' in parents and trashed = false`,
		`a\b`:            `'a\\b' in parents and trashed = false`,
	}
	for in, want := range cases {
		got := driveListQuery(in)
		if got != want {
			t.Errorf("driveListQuery(%q) = %q, want %q", in, got, want)
		}
		if strings.Contains(got, "contains") {
			t.Errorf("truy vấn không được dùng `contains` (chỉ khớp tiền tố): %q", got)
		}
	}
}

// Chặn quay lại lỗi cũ: không ai thêm lại bộ lọc `name contains '.srt'` vào truy vấn liệt kê.
func TestDriveManagerSource_NoNameContainsFilter(t *testing.T) {
	data, err := os.ReadFile("drive_manager.go")
	if err != nil {
		t.Skip("không đọc được drive_manager.go")
	}
	for _, bad := range []string{"name contains '.srt'", "name contains '.vtt'"} {
		if strings.Contains(string(data), bad) {
			t.Errorf("drive_manager.go còn %q: Drive chỉ khớp tiền tố nên phụ đề sẽ bị bỏ sót", bad)
		}
	}
}
