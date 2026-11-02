package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// Mặc định giới hạn tổng dung lượng thư mục spool: 2GB
	defaultMaxSpoolBytes = 2 * 1024 * 1024 * 1024
	// File lớn hơn một nửa ngân sách spool chỉ tải phần đầu (prefix) thay vì toàn bộ
	spoolPrefixBytes = 150 * 1024 * 1024
	// Vùng đệm tối thiểu cần cho block 0 (15MB)
	minBlock0BufferBytes = 15 * 1024 * 1024

	defaultBlock0Wait    = 6 * time.Second
	defaultStallTimeout  = 30 * time.Second
	defaultBurstBytes    = 64 * 1024 * 1024
	defaultBgBytesPerSec = 8 * 1024 * 1024
	defaultSpoolRetries  = 3
)

// spoolUpstream là phần của DriveManager mà spool cần (tách ra để test được bằng upstream giả).
type spoolUpstream interface {
	upstreamGet(ctx context.Context, method, fileID, rangeHdr, ifRange string) (*http.Response, error)
}

// SpoolMeta lưu metadata của file spool để kiểm tra tính hợp lệ (ETag, size), tiếp tục tải dở và LRU
type SpoolMeta struct {
	FileID          string    `json:"file_id"`
	ETag            string    `json:"etag"`
	TotalSize       int64     `json:"total_size"`
	DownloadedBytes int64     `json:"downloaded_bytes"`
	Complete        bool      `json:"complete"`
	UpdatedAt       time.Time `json:"updated_at"`
}

// mp4Head là kết luận về phần đầu file MP4 đang tải dở.
type mp4Head int32

const (
	headUnknown   mp4Head = iota // chưa đủ byte để kết luận
	headReady                    // atom moov nằm trước mdat và đã tải đủ
	headMoovAtEnd                // moov nằm sau mdat: không đọc được khi file chưa tải xong
	headNotMP4                   // không phải họ MP4/MOV (mkv, webm, avi...)
)

// SpoolProgress theo dõi tiến độ tải của một file spool đang hoạt động
type SpoolProgress struct {
	FileID   string
	PartPath string
	MetaPath string

	DownloadedBytes atomic.Int64
	TotalSize       atomic.Int64
	TargetBytes     atomic.Int64 // số byte downloader định tải (toàn bộ, hoặc prefix); 0 = chưa biết
	Complete        atomic.Bool
	Failed          atomic.Bool
	ETag            atomic.Pointer[string]
	FailReason      atomic.Pointer[string]

	headState    atomic.Int32 // chỉ lưu kết luận cuối (Ready/MoovAtEnd/NotMP4)
	lastProgress atomic.Int64 // unix nano của lần nhận byte gần nhất

	cancel context.CancelFunc
	done   chan struct{} // đóng khi goroutine tải đã thoát hẳn
}

func (p *SpoolProgress) fail(reason string) {
	r := reason
	p.FailReason.Store(&r)
	p.Failed.Store(true)
}

// head trả về kết luận về phần đầu file; kết luận cuối được nhớ lại để khỏi đọc đĩa lặp.
func (p *SpoolProgress) head() mp4Head {
	if h := mp4Head(p.headState.Load()); h != headUnknown {
		return h
	}
	h := inspectMP4Head(p.PartPath, p.DownloadedBytes.Load())
	if h != headUnknown {
		p.headState.Store(int32(h))
	}
	return h
}

// DriveSpool quản lý việc tải tuần tự file Drive về đĩa cục bộ phục vụ ffmpeg slicer
type DriveSpool struct {
	mu            sync.Mutex
	spoolDir      string
	maxSpoolBytes int64
	up            spoolUpstream

	activeID   string
	activeProg *SpoolProgress

	// Tham số chỉnh được (test ghi đè)
	block0Wait    time.Duration
	stallTimeout  time.Duration
	burstBytes    int64
	bgBytesPerSec int64 // 0 = không giới hạn
	prefixBytes   int64
	maxRetries    int
	retryBackoff  time.Duration
	pollInterval  time.Duration
}

// NewDriveSpool khởi tạo DriveSpool
func NewDriveSpool(spoolDir string, maxBytes int64, up spoolUpstream) *DriveSpool {
	if spoolDir == "" {
		localAppData := os.Getenv("LOCALAPPDATA")
		if localAppData == "" {
			localAppData = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
		}
		spoolDir = filepath.Join(localAppData, "SubTrans", "spool")
	}
	_ = os.MkdirAll(spoolDir, 0755)

	if maxBytes <= 0 {
		maxBytes = defaultMaxSpoolBytes
	}
	// tránh nil con trỏ bọc trong interface
	if dm, ok := up.(*DriveManager); ok && dm == nil {
		up = nil
	}

	s := &DriveSpool{
		spoolDir:      spoolDir,
		maxSpoolBytes: maxBytes,
		up:            up,
		block0Wait:    defaultBlock0Wait,
		stallTimeout:  defaultStallTimeout,
		burstBytes:    defaultBurstBytes,
		bgBytesPerSec: defaultBgBytesPerSec,
		prefixBytes:   spoolPrefixBytes,
		maxRetries:    defaultSpoolRetries,
		retryBackoff:  400 * time.Millisecond,
		pollInterval:  50 * time.Millisecond,
	}
	s.cleanOrphans()
	return s
}

// targetFor: số byte cần tải cho file kích thước total. File lớn hơn nửa ngân sách chỉ tải prefix.
func (s *DriveSpool) targetFor(total int64) int64 {
	if total <= 0 {
		return 0
	}
	if total <= s.maxSpoolBytes/2 {
		return total
	}
	if s.prefixBytes < total {
		return s.prefixBytes
	}
	return total
}

// StartSpool bắt đầu tải tuần tự một file Drive về thư mục spool (Player-First, 1 kết nối duy nhất).
// Gọi lại cho cùng file khi lần tải trước đã chết sẽ khởi động lại (tiếp tục từ chỗ dở nếu còn hợp lệ).
func (s *DriveSpool) StartSpool(fileID string, knownSize int64) *SpoolProgress {
	s.mu.Lock()
	defer s.mu.Unlock()

	if fileID == "" || s.up == nil {
		return nil
	}

	var prev <-chan struct{}
	if cur := s.activeProg; cur != nil {
		if s.activeID == fileID && !(cur.Failed.Load() && !cur.Complete.Load()) {
			return cur // đang tải (hoặc đã xong) đúng file này
		}
		if cur.cancel != nil {
			cur.cancel()
		}
		prev = cur.done
		s.activeProg = nil
		s.activeID = ""
	}

	prog := &SpoolProgress{
		FileID:   fileID,
		PartPath: filepath.Join(s.spoolDir, fileID+".part"),
		MetaPath: filepath.Join(s.spoolDir, fileID+".meta"),
		done:     make(chan struct{}),
	}
	if knownSize > 0 {
		prog.TotalSize.Store(knownSize)
	}
	prog.lastProgress.Store(time.Now().UnixNano())

	ctx, cancel := context.WithCancel(context.Background())
	prog.cancel = cancel
	s.activeID = fileID
	s.activeProg = prog

	go s.runDownload(ctx, prog, prev)
	return prog
}

// runDownload là goroutine chính của một lần spool: chuẩn bị (kiểm tra bản cũ), tải, ghi kết quả.
func (s *DriveSpool) runDownload(ctx context.Context, prog *SpoolProgress, prev <-chan struct{}) {
	defer close(prog.done)
	t0 := time.Now()

	// Chờ lần tải cũ (cùng file) thoát hẳn để không có hai goroutine ghi chung một file .part
	if prev != nil {
		select {
		case <-prev:
		case <-time.After(5 * time.Second):
		case <-ctx.Done():
			return
		}
	}

	err := s.download(ctx, prog)
	switch {
	case err == nil:
		DiagLog("[spool] file=%s done complete=%v bytes=%d total=%d in=%dms",
			prog.FileID, prog.Complete.Load(), prog.DownloadedBytes.Load(), prog.TotalSize.Load(), time.Since(t0).Milliseconds())
	case isCanceled(err) && ctx.Err() != nil:
		// bị hủy chủ động (đổi video / thoát app): không phải lỗi
	default:
		prog.fail(err.Error())
		DiagLog("[spool] file=%s FAILED after %dms bytes=%d: %v", prog.FileID, time.Since(t0).Milliseconds(), prog.DownloadedBytes.Load(), err)
	}
}

type fatalSpoolErr struct{ error }

func (e fatalSpoolErr) Unwrap() error { return e.error }

// download: kiểm tra bản spool cũ, rồi tải (có thử lại / tiếp tục) cho tới khi xong hoặc hết lượt.
func (s *DriveSpool) download(ctx context.Context, prog *SpoolProgress) error {
	offset, etag, total, err := s.prepareResume(ctx, prog)
	if err != nil {
		return err
	}
	if total > 0 {
		prog.TotalSize.Store(total)
		prog.TargetBytes.Store(s.targetFor(total))
	}
	if etag != "" {
		e := etag
		prog.ETag.Store(&e)
	}
	prog.DownloadedBytes.Store(offset)

	failures := 0
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if target := prog.TargetBytes.Load(); target > 0 && offset >= target {
			return s.finish(prog, offset)
		}

		before := offset
		newOff, finished, err := s.fetchOnce(ctx, prog, offset)
		offset = newOff
		if finished {
			return nil
		}
		if err == nil {
			continue
		}
		var fatal fatalSpoolErr
		if errors.As(err, &fatal) || (isCanceled(err) && ctx.Err() != nil) {
			return err
		}
		if offset > before {
			failures = 0 // có tiến triển → không tính là lần thất bại liên tiếp
		}
		failures++
		if failures > s.maxRetries {
			return fmt.Errorf("tải thất bại sau %d lần thử: %w", failures, err)
		}
		DiagLog("[spool] file=%s retry %d/%d at=%d: %v", prog.FileID, failures, s.maxRetries, offset, err)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(failures) * s.retryBackoff):
		}
	}
}

// prepareResume đối chiếu bản .part/.meta còn lại với Drive (size + ETag). Hợp lệ → tiếp tục từ offset đã có;
// lệch hoặc không kiểm tra được → bắt đầu lại từ 0.
func (s *DriveSpool) prepareResume(ctx context.Context, prog *SpoolProgress) (offset int64, etag string, total int64, err error) {
	meta, merr := s.readMeta(prog.MetaPath)
	fi, serr := os.Stat(prog.PartPath)
	if merr != nil || serr != nil || meta.FileID != prog.FileID {
		return 0, "", 0, nil
	}
	have := meta.DownloadedBytes
	if meta.Complete {
		have = meta.TotalSize
	}
	if fi.Size() < have {
		have = fi.Size()
	}
	if have <= 0 {
		return 0, "", 0, nil
	}

	pe, ptotal, perr := s.probe(ctx, prog.FileID)
	if perr != nil {
		if isCanceled(perr) && ctx.Err() != nil {
			return 0, "", 0, perr
		}
		DiagLog("[spool] file=%s không kiểm tra lại được bản cũ (%v) → tải lại từ đầu", prog.FileID, perr)
		return 0, "", 0, nil
	}
	sizeDiff := ptotal > 0 && meta.TotalSize > 0 && ptotal != meta.TotalSize
	etagDiff := pe != "" && meta.ETag != "" && pe != meta.ETag
	if sizeDiff || etagDiff {
		DiagLog("[spool] file=%s đã đổi trên Drive (size %d→%d, etag đổi=%v) → bỏ bản cũ", prog.FileID, meta.TotalSize, ptotal, etagDiff)
		return 0, "", 0, nil
	}
	if pe == "" {
		pe = meta.ETag
	}
	if ptotal <= 0 {
		ptotal = meta.TotalSize
	}
	return have, pe, ptotal, nil
}

// probe hỏi nhanh size + ETag hiện tại của file trên Drive (Range 0-0).
func (s *DriveSpool) probe(ctx context.Context, fileID string) (etag string, total int64, err error) {
	resp, err := s.up.upstreamGet(ctx, http.MethodGet, fileID, "bytes=0-0", "")
	if err != nil {
		return "", 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		return "", 0, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return resp.Header.Get("ETag"), totalFromResponse(resp, 0), nil
}

// totalFromResponse suy ra tổng kích thước file từ Content-Range (ưu tiên) hoặc Content-Length.
func totalFromResponse(resp *http.Response, offset int64) int64 {
	if cr := resp.Header.Get("Content-Range"); cr != "" {
		if i := strings.LastIndex(cr, "/"); i >= 0 {
			if sz, err := strconv.ParseInt(strings.TrimSpace(cr[i+1:]), 10, 64); err == nil && sz > 0 {
				return sz
			}
		}
	}
	if resp.ContentLength > 0 {
		if resp.StatusCode == http.StatusPartialContent {
			return offset + resp.ContentLength
		}
		return resp.ContentLength
	}
	return 0
}

// finish ghi nhận hoàn tất: Complete khi đã đủ cả file, nếu chỉ đủ prefix thì chỉ lưu meta.
func (s *DriveSpool) finish(prog *SpoolProgress, offset int64) error {
	total := prog.TotalSize.Load()
	etag := ""
	if e := prog.ETag.Load(); e != nil {
		etag = *e
	}
	complete := total > 0 && offset >= total
	if total <= 0 { // server không báo size: EOF chính là hết file
		complete = true
		total = offset
		prog.TotalSize.Store(total)
	}
	s.saveMeta(prog.MetaPath, SpoolMeta{
		FileID:          prog.FileID,
		ETag:            etag,
		TotalSize:       total,
		DownloadedBytes: offset,
		Complete:        complete,
	})
	if complete {
		prog.Complete.Store(true)
	}
	return nil
}

// fetchOnce thực hiện một kết nối tải bắt đầu tại offset. Trả về offset mới, finished=true khi đã xong hẳn.
func (s *DriveSpool) fetchOnce(ctx context.Context, prog *SpoolProgress, offset int64) (newOffset int64, finished bool, err error) {
	actx, acancel := context.WithCancel(ctx)
	defer acancel()

	// Giám sát tải đứng: quá stallTimeout không có byte nào → hủy kết nối này để thử lại
	var stalled atomic.Bool
	prog.lastProgress.Store(time.Now().UnixNano())
	go func() {
		t := time.NewTicker(s.stallTimeout / 10)
		defer t.Stop()
		for {
			select {
			case <-actx.Done():
				return
			case <-t.C:
				if time.Since(time.Unix(0, prog.lastProgress.Load())) > s.stallTimeout {
					stalled.Store(true)
					acancel()
					return
				}
			}
		}
	}()
	wrap := func(e error) error {
		if stalled.Load() {
			return fmt.Errorf("không nhận được byte nào trong %v (tải đứng)", s.stallTimeout)
		}
		return e
	}

	ifRange := ""
	if offset > 0 {
		if e := prog.ETag.Load(); e != nil {
			ifRange = *e
		}
	}
	resp, gerr := s.up.upstreamGet(actx, http.MethodGet, prog.FileID, fmt.Sprintf("bytes=%d-", offset), ifRange)
	if gerr != nil {
		return offset, false, wrap(gerr)
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusPartialContent:
	case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusRequestTimeout || resp.StatusCode >= 500:
		return offset, false, fmt.Errorf("Google Drive trả về HTTP %d", resp.StatusCode)
	default:
		return offset, false, fatalSpoolErr{fmt.Errorf("Google Drive trả về HTTP %d", resp.StatusCode)}
	}

	// Server bỏ qua Range (hoặc If-Range không khớp → file đã đổi): nội dung là toàn bộ file → ghi lại từ 0
	if offset > 0 && resp.StatusCode == http.StatusOK {
		DiagLog("[spool] file=%s server trả 200 cho Range offset=%d → tải lại từ đầu", prog.FileID, offset)
		offset = 0
		prog.DownloadedBytes.Store(0)
		prog.headState.Store(int32(headUnknown))
	}

	etag := resp.Header.Get("ETag")
	if etag != "" {
		e := etag
		prog.ETag.Store(&e)
	} else if p := prog.ETag.Load(); p != nil {
		etag = *p
	}
	if total := totalFromResponse(resp, offset); total > 0 {
		prog.TotalSize.Store(total)
		target := s.targetFor(total)
		prog.TargetBytes.Store(target)
		if offset == 0 {
			s.makeRoom(prog.FileID, target)
		}
	}
	target := prog.TargetBytes.Load()

	flags := os.O_CREATE | os.O_WRONLY
	if offset == 0 {
		flags |= os.O_TRUNC
	}
	f, oerr := os.OpenFile(prog.PartPath, flags, 0644)
	if oerr != nil {
		return offset, false, fatalSpoolErr{fmt.Errorf("không mở được file spool: %w", oerr)}
	}
	defer f.Close()
	if offset > 0 {
		if terr := f.Truncate(offset); terr != nil {
			return offset, false, fatalSpoolErr{terr}
		}
		if _, serr := f.Seek(offset, io.SeekStart); serr != nil {
			return offset, false, fatalSpoolErr{serr}
		}
	}

	th := newThrottle(s.burstBytes, s.bgBytesPerSec)
	buf := make([]byte, 64*1024)
	lastMeta := time.Now()
	saveProgressMeta := func() {
		s.saveMeta(prog.MetaPath, SpoolMeta{
			FileID:          prog.FileID,
			ETag:            etag,
			TotalSize:       prog.TotalSize.Load(),
			DownloadedBytes: offset,
		})
	}

	for {
		if actx.Err() != nil {
			return offset, false, wrap(actx.Err())
		}
		n, rErr := resp.Body.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			if target > 0 && offset+int64(len(chunk)) > target {
				chunk = chunk[:target-offset]
			}
			if _, wErr := f.Write(chunk); wErr != nil {
				return offset, false, fatalSpoolErr{fmt.Errorf("lỗi ghi file spool: %w", wErr)}
			}
			offset += int64(len(chunk))
			prog.DownloadedBytes.Store(offset)
			prog.lastProgress.Store(time.Now().UnixNano())

			if time.Since(lastMeta) > 2*time.Second {
				saveProgressMeta()
				lastMeta = time.Now()
			}
			if target > 0 && offset >= target {
				_ = f.Sync()
				return offset, true, s.finish(prog, offset)
			}
			if werr := th.wait(actx, offset); werr != nil {
				return offset, false, wrap(werr)
			}
		}
		if rErr != nil {
			if rErr == io.EOF {
				total := prog.TotalSize.Load()
				if total > 0 && offset < total {
					saveProgressMeta()
					return offset, false, fmt.Errorf("kết nối đóng sớm tại %d/%d byte: %w", offset, total, io.ErrUnexpectedEOF)
				}
				_ = f.Sync()
				return offset, true, s.finish(prog, offset)
			}
			saveProgressMeta()
			return offset, false, wrap(rErr)
		}
	}
}

// throttle giới hạn tốc độ tải nền sau khi đã "xả" đủ lượng đệm đầu để không tranh băng thông với luồng phát.
type throttle struct {
	burst, bps int64
	started    time.Time
	startOff   int64
}

func newThrottle(burst, bps int64) *throttle { return &throttle{burst: burst, bps: bps} }

func (t *throttle) wait(ctx context.Context, offset int64) error {
	if t.bps <= 0 || offset <= t.burst {
		return nil
	}
	now := time.Now()
	if t.started.IsZero() {
		t.started, t.startOff = now, offset
		return nil
	}
	due := t.started.Add(time.Duration(float64(offset-t.startOff) / float64(t.bps) * float64(time.Second)))
	if d := due.Sub(now); d > 0 {
		if d > 250*time.Millisecond {
			d = 250 * time.Millisecond
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d):
		}
	}
	return nil
}

// neededBytes ước lượng số byte đầu file cần có để cắt [start, start+len]; ok=false nếu không ước lượng được.
func neededBytes(prog *SpoolProgress, startSec, lenSec, totalDurationSec float64) (int64, bool) {
	total := prog.TotalSize.Load()
	if totalDurationSec <= 0 {
		totalDurationSec = 300.0
	}
	block0 := startSec < 0.5
	if total <= 0 {
		if block0 {
			return minBlock0BufferBytes, true
		}
		return 0, false
	}
	avg := float64(total) / totalDurationSec
	need := int64((startSec + lenSec + 10.0) * avg * 1.35) // biên 10s, hệ số 1.35 cho VBR
	if block0 && need < minBlock0BufferBytes {
		need = minBlock0BufferBytes
	}
	if need > total {
		need = total
	}
	return need, true
}

// Acquire cho biết slicer có thể đọc vùng [startSec, startSec+lenSec] từ file spool cục bộ không.
//   - ok=false: dùng đường proxy (không chờ gì thêm).
//   - ok=true, complete=false: file chưa tải xong, người gọi PHẢI kiểm tra kết quả cắt và quay về proxy nếu thiếu.
//
// Block 0 được chờ tối đa block0Wait cho đủ byte đầu; mọi trường hợp khác không chờ.
// Tải đứng/lỗi/hết giờ → trả về ngay (ok=false), không bao giờ chặn pipeline quá block0Wait.
func (s *DriveSpool) Acquire(ctx context.Context, fileID string, startSec, lenSec, totalDurationSec float64) (path string, ok bool, complete bool) {
	s.mu.Lock()
	prog := s.activeProg
	if prog == nil || prog.FileID != fileID {
		s.mu.Unlock()
		return "", false, false
	}
	s.mu.Unlock()

	if prog.Complete.Load() {
		return prog.PartPath, true, true
	}
	if prog.Failed.Load() {
		return "", false, false
	}
	block0 := startSec < 0.5

	if block0 {
		// chờ đủ byte đầu + biết chắc cấu trúc file; thoát sớm khi tải chết
		s.waitFor(ctx, s.block0Wait, func() bool {
			if prog.Complete.Load() || prog.Failed.Load() {
				return true
			}
			need, nok := neededBytes(prog, startSec, lenSec, totalDurationSec)
			if !nok || prog.DownloadedBytes.Load() < need {
				return false
			}
			return prog.head() != headUnknown
		})
		if prog.Complete.Load() {
			return prog.PartPath, true, true
		}
		if prog.Failed.Load() {
			return "", false, false
		}
	}

	need, nok := neededBytes(prog, startSec, lenSec, totalDurationSec)
	if !nok {
		return "", false, false
	}
	if t := prog.TargetBytes.Load(); t > 0 && need > t {
		return "", false, false // vùng nằm ngoài phần sẽ được tải (file lớn chỉ tải prefix)
	}
	if prog.DownloadedBytes.Load() < need {
		return "", false, false
	}

	switch prog.head() {
	case headReady:
		return prog.PartPath, true, false
	case headNotMP4:
		// mkv/webm...: chỉ đọc tuần tự từ đầu mới an toàn khi file còn dở
		if block0 {
			return prog.PartPath, true, false
		}
	}
	return "", false, false // moov ở cuối / chưa rõ → proxy
}

// waitFor thăm dò cond mỗi pollInterval cho tới khi đúng, hết timeout hoặc ctx hủy. Luôn có hạn chót.
func (s *DriveSpool) waitFor(ctx context.Context, timeout time.Duration, cond func() bool) bool {
	if cond() {
		return true
	}
	poll := s.pollInterval
	if poll <= 0 {
		poll = 50 * time.Millisecond
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	tick := time.NewTicker(poll)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return cond()
		case <-deadline.C:
			return cond()
		case <-tick.C:
			if cond() {
				return true
			}
		}
	}
}

// inspectMP4Head đọc các atom cấp cao nhất của file MP4 đang tải dở (avail = số byte hợp lệ đã có).
func inspectMP4Head(path string, avail int64) mp4Head {
	f, err := os.Open(path)
	if err != nil {
		return headUnknown
	}
	defer f.Close()

	var off int64
	for i := 0; i < 64; i++ {
		if off+8 > avail {
			return headUnknown
		}
		var hdr [16]byte
		if n, _ := f.ReadAt(hdr[:8], off); n < 8 {
			return headUnknown
		}
		size := int64(binary.BigEndian.Uint32(hdr[0:4]))
		typ := string(hdr[4:8])
		if i == 0 {
			switch typ {
			case "ftyp", "moov", "mdat", "free", "skip", "wide", "pnot":
			default:
				return headNotMP4
			}
		}
		hdrLen := int64(8)
		if size == 1 { // kích thước 64-bit
			if off+16 > avail {
				return headUnknown
			}
			if n, _ := f.ReadAt(hdr[8:16], off+8); n < 8 {
				return headUnknown
			}
			size = int64(binary.BigEndian.Uint64(hdr[8:16]))
			hdrLen = 16
		}
		switch typ {
		case "mdat":
			return headMoovAtEnd // đã gặp mdat mà chưa thấy moov
		case "moov":
			if size < hdrLen {
				return headUnknown
			}
			if off+size <= avail {
				return headReady
			}
			return headUnknown // moov bắt đầu rồi nhưng chưa tải đủ
		}
		if size < hdrLen {
			return headNotMP4 // atom hỏng / size=0 trước moov
		}
		off += size
	}
	return headUnknown
}

// CancelActive hủy việc tải video hiện tại (khi chuyển video)
func (s *DriveSpool) CancelActive() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.activeProg != nil && s.activeProg.cancel != nil {
		s.activeProg.cancel()
	}
	s.activeProg = nil
	s.activeID = ""
}

// Close hủy tải và chờ goroutine tải thoát hẳn (tối đa 3s) để file không còn bị ghi sau khi đóng.
func (s *DriveSpool) Close() {
	s.mu.Lock()
	prog := s.activeProg
	s.mu.Unlock()
	s.CancelActive()
	if prog != nil && prog.done != nil {
		select {
		case <-prog.done:
		case <-time.After(3 * time.Second):
		}
	}
}

// spoolGroup gom .part + .meta của một video để xóa theo cặp.
type spoolGroup struct {
	id      string
	size    int64
	modTime time.Time
	paths   []string
}

func (s *DriveSpool) groups() map[string]*spoolGroup {
	entries, err := os.ReadDir(s.spoolDir)
	if err != nil {
		return nil
	}
	out := map[string]*spoolGroup{}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		var id string
		switch {
		case strings.HasSuffix(name, ".part"):
			id = strings.TrimSuffix(name, ".part")
		case strings.HasSuffix(name, ".meta"):
			id = strings.TrimSuffix(name, ".meta")
		case strings.HasSuffix(name, ".tmp"):
			id = strings.TrimSuffix(strings.TrimSuffix(name, ".tmp"), ".meta")
		default:
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		g := out[id]
		if g == nil {
			g = &spoolGroup{id: id}
			out[id] = g
		}
		g.size += info.Size()
		if info.ModTime().After(g.modTime) {
			g.modTime = info.ModTime()
		}
		g.paths = append(g.paths, filepath.Join(s.spoolDir, name))
	}
	return out
}

// makeRoom xóa (theo cặp .part+.meta, cũ nhất trước) cho đến khi còn chỗ cho incoming byte.
// Không bao giờ xóa file của video đang tải/phát (keepID và activeID).
func (s *DriveSpool) makeRoom(keepID string, incoming int64) {
	s.mu.Lock()
	activeID := s.activeID
	s.mu.Unlock()

	groups := s.groups()
	var total int64
	list := make([]*spoolGroup, 0, len(groups))
	for _, g := range groups {
		if g.id == keepID {
			continue // phần của chính file này sẽ bị ghi đè/tiếp tục, không tính
		}
		total += g.size
		list = append(list, g)
	}
	if total+incoming <= s.maxSpoolBytes {
		return
	}
	sort.Slice(list, func(i, j int) bool { return list[i].modTime.Before(list[j].modTime) })
	for _, g := range list {
		if total+incoming <= s.maxSpoolBytes {
			break
		}
		if g.id == activeID {
			continue
		}
		for _, p := range g.paths {
			_ = os.Remove(p)
		}
		total -= g.size
		DiagLog("[spool] evict %s (%d bytes)", g.id, g.size)
	}
}

// cleanOrphans dọn file mồ côi từ phiên trước: .meta không có .part, .part/.tmp quá cũ không có .meta.
func (s *DriveSpool) cleanOrphans() {
	for _, g := range s.groups() {
		var hasPart, hasMeta bool
		for _, p := range g.paths {
			switch {
			case strings.HasSuffix(p, ".part"):
				hasPart = true
			case strings.HasSuffix(p, ".meta"):
				hasMeta = true
			}
		}
		stale := time.Since(g.modTime) > 10*time.Minute
		if (hasMeta && !hasPart) || (hasPart && !hasMeta && stale) || (!hasPart && !hasMeta && stale) {
			for _, p := range g.paths {
				_ = os.Remove(p)
			}
		}
	}
}

// saveMeta ghi meta nguyên tử (ghi file tạm rồi đổi tên) để không bao giờ đọc phải nửa chừng.
func (s *DriveSpool) saveMeta(path string, meta SpoolMeta) {
	meta.UpdatedAt = time.Now()
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
	}
}

func (s *DriveSpool) readMeta(path string) (SpoolMeta, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return SpoolMeta{}, err
	}
	var meta SpoolMeta
	err = json.Unmarshal(data, &meta)
	return meta, err
}

func isCanceled(err error) bool {
	return errors.Is(err, context.Canceled)
}
