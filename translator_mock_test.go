package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
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

// TestGTX_RateLimit_And_ExponentialBackoff kiểm tra mã HTTP 429 kích hoạt ErrRateLimited, nhảy bậc backoff (1m -> 2m -> 4m -> 8m -> max 10m), cap step ở 6, và request cũ không mở sớm breaker
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
		gtxBreaker:  NewCircuitBreaker(DefaultBreakerConfig()),
	}

	ctx := context.Background()
	_, err := f.viaGoogle(ctx, []string{"Hello world"})
	if !errors.Is(err, ErrRateLimited) {
		t.Fatalf("kỳ vọng lỗi ErrRateLimited, nhận được: %v", err)
	}

	if !f.isGtxBlocked() {
		t.Fatalf("kỳ vọng breaker mở (chặn Google) sau khi gặp 429")
	}

	if step := f.gtxBreaker.backoffStep.Load(); step != 1 {
		t.Fatalf("kỳ vọng backoff step = 1, nhận: %d", step)
	}

	// Lần 2 gặp 429 khi đang khóa (request thường): bị bỏ qua, step giữ nguyên 1
	f.gtxReport(ErrRateLimited, false)
	if step := f.gtxBreaker.backoffStep.Load(); step != 1 {
		t.Fatalf("kỳ vọng backoff step vẫn giữ 1 khi nhận 429 lúc đang khóa, nhận: %d", step)
	}

	// Probe thất bại do 429 (isProbe = true): tăng bậc 2 (2 phút)
	f.gtxReport(ErrRateLimited, true)
	if step := f.gtxBreaker.backoffStep.Load(); step != 2 {
		t.Fatalf("kỳ vọng backoff step = 2 khi probe thất bại do 429, nhận: %d", step)
	}

	// Test cap step: các lần probe tiếp tục thất bại, step không được vượt quá 6
	for i := 0; i < 10; i++ {
		f.gtxReport(ErrRateLimited, true)
	}
	if step := f.gtxBreaker.backoffStep.Load(); step > 6 {
		t.Fatalf("kỳ vọng step bị cap tối đa ở 6, nhận: %d", step)
	}

	// Request cũ về muộn (isProbe = false, err = nil): KHÔNG được phép mở breaker
	f.gtxReport(nil, false)
	if !f.isGtxBlocked() {
		t.Fatalf("request cũ về muộn (isProbe=false) không được phép đóng breaker")
	}

	// Chỉ request probe (isProbe = true, err = nil) mới được phép đóng breaker và reset backoff
	f.gtxReport(nil, true)
	if f.gtxBreaker.backoffStep.Load() != 0 || f.isGtxBlocked() {
		t.Fatalf("kỳ vọng breaker đóng lại sau khi probe thành công (isProbe=true)")
	}
}

// TestCurrentMode_NoCAS_And_OfflineReport kiểm tra CurrentMode() không gọi CAS làm nuốt lượt probe và báo offline khi không có Qwen
func TestCurrentMode_NoCAS_And_OfflineReport(t *testing.T) {
	f := &FastHybridTranslator{
		phraseCache: NewLRUCache(100),
		gtxBreaker:  NewCircuitBreaker(DefaultBreakerConfig()),
	}

	// Trạng thái bình thường: "api"
	if mode := f.CurrentMode(); mode != "api" {
		t.Fatalf("kỳ vọng mode 'api', nhận: %q", mode)
	}

	// Khóa Google do rate limit, chưa cài đặt model Qwen
	f.gtxBreaker.blockedUntil.Store(time.Now().Add(5 * time.Minute).UnixNano())
	if mode := f.CurrentMode(); mode != "offline" {
		t.Fatalf("kỳ vọng mode 'offline' khi chưa có Qwen model, nhận: %q", mode)
	}

	// Đảm bảo cờ probe không bao giờ bị bật do gọi CurrentMode()
	if f.gtxBreaker.probing.Load() {
		t.Fatalf("CurrentMode() không được phép thay đổi cờ gtxProbing")
	}

	// Khi đã nạp fallback Qwen: báo "local_ai"
	f.fallback = &dummyFallbackTranslator{}
	f.fallbackReady.Store(true)
	if mode := f.CurrentMode(); mode != "local_ai" {
		t.Fatalf("kỳ vọng mode 'local_ai' khi có fallback, nhận: %q", mode)
	}
	if f.gtxBreaker.probing.Load() {
		t.Fatalf("CurrentMode() vẫn không được đổi cờ gtxProbing khi có fallback")
	}
}

// TestHalfOpen_SingleProbeAndRelease kiểm tra cơ chế Half-Open chỉ cấp 1 lượt thử và luôn nhả cờ qua defer
func TestHalfOpen_SingleProbeAndRelease(t *testing.T) {
	f := &FastHybridTranslator{
		phraseCache: NewLRUCache(100),
		gtxBreaker:  NewCircuitBreaker(DefaultBreakerConfig()),
	}

	// Giả lập cooldown vừa hết (until ở quá khứ)
	f.gtxBreaker.blockedUntil.Store(time.Now().Add(-100 * time.Millisecond).UnixNano())

	// Goroutine 1 nhận được quyền probe
	allowed1, isProbe1 := f.allowGtxRequest()
	if !allowed1 || !isProbe1 {
		t.Fatalf("kỳ vọng goroutine 1 nhận quyền probe (true, true), nhận: (%v, %v)", allowed1, isProbe1)
	}

	// Goroutine 2 gọi đồng thời: bị từ chối vì probe đang chạy
	allowed2, isProbe2 := f.allowGtxRequest()
	if allowed2 || isProbe2 {
		t.Fatalf("kỳ vọng goroutine 2 bị chặn (false, false), nhận: (%v, %v)", allowed2, isProbe2)
	}

	// Goroutine 1 thất bại do rate limited: gtxReport phải giải phóng cờ probe
	f.gtxReport(ErrRateLimited, isProbe1)
	if f.gtxBreaker.probing.Load() {
		t.Fatalf("cờ gtxProbing phải được reset về false sau gtxReport")
	}

	// Giả lập cooldown lại hết: Goroutine 3 probe thành công
	f.gtxBreaker.blockedUntil.Store(time.Now().Add(-100 * time.Millisecond).UnixNano())
	allowed3, isProbe3 := f.allowGtxRequest()
	if !allowed3 || !isProbe3 {
		t.Fatalf("kỳ vọng goroutine 3 nhận probe sau khi hết cooldown")
	}

	// Báo thành công -> Breaker đóng hoàn toàn
	f.gtxReport(nil, isProbe3)
	if f.gtxBreaker.probing.Load() {
		t.Fatalf("cờ gtxProbing phải false sau khi probe thành công")
	}
	if f.gtxBreaker.blockedUntil.Load() != 0 {
		t.Fatalf("gtxBlockedUntil phải là 0 sau khi probe thành công")
	}

	// Các request tiếp theo đều được đi qua bình thường (allowed=true, isProbe=false)
	allowedNormal, isProbeNormal := f.allowGtxRequest()
	if !allowedNormal || isProbeNormal {
		t.Fatalf("kỳ vọng request bình thường (true, false), nhận: (%v, %v)", allowedNormal, isProbeNormal)
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
	jsonMismatched := `[[["Xin chào thế giới một hai","Hello world\nOne two",null,null,1]],null,"en"]`

	client := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
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

// TestTranslateBatch_TruncatedOutput_NoPanic kiểm tra khi tầng trước trả về mảng ngắn hơn todo không gây panic và tầng sau tiếp tục bù dòng thiếu
func TestTranslateBatch_TruncatedOutput_NoPanic(t *testing.T) {
	fb := &dummyFallbackTranslator{}
	f := &FastHybridTranslator{
		phraseCache: NewLRUCache(100),
		fallback:    fb,
		gtxBreaker:  NewCircuitBreaker(DefaultBreakerConfig()),
	}

	var mockTier1Called atomic.Bool
	mockTier1 := tier{
		name: "mock_partial",
		translate: func(ctx context.Context, lines []string) ([]string, error) {
			mockTier1Called.Store(true)
			return []string{"Dòng 1 hoàn tất"}, nil // Chỉ trả 1 phần tử cho 3 dòng
		},
		cache:    true,
		fillGaps: true, // Cho phép tầng sau bù dòng thiếu
	}

	var mockTier2Called atomic.Bool
	mockTier2 := tier{
		name: "mock_fallback",
		translate: func(ctx context.Context, lines []string) ([]string, error) {
			mockTier2Called.Store(true)
			res := make([]string, len(lines))
			for i, l := range lines {
				res[i] = "fb: " + l
			}
			return res, nil
		},
		cache:    false,
		fillGaps: false,
	}

	lines := []string{"Line 1", "Line 2", "Line 3"}
	res, err := f.translateWithTiers(context.Background(), lines, []tier{mockTier1, mockTier2})
	if err != nil {
		t.Fatalf("kỳ vọng không lỗi khi tầng 2 bù phần thiếu thành công, nhận: %v", err)
	}
	if len(res) != 3 {
		t.Fatalf("kỳ vọng res đủ 3 phần tử, nhận: %d", len(res))
	}
	if !mockTier1Called.Load() || !mockTier2Called.Load() {
		t.Fatalf("kỳ vọng cả 2 tầng đều được gọi")
	}
	if res[0] != "Dòng 1 hoàn tất" {
		t.Fatalf("dòng 1 phải do tầng 1 dịch, nhận: %q", res[0])
	}
	if res[1] != "fb: Line 2" || res[2] != "fb: Line 3" {
		t.Fatalf("dòng 2 và 3 phải do tầng 2 bù phần thiếu, nhận: %q, %q", res[1], res[2])
	}
}

// TestTranslateBatch_GoogleEmptyLine_NeverWakesQwen kiểm tra khi tầng trước (fillGaps = false) trả về câu rỗng, Qwen tuyệt đối KHÔNG bị đánh thức
func TestTranslateBatch_GoogleEmptyLine_NeverWakesQwen(t *testing.T) {
	fb := &dummyFallbackTranslator{}
	f := &FastHybridTranslator{
		phraseCache: NewLRUCache(100),
		fallback:    fb,
		gtxBreaker:  NewCircuitBreaker(DefaultBreakerConfig()),
	}

	var tier1Called atomic.Bool
	tier1 := tier{
		name: "api",
		translate: func(ctx context.Context, lines []string) ([]string, error) {
			tier1Called.Store(true)
			// Trả về 2 dòng, trong đó dòng 2 là chuỗi rỗng
			return []string{"Câu 1 dịch", ""}, nil
		},
		cache:    true,
		fillGaps: false, // GTX: không đẩy dòng rỗng xuống Qwen
	}

	var qwenCalled atomic.Bool
	qwenTier := tier{
		name: "local_ai",
		translate: func(ctx context.Context, lines []string) ([]string, error) {
			qwenCalled.Store(true)
			return fb.TranslateBatch(ctx, lines)
		},
		cache:    false,
		fillGaps: false,
	}

	lines := []string{"Line 1", "Line 2"}
	res, err := f.translateWithTiers(context.Background(), lines, []tier{tier1, qwenTier})
	if err != nil {
		t.Fatalf("kỳ vọng translateWithTiers thành công, nhận lỗi: %v", err)
	}
	if len(res) != 2 {
		t.Fatalf("kỳ vọng res có 2 phần tử, nhận: %d", len(res))
	}
	if res[0] != "Câu 1 dịch" {
		t.Fatalf("kỳ vọng câu 1 dịch đúng, nhận: %q", res[0])
	}
	if res[1] != "" {
		t.Fatalf("kỳ vọng câu 2 giữ rỗng, nhận: %q", res[1])
	}
	if qwenCalled.Load() {
		t.Fatalf("Qwen fallback KHÔNG được phép bị đánh thức chỉ vì Google trả dòng rỗng!")
	}
	if mode := f.CurrentMode(); mode != "api" {
		t.Fatalf("mode phải là 'api', nhận: %q", mode)
	}
}

type failingFallbackTranslator struct {
	err error
}

func (f *failingFallbackTranslator) Translate(ctx context.Context, line string, _ []string) (string, error) {
	return "", f.err
}

func (f *failingFallbackTranslator) TranslateBatch(ctx context.Context, lines []string) ([]string, error) {
	return nil, f.err
}

func (f *failingFallbackTranslator) Close() error { return nil }

// TestTranslateBatch_AllTiersFail_PreservesCacheAndReturnsError kiểm tra khi cả 2 tầng đều lỗi thì kết quả vẫn giữ các câu trong cache và trả lỗi
func TestTranslateBatch_AllTiersFail_PreservesCacheAndReturnsError(t *testing.T) {
	// Google trả 429
	client := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			return mockResponse(http.StatusTooManyRequests, "Rate Limited")
		}),
	}

	// Qwen fallback cũng bị lỗi
	fb := &failingFallbackTranslator{err: errors.New("llama-server crash")}
	f := &FastHybridTranslator{
		client:      client,
		phraseCache: NewLRUCache(100),
		fallback:    fb,
		gtxBreaker:  NewCircuitBreaker(DefaultBreakerConfig()),
	}
	f.setCached("Cached phrase", "Đã có trong cache")

	lines := []string{"Cached phrase", "New unseen phrase"}
	res, err := f.TranslateBatch(context.Background(), lines)
	if err == nil {
		t.Fatalf("kỳ vọng trả về lỗi khi cả 2 tầng đều thất bại")
	}
	if len(res) != 2 {
		t.Fatalf("kỳ vọng res đủ 2 phần tử, nhận: %d", len(res))
	}
	if res[0] != "Đã có trong cache" {
		t.Fatalf("kỳ vọng câu đã cache được giữ nguyên, nhận: %q", res[0])
	}
	if res[1] != "" {
		t.Fatalf("kỳ vọng câu lỗi chưa dịch được để rỗng, nhận: %q", res[1])
	}
}

// TestTranslateBatch_ContextCanceledAfterTier1Error_Tier2NotCalled kiểm tra khi tầng 1 lỗi và context bị hủy thì dừng ngay, tầng 2 không bao giờ được gọi
func TestTranslateBatch_ContextCanceledAfterTier1Error_Tier2NotCalled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	f := &FastHybridTranslator{
		phraseCache: NewLRUCache(100),
		gtxBreaker:  NewCircuitBreaker(DefaultBreakerConfig()),
	}

	var tier1Called atomic.Bool
	tier1 := tier{
		name: "api",
		translate: func(c context.Context, lines []string) ([]string, error) {
			tier1Called.Store(true)
			// Giả lập tầng 1 lỗi đồng thời người dùng tua video làm hủy context
			cancel()
			return nil, errors.New("temporary server error")
		},
		cache:    true,
		fillGaps: false,
	}

	var tier2Called atomic.Bool
	tier2 := tier{
		name: "local_ai",
		translate: func(c context.Context, lines []string) ([]string, error) {
			tier2Called.Store(true)
			return []string{"dịch từ tầng 2"}, nil
		},
		cache:    false,
		fillGaps: false,
	}

	lines := []string{"Line needing translation"}
	res, err := f.translateWithTiers(ctx, lines, []tier{tier1, tier2})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("kỳ vọng lỗi context.Canceled, nhận: %v", err)
	}
	if res != nil {
		t.Fatalf("kỳ vọng res là nil khi context bị hủy, nhận: %v", res)
	}
	if !tier1Called.Load() {
		t.Fatalf("kỳ vọng tầng 1 đã được gọi")
	}
	if tier2Called.Load() {
		t.Fatalf("kỳ vọng tầng 2 KHÔNG được gọi khi context đã bị hủy sau tầng 1!")
	}
}

// TestTranslateBatch_QwenOutput_NeverCached kiểm tra kết quả dịch từ Qwen fallback tuyệt đối không được ghi vào phraseCache
func TestTranslateBatch_QwenOutput_NeverCached(t *testing.T) {
	// Giả lập Google bị rate limit
	client := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			return mockResponse(http.StatusTooManyRequests, "Rate Limited")
		}),
	}

	fb := &dummyFallbackTranslator{}
	f := &FastHybridTranslator{
		client:      client,
		phraseCache: NewLRUCache(100),
		fallback:    fb,
		gtxBreaker:  NewCircuitBreaker(DefaultBreakerConfig()),
	}

	lines := []string{"Sentence from Qwen"}
	res, err := f.TranslateBatch(context.Background(), lines)
	if err != nil {
		t.Fatalf("kỳ vọng dịch qua Qwen thành công, nhận: %v", err)
	}
	if len(res) != 1 || res[0] != "fb: Sentence from Qwen" {
		t.Fatalf("kỳ vọng nhận câu dịch từ dummyFallback, nhận: %v", res)
	}

	// Đảm bảo không nằm trong phraseCache
	if _, cached := f.getCached("Sentence from Qwen"); cached {
		t.Fatalf("kết quả từ Qwen fallback KHÔNG được phép lưu vào phraseCache")
	}
}

type modeSwitchTranslator struct {
	mode   string
	modeMu sync.RWMutex
}

func (m *modeSwitchTranslator) CurrentMode() string {
	m.modeMu.RLock()
	defer m.modeMu.RUnlock()
	return m.mode
}

func (m *modeSwitchTranslator) setMode(mode string) {
	m.modeMu.Lock()
	m.mode = mode
	m.modeMu.Unlock()
}

func (m *modeSwitchTranslator) Translate(ctx context.Context, line string, _ []string) (string, error) {
	return "trans: " + line, nil
}

func (m *modeSwitchTranslator) TranslateBatch(ctx context.Context, lines []string) ([]string, error) {
	res := make([]string, len(lines))
	for i, l := range lines {
		res[i] = "batch: " + l
	}
	return res, nil
}

func (m *modeSwitchTranslator) Close() error {
	return nil
}

// TestScheduler_Tier2Postpone_TwoWay kiểm tra tính đúng đắn 2 chiều của scheduler:
// - Chiều 1: Khi ở local_ai/offline, block đã hoàn tất Tier-1 không bị scheduler đẩy lại lặp vòng vô tận.
// - Chiều 2: Khi chuyển về api, block được scheduler đẩy lại để dịch nốt các câu Tier-2 còn lại.
func TestScheduler_Tier2Postpone_TwoWay(t *testing.T) {
	tmpDir := t.TempDir()
	store, err := NewBlockStore(tmpDir, CacheMeta{BlockSec: 30, OverlapSec: 2, DurationSec: 60})
	if err != nil {
		t.Fatalf("NewBlockStore error: %v", err)
	}

	mockTrans := &modeSwitchTranslator{mode: "local_ai"}

	p := NewPipeline("test_video.mp4", 60.0, Settings{
		BlockSec:         30.0,
		OverlapSec:       2.0,
		LookaheadMinSec:  10.0,
		LookaheadMaxSec:  60.0,
		TranslateWorkers: 1,
	}, &ToolsPaths{}, store, mockTrans, PipelineEventCallbacks{})

	// Giả lập block 0 đã dịch xong Tier-1, câu Tier-2 tạm hoãn (chưa dịch)
	itemsBlock0 := []SubtitleItem{
		{StartSec: 1.0, EndSec: 3.0, SourceText: "Tier 1 text", TargetText: "Đoạn Tier 1", Translated: true},
		{StartSec: 20.0, EndSec: 25.0, SourceText: "Tier 2 text", TargetText: "", Translated: false},
	}
	_ = store.SaveBlock(0, itemsBlock0)

	// Đánh dấu block 0 đã hoãn Tier-2
	p.mu.Lock()
	p.tier2Deferred[0] = true
	p.playheadSec = 0.0
	p.mu.Unlock()

	// Chiều 1: Khi đang ở local_ai -> IsBlockDone(0) là false nhưng scheduler KHÔNG được chọn block 0
	if store.IsBlockDone(0) {
		t.Fatalf("kỳ vọng block 0 chưa IsBlockDone vì còn câu Tier-2 chưa dịch")
	}

	p.mu.Lock()
	var selectedBlock int = -1
	totalBlocks := 2
	for b := 0; b < totalBlocks; b++ {
		if !p.blockStore.IsBlockDone(b) && !p.activeJobs[b] && p.failedBlocks[b] < 2 {
			if p.tier2Deferred[b] && p.isTier2PostponedMode() {
				continue // Hoãn Tier-2
			}
			selectedBlock = b
			break
		}
	}
	p.mu.Unlock()

	if selectedBlock == 0 {
		t.Fatalf("Chiều 1 THẤT BẠI: Scheduler không được chọn lại block 0 khi đang ở chế độ hoãn local_ai")
	}
	if selectedBlock != 1 {
		t.Fatalf("Chiều 1: Scheduler phải nhảy sang block 1 tiếp theo, nhận: %d", selectedBlock)
	}

	// Chiều 2: Khi chuyển về api (Google online trở lại)
	mockTrans.setMode("api")
	if p.isTier2PostponedMode() {
		t.Fatalf("kỳ vọng isTier2PostponedMode = false khi mode là api")
	}

	p.mu.Lock()
	selectedBlockApi := -1
	for b := 0; b < totalBlocks; b++ {
		if !p.blockStore.IsBlockDone(b) && !p.activeJobs[b] && p.failedBlocks[b] < 2 {
			if p.tier2Deferred[b] && p.isTier2PostponedMode() {
				continue
			}
			selectedBlockApi = b
			break
		}
	}
	p.mu.Unlock()

	if selectedBlockApi != 0 {
		t.Fatalf("Chiều 2 THẤT BẠI: Scheduler phải chọn lại block 0 để hoàn tất Tier-2 khi đã về mode api, nhận: %d", selectedBlockApi)
	}

	// Chiều 3: Block ngắn chỉ có Tier-1 nhưng dịch lỗi trong local_ai/offline
	mockTrans.setMode("local_ai")
	itemsBlockShort := []SubtitleItem{
		{StartSec: 31.0, EndSec: 33.0, SourceText: "Short block line", TargetText: "", Translated: false},
	}
	_ = store.SaveBlock(1, itemsBlockShort)

	// Giả lập worker hoàn tất batch nhưng okCount = 0:
	hasText := 1
	ok := 0
	if ok < hasText && p.isTier2PostponedMode() {
		p.mu.Lock()
		p.tier2Deferred[1] = true
		p.mu.Unlock()
	}

	// Cả block 0 và block 1 đều đã deferred: scheduler không bao giờ bị loop lại
	p.mu.Lock()
	allDeferredSelected := -1
	for b := 0; b < totalBlocks; b++ {
		if !p.blockStore.IsBlockDone(b) && !p.activeJobs[b] && p.failedBlocks[b] < 2 {
			if p.tier2Deferred[b] && p.isTier2PostponedMode() {
				continue
			}
			allDeferredSelected = b
			break
		}
	}
	p.mu.Unlock()

	if allDeferredSelected != -1 {
		t.Fatalf("Chiều 3 THẤT BẠI: Scheduler không được chọn lại block Tier-1 bị lỗi khi đang hoãn, nhận: %d", allDeferredSelected)
	}
}

// TestFastHybrid_ConcurrentProbingAndMode stress test đa luồng chứng minh không có race condition hay deadlock
func TestFastHybrid_ConcurrentProbingAndMode(t *testing.T) {
	f := &FastHybridTranslator{
		phraseCache: NewLRUCache(100),
		gtxBreaker:  NewCircuitBreaker(DefaultBreakerConfig()),
	}
	f.gtxBreaker.blockedUntil.Store(time.Now().Add(-10 * time.Millisecond).UnixNano())

	var wg sync.WaitGroup
	var probeWins atomic.Int32
	var modeQueries atomic.Int32

	// 20 goroutines gọi liên tục CurrentMode()
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				m := f.CurrentMode()
				if m != "" {
					modeQueries.Add(1)
				}
			}
		}()
	}

	// 10 goroutines tranh chấp lượt probe
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			allowed, isProbe := f.allowGtxRequest()
			if allowed && isProbe {
				probeWins.Add(1)
				time.Sleep(1 * time.Millisecond)
				f.gtxReport(ErrRateLimited, true)
			}
		}()
	}

	wg.Wait()

	if wins := probeWins.Load(); wins != 1 {
		t.Fatalf("kỳ vọng đúng 1 goroutine probe ban đầu, nhận: %d", wins)
	}
	if q := modeQueries.Load(); q != 2000 {
		t.Fatalf("kỳ vọng 2000 lượt query mode thành công, nhận: %d", q)
	}
}

// TestTranslateBatch_GTX429_GeminiSuccess_CachedAndModeCloud kiểm tra khi GTX 429, Gemini dịch thành công:
// kết quả đúng, mode chuyển sang 'cloud', và kết quả được lưu vào cache
func TestTranslateBatch_GTX429_GeminiSuccess_CachedAndModeCloud(t *testing.T) {
	gtxClient := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			return mockResponse(http.StatusTooManyRequests, "Google Rate Limited")
		}),
	}

	geminiClientMock := &http.Client{
		Transport: geminiRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			return mockGeminiJSONResponse(http.StatusOK, `[{"id": 0, "vi": "Bản dịch từ Gemini Cloud"}]`, nil), nil
		}),
	}

	cfg := DefaultGeminiConfig()
	cfg.Enabled = true
	cfg.APIKey = "valid_key"
	gemini := NewGeminiClient(cfg, geminiClientMock)

	fb := &dummyFallbackTranslator{}
	f := &FastHybridTranslator{
		client:      gtxClient,
		phraseCache: NewLRUCache(100),
		fallback:    fb,
		gtxBreaker:  NewCircuitBreaker(DefaultBreakerConfig()),
	}
	f.SetGemini(gemini)

	lines := []string{"Hello Cloud"}
	res, err := f.TranslateBatch(context.Background(), lines)
	if err != nil {
		t.Fatalf("kỳ vọng thành công qua Gemini, nhận lỗi: %v", err)
	}
	if len(res) != 1 || res[0] != "Bản dịch từ Gemini Cloud" {
		t.Fatalf("kết quả dịch không đúng: %v", res)
	}
	if mode := f.CurrentMode(); mode != "cloud" {
		t.Fatalf("kỳ vọng mode là 'cloud', nhận: %q", mode)
	}

	// Xác nhận kết quả Gemini ĐƯỢC lưu vào phraseCache
	if c, ok := f.getCached("Hello Cloud"); !ok || c != "Bản dịch từ Gemini Cloud" {
		t.Fatalf("kỳ vọng phraseCache lưu kết quả của Gemini, nhận: %q", c)
	}
}

// TestTranslateBatch_GTXNetworkError_BypassesGemini_DirectToQwen kiểm tra khi GTX rớt mạng thật (errKindNetwork),
// Gemini Cloud TUYỆT ĐỐI KHÔNG ĐƯỢC GỌI, nhảy thẳng xuống Qwen (local_ai)
func TestTranslateBatch_GTXNetworkError_BypassesGemini_DirectToQwen(t *testing.T) {
	gtxClient := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			// Giả lập lỗi DNS / mất mạng Internet
			return nil
		}),
	}
	// Dùng RoundTrip trả về net.Error
	gtxClient.Transport = roundTripFuncWithErr(func(req *http.Request) (*http.Response, error) {
		return nil, &net.DNSError{IsTimeout: true, Err: "no such host"}
	})

	var geminiCalled atomic.Bool
	geminiMock := &http.Client{
		Transport: geminiRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			geminiCalled.Store(true)
			return mockGeminiJSONResponse(http.StatusOK, `[{"id": 0, "vi": "Gemini không nên được gọi"}]`, nil), nil
		}),
	}

	cfg := DefaultGeminiConfig()
	cfg.Enabled = true
	cfg.APIKey = "valid_key"
	gemini := NewGeminiClient(cfg, geminiMock)

	var qwenCalled atomic.Bool
	fb := &dummyFallbackTranslator{}
	f := &FastHybridTranslator{
		client:      gtxClient,
		phraseCache: NewLRUCache(100),
		fallback: &tierRecordingFallback{
			inner:    fb,
			onCalled: func() { qwenCalled.Store(true) },
		},
		gtxBreaker: NewCircuitBreaker(DefaultBreakerConfig()),
	}
	f.SetGemini(gemini)

	lines := []string{"Sentence needing translation"}
	res, err := f.TranslateBatch(context.Background(), lines)
	if err != nil {
		t.Fatalf("kỳ vọng thành công qua Qwen fallback, nhận lỗi: %v", err)
	}
	if len(res) != 1 || res[0] != "fb: Sentence needing translation" {
		t.Fatalf("kỳ vọng nhận kết quả từ Qwen fallback, nhận: %v", res)
	}
	if geminiCalled.Load() {
		t.Fatalf("Lỗi mạng của GTX phải BỎ QUA Gemini và nhảy thẳng xuống Qwen!")
	}
	if !qwenCalled.Load() {
		t.Fatalf("kỳ vọng Qwen fallback đã được gọi")
	}
}

type roundTripFuncWithErr func(req *http.Request) (*http.Response, error)

func (f roundTripFuncWithErr) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

type tierRecordingFallback struct {
	inner    Translator
	onCalled func()
}

func (tr *tierRecordingFallback) Translate(ctx context.Context, line string, ctxLines []string) (string, error) {
	if tr.onCalled != nil {
		tr.onCalled()
	}
	return tr.inner.Translate(ctx, line, ctxLines)
}

func (tr *tierRecordingFallback) TranslateBatch(ctx context.Context, lines []string) ([]string, error) {
	if tr.onCalled != nil {
		tr.onCalled()
	}
	return tr.inner.TranslateBatch(ctx, lines)
}

func (tr *tierRecordingFallback) Close() error { return nil }

// TestTranslateBatch_GeminiMissingLines_FilledByQwen kiểm tra khi Gemini trả thiếu câu,
// nhờ fillGaps: true các câu thiếu được tự động đẩy xuống Qwen bù đắp
func TestTranslateBatch_GeminiMissingLines_FilledByQwen(t *testing.T) {
	gtxClient := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) *http.Response {
			return mockResponse(http.StatusTooManyRequests, "GTX 429")
		}),
	}

	geminiClientMock := &http.Client{
		Transport: geminiRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			// Chỉ trả câu 0, thiếu câu 1
			return mockGeminiJSONResponse(http.StatusOK, `[{"id": 0, "vi": "Câu 0 từ Gemini"}]`, nil), nil
		}),
	}

	cfg := DefaultGeminiConfig()
	cfg.Enabled = true
	cfg.APIKey = "valid_key"
	gemini := NewGeminiClient(cfg, geminiClientMock)

	fb := &dummyFallbackTranslator{}
	f := &FastHybridTranslator{
		client:      gtxClient,
		phraseCache: NewLRUCache(100),
		fallback:    fb,
		gtxBreaker:  NewCircuitBreaker(DefaultBreakerConfig()),
	}
	f.SetGemini(gemini)

	lines := []string{"Line 0", "Line 1"}
	res, err := f.TranslateBatch(context.Background(), lines)
	if err != nil {
		t.Fatalf("kỳ vọng thành công, nhận lỗi: %v", err)
	}
	if len(res) != 2 {
		t.Fatalf("kỳ vọng res đủ 2 phần tử, nhận: %d", len(res))
	}
	if res[0] != "Câu 0 từ Gemini" {
		t.Fatalf("kỳ vọng câu 0 từ Gemini, nhận: %q", res[0])
	}
	if res[1] != "fb: Line 1" {
		t.Fatalf("kỳ vọng câu 1 được Qwen bù đắp, nhận: %q", res[1])
	}

	// Câu 0 (Gemini) được cache, câu 1 (Qwen) KHÔNG được cache
	if c, ok := f.getCached("Line 0"); !ok || c != "Câu 0 từ Gemini" {
		t.Fatalf("kỳ vọng câu của Gemini được cache")
	}
	if _, ok := f.getCached("Line 1"); ok {
		t.Fatalf("kết quả từ Qwen không được phép lưu vào cache")
	}
}

// TestTranslateBatch_GeminiReturnsAllEmpty_DoesNotSetModeCloud kiểm tra khi Gemini trả toàn câu rỗng thì setMode KHÔNG được đặt 'cloud'
func TestTranslateBatch_GeminiReturnsAllEmpty_DoesNotSetModeCloud(t *testing.T) {
	f := &FastHybridTranslator{
		phraseCache: NewLRUCache(100),
		gtxBreaker:  NewCircuitBreaker(DefaultBreakerConfig()),
		currentMode: "api",
	}

	tierGeminiEmpty := tier{
		name: "cloud",
		translate: func(ctx context.Context, lines []string) ([]string, error) {
			// Trả về toàn chuỗi rỗng
			return []string{"", ""}, nil
		},
		cache:    true,
		fillGaps: true,
	}

	lines := []string{"Line 0", "Line 1"}
	res, err := f.translateWithTiers(context.Background(), lines, []tier{tierGeminiEmpty})
	if err != nil {
		t.Fatalf("kỳ vọng nil error, nhận: %v", err)
	}
	if len(res) != 2 || res[0] != "" || res[1] != "" {
		t.Fatalf("kỳ vọng các câu rỗng được giữ nguyên, nhận: %v", res)
	}
	f.modeMu.RLock()
	mode := f.currentMode
	f.modeMu.RUnlock()
	if mode == "cloud" {
		t.Fatalf("setMode KHÔNG được phép đặt 'cloud' khi Gemini chỉ trả về toàn câu rỗng!")
	}
}

// TestTranslateBatch_BothGTXAndGeminiBlocked_NoQwen_ModeOffline kiểm tra khi cả GTX và Gemini cùng bị khóa breaker, và không có Qwen: mode là 'offline'
func TestTranslateBatch_BothGTXAndGeminiBlocked_NoQwen_ModeOffline(t *testing.T) {
	cfg := DefaultGeminiConfig()
	cfg.Enabled = true
	cfg.APIKey = "valid_key"
	gemini := NewGeminiClient(cfg, nil)
	// Khóa breaker Gemini
	gemini.breaker.blockedUntil.Store(time.Now().Add(10 * time.Minute).UnixNano())

	f := &FastHybridTranslator{
		phraseCache: NewLRUCache(100),
		gtxBreaker:  NewCircuitBreaker(DefaultBreakerConfig()),
		modelOK:     false, // Không có Qwen
	}
	f.SetGemini(gemini)
	// Khóa breaker GTX
	f.gtxBreaker.blockedUntil.Store(time.Now().Add(10 * time.Minute).UnixNano())

	if mode := f.CurrentMode(); mode != "offline" {
		t.Fatalf("kỳ vọng CurrentMode là 'offline' khi cả hai tầng cùng khóa và không có Qwen, nhận: %q", mode)
	}
}

// TestPipeline_Tier2NotPostponed_InCloudMode kiểm tra isTier2PostponedMode trả về false khi mode là 'cloud'
func TestPipeline_Tier2NotPostponed_InCloudMode(t *testing.T) {
	cfg := DefaultGeminiConfig()
	cfg.Enabled = true
	cfg.APIKey = "valid_key"
	gemini := NewGeminiClient(cfg, nil)

	f := &FastHybridTranslator{
		phraseCache: NewLRUCache(100),
		gtxBreaker:  NewCircuitBreaker(DefaultBreakerConfig()),
	}
	f.SetGemini(gemini)
	// Khóa breaker GTX để CurrentMode chuyển sang 'cloud'
	f.gtxBreaker.blockedUntil.Store(time.Now().Add(10 * time.Minute).UnixNano())

	if mode := f.CurrentMode(); mode != "cloud" {
		t.Fatalf("kỳ vọng CurrentMode là 'cloud', nhận: %q", mode)
	}

	p := &Pipeline{
		translator: f,
	}
	if p.isTier2PostponedMode() {
		t.Fatalf("kỳ vọng isTier2PostponedMode() = false khi mode là 'cloud' (không được hoãn Tier-2 trên Cloud)!")
	}
}
