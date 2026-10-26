package main

import (
	"testing"
)

// Test_BlockOverlapAndOwnershipMath kiểm tra tính đúng đắn của việc chia block có chồng lấn
func Test_BlockOverlapAndOwnershipMath(t *testing.T) {
	totalDuration := 100.0
	blockSec := 30.0
	overlapSec := 2.0

	// Block 0: khoảng sở hữu [0, 30), cắt audio [0, 32]
	b0 := ComputeBlockRange(0, blockSec, overlapSec, totalDuration)
	if b0.OwnerStart != 0 || b0.OwnerEnd != 30 {
		t.Fatalf("Block 0 khoảng sở hữu sai: [%v, %v)", b0.OwnerStart, b0.OwnerEnd)
	}
	if b0.ExtractStart != 0 || b0.ExtractEnd != 32 {
		t.Fatalf("Block 0 khoảng cắt sai: [%v, %v)", b0.ExtractStart, b0.ExtractEnd)
	}

	// Block 1: khoảng sở hữu [30, 60), cắt audio [28, 62]
	b1 := ComputeBlockRange(1, blockSec, overlapSec, totalDuration)
	if b1.OwnerStart != 30 || b1.OwnerEnd != 60 {
		t.Fatalf("Block 1 khoảng sở hữu sai: [%v, %v)", b1.OwnerStart, b1.OwnerEnd)
	}
	if b1.ExtractStart != 28 || b1.ExtractEnd != 62 {
		t.Fatalf("Block 1 khoảng cắt sai: [%v, %v)", b1.ExtractStart, b1.ExtractEnd)
	}

	// Block 3 (block cuối cùng, duration 100s): khoảng sở hữu [90, 100), cắt audio [88, 100]
	b3 := ComputeBlockRange(3, blockSec, overlapSec, totalDuration)
	if b3.OwnerStart != 90 || b3.OwnerEnd != 100 {
		t.Fatalf("Block 3 khoảng sở hữu sai: [%v, %v)", b3.OwnerStart, b3.OwnerEnd)
	}
	if b3.ExtractStart != 88 || b3.ExtractEnd != 100 {
		t.Fatalf("Block 3 khoảng cắt sai: [%v, %v)", b3.ExtractStart, b3.ExtractEnd)
	}
}

// Test_MidpointOwnershipRule kiểm tra quy tắc điểm giữa (midpoint) triệt tiêu trùng lặp và nuốt câu
func Test_MidpointOwnershipRule(t *testing.T) {
	ownerStart := 30.0
	ownerEnd := 60.0

	// 1. Câu nằm trọn vẹn trong block: [35, 40] -> midpoint = 37.5 -> thuộc block
	if !SegmentBelongsToBlock(35.0, 40.0, ownerStart, ownerEnd) {
		t.Errorf("Câu [35, 40] phải thuộc block")
	}

	// 2. Câu nằm vắt ngang mép trái: [28.5, 32.5] -> midpoint = 30.5 -> thuộc block này (không thuộc block trước)
	if !SegmentBelongsToBlock(28.5, 32.5, ownerStart, ownerEnd) {
		t.Errorf("Câu [28.5, 32.5] có midpoint 30.5 phải thuộc block này")
	}

	// 3. Câu nằm vắt ngang mép trái nhưng phần lớn thuộc block trước: [27.0, 31.0] -> midpoint = 29.0 -> KHÔNG thuộc block này
	if SegmentBelongsToBlock(27.0, 31.0, ownerStart, ownerEnd) {
		t.Errorf("Câu [27.0, 31.0] có midpoint 29.0 không được thuộc block này")
	}

	// 4. Câu nằm vắt ngang mép phải: [58.0, 62.0] -> midpoint = 60.0 -> KHÔNG thuộc block [30, 60) vì [ownerStart, ownerEnd) là nửa mở bên phải
	if SegmentBelongsToBlock(58.0, 62.0, ownerStart, ownerEnd) {
		t.Errorf("Câu [58.0, 62.0] có midpoint 60.0 phải thuộc block kế tiếp [60, 90)")
	}
}

// Test_WhisperHallucinationFilter kiểm tra lọc bỏ các ảo giác phổ biến khi im lặng
func Test_WhisperHallucinationFilter(t *testing.T) {
	cases := []struct {
		text     string
		duration float64
		expected bool
	}{
		{"[BLANK_AUDIO]", 5.0, true},
		{"(music)", 2.0, true},
		{"♪", 1.0, true},
		{"   ", 0.5, true},
		{"Thank you for watching.", 2.0, true},
		{"Thank you for watching this full lecture and tutorial.", 10.0, false}, // Câu dài thực sự không phải ảo giác
		{"This is an actual conversation line.", 2.5, false},
	}

	for _, c := range cases {
		actual := IsHallucination(c.text, c.duration)
		if actual != c.expected {
			t.Errorf("IsHallucination(%q, %v) = %v, kỳ vọng %v", c.text, c.duration, actual, c.expected)
		}
	}
}

// Test_SplitLongSegments kiểm tra tách câu dài theo dấu câu và chia tỷ lệ thời gian
func Test_SplitLongSegments(t *testing.T) {
	longSeg := WhisperSegment{
		StartSec: 10.0,
		EndSec:   20.0, // 10s (> 7s)
		Text:     "First part of sentence. Second part of sentence.",
	}

	splits := SplitLongSegmentIfNeeded(longSeg)
	if len(splits) != 2 {
		t.Fatalf("Kỳ vọng tách làm 2 đoạn, thực tế nhận được %d", len(splits))
	}

	if splits[0].StartSec != 10.0 {
		t.Errorf("StartSec đoạn 1 sai: %v", splits[0].StartSec)
	}
	if splits[1].EndSec != 20.0 {
		t.Errorf("EndSec đoạn 2 sai: %v", splits[1].EndSec)
	}
	if splits[0].EndSec != splits[1].StartSec {
		t.Errorf("Hai đoạn không khớp thời gian liên tục: %v vs %v", splits[0].EndSec, splits[1].StartSec)
	}
}

// Test_CleanLLMOutput kiểm tra lọc token ChatML và chuẩn hóa output bản dịch
func Test_CleanLLMOutput(t *testing.T) {
	cases := []struct {
		raw      string
		source   string
		expected string
	}{
		{
			raw:      "<|im_start|>assistant\nXin chào các bạn.<|im_end|>",
			source:   "Hello everyone.",
			expected: "Xin chào các bạn.",
		},
		{
			raw:      `"Tôi hiểu rồi."`,
			source:   "I got it.",
			expected: "Tôi hiểu rồi.",
		},
		{
			// Output dài bất thường (lặp hoặc bịa)
			raw:      "Một chuỗi dài bất thường lặp đi lặp lại rất nhiều lần không kiểm soát được Một chuỗi dài bất thường lặp đi lặp lại rất nhiều lần",
			source:   "Hi",
			expected: "",
		},
	}

	for _, c := range cases {
		actual := CleanLLMOutput(c.raw, c.source)
		if actual != c.expected {
			t.Errorf("CleanLLMOutput(%q) = %q, kỳ vọng %q", c.raw, actual, c.expected)
		}
	}
}
