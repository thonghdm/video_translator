package main

import "testing"

func TestMatchSubtitles(t *testing.T) {
	video := "002 The Definition of Cloud Computing.mp4"
	subs := []subCandidate{
		{"vi1", "002 The Definition of Cloud Computing_vi.srt"},
		{"en1", "002 The Definition of Cloud Computing_en.srt"},
		{"other", "003 Security in the AWS Cloud_en.srt"},
	}
	m := matchSubtitles(video, subs)
	if m.EnID != "en1" || m.ViID != "vi1" {
		t.Fatalf("ghép sai: %+v", m)
	}
}

func TestMatchSubtitles_Variants(t *testing.T) {
	cases := []struct {
		name           string
		video          string
		subs           []subCandidate
		wantEn, wantVi string
	}{
		{"chỉ có en", "a.mp4", []subCandidate{{"e", "a_en.srt"}}, "e", ""},
		{"chỉ có vi", "a.mp4", []subCandidate{{"v", "a.vi.srt"}}, "", "v"},
		{"không phân biệt hoa thường", "Lesson One.MP4", []subCandidate{{"e", "lesson one_EN.SRT"}, {"v", "LESSON ONE-VN.srt"}}, "e", "v"},
		{"trùng tên hoàn toàn là nguồn", "a.mp4", []subCandidate{{"e", "a.srt"}}, "e", ""},
		{"hậu tố khác là nguồn điểm thấp, en thắng", "a.mp4", []subCandidate{{"x", "a_cc.srt"}, {"e", "a_en.srt"}}, "e", ""},
		{"srt ưu tiên hơn vtt", "a.mp4", []subCandidate{{"t", "a_en.vtt"}, {"s", "a_en.srt"}}, "s", ""},
		{"vi: srt ưu tiên hơn vtt", "a.mp4", []subCandidate{{"t", "a_vi.vtt"}, {"s", "a_vi.srt"}}, "", "s"},
		{"tên video là tiền tố của video khác không bị nhầm", "a.mp4", []subCandidate{{"e", "ab_en.srt"}}, "", ""},
		{"tiếng Việt đủ chữ", "a.mp4", []subCandidate{{"v", "a_vietnamese.srt"}}, "", "v"},
		{"không có phụ đề", "a.mp4", nil, "", ""},
	}
	for _, c := range cases {
		m := matchSubtitles(c.video, c.subs)
		if m.EnID != c.wantEn || m.ViID != c.wantVi {
			t.Errorf("%s: got en=%q vi=%q, want en=%q vi=%q", c.name, m.EnID, m.ViID, c.wantEn, c.wantVi)
		}
	}
}
