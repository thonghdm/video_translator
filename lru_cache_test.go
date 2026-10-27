package main

import (
	"fmt"
	"sync"
	"testing"
)

func TestLRUCache_BasicAndCapacity(t *testing.T) {
	cache := NewLRUCache(3)

	cache.Set("k1", "v1")
	cache.Set("k2", "v2")
	cache.Set("k3", "v3")

	if v, ok := cache.Get("k1"); !ok || v != "v1" {
		t.Fatalf("expected k1=v1, got %v, %v", v, ok)
	}

	// k1 vừa được get nên thứ tự từ mới nhất đến cũ nhất: k1, k3, k2
	// Thêm k4 -> k2 (cũ nhất) phải bị evict
	cache.Set("k4", "v4")

	if _, ok := cache.Get("k2"); ok {
		t.Fatalf("expected k2 to be evicted")
	}

	if v, ok := cache.Get("k1"); !ok || v != "v1" {
		t.Fatalf("expected k1 to survive eviction because it was recently accessed")
	}
	if v, ok := cache.Get("k3"); !ok || v != "v3" {
		t.Fatalf("expected k3 to exist")
	}
	if v, ok := cache.Get("k4"); !ok || v != "v4" {
		t.Fatalf("expected k4 to exist")
	}

	hits, misses, evicts, size := cache.Stats()
	if size != 3 {
		t.Errorf("expected size 3, got %d", size)
	}
	if evicts != 1 {
		t.Errorf("expected 1 evict, got %d", evicts)
	}
	if hits < 3 {
		t.Errorf("expected at least 3 hits, got %d", hits)
	}
	if misses != 1 { // get k2 miss
		t.Errorf("expected 1 miss, got %d", misses)
	}
}

func TestLRUCache_UpdateExistingKey(t *testing.T) {
	cache := NewLRUCache(2)
	cache.Set("k1", "v1")
	cache.Set("k2", "v2")

	// Cập nhật k1 -> k1 thành mới nhất, k2 thành cũ nhất
	cache.Set("k1", "v1_updated")

	if v, ok := cache.Get("k1"); !ok || v != "v1_updated" {
		t.Fatalf("expected updated value v1_updated, got %v", v)
	}

	// Thêm k3 -> k2 phải bị evict, k1 vẫn còn
	cache.Set("k3", "v3")

	if _, ok := cache.Get("k2"); ok {
		t.Fatalf("expected k2 to be evicted")
	}
	if v, ok := cache.Get("k1"); !ok || v != "v1_updated" {
		t.Fatalf("expected k1 to remain, got %v", v)
	}
}

func TestLRUCache_ConcurrentAccess(t *testing.T) {
	cache := NewLRUCache(50)
	var wg sync.WaitGroup

	numGoroutines := 20
	iterations := 200

	for i := 0; i < numGoroutines; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				key := fmt.Sprintf("key_%d", (id*10+j)%100)
				val := fmt.Sprintf("val_%d", j)
				cache.Set(key, val)
				_, _ = cache.Get(key)
			}
		}(i)
	}

	wg.Wait()

	if cache.Len() > 50 {
		t.Fatalf("cache size %d exceeded capacity 50", cache.Len())
	}

	hits, misses, evicts, size := cache.Stats()
	if hits == 0 {
		t.Errorf("expected positive hits, got %d", hits)
	}
	if size > 50 {
		t.Errorf("size exceeded 50: %d", size)
	}
	_ = misses
	_ = evicts
}
