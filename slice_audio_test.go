package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"
)

// ---------- tiện ích ----------

func needFFmpeg(t *testing.T) string {
	t.Helper()
	p, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("không có ffmpeg trong PATH")
	}
	return p
}

// makeMP4 tạo video thử (secs giây, ~800kbps) bằng ffmpeg; faststart=false → moov nằm cuối file.
func makeMP4(t *testing.T, dir, name string, secs int, faststart bool) string {
	t.Helper()
	p := filepath.Join(dir, name)
	args := []string{"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=size=640x360:rate=15:duration=" + strconv.Itoa(secs),
		"-f", "lavfi", "-i", "sine=frequency=440:duration=" + strconv.Itoa(secs),
		"-c:v", "libx264", "-b:v", "800k", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac"}
	if faststart {
		args = append(args, "-movflags", "+faststart")
	}
	args = append(args, p)
	if out, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		t.Fatalf("tạo video thử: %v\n%s", err, out)
	}
	return p
}

func cutFile(t *testing.T, src string, frac float64) string {
	t.Helper()
	b, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	p := src + ".part"
	if err := os.WriteFile(p, b[:int(float64(len(b))*frac)], 0644); err != nil {
		t.Fatal(err)
	}
	return p
}

// fakeSpool trả về kết quả định sẵn và ghi lại các lần gọi.
type fakeSpool struct {
	mu       sync.Mutex
	path     string
	ok       bool
	complete bool
	calls    []acquireCall
}

type acquireCall struct {
	fileID                string
	start, length, durSec float64
}

func (f *fakeSpool) Acquire(ctx context.Context, fileID string, start, length, dur float64) (string, bool, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, acquireCall{fileID, start, length, dur})
	return f.path, f.ok, f.complete
}

// proxyCounter giả lập loopback proxy Drive: máy chủ HTTP thật (có Range) phục vụ file đầy đủ, đếm số lần
// ResolveMediaInput bị gọi. full rỗng/không tồn tại → URL vẫn trả về nhưng 404.
type proxyCounter struct {
	mu  sync.Mutex
	url string
	n   int
}

func newProxy(t *testing.T, full string) *proxyCounter {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, full)
	}))
	t.Cleanup(srv.Close)
	return &proxyCounter{url: srv.URL + "/video.mp4"}
}

func (p *proxyCounter) resolve(string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.n++
	return p.url
}
func (p *proxyCounter) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.n
}

func wavLenOrFail(t *testing.T, wav string) float64 {
	t.Helper()
	d, err := wavSecondsFromSize(wav)
	if err != nil {
		t.Fatalf("không có WAV: %v", err)
	}
	return d
}

func driveParams(ffmpeg string, sp spoolSource, px *proxyCounter, dur float64) sliceParams {
	return sliceParams{
		tools:        &ToolsPaths{FFmpeg: ffmpeg, TempDir: os.TempDir()},
		videoPath:    DrivePathFromID("FILEID"),
		spool:        sp,
		resolveInput: px.resolve,
		durationSec:  dur,
	}
}

// ---------- BUG #2: file spool dở dang không được tạo ra WAV hụt âm thầm ----------

func TestSliceBlockAudio_PartialSpoolFallsBackToProxy(t *testing.T) {
	ff := needFFmpeg(t)
	dir := t.TempDir()
	full := makeMP4(t, dir, "full.mp4", 120, true)
	partial := cutFile(t, full, 0.30) // chỉ có 30% đầu file, nhưng cần cắt ở 90s (75%)
	sp := &fakeSpool{path: partial, ok: true, complete: false}
	px := newProxy(t, full)
	wav := filepath.Join(dir, "b.wav")

	used, err := sliceBlockAudio(context.Background(), driveParams(ff, sp, px, 120), BlockRange{ExtractStart: 90, ExtractLen: 30}, wav)
	if err != nil {
		t.Fatalf("lỗi: %v", err)
	}
	if used {
		t.Error("kết quả cuối lấy từ proxy, usedSpool phải false")
	}
	if px.count() != 1 {
		t.Errorf("phải quay về proxy đúng 1 lần, got %d", px.count())
	}
	if got := wavLenOrFail(t, wav); got < 29 {
		t.Errorf("WAV sau fallback còn hụt: %.2fs (cần ~30s)", got)
	}
}

func TestSliceBlockAudio_PartialSpoolThatCoversBlockIsUsed(t *testing.T) {
	ff := needFFmpeg(t)
	dir := t.TempDir()
	full := makeMP4(t, dir, "full.mp4", 120, true)
	partial := cutFile(t, full, 0.60)
	sp := &fakeSpool{path: partial, ok: true, complete: false}
	px := newProxy(t, full)
	wav := filepath.Join(dir, "b.wav")

	used, err := sliceBlockAudio(context.Background(), driveParams(ff, sp, px, 120), BlockRange{ExtractStart: 0, ExtractLen: 30}, wav)
	if err != nil {
		t.Fatal(err)
	}
	if !used || px.count() != 0 {
		t.Errorf("block 0 nằm gọn trong phần đã tải: used=%v proxyCalls=%d", used, px.count())
	}
	if got := wavLenOrFail(t, wav); got < 29 {
		t.Errorf("WAV hụt: %.2fs", got)
	}
}

func TestSliceBlockAudio_MoovAtEndPartialFallsBack(t *testing.T) {
	ff := needFFmpeg(t)
	dir := t.TempDir()
	full := makeMP4(t, dir, "moovend.mp4", 120, false)
	partial := cutFile(t, full, 0.50) // moov ở cuối → ffmpeg không đọc được file dở
	sp := &fakeSpool{path: partial, ok: true, complete: false}
	px := newProxy(t, full)
	wav := filepath.Join(dir, "b.wav")

	used, err := sliceBlockAudio(context.Background(), driveParams(ff, sp, px, 120), BlockRange{ExtractStart: 0, ExtractLen: 30}, wav)
	if err != nil {
		t.Fatalf("phải tự quay về proxy chứ không lỗi: %v", err)
	}
	if used || px.count() != 1 {
		t.Errorf("used=%v proxyCalls=%d (kỳ vọng false/1)", used, px.count())
	}
	if got := wavLenOrFail(t, wav); got < 29 {
		t.Errorf("WAV hụt: %.2fs", got)
	}
}

func TestSliceBlockAudio_SpoolFileMissingFallsBack(t *testing.T) {
	ff := needFFmpeg(t)
	dir := t.TempDir()
	full := makeMP4(t, dir, "full.mp4", 60, true)
	sp := &fakeSpool{path: filepath.Join(dir, "khong-ton-tai.part"), ok: true, complete: false}
	px := newProxy(t, full)
	wav := filepath.Join(dir, "b.wav")

	used, err := sliceBlockAudio(context.Background(), driveParams(ff, sp, px, 60), BlockRange{ExtractStart: 10, ExtractLen: 20}, wav)
	if err != nil || used || px.count() != 1 {
		t.Fatalf("err=%v used=%v proxyCalls=%d", err, used, px.count())
	}
	if got := wavLenOrFail(t, wav); got < 19 {
		t.Errorf("WAV hụt: %.2fs", got)
	}
}

func TestSliceBlockAudio_CompleteSpoolUsedWithoutPostCheck(t *testing.T) {
	ff := needFFmpeg(t)
	dir := t.TempDir()
	full := makeMP4(t, dir, "full.mp4", 120, true)
	sp := &fakeSpool{path: full, ok: true, complete: true}
	px := newProxy(t, "/không/tồn/tại")
	wav := filepath.Join(dir, "b.wav")

	used, err := sliceBlockAudio(context.Background(), driveParams(ff, sp, px, 120), BlockRange{ExtractStart: 80, ExtractLen: 30}, wav)
	if err != nil || !used || px.count() != 0 {
		t.Fatalf("err=%v used=%v proxyCalls=%d", err, used, px.count())
	}
	if got := wavLenOrFail(t, wav); got < 29 {
		t.Errorf("WAV hụt: %.2fs", got)
	}
}

func TestSliceBlockAudio_CompleteSpoolErrorIsNotMasked(t *testing.T) {
	ff := needFFmpeg(t)
	dir := t.TempDir()
	sp := &fakeSpool{path: filepath.Join(dir, "hong.part"), ok: true, complete: true}
	px := newProxy(t, "/không/tồn/tại")

	_, err := sliceBlockAudio(context.Background(), driveParams(ff, sp, px, 60), BlockRange{ExtractStart: 0, ExtractLen: 20}, filepath.Join(dir, "b.wav"))
	if err == nil {
		t.Fatal("file đầy đủ mà ffmpeg lỗi thì phải báo lỗi, không được im lặng")
	}
	if px.count() != 0 {
		t.Error("không được quay về proxy khi file cục bộ đã đủ")
	}
}

func TestSliceBlockAudio_SpoolNotAvailableUsesProxy(t *testing.T) {
	ff := needFFmpeg(t)
	dir := t.TempDir()
	full := makeMP4(t, dir, "full.mp4", 60, true)
	sp := &fakeSpool{ok: false}
	px := newProxy(t, full)
	wav := filepath.Join(dir, "b.wav")

	used, err := sliceBlockAudio(context.Background(), driveParams(ff, sp, px, 60), BlockRange{ExtractStart: 10, ExtractLen: 20}, wav)
	if err != nil || used || px.count() != 1 {
		t.Fatalf("err=%v used=%v proxyCalls=%d", err, used, px.count())
	}
	if len(sp.calls) != 1 || sp.calls[0].fileID != "FILEID" || sp.calls[0].start != 10 || sp.calls[0].length != 20 || sp.calls[0].durSec != 60 {
		t.Errorf("tham số gửi cho spool sai: %+v", sp.calls)
	}
}

func TestSliceBlockAudio_LocalFileNeverTouchesSpool(t *testing.T) {
	ff := needFFmpeg(t)
	dir := t.TempDir()
	full := makeMP4(t, dir, "full.mp4", 60, true)
	sp := &fakeSpool{ok: true, path: "x", complete: true}
	px := newProxy(t, full)
	sparams := driveParams(ff, sp, px, 60)
	sparams.videoPath = full
	wav := filepath.Join(dir, "b.wav")

	used, err := sliceBlockAudio(context.Background(), sparams, BlockRange{ExtractStart: 5, ExtractLen: 20}, wav)
	if err != nil || used || len(sp.calls) != 0 {
		t.Fatalf("err=%v used=%v spoolCalls=%d", err, used, len(sp.calls))
	}
	if got := wavLenOrFail(t, wav); got < 19 {
		t.Errorf("WAV hụt: %.2fs", got)
	}
}

func TestSliceBlockAudio_CanceledContextDoesNotFallBack(t *testing.T) {
	ff := needFFmpeg(t)
	dir := t.TempDir()
	full := makeMP4(t, dir, "full.mp4", 60, true)
	partial := cutFile(t, full, 0.2)
	sp := &fakeSpool{path: partial, ok: true, complete: false}
	px := newProxy(t, full)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := sliceBlockAudio(ctx, driveParams(ff, sp, px, 60), BlockRange{ExtractStart: 40, ExtractLen: 20}, filepath.Join(dir, "b.wav"))
	if err == nil {
		t.Fatal("ctx đã hủy thì phải trả lỗi")
	}
	if px.count() != 0 {
		t.Error("ctx đã hủy: không được chạy tiếp đường proxy")
	}
}

func TestMinAcceptableSeconds(t *testing.T) {
	cases := []struct{ want, min float64 }{{34, 33}, {10, 9}, {2, 1}, {0.5, 0.25}, {0, 0}}
	for _, c := range cases {
		if got := minAcceptableSeconds(c.want); got != c.min {
			t.Errorf("minAcceptableSeconds(%v)=%v want %v", c.want, got, c.min)
		}
	}
}

// ---------- tích hợp DriveSpool thật + slicer ----------

func TestSliceBlockAudio_RealSpoolFullDownloadIsUsed(t *testing.T) {
	ff := needFFmpeg(t)
	dir := t.TempDir()
	full := makeMP4(t, dir, "full.mp4", 120, true)
	data, _ := os.ReadFile(full)

	s := newTestSpool(t, &fakeUp{data: data, etag: `"v1"`})
	s.block0Wait = 10 * time.Second
	s.stallTimeout = 10 * time.Second
	s.StartSpool("FILEID", 0)
	px := newProxy(t, "/không/tồn/tại")
	wav := filepath.Join(dir, "b.wav")

	used, err := sliceBlockAudio(context.Background(), driveParams(ff, s, px, 120), BlockRange{ExtractStart: 0, ExtractLen: 30}, wav)
	if err != nil || !used || px.count() != 0 {
		t.Fatalf("err=%v used=%v proxyCalls=%d", err, used, px.count())
	}
	if got := wavLenOrFail(t, wav); got < 29 {
		t.Errorf("WAV hụt: %.2fs", got)
	}
}

func TestSliceBlockAudio_RealSpoolStalledMoovAtEndFallsBack(t *testing.T) {
	ff := needFFmpeg(t)
	dir := t.TempDir()
	full := makeMP4(t, dir, "moovend.mp4", 120, false)
	data, _ := os.ReadFile(full)

	// tải đứng ở 40% file, moov ở cuối: spool không thể giúp, pipeline vẫn phải ra WAV đủ qua proxy
	s := newTestSpool(t, &fakeUp{data: data, etag: `"v1"`, stallAfter: int64(len(data)) * 4 / 10})
	s.StartSpool("FILEID", 0)
	px := newProxy(t, full)
	wav := filepath.Join(dir, "b.wav")

	t0 := time.Now()
	used, err := sliceBlockAudio(context.Background(), driveParams(ff, s, px, 120), BlockRange{ExtractStart: 0, ExtractLen: 30}, wav)
	if err != nil || used || px.count() != 1 {
		t.Fatalf("err=%v used=%v proxyCalls=%d", err, used, px.count())
	}
	if time.Since(t0) > 15*time.Second {
		t.Errorf("chậm bất thường: %v", time.Since(t0))
	}
	if got := wavLenOrFail(t, wav); got < 29 {
		t.Errorf("WAV hụt: %.2fs", got)
	}
}

// ---------- nối dây: slicerWorker thật phải dùng đường mới ----------

func TestSlicerWorker_UsesSpoolWithFallback(t *testing.T) {
	ff := needFFmpeg(t)
	dir := t.TempDir()
	full := makeMP4(t, dir, "full.mp4", 120, true)
	partial := cutFile(t, full, 0.25) // block 2 (≈58s) nằm ngoài phần đã tải
	sp := &fakeSpool{path: partial, ok: true, complete: false}
	px := newProxy(t, full)

	settings := Settings{BlockSec: 30, OverlapSec: 2, LookaheadMinSec: 15, LookaheadMaxSec: 60, TranslateWorkers: 1}
	tools := &ToolsPaths{FFmpeg: ff, TempDir: dir}
	p := NewPipeline(DrivePathFromID("FILEID"), 120, settings, tools, nil, nil, PipelineEventCallbacks{})
	p.SetSpool(sp)
	p.resolveInput = px.resolve

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	in := make(chan SlicerJob, 1)
	out := make(chan AudioJob, 1)
	in <- SlicerJob{BlockIdx: 2, ScheduledAt: time.Now(), SessionID: 1}
	go p.slicerWorker(ctx, in, out)

	select {
	case job := <-out:
		if job.BlockIdx != 2 {
			t.Fatalf("sai block %d", job.BlockIdx)
		}
		if got := wavLenOrFail(t, job.WavPath); got < job.Range.ExtractLen-1.5 {
			t.Errorf("WAV block 2 hụt: %.2fs / %.2fs", got, job.Range.ExtractLen)
		}
	case <-ctx.Done():
		t.Fatal("slicerWorker không trả AudioJob")
	}
	if len(sp.calls) != 1 || sp.calls[0].fileID != "FILEID" || sp.calls[0].start != 58 {
		t.Errorf("slicerWorker gọi spool sai: %+v", sp.calls)
	}
	if px.count() != 1 {
		t.Errorf("file dở không đủ → phải quay về proxy đúng 1 lần, got %d", px.count())
	}
}

func TestSetSpoolAcceptsInterface(t *testing.T) {
	var _ spoolSource = (*DriveSpool)(nil) // DriveSpool thật phải thỏa interface mà app.go truyền vào
}
