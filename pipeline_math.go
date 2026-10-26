package main

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
)

// BlockRange định nghĩa khoảng sở hữu và khoảng audio cắt của một block
type BlockRange struct {
	Index        int
	OwnerStart   float64
	OwnerEnd     float64
	ExtractStart float64
	ExtractEnd   float64
	ExtractLen   float64
}

// ComputeBlockRange tính toán chính xác khoảng sở hữu và khoảng trích xuất audio có overlap
func ComputeBlockRange(blockIdx int, blockSec, overlapSec, totalDuration float64) BlockRange {
	ownerStart := float64(blockIdx) * blockSec
	ownerEnd := ownerStart + blockSec
	if ownerEnd > totalDuration {
		ownerEnd = totalDuration
	}

	extractStart := ownerStart - overlapSec
	if extractStart < 0 {
		extractStart = 0
	}

	extractEnd := ownerEnd + overlapSec
	if extractEnd > totalDuration {
		extractEnd = totalDuration
	}

	extractLen := extractEnd - extractStart
	if extractLen < 0 {
		extractLen = 0
	}

	return BlockRange{
		Index:        blockIdx,
		OwnerStart:   ownerStart,
		OwnerEnd:     ownerEnd,
		ExtractStart: extractStart,
		ExtractEnd:   extractEnd,
		ExtractLen:   extractLen,
	}
}

// SegmentBelongsToBlock kiểm tra quy tắc điểm giữa: (start+end)/2 nằm trong [ownerStart, ownerEnd)
func SegmentBelongsToBlock(startSec, endSec, ownerStart, ownerEnd float64) bool {
	midpoint := (startSec + endSec) / 2.0
	return midpoint >= ownerStart && midpoint < ownerEnd
}

// WhisperSegment là cấu trúc một đoạn thoại thô từ Whisper
type WhisperSegment struct {
	StartSec float64
	EndSec   float64
	Text     string
}

// WhisperJSONOutput định dạng JSON tiêu chuẩn khi whisper-cli xuất ra (-oj)
type WhisperJSONOutput struct {
	Transcription []struct {
		Offsets struct {
			From int64 `json:"from"` // milliseconds
			To   int64 `json:"to"`   // milliseconds
		} `json:"offsets"`
		Text string `json:"text"`
	} `json:"transcription"`
}

var commonHallucinations = []string{
	"thank you for watching",
	"thanks for watching",
	"thank you",
	"subtitles by",
	"subtitled by",
	"subscribe",
	"like and subscribe",
	"see you next time",
	"bye",
}

// IsHallucination kiểm tra xem đoạn text có phải là ảo giác phổ biến của Whisper không
func IsHallucination(text string, duration float64) bool {
	cleaned := strings.ToLower(strings.TrimSpace(text))
	cleaned = strings.Trim(cleaned, `.,!?:;'"[]()♪-`)

	if cleaned == "" || cleaned == "[blank_audio]" || cleaned == "(music)" || cleaned == "music" {
		return true
	}

	// Nếu câu thoại quá ngắn hoặc nằm trong danh sách câu ảo giác khi im lặng
	for _, h := range commonHallucinations {
		if cleaned == h {
			// Thường xuất hiện ở các đoạn âm thanh im lặng (hoặc rất ngắn < 3s)
			if duration <= 3.5 {
				return true
			}
		}
	}

	return false
}

// ParseWhisperJSON phân tích chuỗi JSON trả về từ whisper-cli
func ParseWhisperJSON(jsonData []byte, extractStart float64) ([]WhisperSegment, error) {
	var parsed WhisperJSONOutput
	if err := json.Unmarshal(jsonData, &parsed); err != nil {
		return nil, fmt.Errorf("không thể parse JSON từ whisper: %w", err)
	}

	var segments []WhisperSegment
	for _, item := range parsed.Transcription {
		start := extractStart + float64(item.Offsets.From)/1000.0
		end := extractStart + float64(item.Offsets.To)/1000.0
		text := strings.TrimSpace(item.Text)

		if text != "" {
			segments = append(segments, WhisperSegment{
				StartSec: start,
				EndSec:   end,
				Text:     text,
			})
		}
	}

	return segments, nil
}

// FilterAndDeduplicateSegments áp dụng quy tắc điểm giữa, loại bỏ ảo giác và trùng lặp
func FilterAndDeduplicateSegments(raw []WhisperSegment, bRange BlockRange) []WhisperSegment {
	var filtered []WhisperSegment
	var lastText string
	repeatCount := 0

	for _, seg := range raw {
		// 1. Kiểm tra quy tắc điểm giữa nằm trong vùng sở hữu của block
		if !SegmentBelongsToBlock(seg.StartSec, seg.EndSec, bRange.OwnerStart, bRange.OwnerEnd) {
			continue
		}

		dur := seg.EndSec - seg.StartSec
		// 2. Lọc câu ảo giác
		if IsHallucination(seg.Text, dur) {
			continue
		}

		// 3. Lọc segment lặp y hệt nhau quá 2 lần
		cleanedText := strings.ToLower(strings.TrimSpace(seg.Text))
		if cleanedText == lastText {
			repeatCount++
			if repeatCount >= 2 {
				continue
			}
		} else {
			lastText = cleanedText
			repeatCount = 0
		}

		// 4. Tách các câu dài (> 7 giây hoặc > 84 ký tự)
		splitSegments := SplitLongSegmentIfNeeded(seg)
		filtered = append(filtered, splitSegments...)
	}

	return filtered
}

// SplitLongSegmentIfNeeded tách câu dài theo dấu câu và chia tỷ lệ thời gian
func SplitLongSegmentIfNeeded(seg WhisperSegment) []WhisperSegment {
	dur := seg.EndSec - seg.StartSec
	text := strings.TrimSpace(seg.Text)

	if dur <= 7.0 && len(text) <= 84 {
		return []WhisperSegment{seg}
	}

	// Tách theo dấu câu: . , ? ! ;
	re := regexp.MustCompile(`([.,?!;]+)`)
	parts := re.Split(text, -1)
	matches := re.FindAllString(text, -1)

	var sentences []string
	for i, part := range parts {
		p := strings.TrimSpace(part)
		if p == "" {
			continue
		}
		if i < len(matches) {
			sentences = append(sentences, p+matches[i])
		} else {
			sentences = append(sentences, p)
		}
	}

	if len(sentences) <= 1 {
		return []WhisperSegment{seg}
	}

	// Tính tổng ký tự để chia đều theo tỷ lệ
	totalChars := 0
	for _, s := range sentences {
		totalChars += len(s)
	}

	if totalChars == 0 {
		return []WhisperSegment{seg}
	}

	var result []WhisperSegment
	curStart := seg.StartSec
	for _, s := range sentences {
		fraction := float64(len(s)) / float64(totalChars)
		segDur := dur * fraction
		curEnd := curStart + segDur

		result = append(result, WhisperSegment{
			StartSec: math.Round(curStart*100) / 100,
			EndSec:   math.Round(curEnd*100) / 100,
			Text:     strings.TrimSpace(s),
		})
		curStart = curEnd
	}

	return result
}
