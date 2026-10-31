package main

// segmentLRU giữ tối đa `max` danh sách phụ đề (theo videoID) gần nhất; mục cũ nhất bị loại khi vượt giới hạn.
// BUG-19: tránh DriveManager.subCache phình dần theo số video Drive đã mở trong một phiên.
// Không an toàn đa luồng: người dùng phải giữ khóa của chủ sở hữu (DriveManager.mu).
type segmentLRU struct {
	max   int
	order []string // cũ → mới
	data  map[string][]WhisperSegment
}

// driveSubCacheMax: Pipeline đã sao chép externalSegments lúc khởi tạo nên chỉ cần giữ vài video gần nhất
// (video hiện tại + một vài video vừa xem để quay lại nhanh).
const driveSubCacheMax = 3

func newSegmentLRU(max int) *segmentLRU {
	if max < 1 {
		max = 1
	}
	return &segmentLRU{max: max, data: make(map[string][]WhisperSegment)}
}

func (c *segmentLRU) Get(id string) []WhisperSegment { return c.data[id] }

func (c *segmentLRU) Len() int { return len(c.data) }

func (c *segmentLRU) Put(id string, segs []WhisperSegment) {
	if _, ok := c.data[id]; ok {
		c.removeOrder(id)
	}
	c.data[id] = segs
	c.order = append(c.order, id)
	for len(c.order) > c.max {
		oldest := c.order[0]
		c.order = c.order[1:]
		delete(c.data, oldest)
	}
}

func (c *segmentLRU) Delete(id string) {
	if _, ok := c.data[id]; !ok {
		return
	}
	delete(c.data, id)
	c.removeOrder(id)
}

func (c *segmentLRU) Clear() {
	c.data = make(map[string][]WhisperSegment)
	c.order = nil
}

func (c *segmentLRU) removeOrder(id string) {
	for i, v := range c.order {
		if v == id {
			c.order = append(c.order[:i], c.order[i+1:]...)
			return
		}
	}
}
