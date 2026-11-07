package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------- upstream giả ----------

type fakeUp struct {
	mu   sync.Mutex
	data []byte
	etag string

	status     int           // khác 0: luôn trả status này (vd 403)
	stallAfter int64         // đứng im (tới khi ctx hủy) khi chạm vị trí tuyệt đối n của file (0 = không)
	dieAfter   int64         // response ĐẦU TIÊN: đóng sớm khi chạm vị trí tuyệt đối n (0 = không)
	chunkDelay time.Duration // trễ giữa các lần Read
	calls      []string
	served     int
}

func (f *fakeUp) rangesSeen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func (f *fakeUp) setStatus(st int) {
	f.mu.Lock()
	f.status = st
	f.mu.Unlock()
}

func (f *fakeUp) upstreamGet(ctx context.Context, method, fileID, rangeHdr, ifRange string) (*http.Response, error) {
	f.mu.Lock()
	f.calls = append(f.calls, rangeHdr+"|"+ifRange)
	f.served++
	nth := f.served
	status, data, etag := f.status, f.data, f.etag
	f.mu.Unlock()

	if err := ctx.Err(); err != nil {
		return nil, err
	}
	h := http.Header{}
	if etag != "" {
		h.Set("ETag", etag)
	}
	if status != 0 {
		return &http.Response{StatusCode: status, Header: h, Body: io.NopCloser(bytes.NewReader(nil))}, nil
	}

	total := int64(len(data))
	start, end := int64(0), total-1
	code := http.StatusOK
	if strings.HasPrefix(rangeHdr, "bytes=") && (ifRange == "" || ifRange == etag) {
		spec := strings.TrimPrefix(rangeHdr, "bytes=")
		a, b, _ := strings.Cut(spec, "-")
		start, _ = strconv.ParseInt(a, 10, 64)
		if b != "" {
			end, _ = strconv.ParseInt(b, 10, 64)
		}
		if end >= total {
			end = total - 1
		}
		code = http.StatusPartialContent
		h.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, total))
	}
	body := &fakeBody{ctx: ctx, data: data[start : end+1], base: start, delay: f.chunkDelay, stallAfter: f.stallAfter}
	if f.dieAfter > 0 && nth == 1 {
		body.dieAfter = f.dieAfter
	}
	return &http.Response{StatusCode: code, Header: h, ContentLength: int64(len(body.data)), Body: body}, nil
}

type fakeBody struct {
	ctx        context.Context
	data       []byte
	base       int64 // vị trí tuyệt đối của byte đầu trong file (stall/die tính theo vị trí tuyệt đối)
	pos        int64
	delay      time.Duration
	stallAfter int64
	dieAfter   int64
}

func (b *fakeBody) Read(p []byte) (int, error) {
	if b.stallAfter > 0 && b.base+b.pos >= b.stallAfter {
		<-b.ctx.Done()
		return 0, b.ctx.Err()
	}
	if b.dieAfter > 0 && b.base+b.pos >= b.dieAfter {
		return 0, io.EOF // đóng sớm giữa chừng
	}
	if b.delay > 0 {
		select {
		case <-time.After(b.delay):
		case <-b.ctx.Done():
			return 0, b.ctx.Err()
		}
	}
	if b.pos >= int64(len(b.data)) {
		return 0, io.EOF
	}
	n := len(p)
	if n > 32*1024 {
		n = 32 * 1024
	}
	if rest := int64(len(b.data)) - b.pos; int64(n) > rest {
		n = int(rest)
	}
	if b.stallAfter > 0 && b.base+b.pos+int64(n) > b.stallAfter {
		n = int(b.stallAfter - b.base - b.pos)
	}
	if b.dieAfter > 0 && b.base+b.pos+int64(n) > b.dieAfter {
		n = int(b.dieAfter - b.base - b.pos)
	}
	copy(p, b.data[b.pos:b.pos+int64(n)])
	b.pos += int64(n)
	return n, nil
}
func (b *fakeBody) Close() error { return nil }

func pattern(n int) []byte {
	d := make([]byte, n)
	for i := range d {
		d[i] = byte(i*7 + i>>8)
	}
	return d
}

func newTestSpool(t *testing.T, up spoolUpstream) *DriveSpool {
	t.Helper()
	s := NewDriveSpool(t.TempDir(), 64<<20, up)
	s.block0Wait = 300 * time.Millisecond
	s.stallTimeout = 200 * time.Millisecond
	s.retryBackoff = 5 * time.Millisecond
	s.maxRetries = 2
	s.pollInterval = 5 * time.Millisecond
	s.bgBytesPerSec = 0
	t.Cleanup(s.Close)
	return s
}

func spoolEventually(t *testing.T, d time.Duration, what string, cond func() bool) {
	t.Helper()
	dl := time.Now().Add(d)
	for time.Now().Before(dl) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("hết %v mà chưa có: %s", d, what)
}

// ---------- tải đầy đủ ----------

func TestSpool_FullDownloadCompletes(t *testing.T) {
	data := pattern(3<<20 + 123)
	up := &fakeUp{data: data, etag: `"v1"`}
	s := newTestSpool(t, up)
	prog := s.StartSpool("vid", 0)
	spoolEventually(t, 5*time.Second, "Complete", prog.Complete.Load)

	got, err := os.ReadFile(prog.PartPath)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("nội dung file spool sai (err=%v, len=%d want=%d)", err, len(got), len(data))
	}
	meta, err := s.readMeta(prog.MetaPath)
	if err != nil || !meta.Complete || meta.TotalSize != int64(len(data)) || meta.ETag != `"v1"` {
		t.Fatalf("meta sai: %+v err=%v", meta, err)
	}
	path, ok, complete := s.Acquire(context.Background(), "vid", 100, 34, 300)
	if !ok || !complete || path != prog.PartPath {
		t.Fatalf("Acquire sau khi xong: ok=%v complete=%v", ok, complete)
	}
}

// ---------- BUG #1: tải đứng / lỗi không được làm treo pipeline ----------

func TestSpool_StalledDownload_Block0ReturnsQuickly(t *testing.T) {
	up := &fakeUp{data: pattern(40 << 20), etag: `"v1"`, stallAfter: 1 << 20}
	s := newTestSpool(t, up)
	s.block0Wait = 5 * time.Second // lớn hơn hẳn: phải thoát sớm nhờ cờ Failed, không phải đợi hết giờ
	prog := s.StartSpool("vid", 0)

	t0 := time.Now()
	_, ok, _ := s.Acquire(context.Background(), "vid", 0, 34, 300)
	el := time.Since(t0)
	if ok {
		t.Fatal("tải đứng sau 1MB mà vẫn báo dùng được spool")
	}
	if el > 3*time.Second {
		t.Fatalf("Acquire chặn %v (phải thoát khi tải bị đánh dấu hỏng)", el)
	}
	if !prog.Failed.Load() {
		t.Fatal("tải đứng nhưng không có cờ Failed")
	}
}

func TestSpool_Block0WaitHasHardDeadline(t *testing.T) {
	// tải chậm (không đứng, không lỗi): phải hết giờ đúng block0Wait
	up := &fakeUp{data: pattern(40 << 20), etag: `"v1"`, chunkDelay: 20 * time.Millisecond}
	s := newTestSpool(t, up)
	s.stallTimeout = 10 * time.Second
	s.block0Wait = 250 * time.Millisecond
	s.StartSpool("vid", 0)

	t0 := time.Now()
	_, ok, _ := s.Acquire(context.Background(), "vid", 0, 34, 300)
	el := time.Since(t0)
	if ok {
		t.Fatal("chưa đủ byte mà vẫn ok")
	}
	if el < 200*time.Millisecond || el > 2*time.Second {
		t.Fatalf("hết giờ sai: %v (kỳ vọng ~250ms)", el)
	}
}

func TestSpool_Http403_FailsFast(t *testing.T) {
	up := &fakeUp{data: pattern(1 << 20), status: http.StatusForbidden}
	s := newTestSpool(t, up)
	s.block0Wait = 5 * time.Second
	prog := s.StartSpool("vid", 0)

	t0 := time.Now()
	_, ok, _ := s.Acquire(context.Background(), "vid", 0, 34, 300)
	if ok || time.Since(t0) > 2*time.Second {
		t.Fatalf("403: ok=%v sau %v (phải thoát nhanh, không dùng spool)", ok, time.Since(t0))
	}
	if !prog.Failed.Load() || prog.FailReason.Load() == nil || !strings.Contains(*prog.FailReason.Load(), "403") {
		t.Fatalf("thiếu lý do lỗi 403")
	}
	if n := len(up.rangesSeen()); n != 1 {
		t.Fatalf("403 là lỗi cuối, không được thử lại (số lần gọi=%d)", n)
	}
}

func TestSpool_FailedDownloadRestartsOnNextStart(t *testing.T) {
	data := pattern(2 << 20)
	up := &fakeUp{data: data, etag: `"v1"`, status: http.StatusForbidden}
	s := newTestSpool(t, up)
	p1 := s.StartSpool("vid", 0)
	spoolEventually(t, 2*time.Second, "Failed", p1.Failed.Load)

	up.setStatus(0)
	p2 := s.StartSpool("vid", 0)
	if p2 == p1 {
		t.Fatal("tiến trình đã chết nhưng StartSpool vẫn trả lại bản cũ")
	}
	spoolEventually(t, 5*time.Second, "Complete sau khi khởi động lại", p2.Complete.Load)
}

// ---------- thử lại / tiếp tục ----------

func TestSpool_EarlyEOF_ResumesWithRange(t *testing.T) {
	data := pattern(2<<20 + 77)
	up := &fakeUp{data: data, etag: `"v1"`, dieAfter: 700 * 1024}
	s := newTestSpool(t, up)
	prog := s.StartSpool("vid", 0)
	spoolEventually(t, 5*time.Second, "Complete", prog.Complete.Load)

	got, _ := os.ReadFile(prog.PartPath)
	if !bytes.Equal(got, data) {
		t.Fatalf("sau khi nối lại nội dung sai (len=%d want=%d)", len(got), len(data))
	}
	calls := up.rangesSeen()
	if len(calls) < 2 || !strings.HasPrefix(calls[1], "bytes=716800-") || !strings.HasSuffix(calls[1], `|"v1"`) {
		t.Fatalf("lần nối phải xin Range tiếp theo kèm If-Range ETag, calls=%v", calls)
	}
}

func TestSpool_PrematureEOFIsNotComplete(t *testing.T) {
	data := pattern(1 << 20)
	// luôn đóng sớm: mọi response (dieAfter chỉ áp dụng response đầu → dùng wrapper)
	up := &alwaysShortUp{fakeUp: fakeUp{data: data, etag: `"v1"`}, cut: 300 * 1024}
	s := newTestSpool(t, up)
	prog := s.StartSpool("vid", 0)
	spoolEventually(t, 5*time.Second, "Failed", prog.Failed.Load)
	if prog.Complete.Load() {
		t.Fatal("file thiếu byte nhưng bị đánh dấu Complete")
	}
}

// mọi response đều đóng sớm tại vị trí tuyệt đối `cut` (nối lại cũng không tiến thêm được)
type alwaysShortUp struct {
	fakeUp
	cut int64
}

func (a *alwaysShortUp) upstreamGet(ctx context.Context, m, id, rng, ifr string) (*http.Response, error) {
	resp, err := a.fakeUp.upstreamGet(ctx, m, id, rng, ifr)
	if err == nil && resp.StatusCode < 300 {
		fb := resp.Body.(*fakeBody)
		fb.dieAfter = a.cut
	}
	return resp, err
}

// ---------- ETag / size: dùng lại bản cũ khi còn đúng, bỏ khi đã đổi ----------

func TestSpool_ReuseCompleteFile_RevalidatesFirst(t *testing.T) {
	data := pattern(1<<20 + 5)
	up := &fakeUp{data: data, etag: `"v1"`}
	dir := t.TempDir()
	mk := func(u spoolUpstream) *DriveSpool {
		s := NewDriveSpool(dir, 64<<20, u)
		s.pollInterval = 5 * time.Millisecond
		s.bgBytesPerSec = 0
		t.Cleanup(s.Close)
		return s
	}
	s1 := mk(up)
	p1 := s1.StartSpool("vid", 0)
	spoolEventually(t, 5*time.Second, "lần 1 xong", p1.Complete.Load)
	s1.Close()

	// phiên mới, file không đổi: chỉ được probe 0-0, không tải lại nội dung
	up2 := &fakeUp{data: data, etag: `"v1"`}
	s2 := mk(up2)
	p2 := s2.StartSpool("vid", 0)
	spoolEventually(t, 5*time.Second, "lần 2 Complete", p2.Complete.Load)
	calls := up2.rangesSeen()
	if len(calls) != 1 || calls[0] != "bytes=0-0|" {
		t.Fatalf("dùng lại bản cũ chỉ cần 1 lần probe, calls=%v", calls)
	}
	s2.Close()

	// phiên 3: file trên Drive đã đổi (ETag + nội dung + size) → bỏ bản cũ, tải lại
	data3 := pattern(1<<20 + 999)
	data3[0] ^= 0xFF
	up3 := &fakeUp{data: data3, etag: `"v2"`}
	s3 := mk(up3)
	p3 := s3.StartSpool("vid", 0)
	spoolEventually(t, 5*time.Second, "lần 3 Complete", p3.Complete.Load)
	got, _ := os.ReadFile(p3.PartPath)
	if !bytes.Equal(got, data3) {
		t.Fatal("file đã đổi trên Drive nhưng vẫn dùng nội dung cũ")
	}
}

func TestSpool_SameSizeDifferentETag_Discarded(t *testing.T) {
	data := pattern(512 << 10)
	dir := t.TempDir()
	s1 := NewDriveSpool(dir, 64<<20, &fakeUp{data: data, etag: `"A"`})
	s1.bgBytesPerSec = 0
	p1 := s1.StartSpool("vid", 0)
	spoolEventually(t, 5*time.Second, "xong A", p1.Complete.Load)
	s1.Close()

	data2 := pattern(512 << 10)
	data2[100] ^= 1
	s2 := NewDriveSpool(dir, 64<<20, &fakeUp{data: data2, etag: `"B"`})
	s2.bgBytesPerSec = 0
	defer s2.Close()
	p2 := s2.StartSpool("vid", 0)
	spoolEventually(t, 5*time.Second, "xong B", p2.Complete.Load)
	if got, _ := os.ReadFile(p2.PartPath); !bytes.Equal(got, data2) {
		t.Fatal("cùng size nhưng khác ETag mà vẫn giữ bản cũ")
	}
}

func TestSpool_ResumesPartialFileFromPreviousSession(t *testing.T) {
	data := pattern(2 << 20)
	dir := t.TempDir()
	half := int64(len(data) / 2)
	if err := os.WriteFile(filepath.Join(dir, "vid.part"), data[:half], 0644); err != nil {
		t.Fatal(err)
	}
	seed := NewDriveSpool(dir, 64<<20, nil)
	seed.saveMeta(filepath.Join(dir, "vid.meta"), SpoolMeta{FileID: "vid", ETag: `"v1"`, TotalSize: int64(len(data)), DownloadedBytes: half})

	up := &fakeUp{data: data, etag: `"v1"`}
	s := NewDriveSpool(dir, 64<<20, up)
	s.bgBytesPerSec = 0
	defer s.Close()
	p := s.StartSpool("vid", 0)
	spoolEventually(t, 5*time.Second, "Complete", p.Complete.Load)

	if got, _ := os.ReadFile(p.PartPath); !bytes.Equal(got, data) {
		t.Fatal("nội dung sau khi tiếp tục sai")
	}
	calls := up.rangesSeen()
	if len(calls) != 2 || calls[0] != "bytes=0-0|" || !strings.HasPrefix(calls[1], fmt.Sprintf("bytes=%d-", half)) {
		t.Fatalf("phải probe rồi xin tiếp từ %d, calls=%v", half, calls)
	}
}

// ---------- chiến lược prefix cho file lớn ----------

func TestSpool_LargeFileOnlyDownloadsPrefix(t *testing.T) {
	data := pattern(8 << 20)
	up := &fakeUp{data: data, etag: `"v1"`}
	s := NewDriveSpool(t.TempDir(), 4<<20, up) // ngân sách 4MB → file 8MB > nửa ngân sách
	s.prefixBytes = 1 << 20
	s.bgBytesPerSec = 0
	defer s.Close()
	prog := s.StartSpool("vid", 0)
	spoolEventually(t, 5*time.Second, "đủ prefix", func() bool { return prog.DownloadedBytes.Load() >= 1<<20 })
	time.Sleep(100 * time.Millisecond)

	if prog.Complete.Load() {
		t.Fatal("file lớn không được đánh dấu Complete khi mới tải prefix")
	}
	if fi, _ := os.Stat(prog.PartPath); fi.Size() != 1<<20 {
		t.Fatalf("file spool = %d, kỳ vọng đúng prefix 1MB", fi.Size())
	}
	// vùng nằm ngoài prefix → proxy ngay, không chờ
	t0 := time.Now()
	if _, ok, _ := s.Acquire(context.Background(), "vid", 200, 34, 300); ok || time.Since(t0) > 100*time.Millisecond {
		t.Fatalf("vùng ngoài prefix phải trả proxy ngay (ok=%v, %v)", ok, time.Since(t0))
	}
	meta, _ := s.readMeta(prog.MetaPath)
	if meta.Complete || meta.DownloadedBytes != 1<<20 {
		t.Fatalf("meta prefix sai: %+v", meta)
	}
}

// ---------- tải nền có giới hạn tốc độ ----------

func TestSpool_BackgroundThrottle(t *testing.T) {
	data := pattern(900 << 10)
	run := func(bps int64) time.Duration {
		up := &fakeUp{data: data, etag: `"v1"`}
		s := NewDriveSpool(t.TempDir(), 64<<20, up)
		s.burstBytes = 100 << 10
		s.bgBytesPerSec = bps
		defer s.Close()
		t0 := time.Now()
		p := s.StartSpool("vid", 0)
		spoolEventually(t, 10*time.Second, "Complete", p.Complete.Load)
		return time.Since(t0)
	}
	fast := run(0)
	slow := run(1 << 20) // 800KB sau burst ở 1MB/s ≈ 0.75s
	if slow < 500*time.Millisecond || slow < fast+300*time.Millisecond {
		t.Fatalf("giới hạn tốc độ không có tác dụng: không giới hạn=%v, giới hạn=%v", fast, slow)
	}
}

// ---------- Acquire: chính sách theo cấu trúc file ----------

func box(typ string, payload int) []byte {
	b := make([]byte, 8+payload)
	binary.BigEndian.PutUint32(b[0:4], uint32(8+payload))
	copy(b[4:8], typ)
	return b
}

func cat(parts ...[]byte) []byte { return bytes.Join(parts, nil) }

func TestInspectMP4Head(t *testing.T) {
	big := box("mdat", 1<<20)
	mdat64 := append([]byte{0, 0, 0, 1, 'm', 'd', 'a', 't', 0, 0, 0, 0, 0, 0x10, 0, 0}, make([]byte, 1<<20)...)
	ebml := append([]byte{0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81}, make([]byte, 4096)...)
	cases := []struct {
		name  string
		data  []byte
		avail int64 // 0 = toàn bộ
		want  mp4Head
	}{
		{"faststart ftyp+moov+mdat", cat(box("ftyp", 16), box("moov", 500), big), 0, headReady},
		{"free trước moov", cat(box("ftyp", 16), box("free", 100), box("moov", 500), big), 0, headReady},
		{"moov nằm cuối", cat(box("ftyp", 16), big, box("moov", 500)), 0, headMoovAtEnd},
		{"mdat 64-bit trước moov", cat(box("ftyp", 16), mdat64), 0, headMoovAtEnd},
		{"moov chưa tải đủ", cat(box("ftyp", 16), box("moov", 5000), big), 24 + 2000, headUnknown},
		{"chưa đủ 8 byte đầu", cat(box("ftyp", 16), box("moov", 500)), 6, headUnknown},
		{"mới có ftyp", cat(box("ftyp", 16), box("moov", 500)), 24, headUnknown},
		{"mkv/webm", ebml, 0, headNotMP4},
		{"rác", bytes.Repeat([]byte{0xAB}, 4096), 0, headNotMP4},
	}
	for _, c := range cases {
		p := filepath.Join(t.TempDir(), "x.part")
		if err := os.WriteFile(p, c.data, 0644); err != nil {
			t.Fatal(err)
		}
		avail := c.avail
		if avail == 0 {
			avail = int64(len(c.data))
		}
		if got := inspectMP4Head(p, avail); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

// dựng spool với tiến trình đã có sẵn trạng thái (không cần mạng)
func spoolWithProgress(t *testing.T, content []byte, total int64, target int64, mut func(*SpoolProgress)) (*DriveSpool, *SpoolProgress) {
	t.Helper()
	s := NewDriveSpool(t.TempDir(), 1<<30, nil)
	s.block0Wait = 200 * time.Millisecond
	s.pollInterval = 5 * time.Millisecond
	p := &SpoolProgress{FileID: "vid", PartPath: filepath.Join(s.spoolDir, "vid.part"), MetaPath: filepath.Join(s.spoolDir, "vid.meta"), done: make(chan struct{})}
	if err := os.WriteFile(p.PartPath, content, 0644); err != nil {
		t.Fatal(err)
	}
	p.TotalSize.Store(total)
	p.TargetBytes.Store(target)
	p.DownloadedBytes.Store(int64(len(content)))
	if mut != nil {
		mut(p)
	}
	s.activeID, s.activeProg = "vid", p
	return s, p
}

func TestAcquire_Policy(t *testing.T) {
	const total = 100 << 20 // 100MB, 300s → ~349KB/s; cần ≈ (start+len+10)*avg*1.35 (start=50 → ~44MB)
	faststart := cat(box("ftyp", 16), box("moov", 500), box("mdat", 60<<20))
	moovEnd := cat(box("ftyp", 16), box("mdat", 60<<20), box("moov", 500))
	mkv := cat([]byte{0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81}, make([]byte, 60<<20))

	type tc struct {
		name         string
		content      []byte
		start        float64
		mut          func(*SpoolProgress)
		fileID       string
		wantOK       bool
		wantComplete bool
	}
	cases := []tc{
		{"faststart, đã tải đủ vùng (đoạn 50s cần ~44MB)", faststart, 50, nil, "vid", true, false},
		{"faststart, chưa tải tới vùng 250s", faststart, 250, nil, "vid", false, false},
		{"moov ở cuối: dù tải 60MB vẫn không dùng được", moovEnd, 50, nil, "vid", false, false},
		{"mkv đọc giữa chừng không an toàn", mkv, 50, nil, "vid", false, false},
		{"mkv block 0 đọc tuần tự được", mkv, 0, nil, "vid", true, false},
		{"đã Complete → luôn dùng", faststart[:1000], 250, func(p *SpoolProgress) { p.Complete.Store(true) }, "vid", true, true},
		{"đã Failed → bỏ", faststart, 50, func(p *SpoolProgress) { p.fail("x") }, "vid", false, false},
		{"khác fileID → bỏ", faststart, 50, nil, "other", false, false},
		{"ngoài phần sẽ tải (prefix)", faststart, 50, func(p *SpoolProgress) { p.TargetBytes.Store(10 << 20) }, "vid", false, false},
	}
	for _, c := range cases {
		s, _ := spoolWithProgress(t, c.content, total, total, c.mut)
		path, ok, complete := s.Acquire(context.Background(), c.fileID, c.start, 34, 300)
		if ok != c.wantOK || complete != c.wantComplete {
			t.Errorf("%s: ok=%v complete=%v, want ok=%v complete=%v", c.name, ok, complete, c.wantOK, c.wantComplete)
		}
		if ok && path == "" {
			t.Errorf("%s: ok nhưng path rỗng", c.name)
		}
	}
}

func TestAcquire_Block0WaitsForBytesThenSucceeds(t *testing.T) {
	data := cat(box("ftyp", 16), box("moov", 500), box("mdat", 20<<20))
	up := &fakeUp{data: data, etag: `"v1"`, chunkDelay: 2 * time.Millisecond}
	s := newTestSpool(t, up)
	s.block0Wait = 5 * time.Second
	s.stallTimeout = 5 * time.Second
	s.StartSpool("vid", 0)

	_, ok, _ := s.Acquire(context.Background(), "vid", 0, 34, 300)
	if !ok {
		t.Fatal("block 0 phải đợi tới khi đủ byte rồi dùng spool")
	}
}

func TestWaitFor_RespectsContextAndDeadline(t *testing.T) {
	s := NewDriveSpool(t.TempDir(), 1<<20, nil)
	t0 := time.Now()
	if s.waitFor(context.Background(), 100*time.Millisecond, func() bool { return false }) {
		t.Fatal("cond luôn false mà trả true")
	}
	if el := time.Since(t0); el < 90*time.Millisecond || el > time.Second {
		t.Fatalf("deadline sai: %v", el)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()
	t0 = time.Now()
	s.waitFor(ctx, 10*time.Second, func() bool { return false })
	if time.Since(t0) > time.Second {
		t.Fatal("không thoát khi ctx hủy")
	}
}

// ---------- đổi video / dọn dẹp ----------

func TestSpool_SwitchVideoCancelsOld(t *testing.T) {
	up := &fakeUp{data: pattern(40 << 20), etag: `"v1"`, chunkDelay: 5 * time.Millisecond}
	s := newTestSpool(t, up)
	s.stallTimeout = 10 * time.Second
	p1 := s.StartSpool("a", 0)
	spoolEventually(t, 2*time.Second, "a có dữ liệu", func() bool { return p1.DownloadedBytes.Load() > 0 })
	p2 := s.StartSpool("b", 0)
	select {
	case <-p1.done:
	case <-time.After(3 * time.Second):
		t.Fatal("tải video cũ không dừng sau khi đổi video")
	}
	if p1.Failed.Load() {
		t.Fatal("hủy chủ động không được tính là lỗi")
	}
	if _, ok, _ := s.Acquire(context.Background(), "a", 100, 34, 300); ok {
		t.Fatal("Acquire video cũ phải trả proxy")
	}
	_ = p2
}

func TestSpool_EvictsWholePairsOldestFirst(t *testing.T) {
	dir := t.TempDir()
	s := NewDriveSpool(dir, 3500<<10, nil)
	now := time.Now()
	mk := func(id string, age time.Duration) {
		for _, ext := range []string{".part", ".meta"} {
			p := filepath.Join(dir, id+ext)
			if err := os.WriteFile(p, make([]byte, 600<<10), 0644); err != nil {
				t.Fatal(err)
			}
			mt := now.Add(-age)
			_ = os.Chtimes(p, mt, mt)
		}
	}
	mk("old", 3*time.Hour)
	mk("mid", 2*time.Hour)
	mk("new", 1*time.Hour)
	s.activeID = "active"

	s.makeRoom("cur", 1500<<10) // 3×1200KB=3600KB + 1500KB > 3500KB → phải xóa ít nhất 2 cặp cũ nhất
	exists := func(n string) bool { _, err := os.Stat(filepath.Join(dir, n)); return err == nil }
	if exists("old.part") || exists("old.meta") {
		t.Error("cặp cũ nhất phải bị xóa cả .part lẫn .meta")
	}
	if exists("mid.part") != exists("mid.meta") || exists("new.part") != exists("new.meta") {
		t.Error("không được để lại nửa cặp")
	}
	if !exists("new.part") {
		t.Error("cặp mới nhất không được xóa khi đã đủ chỗ")
	}
}

func TestSpool_EvictKeepsActiveAndCurrent(t *testing.T) {
	dir := t.TempDir()
	s := NewDriveSpool(dir, 1<<20, nil)
	for _, id := range []string{"active", "cur"} {
		for _, ext := range []string{".part", ".meta"} {
			_ = os.WriteFile(filepath.Join(dir, id+ext), make([]byte, 900<<10), 0644)
		}
	}
	s.activeID = "active"
	s.makeRoom("cur", 5<<20)
	for _, n := range []string{"active.part", "active.meta", "cur.part", "cur.meta"} {
		if _, err := os.Stat(filepath.Join(dir, n)); err != nil {
			t.Errorf("%s bị xóa nhầm", n)
		}
	}
}

func TestSpool_CleanOrphansOnStart(t *testing.T) {
	dir := t.TempDir()
	old := time.Now().Add(-time.Hour)
	write := func(name string, aged bool) {
		p := filepath.Join(dir, name)
		_ = os.WriteFile(p, []byte("x"), 0644)
		if aged {
			_ = os.Chtimes(p, old, old)
		}
	}
	write("lonelymeta.meta", false) // .meta không có .part → xóa
	write("stale.part", true)       // .part cũ không có .meta → xóa
	write("fresh.part", false)      // .part mới (đang tải) không có .meta → giữ
	write("pair.part", true)        // cặp đầy đủ → giữ
	write("pair.meta", true)
	NewDriveSpool(dir, 1<<20, nil)
	exists := func(n string) bool { _, err := os.Stat(filepath.Join(dir, n)); return err == nil }
	if exists("lonelymeta.meta") || exists("stale.part") {
		t.Error("file mồ côi chưa được dọn")
	}
	if !exists("fresh.part") || !exists("pair.part") || !exists("pair.meta") {
		t.Error("dọn nhầm file còn dùng")
	}
}

func TestSpool_NilUpstreamNeverStarts(t *testing.T) {
	s := NewDriveSpool(t.TempDir(), 1<<20, nil)
	if s.StartSpool("vid", 0) != nil {
		t.Fatal("không có upstream thì không được bắt đầu tải")
	}
	if _, ok, _ := s.Acquire(context.Background(), "vid", 0, 34, 300); ok {
		t.Fatal("không có spool mà Acquire ok")
	}
}
