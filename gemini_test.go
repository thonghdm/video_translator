package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// roundTripFunc mock HTTP Transport
type geminiRoundTripFunc func(req *http.Request) (*http.Response, error)

func (f geminiRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func mockGeminiJSONResponse(status int, candidateJSON string, headers map[string]string) *http.Response {
	respPayload := geminiResponse{
		Candidates: []geminiCandidate{
			{
				Content: geminiCandidateContent{
					Parts: []geminiCandidatePart{
						{Text: candidateJSON},
					},
				},
			},
		},
	}
	bodyBytes, _ := json.Marshal(respPayload)
	header := make(http.Header)
	header.Set("Content-Type", "application/json")
	for k, v := range headers {
		header.Set(k, v)
	}
	return &http.Response{
		StatusCode: status,
		Header:     header,
		Body:       io.NopCloser(strings.NewReader(string(bodyBytes))),
	}
}

// 1. Test cấu trúc Request: header x-goog-api-key, không có key trên URL, system prompt, context
func TestGemini_RequestFormatting(t *testing.T) {
	var capturedReq *http.Request
	var capturedBody []byte

	client := &http.Client{
		Transport: geminiRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			capturedReq = req
			capturedBody, _ = io.ReadAll(req.Body)
			return mockGeminiJSONResponse(http.StatusOK, `[{"id": 0, "vi": "Chào bạn"}]`, nil), nil
		}),
	}

	cfg := DefaultGeminiConfig()
	cfg.Enabled = true
	cfg.APIKey = "AIzaSyTEST_KEY_987654321"

	g := NewGeminiClient(cfg, client)
	lines := []string{"Hello there"}
	contextLines := []string{"Previous conversation line"}

	res, err := g.TranslateLines(context.Background(), lines, contextLines, true)
	if err != nil {
		t.Fatalf("kỳ vọng thành công, nhận lỗi: %v", err)
	}
	if len(res) != 1 || res[0] != "Chào bạn" {
		t.Fatalf("kỳ vọng 'Chào bạn', nhận: %v", res)
	}

	// Kiểm tra Header
	if keyHeader := capturedReq.Header.Get("x-goog-api-key"); keyHeader != cfg.APIKey {
		t.Fatalf("kỳ vọng x-goog-api-key = %q, nhận: %q", cfg.APIKey, keyHeader)
	}

	// Kiểm tra URL tuyệt đối không chứa key
	if strings.Contains(capturedReq.URL.String(), "key=") {
		t.Fatalf("URL không được phép chứa key, nhận URL: %q", capturedReq.URL.String())
	}

	// Kiểm tra System Prompt và Context trong Body
	bodyStr := string(capturedBody)
	if !strings.Contains(bodyStr, "phụ đề khóa học lập trình") {
		t.Fatalf("body phải chứa system prompt cho phụ đề, nhận: %s", bodyStr)
	}
	if !strings.Contains(bodyStr, "[CONTEXT - KHÔNG DỊCH] Previous conversation line") {
		t.Fatalf("body phải chứa dòng ngữ cảnh được đánh dấu, nhận: %s", bodyStr)
	}
	if !strings.Contains(bodyStr, "response_schema") {
		t.Fatalf("body phải chứa response_schema, nhận: %s", bodyStr)
	}
}

// 2. Test parse phản hồi chuẩn mảng {id, vi}
func TestGemini_ValidResponse(t *testing.T) {
	client := &http.Client{
		Transport: geminiRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			jsonResp := `[{"id": 0, "vi": "Dòng 0 dịch"}, {"id": 1, "vi": "Dòng 1 dịch"}]`
			return mockGeminiJSONResponse(http.StatusOK, jsonResp, nil), nil
		}),
	}

	cfg := DefaultGeminiConfig()
	cfg.Enabled = true
	cfg.APIKey = "valid_key"

	g := NewGeminiClient(cfg, client)
	res, err := g.TranslateLines(context.Background(), []string{"Line 0", "Line 1"}, nil, true)
	if err != nil {
		t.Fatalf("kỳ vọng thành công, nhận lỗi: %v", err)
	}
	if len(res) != 2 || res[0] != "Dòng 0 dịch" || res[1] != "Dòng 1 dịch" {
		t.Fatalf("kết quả dịch không đúng: %v", res)
	}
}

// 3. Test retry riêng ID thiếu và thành công
func TestGemini_MissingID_RetrySucceeds(t *testing.T) {
	var callCount atomic.Int32

	client := &http.Client{
		Transport: geminiRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			cnt := callCount.Add(1)
			if cnt == 1 {
				// Lần 1: gửi 3 câu nhưng chỉ trả id 0 và id 2 (thiếu id 1)
				return mockGeminiJSONResponse(http.StatusOK, `[{"id": 0, "vi": "Dịch 0"}, {"id": 2, "vi": "Dịch 2"}]`, nil), nil
			}
			// Lần 2 (retry): chỉ nhận được id 1 và trả đúng id 1
			body, _ := io.ReadAll(req.Body)
			bodyStr := string(body)
			if !strings.Contains(bodyStr, `"id":1`) && !strings.Contains(bodyStr, `\"id\":1`) {
				t.Errorf("lần retry phải chứa id 1, nhận body: %s", bodyStr)
			}
			return mockGeminiJSONResponse(http.StatusOK, `[{"id": 1, "vi": "Dịch 1 (sau retry)"}]`, nil), nil
		}),
	}

	cfg := DefaultGeminiConfig()
	cfg.Enabled = true
	cfg.APIKey = "valid_key"

	g := NewGeminiClient(cfg, client)
	lines := []string{"Line 0", "Line 1", "Line 2"}
	res, err := g.TranslateLines(context.Background(), lines, nil, true)
	if err != nil {
		t.Fatalf("kỳ vọng thành công sau retry, nhận lỗi: %v", err)
	}
	if callCount.Load() != 2 {
		t.Fatalf("kỳ vọng gọi đúng 2 lần (1 ban đầu + 1 retry), nhận: %d", callCount.Load())
	}
	if len(res) != 3 || res[0] != "Dịch 0" || res[1] != "Dịch 1 (sau retry)" || res[2] != "Dịch 2" {
		t.Fatalf("kết quả sau retry không đúng: %v", res)
	}
}

// 4. Test retry riêng ID thiếu nhưng vẫn thiếu -> để chuỗi rỗng và trả err == nil (để fillGaps đẩy Qwen)
func TestGemini_MissingID_RetryStillMissing_ReturnsEmptyStringAndNilError(t *testing.T) {
	var callCount atomic.Int32

	client := &http.Client{
		Transport: geminiRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			callCount.Add(1)
			// Cả 2 lần đều không trả id 1
			return mockGeminiJSONResponse(http.StatusOK, `[{"id": 0, "vi": "Dịch 0"}]`, nil), nil
		}),
	}

	cfg := DefaultGeminiConfig()
	cfg.Enabled = true
	cfg.APIKey = "valid_key"

	g := NewGeminiClient(cfg, client)
	lines := []string{"Line 0", "Line 1"}
	res, err := g.TranslateLines(context.Background(), lines, nil, true)
	if err != nil {
		t.Fatalf("kỳ vọng err == nil để fillGaps xử lý, nhận lỗi: %v", err)
	}
	if len(res) != 2 {
		t.Fatalf("kỳ vọng res đủ 2 phần tử, nhận: %d", len(res))
	}
	if res[0] != "Dịch 0" {
		t.Fatalf("kỳ vọng res[0] = 'Dịch 0', nhận: %q", res[0])
	}
	if res[1] != "" {
		t.Fatalf("kỳ vọng ID 1 thiếu thì để chuỗi rỗng '', nhận: %q", res[1])
	}
}

// 5. Test response có ID lạ ngoài tập gửi hoặc trùng ID: từ chối đúng
func TestGemini_InvalidOrDuplicateIDs_Rejected(t *testing.T) {
	// Trường hợp 1: ID lạ (gửi 0, nhận 99)
	clientInvalidID := &http.Client{
		Transport: geminiRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			return mockGeminiJSONResponse(http.StatusOK, `[{"id": 99, "vi": "ID lạ"}]`, nil), nil
		}),
	}

	cfg := DefaultGeminiConfig()
	cfg.Enabled = true
	cfg.APIKey = "valid_key"

	g1 := NewGeminiClient(cfg, clientInvalidID)
	_, err := g1.TranslateLines(context.Background(), []string{"Line 0"}, nil, true)
	if !errors.Is(err, ErrInvalidResponseIDs) {
		t.Fatalf("kỳ vọng ErrInvalidResponseIDs khi gặp ID lạ, nhận: %v", err)
	}

	// Trường hợp 2: Trùng ID (hai phần tử cùng id 0)
	clientDuplicateID := &http.Client{
		Transport: geminiRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			return mockGeminiJSONResponse(http.StatusOK, `[{"id": 0, "vi": "Lần 1"}, {"id": 0, "vi": "Lần 2"}]`, nil), nil
		}),
	}

	g2 := NewGeminiClient(cfg, clientDuplicateID)
	_, err2 := g2.TranslateLines(context.Background(), []string{"Line 0"}, nil, true)
	if !errors.Is(err2, ErrInvalidResponseIDs) {
		t.Fatalf("kỳ vọng ErrInvalidResponseIDs khi gặp ID trùng lặp, nhận: %v", err2)
	}
}

// 6. Test Gemini 429 có Retry-After: khóa đúng thời gian
func TestGemini_429_WithRetryAfter_LocksBreaker(t *testing.T) {
	client := &http.Client{
		Transport: geminiRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			header := make(http.Header)
			header.Set("Retry-After", "45") // Khóa 45 giây
			return &http.Response{
				StatusCode: http.StatusTooManyRequests,
				Header:     header,
				Body:       io.NopCloser(strings.NewReader(`{"error": {"message": "Rate limited"}}`)),
			}, nil
		}),
	}

	cfg := DefaultGeminiConfig()
	cfg.Enabled = true
	cfg.APIKey = "valid_key"

	g := NewGeminiClient(cfg, client)
	_, err := g.TranslateLines(context.Background(), []string{"Line 0"}, nil, true)
	if err == nil {
		t.Fatalf("kỳ vọng nhận lỗi khi bị 429")
	}

	// Kiểm tra breaker bị khóa
	if !g.Blocked() {
		t.Fatalf("kỳ vọng breaker bị khóa sau khi nhận 429 kèm Retry-After")
	}
}

// 7. Test timeout & network error: 3 lỗi liên tiếp khóa 2 phút
func TestGemini_ConsecutiveNetworkErrors_LocksBreaker(t *testing.T) {
	client := &http.Client{
		Transport: geminiRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			// Giả lập lỗi timeout mạng
			return nil, &net.DNSError{IsTimeout: true}
		}),
	}

	cfg := DefaultGeminiConfig()
	cfg.Enabled = true
	cfg.APIKey = "valid_key"

	g := NewGeminiClient(cfg, client)

	// Lần 1: lỗi mạng nhưng chưa đủ 3 lần
	g.TranslateLines(context.Background(), []string{"Line 0"}, nil, true)
	if g.Blocked() {
		t.Fatalf("mới 1 lỗi mạng chưa được khóa breaker")
	}

	// Lần 2: lỗi mạng nhưng chưa đủ 3 lần
	g.TranslateLines(context.Background(), []string{"Line 0"}, nil, true)
	if g.Blocked() {
		t.Fatalf("mới 2 lỗi mạng chưa được khóa breaker")
	}

	// Lần 3: chạm ngưỡng 3 lỗi mạng liên tiếp -> khóa breaker 2 phút
	g.TranslateLines(context.Background(), []string{"Line 0"}, nil, true)
	if !g.Blocked() {
		t.Fatalf("sau 3 lỗi mạng liên tiếp breaker bắt buộc phải bị khóa")
	}
}

// 8. Test token bucket hết token: trả về ErrRateLimitedLocal, KHÔNG gọi HTTP và KHÔNG phạt breaker
func TestGemini_TokenBucketExhausted_ReturnsLocalRateLimit_NoHTTP_NoBreakerPenalty(t *testing.T) {
	var httpCallCount atomic.Int32
	client := &http.Client{
		Transport: geminiRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			httpCallCount.Add(1)
			return mockGeminiJSONResponse(http.StatusOK, `[{"id": 0, "vi": "Dịch"}]`, nil), nil
		}),
	}

	cfg := DefaultGeminiConfig()
	cfg.Enabled = true
	cfg.APIKey = "valid_key"
	cfg.RPM = 1
	cfg.TimeoutTier1 = 50 * time.Millisecond // Chờ ngắn để test timeout nhanh

	g := NewGeminiClient(cfg, client)

	// Tiêu thụ hết token có sẵn
	if !g.rateLimiter.TryAcquire(true) {
		t.Fatalf("lần acquire đầu tiên phải thành công")
	}

	// Gọi TranslateLines khi bucket đang trống và thời gian chờ ngắn
	_, err := g.TranslateLines(context.Background(), []string{"Line 0"}, nil, true)
	if !errors.Is(err, ErrRateLimitedLocal) {
		t.Fatalf("kỳ vọng nhận ErrRateLimitedLocal, nhận: %v", err)
	}

	// Xác nhận HTTP không bị gọi
	if httpCallCount.Load() != 0 {
		t.Fatalf("HTTP tuyệt đối không được gọi khi hết token nội bộ, nhận: %d", httpCallCount.Load())
	}

	// Xác nhận breaker Google KHÔNG bị phạt
	if g.Blocked() {
		t.Fatalf("breaker không được phép bị phạt vì lỗi rate limit nội bộ")
	}
}

// 9. Test Tier-1 có quyền ưu tiên token hơn Tier-2
func TestGemini_Tier1_PriorityOver_Tier2(t *testing.T) {
	tb := NewTokenBucket(10)
	// Rút cạn còn đúng 2 token
	tb.tokens = 2.0

	// Tier-2 thử lấy token: phải thất bại vì cần >= 3.0 token (dự trữ cho Tier-1)
	if tb.TryAcquire(false) {
		t.Fatalf("Tier-2 không được phép lấy token khi số lượng <= 2")
	}

	// Tier-1 thử lấy token: phải thành công vì chỉ cần >= 1.0 token
	if !tb.TryAcquire(true) {
		t.Fatalf("Tier-1 bắt buộc lấy được token khi còn 2 token")
	}

	// Giờ còn 1 token: Tier-1 vẫn lấy được nốt
	if !tb.TryAcquire(true) {
		t.Fatalf("Tier-1 bắt buộc lấy được token cuối cùng")
	}

	// Giờ hết token: cả 2 đều không lấy được
	if tb.TryAcquire(true) {
		t.Fatalf("khi 0 token thì Tier-1 cũng không lấy được")
	}
}

// 10. Test context.Canceled: không phạt breaker
func TestGemini_ContextCanceled_DoesNotPenalizeBreaker(t *testing.T) {
	client := &http.Client{
		Transport: geminiRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			return nil, context.Canceled
		}),
	}

	cfg := DefaultGeminiConfig()
	cfg.Enabled = true
	cfg.APIKey = "valid_key"

	g := NewGeminiClient(cfg, client)
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Hủy context ngay

	_, err := g.TranslateLines(ctx, []string{"Line 0"}, nil, true)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("kỳ vọng lỗi context.Canceled, nhận: %v", err)
	}
	if g.Blocked() {
		t.Fatalf("context.Canceled tuyệt đối không được phạt breaker")
	}
}

// 11. Test bảo mật key: API key tuyệt đối không lọt vào log hoặc thông báo lỗi
func TestGemini_KeyLeakagePrevention(t *testing.T) {
	secretKey := "AIzaSySUPER_SECRET_LEAK_CHECK_KEY_777"

	client := &http.Client{
		Transport: geminiRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			// Giả lập server trả về lỗi phản chiếu lại cả chuỗi key
			leakBody := fmt.Sprintf(`{"error": {"message": "Invalid key provided: %s"}}`, secretKey)
			return &http.Response{
				StatusCode: http.StatusBadRequest,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(leakBody)),
			}, nil
		}),
	}

	cfg := DefaultGeminiConfig()
	cfg.Enabled = true
	cfg.APIKey = secretKey

	g := NewGeminiClient(cfg, client)
	_, err := g.TranslateLines(context.Background(), []string{"Line 0"}, nil, true)
	if err == nil {
		t.Fatalf("kỳ vọng nhận lỗi")
	}

	errMsg := err.Error()
	if strings.Contains(errMsg, secretKey) {
		t.Fatalf("API key bị lộ trong thông báo lỗi! errMsg: %s", errMsg)
	}
	if !strings.Contains(errMsg, "[REDACTED_API_KEY]") {
		t.Fatalf("kỳ vọng key được thay thế bằng [REDACTED_API_KEY], nhận: %s", errMsg)
	}
}

// 12. Test Enabled=false hoặc key rỗng: trả về ErrGeminiDisabled ngay lập tức
func TestGemini_DisabledOrEmptyKey(t *testing.T) {
	cfg := DefaultGeminiConfig()
	cfg.Enabled = false
	cfg.APIKey = ""

	g := NewGeminiClient(cfg, nil)
	_, err := g.TranslateLines(context.Background(), []string{"Line 0"}, nil, true)
	if !errors.Is(err, ErrGeminiDisabled) {
		t.Fatalf("kỳ vọng ErrGeminiDisabled khi Enabled=false, nhận: %v", err)
	}

	cfg.Enabled = true
	cfg.APIKey = ""
	g2 := NewGeminiClient(cfg, nil)
	_, err2 := g2.TranslateLines(context.Background(), []string{"Line 0"}, nil, true)
	if !errors.Is(err2, ErrGeminiDisabled) {
		t.Fatalf("kỳ vọng ErrGeminiDisabled khi APIKey='', nhận: %v", err2)
	}
}

// 13. Test parse Retry-After với định dạng HTTP Date và các trường hợp biên
func TestGemini_RetryAfter_HTTPDate(t *testing.T) {
	// Dạng số giây chuẩn
	if d := parseRetryAfter("30"); d != 30*time.Second {
		t.Fatalf("kỳ vọng 30s, nhận: %v", d)
	}
	// Dạng âm / 0
	if d := parseRetryAfter("0"); d != 0 {
		t.Fatalf("kỳ vọng 0s, nhận: %v", d)
	}
	if d := parseRetryAfter("-5"); d != 0 {
		t.Fatalf("kỳ vọng 0s, nhận: %v", d)
	}
	// Dạng rỗng
	if d := parseRetryAfter(""); d != 0 {
		t.Fatalf("kỳ vọng 0s, nhận: %v", d)
	}
	// Dạng HTTP Date trong tương lai (~60s tới)
	futureDate := time.Now().Add(60 * time.Second).UTC().Format(http.TimeFormat)
	dFuture := parseRetryAfter(futureDate)
	if dFuture < 55*time.Second || dFuture > 65*time.Second {
		t.Fatalf("kỳ vọng parse HTTP date ~60s, nhận: %v", dFuture)
	}
	// Dạng HTTP Date đã hết hạn (trong quá khứ)
	pastDate := time.Now().Add(-60 * time.Second).UTC().Format(http.TimeFormat)
	if d := parseRetryAfter(pastDate); d != 0 {
		t.Fatalf("kỳ vọng 0s cho date đã hết hạn, nhận: %v", d)
	}
}

// 14. Test Retry-After ngắn bị chặn sàn 15s và probe thất bại vẫn tăng bậc
func TestGemini_RetryAfter_FloorAndProbeIncrement(t *testing.T) {
	cb := NewCircuitBreaker(DefaultBreakerConfig())

	// Lần 1: nhận 429 với Retry-After chỉ 5 giây (quá ngắn)
	// Bắt buộc được đặt sàn tối thiểu 15 giây
	rlErrShort := &RateLimitError{RetryAfter: 5 * time.Second}
	cb.Report(rlErrShort, false)
	if !cb.Blocked() {
		t.Fatalf("kỳ vọng breaker bị khóa")
	}
	if step := cb.backoffStep.Load(); step != 1 {
		t.Fatalf("kỳ vọng bậc 1 sau lần khóa đầu, nhận: %d", step)
	}

	// Giả lập cooldown kết thúc, thử probe lại (half-open)
	cb.blockedUntil.Store(time.Now().Add(-1 * time.Second).UnixNano())
	allowed, isProbe := cb.Allow()
	if !allowed || !isProbe {
		t.Fatalf("kỳ vọng nhận probe khi cooldown hết")
	}

	// Lần 2 (probe): tiếp tục nhận 429 kèm Retry-After 5s
	// Bắt buộc phải tăng lên bậc 2 và thời gian khóa phải là max(15s, 2m) = 2 phút!
	cb.Report(rlErrShort, true)
	if step := cb.backoffStep.Load(); step != 2 {
		t.Fatalf("probe thất bại bắt buộc phải tăng lên bậc 2, nhận: %d", step)
	}
}

// 15. Test finishReason != STOP (ví dụ SAFETY) trả về lỗi rõ ràng
func TestGemini_FinishReasonSafety_Rejected(t *testing.T) {
	client := &http.Client{
		Transport: geminiRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			respPayload := geminiResponse{
				Candidates: []geminiCandidate{
					{
						FinishReason: "SAFETY",
						Content: geminiCandidateContent{
							Parts: []geminiCandidatePart{{Text: ""}},
						},
					},
				},
			}
			bodyBytes, _ := json.Marshal(respPayload)
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(bytes.NewReader(bodyBytes)),
			}, nil
		}),
	}

	cfg := DefaultGeminiConfig()
	cfg.Enabled = true
	cfg.APIKey = "valid_key"

	g := NewGeminiClient(cfg, client)
	_, err := g.TranslateLines(context.Background(), []string{"Suspicious line"}, nil, true)
	if err == nil {
		t.Fatalf("kỳ vọng nhận lỗi khi finishReason = SAFETY")
	}
	if !strings.Contains(err.Error(), "finishReason=SAFETY") {
		t.Fatalf("lỗi phải chỉ rõ finishReason=SAFETY, nhận: %v", err)
	}
}

// 16. Test Chunking khi số câu vượt quá MaxItemsPerCall: không câu nào bị cắt bỏ
func TestGemini_Chunking_MoreThanMaxItemsPerCall(t *testing.T) {
	var chunkCalls atomic.Int32

	client := &http.Client{
		Transport: geminiRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			cnt := chunkCalls.Add(1)
			var respItems []GeminiResponseItem
			if cnt == 1 {
				respItems = []GeminiResponseItem{
					{ID: 0, VI: "Dịch 0"},
					{ID: 1, VI: "Dịch 1"},
				}
			} else {
				respItems = []GeminiResponseItem{
					{ID: 0, VI: "Dịch 2"},
				}
			}
			respJSON, _ := json.Marshal(respItems)
			return mockGeminiJSONResponse(http.StatusOK, string(respJSON), nil), nil
		}),
	}

	cfg := DefaultGeminiConfig()
	cfg.Enabled = true
	cfg.APIKey = "valid_key"
	cfg.MaxItemsPerCall = 2 // Mỗi chunk tối đa 2 câu

	g := NewGeminiClient(cfg, client)
	// Gửi 3 câu -> phải chia thành 2 chunk (2 câu + 1 câu)
	lines := []string{"Line 0", "Line 1", "Line 2"}
	res, err := g.TranslateLines(context.Background(), lines, nil, true)
	if err != nil {
		t.Fatalf("kỳ vọng dịch 3 câu qua chunking thành công, nhận lỗi: %v", err)
	}
	if chunkCalls.Load() != 2 {
		t.Fatalf("kỳ vọng gọi 2 chunk HTTP, nhận: %d", chunkCalls.Load())
	}
	if len(res) != 3 {
		t.Fatalf("kỳ vọng đủ 3 kết quả, nhận: %d", len(res))
	}
	if res[0] != "Dịch 0" || res[1] != "Dịch 1" || res[2] != "Dịch 2" {
		t.Fatalf("kết quả dịch sau chunking không đúng: %v", res)
	}
}
