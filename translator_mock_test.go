package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(req *http.Request) *http.Response

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req), nil
}

func mockResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
	}
}

type dummyFallbackTranslator struct {
	calledBatch bool
	batchResult []string
}

func (d *dummyFallbackTranslator) Translate(ctx context.Context, line string, _ []string) (string, error) {
	return "fallback: " + line, nil
}

func (d *dummyFallbackTranslator) TranslateBatch(ctx context.Context, lines []string) ([]string, error) {
	d.calledBatch = true
	res := make([]string, len(lines))
	for i, l := range lines {
		res[i] = "fb: " + l
	}
	return res, nil
}

func (d *dummyFallbackTranslator) Close() error {
	return nil
}

// TestGTX_RateLimit_And_ExponentialBackoff kiểm tra mã HTTP 429 kích hoạt ErrRateLimited và nhảy bậc backoff
func TestGTX_RateLimit_And_ExponentialBackoff(t *testing.T) {
	client := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			return mockResponse(http.StatusTooManyRequests, "Too Many Requests")
		}),
	}

	fb := &dummyFallbackTranslator{}
	f := &FastHybridTranslator{
		client:      client,
		phraseCache: NewLRUCache(100),
		fallback:    fb,
	}

	ctx := context.Background()
	_, err := f.viaGoogle(ctx, []string{"Hello world"})
	if !errors.Is(err, ErrRateLimited) {
		t.Fatalf("kỳ vọng lỗi ErrRateLimited, nhận được: %v", err)
	}

	if f.gtxAllowed() {
		t.Fatalf("kỳ vọng breaker mở (chặn Google) sau khi gặp 429")
	}

	if step := f.gtxBackoffStep.Load(); step != 1 {
		t.Fatalf("kỳ vọng backoff step = 1, nhận: %d", step)
	}

	// Lần 2 gặp 429: tăng bậc 2
	f.gtxReport(ErrRateLimited)
	if step := f.gtxBackoffStep.Load(); step != 2 {
		t.Fatalf("kỳ vọng backoff step = 2, nhận: %d", step)
	}

	// Reset khi có request thành công
	f.gtxReport(nil)
	if f.gtxBackoffStep.Load() != 0 || !f.gtxAllowed() {
		t.Fatalf("kỳ vọng breaker đóng lại sau khi report nil error")
	}
}

// TestGTX_HtmlCaptchaDetection kiểm tra Google trả về trang Captcha HTML được nhận diện là rate limit
func TestGTX_HtmlCaptchaDetection(t *testing.T) {
	captchaHTML := `<!DOCTYPE html><html><body><form id="captcha">Please solve captcha</form></body></html>`
	client := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			return mockResponse(http.StatusOK, captchaHTML)
		}),
	}

	f := &FastHybridTranslator{
		client:      client,
		phraseCache: NewLRUCache(100),
	}

	_, err := f.translateFastGTX(context.Background(), "Hello")
	if !errors.Is(err, ErrRateLimited) {
		t.Fatalf("kỳ vọng HTML captcha trả về ErrRateLimited, nhận được: %v", err)
	}
}

// TestGTX_LineMismatchFallback kiểm tra khi Google gộp/lệch dòng sẽ tăng mismatchCount và fallback từng dòng
func TestGTX_LineMismatchFallback(t *testing.T) {
	// Giả lập Google trả về JSON gộp 2 câu thành 1 dòng duy nhất
	jsonMismatched := `[[["Xin chào thế giới một hai","Hello world\nOne two",null,null,1]],null,"en"]`

	client := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			// Nếu query chứa \n -> trả về 1 dòng lệch; nếu query từng câu -> trả về đúng
			if strings.Contains(req.URL.RawQuery, "%0A") || strings.Contains(req.URL.RawQuery, "\n") {
				return mockResponse(http.StatusOK, jsonMismatched)
			}
			return mockResponse(http.StatusOK, `[[["Dịch đơn lẻ","Single",null,null,1]],null,"en"]`)
		}),
	}

	f := &FastHybridTranslator{
		client:      client,
		phraseCache: NewLRUCache(100),
	}

	lines := []string{"Hello world", "One two"}
	out, err := f.googleBatchOrPerLine(context.Background(), lines)
	if err != nil {
		t.Fatalf("googleBatchOrPerLine lỗi: %v", err)
	}

	if f.mismatchCount.Load() == 0 {
		t.Fatalf("kỳ vọng mismatchCount tăng khi số dòng trả về không khớp")
	}

	if len(out) != 2 || out[0] != "Dịch đơn lẻ" || out[1] != "Dịch đơn lẻ" {
		t.Fatalf("kết quả fallback từng dòng không đúng: %v", out)
	}
}

// TestGTX_PreserveCacheOnFailure kiểm tra các câu đã có trong cache được giữ nguyên khi network lỗi
func TestGTX_PreserveCacheOnFailure(t *testing.T) {
	client := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			return mockResponse(http.StatusInternalServerError, "Server Error")
		}),
	}

	f := &FastHybridTranslator{
		client:      client,
		phraseCache: NewLRUCache(100),
	}
	f.setCached("Hello cached", "Xin chào có sẵn")

	lines := []string{"Hello cached", "Unseen line"}
	res, err := f.TranslateBatch(context.Background(), lines)

	if err == nil {
		t.Fatalf("kỳ vọng trả về lỗi vì câu chưa cache bị lỗi mạng")
	}
	if len(res) != 2 {
		t.Fatalf("kỳ vọng res có 2 phần tử, nhận: %d", len(res))
	}
	if res[0] != "Xin chào có sẵn" {
		t.Fatalf("kỳ vọng câu đã cache được giữ nguyên, nhận: %q", res[0])
	}
	if res[1] != "" {
		t.Fatalf("kỳ vọng câu lỗi trả về rỗng, nhận: %q", res[1])
	}
}

// TestGTX_ContextCanceledNoFallback kiểm tra tua video (context canceled) không kích hoạt fallback Qwen
func TestGTX_ContextCanceledNoFallback(t *testing.T) {
	client := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			return mockResponse(http.StatusGatewayTimeout, "Gateway Timeout")
		}),
	}

	fb := &dummyFallbackTranslator{}
	f := &FastHybridTranslator{
		client:      client,
		phraseCache: NewLRUCache(100),
		fallback:    fb,
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Giả lập tua video hủy context ngay lập tức

	_, err := f.TranslateBatch(ctx, []string{"Some line"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("kỳ vọng context.Canceled, nhận được: %v", err)
	}
	if fb.calledBatch {
		t.Fatalf("kỳ vọng Qwen fallback KHÔNG bị đánh thức khi context đã bị hủy")
	}
}
