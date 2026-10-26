package main

import (
	"testing"
)

// Test_FormatSRTTime kiểm tra chuyển đổi số giây sang chuẩn thời gian SRT
func Test_FormatSRTTime(t *testing.T) {
	cases := []struct {
		sec      float64
		expected string
	}{
		{0.0, "00:00:00,000"},
		{1.5, "00:00:01,500"},
		{65.42, "00:01:05,420"},
		{3661.05, "01:01:01,050"},
	}

	for _, c := range cases {
		actual := FormatSRTTime(c.sec)
		if actual != c.expected {
			t.Errorf("FormatSRTTime(%v) = %q, kỳ vọng %q", c.sec, actual, c.expected)
		}
	}
}
