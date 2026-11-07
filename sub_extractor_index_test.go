package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// BUG-10: index trong RAM phải cho cùng kết quả bool với hai hàm Find* cũ trên mọi tổ hợp tên file.
func Test_BUG10_SubtitleIndex_EquivalentToFindExternal(t *testing.T) {
	dir := t.TempDir()
	big := make([]byte, 64)
	small := []byte("x")
	files := map[string][]byte{
		"a.mp4": nil, "a_en.srt": big, "b.mp4": nil, "b.srt": big, "c.mp4": nil, "c.vi.srt": big,
		"d.mp4": nil, "d.bilingual.srt": big, "e.mp4": nil, "e_en.srt": small, "f.mp4": nil,
		"g.mp4": nil, "G.EN.SRT": big, "h.mp4": nil, "h_vn.vtt": big, "i.mp4": nil, "i-en.vtt": big,
		"Bài 1.mp4": nil, "Bài 1 [English].srt": big, "j.mp4": nil, "j2_en.srt": big, "k.mp4": nil,
		"k.txt": big, "l.mp4": nil, "l.vie.srt": small, "m.mp4": nil, "m.en.srt.bak": big,
	}
	for n, c := range files {
		if err := os.WriteFile(filepath.Join(dir, n), c, 0644); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.Mkdir(filepath.Join(dir, "n_en.srt"), 0755) // thư mục trùng tên: phải bị bỏ qua
	entries, _ := os.ReadDir(dir)
	idx := newExternalSubtitleIndex(dir, entries)
	for n := range files {
		if filepath.Ext(n) != ".mp4" {
			continue
		}
		full := filepath.Join(dir, n)
		want := FindExternalSubtitleFile(full) != "" || FindExternalVietnameseSubtitleFile(full) != ""
		if got := idx.HasExternalSubtitle(n); got != want {
			t.Errorf("%s: index=%v, hàm cũ=%v", n, got, want)
		}
	}
}

// Đo số file/thư mục lớn: kết quả để so sánh (chạy với -run Bench hoặc strace).
func Benchmark_BUG10_Old(b *testing.B) { benchScan(b, false) }
func Benchmark_BUG10_New(b *testing.B) { benchScan(b, true) }

func benchScan(b *testing.B, useIndex bool) {
	dir := b.TempDir()
	var names []string
	for i := 0; i < 300; i++ {
		n := fmt.Sprintf("Bài %03d.mp4", i)
		names = append(names, n)
		_ = os.WriteFile(filepath.Join(dir, n), nil, 0644)
		if i%2 == 0 {
			_ = os.WriteFile(filepath.Join(dir, fmt.Sprintf("Bài %03d_en.srt", i)), make([]byte, 64), 0644)
		}
	}
	b.ResetTimer()
	for it := 0; it < b.N; it++ {
		entries, _ := os.ReadDir(dir)
		if useIndex {
			idx := newExternalSubtitleIndex(dir, entries)
			for _, n := range names {
				_ = idx.HasExternalSubtitle(n)
			}
		} else {
			for _, n := range names {
				full := filepath.Join(dir, n)
				_ = FindExternalSubtitleFile(full) != "" || FindExternalVietnameseSubtitleFile(full) != ""
			}
		}
	}
}
