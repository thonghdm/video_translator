package main

import (
	"path/filepath"
	"strings"
)

// subCandidate là một file phụ đề (.srt/.vtt) tìm thấy cùng thư mục Drive với video.
type subCandidate struct{ ID, Name string }

// subtitleMatch là kết quả ghép phụ đề cho một video: bản gốc (tiếng Anh) và bản tiếng Việt đã dịch sẵn.
type subtitleMatch struct {
	EnID, EnName string
	ViID, ViName string
}

var (
	enSubLang = map[string]bool{"en": true, "eng": true, "en_us": true, "en-us": true, "english": true}
	viSubLang = map[string]bool{"vi": true, "vn": true, "vie": true, "vietnamese": true}
)

// classifySubtitle chấm điểm một file phụ đề so với video (cả hai đã hạ chữ thường, bỏ đuôi).
// Trả về ("en"|"vi", điểm); điểm 0 = không liên quan.
//   - trùng tên hoàn toàn           → nguồn, 30
//   - tên video + hậu tố en/eng/... → nguồn, 40
//   - tên video + hậu tố vi/vn/...  → tiếng Việt, 40
//   - tên video + hậu tố khác       → nguồn, 10
func classifySubtitle(vstem, sstem string) (kind string, score int) {
	if sstem == vstem {
		return "en", 30
	}
	if !strings.HasPrefix(sstem, vstem) || len(sstem) <= len(vstem) {
		return "", 0
	}
	rest := sstem[len(vstem):]
	if !strings.ContainsRune("._- ", rune(rest[0])) {
		return "", 0
	}
	lang := strings.TrimLeft(rest, "._- ")
	switch {
	case enSubLang[lang]:
		return "en", 40
	case viSubLang[lang]:
		return "vi", 40
	default:
		return "en", 10
	}
}

// matchSubtitles chọn phụ đề gốc và phụ đề tiếng Việt tốt nhất cho video (.srt được ưu tiên hơn .vtt).
func matchSubtitles(videoName string, subs []subCandidate) subtitleMatch {
	vstem := strings.ToLower(strings.TrimSuffix(videoName, filepath.Ext(videoName)))
	var m subtitleMatch
	bestEn, bestVi := 0, 0
	for _, s := range subs {
		sl := strings.ToLower(s.Name)
		isSRT := strings.HasSuffix(sl, ".srt")
		sstem := strings.TrimSuffix(strings.TrimSuffix(sl, ".srt"), ".vtt")

		kind, score := classifySubtitle(vstem, sstem)
		if score == 0 {
			continue
		}
		if isSRT {
			score++
		}
		switch kind {
		case "en":
			if score > bestEn {
				bestEn, m.EnID, m.EnName = score, s.ID, s.Name
			}
		case "vi":
			if score > bestVi {
				bestVi, m.ViID, m.ViName = score, s.ID, s.Name
			}
		}
	}
	return m
}
