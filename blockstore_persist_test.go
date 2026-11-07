package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func setupBug14(t testing.TB, minutes int) (*BlockStore, string, float64) {
	t.Helper()
	if tt, ok := t.(*testing.T); ok {
		tt.Setenv("LOCALAPPDATA", tt.TempDir())
	}
	dir := t.TempDir()
	vid := filepath.Join(dir, "lesson.mp4")
	_ = os.WriteFile(vid, make([]byte, 2048), 0644)
	dur := float64(minutes * 60)
	var sb strings.Builder
	n := minutes * 60 / 5
	ts := func(sec int) string { return fmt.Sprintf("%02d:%02d:%02d,000", sec/3600, sec%3600/60, sec%60) }
	for i := 0; i < n; i++ {
		fmt.Fprintf(&sb, "%d\n%s --> %s\nCâu số %d\n\n", i+1, ts(i*5), ts(i*5+4), i)
	}
	_ = os.WriteFile(filepath.Join(dir, "lesson_vi.srt"), []byte(sb.String()), 0644)
	bs, err := NewBlockStore(vid, CacheMeta{BlockSec: 30, OverlapSec: 2, DurationSec: dur})
	if err != nil {
		t.Fatal(err)
	}
	return bs, vid, dur
}

func Test_BUG14_Populate_RAMImmediate_DiskEventually(t *testing.T) {
	bs, vid, dur := setupBug14(t, 60)
	if !PopulateStoreFromVietnameseSRT(bs, vid, dur, 30, 2) {
		t.Fatal("Populate trả về false")
	}
	// Ngay sau khi hàm trả về: RAM phải đủ dữ liệu
	if got := len(bs.GetDoneBlocks()); got != 120 {
		t.Fatalf("RAM: %d block done, want 120", got)
	}
	if got := len(bs.GetAllItemsSorted()); got != 720 {
		t.Fatalf("RAM: %d câu, want 720", got)
	}
	bs.WaitPersist()
	files, _ := filepath.Glob(filepath.Join(bs.blocksDir, "*.json"))
	if len(files) != 120 {
		t.Fatalf("đĩa: %d file, want 120", len(files))
	}
	if tmp, _ := filepath.Glob(filepath.Join(bs.blocksDir, "*.tmp")); len(tmp) != 0 {
		t.Fatalf("còn file .tmp: %v", tmp)
	}
	// Nạp lại từ đĩa cho cùng kết quả
	bs2, err := NewBlockStore(vid, CacheMeta{BlockSec: 30, OverlapSec: 2, DurationSec: dur})
	if err != nil {
		t.Fatal(err)
	}
	if got := len(bs2.GetAllItemsSorted()); got != 720 {
		t.Fatalf("nạp lại từ đĩa: %d câu, want 720", got)
	}
}

// Ghi nền không được đè lên dữ liệu mới hơn do SaveBlock ghi chen vào.
func Test_BUG14_BackgroundFlush_DoesNotClobberNewerSaveBlock(t *testing.T) {
	bs, vid, dur := setupBug14(t, 60)
	PopulateStoreFromVietnameseSRT(bs, vid, dur, 30, 2)
	newer := []SubtitleItem{{ID: 7, Block: 3, StartSec: 91, EndSec: 92, SourceText: "x", TargetText: "MỚI", Translated: true}}
	if err := bs.SaveBlock(3, newer); err != nil {
		t.Fatal(err)
	}
	bs.WaitPersist()
	bs2, _ := NewBlockStore(vid, CacheMeta{BlockSec: 30, OverlapSec: 2, DurationSec: dur})
	items, _ := bs2.itemsMap[3], 0
	if len(items) != 1 || items[0].TargetText != "MỚI" {
		t.Fatalf("block 3 trên đĩa bị ghi đè bởi bản cũ: %+v", items)
	}
}

func Test_BUG14_Race(t *testing.T) {
	bs, vid, dur := setupBug14(t, 20)
	PopulateStoreFromVietnameseSRT(bs, vid, dur, 30, 2)
	for i := 0; i < 40; i++ {
		_ = bs.SaveBlock(i, []SubtitleItem{{ID: int64(i), Block: i, TargetText: "a", Translated: true}})
		_ = bs.GetDoneBlocks()
	}
	bs.WaitPersist()
}

func benchPopulate(b *testing.B, wait bool) {
	for i := 0; i < b.N; i++ {
		b.StopTimer()
		bs, vid, dur := setupBug14(b, 60)
		b.StartTimer()
		t0 := time.Now()
		PopulateStoreFromVietnameseSRT(bs, vid, dur, 30, 2)
		if wait {
			bs.WaitPersist()
		}
		_ = t0
		b.StopTimer()
		bs.WaitPersist()
		b.StartTimer()
	}
}
func Benchmark_BUG14_ReturnLatency(b *testing.B) { benchPopulate(b, false) }
func Benchmark_BUG14_FullPersist(b *testing.B)   { benchPopulate(b, true) }
