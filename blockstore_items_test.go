package main

import (
	"os"
	"path/filepath"
	"testing"
)

func newTestBlockStore(t *testing.T) *BlockStore {
	t.Helper()
	t.Setenv("LOCALAPPDATA", t.TempDir())
	video := filepath.Join(t.TempDir(), "v.mp4")
	_ = os.WriteFile(video, make([]byte, 1024), 0644)
	bs, err := NewBlockStore(video, CacheMeta{BlockSec: 30, OverlapSec: 2, DurationSec: 120})
	if err != nil {
		t.Fatalf("NewBlockStore: %v", err)
	}
	return bs
}

func TestBlockStore_GetBlockItems(t *testing.T) {
	bs := newTestBlockStore(t)

	if _, ok := bs.GetBlockItems(0); ok {
		t.Fatalf("block chưa tồn tại phải trả về false")
	}

	// Block im lặng (0 câu) hoặc chỉ có câu rỗng: không có STT để tái sử dụng
	_ = bs.SaveBlock(1, nil)
	if _, ok := bs.GetBlockItems(1); ok {
		t.Fatalf("block im lặng không được coi là có STT")
	}
	_ = bs.SaveBlock(2, []SubtitleItem{{ID: 2000, Block: 2, SourceText: ""}})
	if _, ok := bs.GetBlockItems(2); ok {
		t.Fatalf("block chỉ có câu rỗng không được coi là có STT")
	}

	// Block có STT nhưng chưa dịch -> trả về bản sao, sửa bản sao không ảnh hưởng store
	_ = bs.SaveBlock(3, []SubtitleItem{
		{ID: 3000, Block: 3, SourceText: "Hello", Translated: false},
		{ID: 3001, Block: 3, SourceText: "World", TargetText: "Thế giới", Translated: true},
	})
	items, ok := bs.GetBlockItems(3)
	if !ok || len(items) != 2 {
		t.Fatalf("kỳ vọng 2 câu, nhận ok=%v len=%d", ok, len(items))
	}
	items[0].SourceText = "changed"
	again, _ := bs.GetBlockItems(3)
	if again[0].SourceText != "Hello" {
		t.Fatalf("GetBlockItems phải trả về bản sao")
	}
}
