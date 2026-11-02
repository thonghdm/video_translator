package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

const fallthroughStatus = 599 // handler thử nghiệm trả mã này khi ServeRange nhường cho đường proxy Drive

func spoolServer(t *testing.T, s *DriveSpool, fileID string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.ServeRange(w, r, fileID) {
			w.WriteHeader(fallthroughStatus)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func getRange(t *testing.T, url, rng string, hdr map[string]string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	if rng != "" {
		req.Header.Set("Range", rng)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, body
}

func TestParseSingleRange(t *testing.T) {
	cases := []struct {
		h     string
		total int64
		s, e  int64
		ok    bool
	}{
		{"bytes=0-99", 1000, 0, 99, true},
		{"bytes=900-", 1000, 900, 999, true},
		{"bytes=0-", 1000, 0, 999, true},
		{"bytes=-100", 1000, 900, 999, true},
		{"bytes=-5000", 1000, 0, 999, true},
		{"bytes=500-5000", 1000, 500, 999, true},
		{"bytes=1000-", 1000, 0, 0, false},
		{"bytes=5-2", 1000, 0, 0, false},
		{"bytes=0-1,5-6", 1000, 0, 0, false},
		{"items=0-1", 1000, 0, 0, false},
		{"bytes=abc-", 1000, 0, 0, false},
		{"bytes=0-1", 0, 0, 0, false},
		{"bytes=-", 1000, 0, 0, false},
	}
	for _, c := range cases {
		s, e, ok := parseSingleRange(c.h, c.total)
		if ok != c.ok || (ok && (s != c.s || e != c.e)) {
			t.Errorf("parseSingleRange(%q,%d) = %d,%d,%v want %d,%d,%v", c.h, c.total, s, e, ok, c.s, c.e, c.ok)
		}
	}
}

func TestServeRange_CompleteFile(t *testing.T) {
	data := pattern(2<<20 + 11)
	s := newTestSpool(t, &fakeUp{data: data, etag: `"v1"`})
	p := s.StartSpool("vid", 0)
	spoolEventually(t, 5*time.Second, "Complete", p.Complete.Load)
	srv := spoolServer(t, s, "vid")

	resp, body := getRange(t, srv.URL, "bytes=1000-5000", nil)
	if resp.StatusCode != 206 || !bytes.Equal(body, data[1000:5001]) {
		t.Fatalf("status=%d len=%d", resp.StatusCode, len(body))
	}
	if cr := resp.Header.Get("Content-Range"); cr != "bytes 1000-5000/"+strconv.Itoa(len(data)) {
		t.Errorf("Content-Range=%q", cr)
	}
	if resp.Header.Get("Accept-Ranges") != "bytes" || resp.Header.Get("Content-Length") != "4001" {
		t.Errorf("header sai: %v", resp.Header)
	}

	resp, body = getRange(t, srv.URL, "bytes=-100", nil)
	if resp.StatusCode != 206 || !bytes.Equal(body, data[len(data)-100:]) {
		t.Fatalf("suffix range sai: %d %d", resp.StatusCode, len(body))
	}
}

func TestServeRange_FollowsDownloadInProgress(t *testing.T) {
	data := pattern(3 << 20)
	up := &fakeUp{data: data, etag: `"v1"`, chunkDelay: 3 * time.Millisecond}
	s := newTestSpool(t, up)
	s.stallTimeout = 5 * time.Second
	s.StartSpool("vid", 0)
	srv := spoolServer(t, s, "vid")

	// request mở "bytes=0-" khi mới tải được một phần: phải chờ và nhận đủ file khi spool tải tiếp
	resp, body := getRange(t, srv.URL, "bytes=0-", nil)
	if resp.StatusCode != 206 || !bytes.Equal(body, data) {
		t.Fatalf("status=%d len=%d want %d", resp.StatusCode, len(body), len(data))
	}
}

func TestServeRange_FarAheadOfFrontierFallsThrough(t *testing.T) {
	data := pattern(40 << 20)
	up := &fakeUp{data: data, etag: `"v1"`, stallAfter: 1 << 20} // spool chỉ có ~1MB
	s := newTestSpool(t, up)
	s.stallTimeout = 10 * time.Second
	p := s.StartSpool("vid", 0)
	spoolEventually(t, 5*time.Second, "có 1MB", func() bool { return p.DownloadedBytes.Load() >= 1<<20 })
	srv := spoolServer(t, s, "vid")

	resp, _ := getRange(t, srv.URL, "bytes=30000000-", nil)
	if resp.StatusCode != fallthroughStatus {
		t.Fatalf("tua xa khỏi vùng đã tải phải nhường cho Drive, got %d", resp.StatusCode)
	}
	resp, body := getRange(t, srv.URL, "bytes=0-99", nil)
	if resp.StatusCode != 206 || !bytes.Equal(body, data[:100]) {
		t.Fatalf("vùng đã tải phải phục vụ được: %d", resp.StatusCode)
	}
}

func TestServeRange_FallsThroughWhenNotApplicable(t *testing.T) {
	data := pattern(1 << 20)
	s := newTestSpool(t, &fakeUp{data: data, etag: `"v1"`})
	p := s.StartSpool("vid", 0)
	spoolEventually(t, 5*time.Second, "Complete", p.Complete.Load)

	srvOther := spoolServer(t, s, "khac")
	if resp, _ := getRange(t, srvOther.URL, "bytes=0-9", nil); resp.StatusCode != fallthroughStatus {
		t.Errorf("khác fileID phải nhường, got %d", resp.StatusCode)
	}
	srv := spoolServer(t, s, "vid")
	if resp, _ := getRange(t, srv.URL, "", nil); resp.StatusCode != fallthroughStatus {
		t.Errorf("không có Range phải nhường, got %d", resp.StatusCode)
	}
	if resp, _ := getRange(t, srv.URL, "bytes=0-9", map[string]string{"If-Range": `"cũ"`}); resp.StatusCode != fallthroughStatus {
		t.Errorf("If-Range lệch ETag phải nhường, got %d", resp.StatusCode)
	}
	if resp, _ := getRange(t, srv.URL, "bytes=0-9", map[string]string{"If-Range": `"v1"`}); resp.StatusCode != 206 {
		t.Errorf("If-Range khớp ETag phải phục vụ, got %d", resp.StatusCode)
	}
	if resp, _ := getRange(t, srv.URL, "bytes=99999999-", nil); resp.StatusCode != fallthroughStatus {
		t.Errorf("Range ngoài file phải nhường để Drive trả 416, got %d", resp.StatusCode)
	}
	req, _ := http.NewRequest("POST", srv.URL, nil)
	req.Header.Set("Range", "bytes=0-9")
	if resp, err := http.DefaultClient.Do(req); err != nil || resp.StatusCode != fallthroughStatus {
		t.Errorf("POST phải nhường")
	}
}

func TestServeRange_FailedSpoolFallsThrough(t *testing.T) {
	s := newTestSpool(t, &fakeUp{data: pattern(1 << 20), status: http.StatusForbidden})
	p := s.StartSpool("vid", 0)
	spoolEventually(t, 3*time.Second, "Failed", p.Failed.Load)
	srv := spoolServer(t, s, "vid")
	if resp, _ := getRange(t, srv.URL, "bytes=0-9", nil); resp.StatusCode != fallthroughStatus {
		t.Fatalf("spool hỏng phải nhường, got %d", resp.StatusCode)
	}
}

func TestServeRange_StalledDownloadEndsResponseInsteadOfHanging(t *testing.T) {
	data := pattern(8 << 20)
	up := &fakeUp{data: data, etag: `"v1"`, stallAfter: 512 << 10}
	s := newTestSpool(t, up) // stallTimeout 200ms, maxRetries 2
	s.StartSpool("vid", 0)
	srv := spoolServer(t, s, "vid")

	t0 := time.Now()
	resp, body := getRange(t, srv.URL, "bytes=0-", nil)
	if time.Since(t0) > 10*time.Second {
		t.Fatalf("treo %v", time.Since(t0))
	}
	if resp.StatusCode != 206 {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	if len(body) >= len(data) || !bytes.Equal(body, data[:len(body)]) {
		t.Fatalf("phần đã gửi phải là tiền tố đúng của file (len=%d)", len(body))
	}
}

func TestServeRange_PrefixModeClampsRange(t *testing.T) {
	data := pattern(8 << 20)
	s := NewDriveSpool(t.TempDir(), 4<<20, &fakeUp{data: data, etag: `"v1"`})
	s.prefixBytes = 1 << 20
	s.bgBytesPerSec = 0
	defer s.Close()
	p := s.StartSpool("vid", 0)
	spoolEventually(t, 5*time.Second, "đủ prefix", func() bool { return p.DownloadedBytes.Load() >= 1<<20 })
	srv := spoolServer(t, s, "vid")

	resp, body := getRange(t, srv.URL, "bytes=0-", nil)
	if resp.StatusCode != 206 || len(body) != 1<<20 || !bytes.Equal(body, data[:1<<20]) {
		t.Fatalf("status=%d len=%d", resp.StatusCode, len(body))
	}
	if cr := resp.Header.Get("Content-Range"); !strings.HasPrefix(cr, "bytes 0-1048575/") {
		t.Errorf("Content-Range=%q", cr)
	}
	if resp, _ := getRange(t, srv.URL, "bytes=2000000-", nil); resp.StatusCode != fallthroughStatus {
		t.Errorf("ngoài prefix phải nhường, got %d", resp.StatusCode)
	}
}

func TestServeRange_HeadHasHeadersOnly(t *testing.T) {
	data := pattern(1 << 20)
	s := newTestSpool(t, &fakeUp{data: data, etag: `"v1"`})
	p := s.StartSpool("vid", 0)
	spoolEventually(t, 5*time.Second, "Complete", p.Complete.Load)
	srv := spoolServer(t, s, "vid")

	req, _ := http.NewRequest("HEAD", srv.URL, nil)
	req.Header.Set("Range", "bytes=0-99")
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 206 || resp.Header.Get("Content-Range") == "" {
		t.Fatalf("HEAD: err=%v resp=%+v", err, resp)
	}
}

func TestSetDriveSpoolServer_NilDisables(t *testing.T) {
	SetDriveSpoolServer(nil)
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/drive/stream", nil)
	r.Header.Set("Range", "bytes=0-1")
	if serveFromSpool(w, r, "vid") {
		t.Fatal("chưa đăng ký spool thì không được xử lý")
	}
}
