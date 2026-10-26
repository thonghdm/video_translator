package main

import (
	"os"
	"path/filepath"
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

// Test_ScanVideoFolder_NaturalSort kiểm tra quét cây thư mục và sắp xếp tự nhiên (Bài 2 đứng trước Bài 10)
func Test_ScanVideoFolder_NaturalSort(t *testing.T) {
	rootDir := t.TempDir()
	mod2 := filepath.Join(rootDir, "Module 2")
	mod10 := filepath.Join(rootDir, "Module 10")
	emptyDir := filepath.Join(rootDir, "EmptyFolder")

	_ = os.MkdirAll(mod2, 0755)
	_ = os.MkdirAll(mod10, 0755)
	_ = os.MkdirAll(emptyDir, 0755)

	_ = os.WriteFile(filepath.Join(mod2, "Lesson 10.mp4"), []byte("dummy"), 0644)
	_ = os.WriteFile(filepath.Join(mod2, "Lesson 2.mp4"), []byte("dummy"), 0644)
	_ = os.WriteFile(filepath.Join(mod10, "Final.mkv"), []byte("dummy"), 0644)

	app := NewApp()
	tree, err := app.ScanVideoFolder(rootDir)
	if err != nil {
		t.Fatalf("ScanVideoFolder thất bại: %v", err)
	}
	if tree == nil || len(tree.Children) != 2 {
		t.Fatalf("Kỳ vọng 2 thư mục con có video (bỏ qua EmptyFolder), nhận được: %+v", tree)
	}
	if tree.Children[0].Name != "Module 2" || tree.Children[1].Name != "Module 10" {
		t.Errorf("Thứ tự thư mục sai: %s rồi %s", tree.Children[0].Name, tree.Children[1].Name)
	}
	if len(tree.Children[0].Children) != 2 || tree.Children[0].Children[0].Name != "Lesson 2.mp4" {
		t.Errorf("Thứ tự bài học trong Module 2 sai: %+v", tree.Children[0].Children)
	}
}

// Test_ParseSRTorVTT_And_MergeBrokenSegments kiểm tra đọc file .srt đi kèm và gộp câu đứt đoạn
func Test_ParseSRTorVTT_And_MergeBrokenSegments(t *testing.T) {
	srtRaw := `1
00:00:01,000 --> 00:00:02,500
- Hey everyone, I'm Morgan,

2
00:00:02,600 --> 00:00:04,800
welcome to this course.
`
	segs := ParseSRTorVTT(srtRaw)
	if len(segs) != 2 {
		t.Fatalf("Kỳ vọng parse được 2 segment từ SRT, nhận được %d", len(segs))
	}

	merged := MergeBrokenSegments(segs)
	if len(merged) != 1 {
		t.Fatalf("Kỳ vọng gộp 2 mảnh câu chưa kết thúc thành 1 câu hoàn chỉnh, nhận được %d", len(merged))
	}
	if merged[0].Text != "Hey everyone, I'm Morgan, welcome to this course." {
		t.Errorf("Nội dung câu sau khi gộp không khớp: %q", merged[0].Text)
	}
}
