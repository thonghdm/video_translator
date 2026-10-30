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

// Test_ParseSRTorVTT_And_MergeBrokenSegments kiểm tra đọc file _en.srt đi kèm và gộp câu đứt đoạn
func Test_ParseSRTorVTT_And_MergeBrokenSegments(t *testing.T) {
	tempDir := t.TempDir()
	vidPath := filepath.Join(tempDir, "001 Introduction.mp4")
	srtPath := filepath.Join(tempDir, "001 Introduction_en.srt")

	srtRaw := `1
00:00:00,000 --> 00:00:01,589
-: Hi, welcome back.

2
00:00:01,589 --> 00:00:05,190
I am Kalyan Reddy Daida and I will be your instructor

3
00:00:05,190 --> 00:00:09,210
in this EKS Kubernetes Masterclass course.
`
	_ = os.WriteFile(vidPath, []byte("dummy"), 0644)
	_ = os.WriteFile(srtPath, []byte(srtRaw), 0644)

	// 1. Kiểm tra FindExternalSubtitleFile tự phát hiện _en.srt từ đường dẫn .mp4
	foundSub := FindExternalSubtitleFile(vidPath)
	if foundSub != srtPath {
		t.Fatalf("Kỳ vọng tìm thấy %q, thực tế nhận %q", srtPath, foundSub)
	}

	// 2. Kiểm tra ResolveVideoFromSubtitlePath tự ánh xạ từ _en.srt sang .mp4
	resolvedVid := ResolveVideoFromSubtitlePath(srtPath)
	if resolvedVid != vidPath {
		t.Fatalf("Kỳ vọng ánh xạ về %q, thực tế nhận %q", vidPath, resolvedVid)
	}

	segs := ParseSRTorVTT(srtRaw)
	if len(segs) != 3 {
		t.Fatalf("Kỳ vọng parse được 3 segment từ SRT, nhận được %d", len(segs))
	}

	merged := MergeBrokenSegments(segs)
	if len(merged) != 2 {
		t.Fatalf("Kỳ vọng gộp mảnh 2 và 3 chưa kết thúc câu thành 1 câu hoàn chỉnh (tổng 2 câu), nhận được %d", len(merged))
	}
	if merged[0].Text != "Hi, welcome back." {
		t.Errorf("Kỳ vọng lọc sạch tiền tố '-: ', nhận được: %q", merged[0].Text)
	}

	// 3. Kiểm tra thêm trường hợp có file _vi.srt đi kèm (nạp thẳng phụ đề Tiếng Việt + ghép cặp Song ngữ với _en.srt)
	viSrtPath := filepath.Join(tempDir, "001 Introduction_vi.srt")
	viRaw := `1
00:00:00,000 --> 00:00:01,589
Xin chào, chào mừng quay trở lại.

2
00:00:01,589 --> 00:00:05,190
Tôi là Kalyan Reddy Daida và tôi sẽ là giảng viên của bạn

3
00:00:05,190 --> 00:00:09,210
trong khóa học EKS Kubernetes Masterclass này.
`
	_ = os.WriteFile(viSrtPath, []byte(viRaw), 0644)

	foundVi := FindExternalVietnameseSubtitleFile(vidPath)
	if foundVi != viSrtPath {
		t.Fatalf("Kỳ vọng tìm thấy file Tiếng Việt %q, thực tế nhận %q", viSrtPath, foundVi)
	}
	if ResolveVideoFromSubtitlePath(viSrtPath) != vidPath {
		t.Fatalf("Kỳ vọng ánh xạ từ _vi.srt về %q", vidPath)
	}

	bs, err := NewBlockStore(vidPath, CacheMeta{BlockSec: 30, OverlapSec: 2, DurationSec: 30})
	if err != nil {
		t.Fatalf("Lỗi tạo BlockStore: %v", err)
	}
	if !PopulateStoreFromVietnameseSRT(bs, vidPath, 30.0, 30.0, 2.0) {
		t.Fatalf("Kỳ vọng nạp thành công phụ đề từ _vi.srt")
	}
	items := bs.GetAllItemsSorted()
	if len(items) != 3 || !items[0].Translated || items[0].TargetText != "Xin chào, chào mừng quay trở lại." || items[0].SourceText != "Hi, welcome back." {
		t.Errorf("Ghép cặp song ngữ _en.srt + _vi.srt không đúng mong đợi: %+v", items)
	}
}

// Test_BuildSubtitleContent_SRT_And_VTT kiểm tra xuất phụ đề .srt và .vtt ở chế độ Chỉ Tiếng Việt & Song ngữ
func Test_BuildSubtitleContent_SRT_And_VTT(t *testing.T) {
	items := []SubtitleItem{
		{ID: 1, StartSec: 1.5, EndSec: 4.25, SourceText: "Hello world.", TargetText: "Xin chào thế giới.", Translated: true},
	}

	srtVi := BuildSubtitleContent(items, "srt", "target")
	expectedSrtVi := "1\n00:00:01,500 --> 00:00:04,250\nXin chào thế giới.\n\n"
	if srtVi != expectedSrtVi {
		t.Errorf("SRT target sai:\n%q\nkỳ vọng:\n%q", srtVi, expectedSrtVi)
	}

	vttBi := BuildSubtitleContent(items, "vtt", "bilingual")
	expectedVttBi := "WEBVTT\n\n1\n00:00:01.500 --> 00:00:04.250\nHello world.\nXin chào thế giới.\n\n"
	if vttBi != expectedVttBi {
		t.Errorf("VTT bilingual sai:\n%q\nkỳ vọng:\n%q", vttBi, expectedVttBi)
	}
}

// Test_TwoTierLookaheadBatches_And_Metrics kiểm tra chia batch 2 tầng ưu tiên Playhead và tính p50/p95 latency
func Test_TwoTierLookaheadBatches_And_Metrics(t *testing.T) {
	items := []SubtitleItem{
		{ID: 0, StartSec: 1.0, EndSec: 4.0, SourceText: "Past line 1"},
		{ID: 1, StartSec: 5.0, EndSec: 9.0, SourceText: "Past line 2"},
		{ID: 2, StartSec: 16.0, EndSec: 19.0, SourceText: "Playhead priority line 1"},
		{ID: 3, StartSec: 20.0, EndSec: 24.0, SourceText: "Playhead priority line 2"},
		{ID: 4, StartSec: 25.0, EndSec: 29.0, SourceText: "Playhead priority line 3"},
	}

	// Giả sử người dùng vừa tua tới giây thứ 16.0 trong block [0..30s]
	batches, nTier1 := BuildTwoTierBatches(items, 16.0, true)
	if len(batches) != 2 || nTier1 != 1 {
		t.Fatalf("Kỳ vọng 2 batch (Tier 1 trước, Tier 2 sau), nhận được len=%d, nTier1=%d", len(batches), nTier1)
	}
	// Batch đầu tiên phải là các câu tại Playhead (chỉ số 2, 3, 4)
	if len(batches[0]) != 3 || batches[0][0] != 2 || batches[0][1] != 3 || batches[0][2] != 4 {
		t.Errorf("Tier 1 phải ưu tiên dịch câu tại playhead [2, 3, 4] trước, nhận được: %v", batches[0])
	}
	// Batch thứ hai mới quay lại bù các câu đầu block [0, 1]
	if len(batches[1]) != 2 || batches[1][0] != 0 || batches[1][1] != 1 {
		t.Errorf("Tier 2 phải chứa các câu còn lại [0, 1], nhận được: %v", batches[1])
	}

	// Kiểm tra tính toán p50 / p95
	samples := []int64{80, 110, 95, 120, 100, 130, 90, 105, 115, 250}
	p50, p95 := ComputeLatencyPercentiles(samples)
	if p50 != 105 || p95 != 130 {
		t.Errorf("Percentile p50=%d p95=%d không khớp kỳ vọng (105, 130)", p50, p95)
	}
}
