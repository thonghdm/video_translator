package main

import (
	"container/list"
	"sync"
	"sync/atomic"
)

type lruEntry struct {
	key   string
	value string
}

// LRUCache là bộ nhớ đệm chuỗi thread-safe dùng container/list và map
type LRUCache struct {
	capacity int
	mu       sync.Mutex
	items    map[string]*list.Element
	order    *list.List

	hits   int64
	misses int64
	evicts int64
}

// NewLRUCache khởi tạo LRU cache với dung lượng cố định
func NewLRUCache(capacity int) *LRUCache {
	if capacity <= 0 {
		capacity = 8000
	}
	return &LRUCache{
		capacity: capacity,
		items:    make(map[string]*list.Element, capacity),
		order:    list.New(),
	}
}

// Get truy vấn giá trị và đưa phần tử lên đầu danh sách nếu tồn tại
func (c *LRUCache) Get(key string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if elem, ok := c.items[key]; ok {
		c.order.MoveToFront(elem)
		atomic.AddInt64(&c.hits, 1)
		return elem.Value.(*lruEntry).value, true
	}

	atomic.AddInt64(&c.misses, 1)
	return "", false
}

// Set thêm hoặc cập nhật phần tử, đẩy lên đầu. Nếu quá capacity thì loại bỏ phần tử cuối (LRU)
func (c *LRUCache) Set(key, value string) {
	if key == "" || value == "" {
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if elem, ok := c.items[key]; ok {
		c.order.MoveToFront(elem)
		elem.Value.(*lruEntry).value = value
		return
	}

	for c.order.Len() >= c.capacity {
		oldest := c.order.Back()
		if oldest == nil {
			break
		}
		c.order.Remove(oldest)
		kv := oldest.Value.(*lruEntry)
		delete(c.items, kv.key)
		atomic.AddInt64(&c.evicts, 1)
	}

	elem := c.order.PushFront(&lruEntry{key: key, value: value})
	c.items[key] = elem
}

// Stats trả về số lần hit, miss, evict và kích thước hiện tại
func (c *LRUCache) Stats() (hits, misses, evicts int64, size int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return atomic.LoadInt64(&c.hits), atomic.LoadInt64(&c.misses), atomic.LoadInt64(&c.evicts), len(c.items)
}

// Len trả về số phần tử hiện tại
func (c *LRUCache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.items)
}
