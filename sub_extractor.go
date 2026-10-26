package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var srtTimestampLineRe = regexp.MustCompile(`(\d{1,2}:)?(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})[,.](\d{3})`)
var htmlTagRe = regexp.MustCompile(`<[^>]+>`)

// FindExternalSubtitleFile tìm file phụ đề .srt / .vtt đi kèm cùng tên với file video
func FindExternalSubtitleFile(videoPath string) string {
	dir := filepath.Dir(videoPath)
	ext := filepath.Ext(videoPath)
	base := strings.TrimSuffix(filepath.Base(videoPath), ext)

	candidates := []string{
		base + ".en.srt",
		base + ".eng.srt",
		base + "_en.srt",
		base + ".srt",
		base + ".en.vtt",
		base + ".eng.vtt",
		base + "_en.vtt",
		base + ".vtt",
	}

	for _, name := range candidates {
		full := filepath.Join(dir, name)
		if fi, err := os.Stat(full); err == nil && !fi.IsDir() && fi.Size() > 10 {
			return full
		}
	}
	return ""
}

// LoadExternalSubtitles đọc và phân tích file .srt hoặc .vtt thành danh sách WhisperSegment
func LoadExternalSubtitles(subPath string) ([]WhisperSegment, error) {
	data, err := os.ReadFile(subPath)
	if err != nil {
		return nil, err
	}
	return ParseSRTorVTT(string(data)), nil
}

// ParseSRTorVTT phân tích nội dung định dạng SRT hoặc WebVTT thành danh sách WhisperSegment
func ParseSRTorVTT(content string) []WhisperSegment {
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	normalized = strings.TrimPrefix(normalized, "\xef\xbb\xbf") // UTF-8 BOM

	blocks := strings.Split(normalized, "\n\n")
	var segments []WhisperSegment

	for _, block := range blocks {
		lines := strings.Split(strings.TrimSpace(block), "\n")
		if len(lines) < 2 {
			continue
		}

		timeLineIdx := -1
		var startSec, endSec float64
		for i, line := range lines {
			m := srtTimestampLineRe.FindStringSubmatch(line)
			if m != nil {
				startSec = parseHMSMs(m[1], m[2], m[3], m[4])
				endSec = parseHMSMs(m[5], m[6], m[7], m[8])
				timeLineIdx = i
				break
			}
		}

		if timeLineIdx == -1 || endSec <= startSec {
			continue
		}

		var textParts []string
		for _, l := range lines[timeLineIdx+1:] {
			cleaned := htmlTagRe.ReplaceAllString(l, "")
			cleaned = strings.TrimSpace(cleaned)
			if cleaned != "" {
				textParts = append(textParts, cleaned)
			}
		}

		if len(textParts) == 0 {
			continue
		}

		fullText := strings.Join(textParts, " ")
		if !IsHallucination(fullText, endSec-startSec) {
			segments = append(segments, WhisperSegment{
				StartSec: startSec,
				EndSec:   endSec,
				Text:     fullText,
			})
		}
	}

	return segments
}

func parseHMSMs(hStr, mStr, sStr, msStr string) float64 {
	var h int
	if hStr != "" {
		h, _ = strconv.Atoi(strings.TrimSuffix(hStr, ":"))
	}
	m, _ := strconv.Atoi(mStr)
	s, _ := strconv.Atoi(sStr)
	ms, _ := strconv.Atoi(msStr)
	return float64(h)*3600.0 + float64(m)*60.0 + float64(s) + float64(ms)/1000.0
}
