package main

import (
	"fmt"
	"runtime"
	"testing"
)

func mkSegs(n int) []WhisperSegment {
	s := make([]WhisperSegment, n)
	for i := range s {
		s[i] = WhisperSegment{StartSec: float64(i), EndSec: float64(i) + 1, Text: fmt.Sprintf("Dòng phụ đề số %d của video", i)}
	}
	return s
}

func Test_BUG19_SegmentLRU_EvictsOldest(t *testing.T) {
	c := newSegmentLRU(3)
	for _, id := range []string{"a", "b", "c", "d"} {
		c.Put(id, mkSegs(2))
	}
	if c.Len() != 3 || c.Get("a") != nil || c.Get("d") == nil {
		t.Fatalf("a phải bị loại, len=%d", c.Len())
	}
	c.Put("b", mkSegs(5)) // b thành mới nhất; thêm e → loại c
	c.Put("e", mkSegs(1))
	if c.Get("c") != nil || len(c.Get("b")) != 5 || c.Get("d") == nil || c.Get("e") == nil {
		t.Fatalf("thứ tự LRU sai: order=%v", c.order)
	}
	c.Delete("d")
	if c.Len() != 2 || len(c.order) != 2 {
		t.Fatalf("Delete không dọn order: %v", c.order)
	}
	c.Delete("zzz")
	c.Clear()
	if c.Len() != 0 || len(c.order) != 0 {
		t.Fatalf("Clear lỗi")
	}
}

func heapMB() float64 {
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return float64(m.HeapAlloc) / 1e6
}

// Mô phỏng xem liên tiếp 60 video Drive, mỗi video 5000 câu phụ đề.
func Test_BUG19_Memory_UnboundedVsBounded(t *testing.T) {
	const videos, segs = 60, 5000
	base := heapMB()
	unbounded := map[string][]WhisperSegment{}
	for i := 0; i < videos; i++ {
		unbounded[fmt.Sprint(i)] = mkSegs(segs)
	}
	before := heapMB() - base
	runtime.KeepAlive(unbounded)
	unbounded = nil
	runtime.GC()

	base = heapMB()
	c := newSegmentLRU(driveSubCacheMax)
	for i := 0; i < videos; i++ {
		c.Put(fmt.Sprint(i), mkSegs(segs))
	}
	after := heapMB() - base
	runtime.KeepAlive(c)
	t.Logf("BUG-19: %d video × %d câu → trước (không giới hạn): %.1f MB, sau (tối đa %d): %.1f MB", videos, segs, before, driveSubCacheMax, after)
	if c.Len() != driveSubCacheMax {
		t.Fatalf("len=%d", c.Len())
	}
	if after > before/5 {
		t.Fatalf("bộ nhớ không giảm đủ: %.1f → %.1f MB", before, after)
	}
}
