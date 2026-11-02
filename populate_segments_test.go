package main

import (
	"testing"
)

func newPopStore(t *testing.T) *BlockStore {
	t.Helper()
	t.Setenv("LOCALAPPDATA", t.TempDir())
	bs, err := NewBlockStore(DrivePathFromID("popfile"), CacheMeta{Version: "2.0", BlockSec: 30, OverlapSec: 2, DurationSec: 120})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(bs.WaitPersist)
	return bs
}

// itemsOfBlock đọc mọi câu của block (GetBlockItems chỉ trả block có câu gốc, nên không dùng cho trường hợp chỉ có tiếng Việt)
func itemsOfBlock(bs *BlockStore, block int) []SubtitleItem {
	var out []SubtitleItem
	for _, it := range bs.GetAllItemsSorted() {
		if it.Block == block {
			out = append(out, it)
		}
	}
	return out
}

func seg(a, b float64, text string) WhisperSegment {
	return WhisperSegment{StartSec: a, EndSec: b, Text: text}
}

func TestPopulateStoreFromSegments_PairsViWithEn(t *testing.T) {
	bs := newPopStore(t)
	vi := []WhisperSegment{seg(1, 3, "Xin chào"), seg(31, 33, "Đám mây"), seg(61, 63, "Máy chủ"), seg(91, 119, "Tạm biệt")}
	en := []WhisperSegment{seg(1, 3, "Hello"), seg(31, 33, "Cloud"), seg(61, 63, "Server"), seg(91, 119, "Bye")}
	if !PopulateStoreFromSegments(bs, vi, en, 120, 30, 2, false) {
		t.Fatal("phải nạp được")
	}
	for b := 0; b < 4; b++ {
		if !bs.IsBlockDone(b) {
			t.Errorf("block %d chưa xong", b)
		}
	}
	items, _ := bs.GetBlockItems(1)
	if len(items) != 1 || items[0].TargetText != "Đám mây" || items[0].SourceText != "Cloud" || !items[0].Translated {
		t.Fatalf("block 1 sai: %+v", items)
	}
}

func TestPopulateStoreFromSegments_ViWithoutEn(t *testing.T) {
	bs := newPopStore(t)
	vi := []WhisperSegment{seg(1, 3, "Xin chào"), seg(100, 119, "Tạm biệt")}
	PopulateStoreFromSegments(bs, vi, nil, 120, 30, 2, false)
	items := itemsOfBlock(bs, 0)
	if len(items) != 1 || items[0].TargetText != "Xin chào" || items[0].SourceText != "" {
		t.Fatalf("sai: %+v", items)
	}
}

func TestPopulateStoreFromSegments_OverwriteControlsExistingBlocks(t *testing.T) {
	bs := newPopStore(t)
	bs.SaveBlocksDeferred(map[int][]SubtitleItem{0: {{Block: 0, StartSec: 1, EndSec: 3, SourceText: "Hello", TargetText: "BẢN CŨ", Translated: true}}})
	vi := []WhisperSegment{seg(1, 3, "BẢN MỚI"), seg(100, 119, "x")}

	PopulateStoreFromSegments(bs, vi, nil, 120, 30, 2, false)
	if items := itemsOfBlock(bs, 0); len(items) != 1 || items[0].TargetText != "BẢN CŨ" {
		t.Fatalf("overwrite=false phải giữ block đã xong, got %+v", items)
	}
	PopulateStoreFromSegments(bs, vi, nil, 120, 30, 2, true)
	if items := itemsOfBlock(bs, 0); len(items) != 1 || items[0].TargetText != "BẢN MỚI" {
		t.Fatalf("overwrite=true phải ghi đè, got %+v", items)
	}
}

func TestPopulateStoreFromSegments_TruncatedSubtitleLeavesTailForPipeline(t *testing.T) {
	bs := newPopStore(t)
	vi := []WhisperSegment{seg(1, 3, "a"), seg(31, 33, "b")} // chỉ phủ tới 33s trong video 120s
	PopulateStoreFromSegments(bs, vi, nil, 120, 30, 2, true)
	if !bs.IsBlockDone(0) || !bs.IsBlockDone(1) {
		t.Fatal("block có phụ đề phải xong")
	}
	if bs.IsBlockDone(3) {
		t.Fatal("block 3 (90s+) nằm ngoài phụ đề bị cụt: phải để lại cho Whisper")
	}
}

func TestPopulateStoreFromSegments_SilentOutroStillMarkedDone(t *testing.T) {
	bs := newPopStore(t)
	vi := []WhisperSegment{seg(1, 3, "a"), seg(60, 103, "b")} // phủ 103/120s = 86% → đoạn cuối là im lặng thật
	PopulateStoreFromSegments(bs, vi, nil, 120, 30, 2, true)
	if !bs.IsBlockDone(3) {
		t.Fatal("phụ đề phủ gần hết video: block cuối im lặng vẫn phải đánh dấu xong")
	}
}

func TestPopulateStoreFromSegments_Guards(t *testing.T) {
	if PopulateStoreFromSegments(nil, []WhisperSegment{seg(1, 2, "a")}, nil, 60, 30, 2, true) {
		t.Error("bs nil phải trả false")
	}
	if PopulateStoreFromSegments(newPopStore(t), nil, nil, 60, 30, 2, true) {
		t.Error("không có phụ đề phải trả false")
	}
}
