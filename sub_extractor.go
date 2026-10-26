package main

import (
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var srtTimestampLineRe = regexp.MustCompile(`(\d{1,2}:)?(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})[,.](\d{3})`)
var htmlTagRe = regexp.MustCompile(`<[^>]+>`)

// FindExternalSubtitleFile tìm file phụ đề .srt / .vtt đi kèm cùng tên với file video (hỗ trợ _en.srt, .en.srt, -en.srt, .srt...)
func FindExternalSubtitleFile(videoPath string) string {
	dir := filepath.Dir(videoPath)
	ext := filepath.Ext(videoPath)
	base := strings.TrimSuffix(filepath.Base(videoPath), ext)

	candidates := []string{
		base + "_en.srt",
		base + ".en.srt",
		base + "_eng.srt",
		base + ".eng.srt",
		base + "-en.srt",
		base + "_en_US.srt",
		base + ".en_US.srt",
		base + ".srt",
		base + "_en.vtt",
		base + ".en.vtt",
		base + "_eng.vtt",
		base + ".eng.vtt",
		base + "-en.vtt",
		base + ".vtt",
	}

	for _, name := range candidates {
		full := filepath.Join(dir, name)
		if fi, err := os.Stat(full); err == nil && !fi.IsDir() && fi.Size() > 10 {
			return full
		}
	}

	// Quét thư mục để bắt mọi biến thể hoa/thường như _EN.srt, [English].srt (bỏ qua file .vi.srt / .bilingual.srt đã xuất)
	entries, err := os.ReadDir(dir)
	if err == nil {
		lowerBase := strings.ToLower(base)
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			lowerName := strings.ToLower(e.Name())
			if !strings.HasSuffix(lowerName, ".srt") && !strings.HasSuffix(lowerName, ".vtt") {
				continue
			}
			if strings.Contains(lowerName, ".vi.") || strings.Contains(lowerName, "_vi.") || strings.Contains(lowerName, "-vi.") ||
				strings.Contains(lowerName, ".vn.") || strings.Contains(lowerName, "_vn.") || strings.Contains(lowerName, "-vn.") ||
				strings.Contains(lowerName, ".vie.") || strings.Contains(lowerName, "_vie.") || strings.Contains(lowerName, ".bilingual.") {
				continue
			}
			if strings.HasPrefix(lowerName, lowerBase) {
				full := filepath.Join(dir, e.Name())
				if fi, statErr := os.Stat(full); statErr == nil && fi.Size() > 10 {
					return full
				}
			}
		}
	}

	return ""
}

// FindExternalVietnameseSubtitleFile tìm file phụ đề Tiếng Việt đi kèm (_vi.srt, .vi.srt, _vn.srt, .vn.srt, -vi.srt, _vie.srt...)
func FindExternalVietnameseSubtitleFile(videoPath string) string {
	dir := filepath.Dir(videoPath)
	ext := filepath.Ext(videoPath)
	base := strings.TrimSuffix(filepath.Base(videoPath), ext)

	candidates := []string{
		base + "_vi.srt",
		base + ".vi.srt",
		base + "-vi.srt",
		base + "_vn.srt",
		base + ".vn.srt",
		base + "-vn.srt",
		base + "_vie.srt",
		base + ".vie.srt",
		base + "_vi.vtt",
		base + ".vi.vtt",
		base + "-vi.vtt",
		base + "_vn.vtt",
		base + ".vn.vtt",
		base + "_vie.vtt",
		base + ".vie.vtt",
	}

	for _, name := range candidates {
		full := filepath.Join(dir, name)
		if fi, err := os.Stat(full); err == nil && !fi.IsDir() && fi.Size() > 10 {
			return full
		}
	}

	entries, err := os.ReadDir(dir)
	if err == nil {
		lowerBase := strings.ToLower(base)
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			lowerName := strings.ToLower(e.Name())
			if !strings.HasSuffix(lowerName, ".srt") && !strings.HasSuffix(lowerName, ".vtt") {
				continue
			}
			if !strings.HasPrefix(lowerName, lowerBase) {
				continue
			}
			if strings.Contains(lowerName, "_vi.") || strings.Contains(lowerName, ".vi.") || strings.Contains(lowerName, "-vi.") ||
				strings.Contains(lowerName, "_vn.") || strings.Contains(lowerName, ".vn.") || strings.Contains(lowerName, "-vn.") ||
				strings.Contains(lowerName, "_vie.") || strings.Contains(lowerName, ".vie.") {
				full := filepath.Join(dir, e.Name())
				if fi, statErr := os.Stat(full); statErr == nil && fi.Size() > 10 {
					return full
				}
			}
		}
	}

	return ""
}

// PopulateStoreFromVietnameseSRT nạp thẳng phụ đề Tiếng Việt (_vi.srt) và ghép cặp với (_en.srt nếu có) vào BlockStore mà không cần dịch lại
func PopulateStoreFromVietnameseSRT(bs *BlockStore, videoPath string, durationSec, blockSec, overlapSec float64) bool {
	viPath := FindExternalVietnameseSubtitleFile(videoPath)
	if viPath == "" || bs == nil {
		return false
	}

	viSegs, err := LoadExternalSubtitles(viPath)
	if err != nil || len(viSegs) == 0 {
		return false
	}

	var enSegs []WhisperSegment
	if enPath := FindExternalSubtitleFile(videoPath); enPath != "" {
		enSegs, _ = LoadExternalSubtitles(enPath)
	}

	if blockSec <= 0 {
		blockSec = 30.0
	}
	if overlapSec <= 0 {
		overlapSec = 2.0
	}
	totalBlocks := int(math.Ceil(durationSec / blockSec))
	if totalBlocks <= 0 {
		totalBlocks = 1
	}

	for b := 0; b < totalBlocks; b++ {
		if bs.IsBlockDone(b) {
			continue
		}
		bRange := ComputeBlockRange(b, blockSec, overlapSec, durationSec)
		var items []SubtitleItem
		seq := 0
		for i, vSeg := range viSegs {
			if !SegmentBelongsToBlock(vSeg.StartSec, vSeg.EndSec, bRange.OwnerStart, bRange.OwnerEnd) {
				continue
			}
			vText := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(vSeg.Text), "-: "))
			vText = strings.TrimSpace(strings.TrimPrefix(vText, "- "))
			if vText == "" {
				continue
			}

			// Tìm câu tiếng Anh khớp mốc thời gian (nếu có file _en.srt đi kèm)
			srcText := ""
			if i < len(enSegs) && math.Abs(enSegs[i].StartSec-vSeg.StartSec) <= 1.5 {
				srcText = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(enSegs[i].Text), "-: "))
				srcText = strings.TrimSpace(strings.TrimPrefix(srcText, "- "))
			} else if len(enSegs) > 0 {
				vMid := (vSeg.StartSec + vSeg.EndSec) / 2.0
				for _, eSeg := range enSegs {
					if vMid >= eSeg.StartSec-0.5 && vMid <= eSeg.EndSec+0.5 {
						srcText = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(eSeg.Text), "-: "))
						srcText = strings.TrimSpace(strings.TrimPrefix(srcText, "- "))
						break
					}
				}
			}

			items = append(items, SubtitleItem{
				ID:         int64(b)*1000 + int64(seq),
				Block:      b,
				StartSec:   vSeg.StartSec,
				EndSec:     vSeg.EndSec,
				SourceText: srcText,
				TargetText: vText,
				Translated: true,
			})
			seq++
		}
		_ = bs.SaveBlock(b, items)
	}

	return true
}

// ResolveVideoFromSubtitlePath tìm file video .mp4/.mkv tương ứng nếu người dùng chọn/kéo thả file _en.srt hoặc _vi.srt
func ResolveVideoFromSubtitlePath(subOrVideoPath string) string {
	lower := strings.ToLower(subOrVideoPath)
	if !strings.HasSuffix(lower, ".srt") && !strings.HasSuffix(lower, ".vtt") {
		return subOrVideoPath
	}

	dir := filepath.Dir(subOrVideoPath)
	base := filepath.Base(subOrVideoPath)
	// Cắt bỏ các hậu tố phổ biến của file phụ đề cả tiếng Anh và tiếng Việt: _en.srt, _vi.srt, .vi.srt, _vn.srt...
	suffixes := []string{
		"_en_us.srt", ".en_us.srt", "_en.srt", ".en.srt", "_eng.srt", ".eng.srt", "-en.srt",
		"_vi.srt", ".vi.srt", "-vi.srt", "_vn.srt", ".vn.srt", "-vn.srt", "_vie.srt", ".vie.srt", ".bilingual.srt", ".srt",
		"_en.vtt", ".en.vtt", "_eng.vtt", ".eng.vtt", "-en.vtt",
		"_vi.vtt", ".vi.vtt", "-vi.vtt", "_vn.vtt", ".vn.vtt", "_vie.vtt", ".vie.vtt", ".bilingual.vtt", ".vtt",
	}
	for _, suffix := range suffixes {
		if strings.HasSuffix(strings.ToLower(base), suffix) {
			base = base[:len(base)-len(suffix)]
			break
		}
	}

	for _, vExt := range []string{".mp4", ".mkv", ".webm", ".avi", ".mov"} {
		candidate := filepath.Join(dir, base+vExt)
		if fi, err := os.Stat(candidate); err == nil && !fi.IsDir() {
			return candidate
		}
	}
	return subOrVideoPath
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
