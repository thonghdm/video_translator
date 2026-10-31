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
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	// ErrRateLimitedLocal biểu thị bucket hết token, không gọi HTTP và không phạt Google breaker
	ErrRateLimitedLocal = errors.New("gemini: rate limit reached (local token bucket)")
	// ErrGeminiDisabled biểu thị tầng Gemini chưa được bật hoặc chưa cấu hình API key
	ErrGeminiDisabled = errors.New("gemini: disabled or missing API key")
	// ErrGeminiBreakerOpen biểu thị breaker của Gemini đang ở trạng thái khóa
	ErrGeminiBreakerOpen = errors.New("gemini: breaker open")
	// ErrInvalidResponseIDs biểu thị phản hồi chứa ID lạ ngoài danh sách gửi hoặc bị trùng lặp ID
	ErrInvalidResponseIDs = errors.New("gemini: invalid or unexpected response IDs")
)

// GeminiConfig chứa toàn bộ tham số cấu hình cho tầng Gemini Cloud
type GeminiConfig struct {
	Enabled         bool          `json:"enabled"`
	Model           string        `json:"model"`
	APIKey          string        `json:"api_key"`
	Endpoint        string        `json:"endpoint"`
	RPM             int           `json:"rpm"`
	TimeoutTier1    time.Duration `json:"timeout_tier1"`
	TimeoutTier2    time.Duration `json:"timeout_tier2"`
	MaxItemsPerCall int           `json:"max_items_per_call"`
}

// DefaultGeminiModel là model mặc định được tối ưu latency cho dịch thuật video
const DefaultGeminiModel = "gemini-3.5-flash-lite"

// DefaultGeminiConfig trả về cấu hình mặc định an toàn cho Gemini Cloud
func DefaultGeminiConfig() GeminiConfig {
	return GeminiConfig{
		Enabled:         false, // Mặc định tắt
		Model:           DefaultGeminiModel, // Model nhẹ, độ trễ p50 ~1.19s, hỗ trợ JSON Schema
		APIKey:          "",
		Endpoint:        "https://generativelanguage.googleapis.com/v1beta/models",
		RPM:             12, // Đặt 12 RPM (thấp hơn 20% so với trần 15 RPM của free tier để an toàn)
		TimeoutTier1:    3500 * time.Millisecond,
		TimeoutTier2:    8000 * time.Millisecond,
		MaxItemsPerCall: 10,
	}
}

// TokenBucket điều tiết tần suất request (RPM) với quyền ưu tiên cho Tier-1
type TokenBucket struct {
	mu         sync.Mutex
	capacity   float64
	tokens     float64
	fillRate   float64 // số token nạp lại mỗi giây
	lastRefill time.Time
}

// NewTokenBucket khởi tạo TokenBucket dựa trên RPM
func NewTokenBucket(rpm int) *TokenBucket {
	if rpm <= 0 {
		rpm = 12
	}
	rate := float64(rpm) / 60.0
	return &TokenBucket{
		capacity:   float64(rpm),
		tokens:     float64(rpm),
		fillRate:   rate,
		lastRefill: time.Now(),
	}
}

func (tb *TokenBucket) refillLocked() {
	now := time.Now()
	elapsed := now.Sub(tb.lastRefill).Seconds()
	if elapsed > 0 {
		tb.tokens += elapsed * tb.fillRate
		if tb.tokens > tb.capacity {
			tb.tokens = tb.capacity
		}
		tb.lastRefill = now
	}
}

// HasTokens kiểm tra xem bucket hiện có ít nhất 1 token không
func (tb *TokenBucket) HasTokens() bool {
	tb.mu.Lock()
	defer tb.mu.Unlock()
	tb.refillLocked()
	return tb.tokens >= 1.0
}

// TryAcquire kiểm tra và tiêu tốn 1 token.
// Tier-1 (ưu tiên): chỉ cần >= 1.0 token.
// Tier-2: bắt buộc >= 3.0 token (dự trữ ít nhất 2 token cho Tier-1).
func (tb *TokenBucket) TryAcquire(isTier1 bool) bool {
	tb.mu.Lock()
	defer tb.mu.Unlock()
	tb.refillLocked()

	minTokens := 1.0
	if !isTier1 {
		minTokens = 3.0
	}

	if tb.tokens >= minTokens {
		tb.tokens -= 1.0
		return true
	}
	return false
}

// Acquire chờ lấy token trong khoảng waitTimeout. Nếu hết hạn chờ thì trả về ErrRateLimitedLocal.
func (tb *TokenBucket) Acquire(ctx context.Context, isTier1 bool, waitTimeout time.Duration) error {
	if tb.TryAcquire(isTier1) {
		return nil
	}

	timer := time.NewTimer(waitTimeout)
	defer timer.Stop()

	ticker := time.NewTicker(40 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return ErrRateLimitedLocal
		case <-ticker.C:
			if tb.TryAcquire(isTier1) {
				return nil
			}
		}
	}
}

// GeminiItem đại diện cho một câu cần dịch kèm ID
type GeminiItem struct {
	ID   int    `json:"id"`
	Text string `json:"text"`
}

// GeminiResponseItem đại diện cho câu đã dịch kèm ID từ Gemini
type GeminiResponseItem struct {
	ID int    `json:"id"`
	VI string `json:"vi"`
}

// Cấu trúc REST JSON cho Gemini API
type geminiPart struct {
	Text string `json:"text"`
}

type geminiContent struct {
	Role  string       `json:"role,omitempty"`
	Parts []geminiPart `json:"parts"`
}

type geminiSystemInstruction struct {
	Parts []geminiPart `json:"parts"`
}

type geminiProperty struct {
	Type string `json:"type"`
}

type geminiItemsSchema struct {
	Type       string                    `json:"type"`
	Properties map[string]geminiProperty `json:"properties"`
	Required   []string                  `json:"required"`
}

type geminiResponseSchema struct {
	Type  string            `json:"type"`
	Items geminiItemsSchema `json:"items"`
}

type geminiGenerationConfig struct {
	ResponseMimeType string               `json:"response_mime_type"`
	ResponseSchema   geminiResponseSchema `json:"response_schema"`
}

type geminiRequestBody struct {
	SystemInstruction *geminiSystemInstruction `json:"system_instruction,omitempty"`
	Contents          []geminiContent          `json:"contents"`
	GenerationConfig  geminiGenerationConfig   `json:"generation_config"`
}

type geminiCandidatePart struct {
	Text string `json:"text"`
}

type geminiCandidateContent struct {
	Parts []geminiCandidatePart `json:"parts"`
}

type geminiCandidate struct {
	Content      geminiCandidateContent `json:"content"`
	FinishReason string                 `json:"finishReason"`
}

type geminiResponse struct {
	Candidates []geminiCandidate `json:"candidates"`
	Error      *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Status  string `json:"status"`
	} `json:"error,omitempty"`
}

// GeminiClient quản lý kết nối, ngắt mạch và giới hạn tần suất cho Gemini API
type GeminiClient struct {
	cfg         GeminiConfig
	client      *http.Client
	breaker     *CircuitBreaker
	rateLimiter *TokenBucket
}

// NewGeminiClient khởi tạo client cho Gemini
func NewGeminiClient(cfg GeminiConfig, client *http.Client) *GeminiClient {
	if client == nil {
		// Dùng chung transport với GTX/Llama để tái sử dụng kết nối TLS/HTTP2 (mặc định chỉ giữ 2 idle conn/host)
		client = &http.Client{Timeout: 15 * time.Second, Transport: sharedHTTPTransport}
	}
	if cfg.RPM <= 0 {
		cfg.RPM = 12
	}
	// Cấu hình CircuitBreaker độc lập cho Gemini
	bCfg := BreakerConfig{
		BaseBackoff:              1 * time.Minute,
		MaxBackoff:               10 * time.Minute,
		ProbeFailCooldown:        1 * time.Minute,
		NetworkCooldown:          2 * time.Minute,
		ConsecutiveFailThreshold: 3,
		MaxBackoffStep:           6,
	}
	return &GeminiClient{
		cfg:         cfg,
		client:      client,
		breaker:     NewCircuitBreaker(bCfg),
		rateLimiter: NewTokenBucket(cfg.RPM),
	}
}

func (c *GeminiClient) sanitize(msg string) string {
	if c.cfg.APIKey != "" && strings.Contains(msg, c.cfg.APIKey) {
		return strings.ReplaceAll(msg, c.cfg.APIKey, "[REDACTED_API_KEY]")
	}
	return msg
}

// Blocked trả về trạng thái khóa của Gemini breaker (read-only atomic load)
func (c *GeminiClient) Blocked() bool {
	return c.breaker.Blocked()
}

// Available kiểm tra xem Gemini có sẵn sàng dịch không: được bật, có key, breaker không khóa và bucket còn token
func (c *GeminiClient) Available() bool {
	if !c.cfg.Enabled || c.cfg.APIKey == "" || c.breaker.Blocked() {
		return false
	}
	return c.rateLimiter.HasTokens()
}

// TranslateLines dịch một danh sách câu qua Gemini Cloud.
// Nếu số câu vượt quá MaxItemsPerCall, tự động chia nhỏ thành các chunk để không bao giờ cắt bỏ câu.
// Tự động validate ID, retry 1 lần với riêng các ID thiếu, và trả về mảng kết quả đúng thứ tự.
func (c *GeminiClient) TranslateLines(ctx context.Context, lines []string, contextLines []string, isTier1 bool) ([]string, error) {
	if !c.cfg.Enabled || c.cfg.APIKey == "" {
		return nil, ErrGeminiDisabled
	}
	if len(lines) == 0 {
		return []string{}, nil
	}

	maxChunk := c.cfg.MaxItemsPerCall
	if maxChunk <= 0 {
		maxChunk = 10
	}

	if len(lines) > maxChunk {
		res := make([]string, len(lines))
		var lastErr error
		translatedAny := false
		for start := 0; start < len(lines); start += maxChunk {
			end := start + maxChunk
			if end > len(lines) {
				end = len(lines)
			}
			chunkLines := lines[start:end]
			var chunkContext []string
			if start == 0 {
				chunkContext = contextLines
			} else {
				prevCount := 2
				if start < prevCount {
					prevCount = start
				}
				chunkContext = lines[start-prevCount : start]
			}
			chunkRes, err := c.translateChunk(ctx, chunkLines, chunkContext, isTier1)
			if err != nil {
				lastErr = err
				// Giữ các dòng của chunk lỗi là chuỗi rỗng để fillGaps đẩy xuống Qwen
				continue
			}
			for i, r := range chunkRes {
				if r != "" {
					translatedAny = true
					res[start+i] = r
				}
			}
		}
		if !translatedAny && lastErr != nil {
			return nil, lastErr
		}
		return res, nil
	}

	return c.translateChunk(ctx, lines, contextLines, isTier1)
}

func (c *GeminiClient) translateChunk(ctx context.Context, lines []string, contextLines []string, isTier1 bool) ([]string, error) {
	timeout := c.cfg.TimeoutTier2
	if isTier1 {
		timeout = c.cfg.TimeoutTier1
	}
	if timeout <= 0 {
		timeout = 5 * time.Second
	}

	// 1. Kiểm tra Token Bucket rate limiter (hết token thì trả lỗi ErrRateLimitedLocal, không gọi HTTP, không phạt breaker)
	if err := c.rateLimiter.Acquire(ctx, isTier1, timeout); err != nil {
		return nil, err
	}

	// 2. Kiểm tra CircuitBreaker
	allowed, isProbe := c.breaker.Allow()
	if !allowed {
		return nil, ErrGeminiBreakerOpen
	}

	items := make([]GeminiItem, len(lines))
	for i, l := range lines {
		items[i] = GeminiItem{ID: i, Text: l}
	}

	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// 3. Thực hiện gửi request lần 1
	resultMap, err := c.doRequest(callCtx, items, contextLines)
	if err != nil {
		c.handleError(ctx, err, isProbe)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if errors.Is(err, context.Canceled) {
			return nil, err
		}
		return nil, fmt.Errorf("gemini request failed: %w", err)
	}

	// 4. Validate ID và tập hợp ID còn thiếu
	var missingItems []GeminiItem
	for i, item := range items {
		if _, ok := resultMap[item.ID]; !ok {
			missingItems = append(missingItems, items[i])
		}
	}

	// 5. Nếu thiếu ID: retry đúng 1 lần CHỈ RIÊNG các ID thiếu
	if len(missingItems) > 0 {
		retryCtx, retryCancel := context.WithTimeout(ctx, timeout)
		defer retryCancel()

		// Thử lấy thêm token nhanh cho lượt retry (nếu có)
		if c.rateLimiter.TryAcquire(isTier1) {
			retryMap, rErr := c.doRequest(retryCtx, missingItems, contextLines)
			if rErr == nil {
				for k, v := range retryMap {
					resultMap[k] = v
				}
			}
		}
	}

	// Báo cáo thành công cho breaker
	c.breaker.Report(nil, isProbe)

	// 6. Xây dựng mảng kết quả: ID nào vẫn thiếu sau retry thì để chuỗi rỗng
	res := make([]string, len(lines))
	for i := range lines {
		if val, ok := resultMap[i]; ok {
			res[i] = val
		} else {
			res[i] = ""
		}
	}

	return res, nil
}

func (c *GeminiClient) handleError(ctx context.Context, err error, isProbe bool) {
	if ctx.Err() != nil || errors.Is(err, context.Canceled) {
		c.breaker.Report(context.Canceled, isProbe)
		return
	}
	var rlErr *RateLimitError
	if errors.As(err, &rlErr) {
		c.breaker.Report(rlErr, isProbe)
		return
	}
	var netErr net.Error
	if errors.As(err, &netErr) || errors.Is(err, context.DeadlineExceeded) {
		c.breaker.Report(err, isProbe)
		return
	}
	// Lỗi khác
	c.breaker.Report(err, isProbe)
}

func (c *GeminiClient) doRequest(ctx context.Context, items []GeminiItem, contextLines []string) (map[int]string, error) {
	if len(items) == 0 {
		return map[int]string{}, nil
	}

	// Schema bắt buộc cho Gemini
	schema := geminiResponseSchema{
		Type: "ARRAY",
		Items: geminiItemsSchema{
			Type: "OBJECT",
			Properties: map[string]geminiProperty{
				"id": {Type: "INTEGER"},
				"vi": {Type: "STRING"},
			},
			Required: []string{"id", "vi"},
		},
	}

	// Tạo nội dung prompt người dùng
	var promptBuilder strings.Builder
	if len(contextLines) > 0 {
		for _, cl := range contextLines {
			cl = strings.TrimSpace(cl)
			if cl != "" {
				promptBuilder.WriteString(fmt.Sprintf("[CONTEXT - KHÔNG DỊCH] %s\n", cl))
			}
		}
	}

	itemsBytes, err := json.Marshal(items)
	if err != nil {
		return nil, err
	}
	promptBuilder.WriteString("Dưới đây là các câu cần dịch dạng JSON:\n")
	promptBuilder.Write(itemsBytes)

	reqBody := geminiRequestBody{
		SystemInstruction: &geminiSystemInstruction{
			Parts: []geminiPart{
				{
					Text: "Bạn là chuyên gia dịch phụ đề khóa học lập trình. Dịch các câu tiếng Anh sang tiếng Việt, giữ nguyên các thuật ngữ kỹ thuật trong ngành lập trình, không thêm bớt nội dung ngoài câu gốc. Các dòng đánh dấu [CONTEXT - KHÔNG DỊCH] chỉ dùng để hiểu ngữ cảnh, tuyệt đối không dịch và không trả về ID của chúng.",
				},
			},
		},
		Contents: []geminiContent{
			{
				Role: "user",
				Parts: []geminiPart{
					{Text: promptBuilder.String()},
				},
			},
		},
		GenerationConfig: geminiGenerationConfig{
			ResponseMimeType: "application/json",
			ResponseSchema:   schema,
		},
	}

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}

	// Endpoint tuyệt đối KHÔNG chứa API key trên URL query param
	url := fmt.Sprintf("%s/%s:generateContent", strings.TrimRight(c.cfg.Endpoint, "/"), c.cfg.Model)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Content-Type", "application/json")
	// Key được truyền bảo mật qua header x-goog-api-key
	req.Header.Set("x-goog-api-key", c.cfg.APIKey)

	resp, err := c.client.Do(req)
	if err != nil {
		if errors.Is(err, context.Canceled) || ctx.Err() != nil {
			return nil, context.Canceled
		}
		return nil, errors.New(c.sanitize(err.Error()))
	}
	// Đọc cạn phần body còn lại (tối đa 1MB) trước khi đóng để kết nối quay về pool thay vì bị hủy
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		_ = resp.Body.Close()
	}()

	if resp.StatusCode == http.StatusTooManyRequests {
		retryAfter := parseRetryAfter(resp.Header.Get("Retry-After"))
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
		if retryAfter == 0 && len(bodyBytes) > 0 {
			retryAfter = parseRetryDelayFromBody(bodyBytes)
		}
		return nil, &RateLimitError{
			RetryAfter: retryAfter,
			Message:    "gemini rate limit 429",
		}
	}

	respBytes, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // Giới hạn đọc 1MB
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("gemini HTTP %d: %s", resp.StatusCode, c.sanitize(string(respBytes)))
	}

	var gResp geminiResponse
	if err := json.Unmarshal(respBytes, &gResp); err != nil {
		return nil, fmt.Errorf("gemini parse response error: %w", err)
	}

	if gResp.Error != nil {
		return nil, fmt.Errorf("gemini API error: %s", c.sanitize(gResp.Error.Message))
	}

	if len(gResp.Candidates) == 0 {
		return nil, errors.New("gemini: empty candidates in response")
	}

	cand := gResp.Candidates[0]
	if cand.FinishReason != "" && cand.FinishReason != "STOP" {
		return nil, fmt.Errorf("gemini: generation stopped abnormally (finishReason=%s)", cand.FinishReason)
	}

	if len(cand.Content.Parts) == 0 || strings.TrimSpace(cand.Content.Parts[0].Text) == "" {
		return nil, errors.New("gemini: empty candidate text parts")
	}

	candidateText := cleanJSONText(cand.Content.Parts[0].Text)
	var outputItems []GeminiResponseItem
	if err := json.Unmarshal([]byte(candidateText), &outputItems); err != nil {
		return nil, fmt.Errorf("gemini invalid JSON array output: %w", err)
	}

	// Validate: Tập ID trả về phải là tập con của tập ID gửi (⊆ items), không trùng lặp
	sentIDMap := make(map[int]bool, len(items))
	for _, it := range items {
		sentIDMap[it.ID] = true
	}

	resMap := make(map[int]string, len(outputItems))
	for _, out := range outputItems {
		// 1. Kiểm tra ID lạ
		if !sentIDMap[out.ID] {
			return nil, fmt.Errorf("%w: nhận ID %d không có trong danh sách gửi", ErrInvalidResponseIDs, out.ID)
		}
		// 2. Kiểm tra ID trùng
		if _, exists := resMap[out.ID]; exists {
			return nil, fmt.Errorf("%w: ID %d bị trùng lặp trong phản hồi", ErrInvalidResponseIDs, out.ID)
		}
		resMap[out.ID] = out.VI
	}

	return resMap, nil
}

func cleanJSONText(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```json") {
		s = strings.TrimPrefix(s, "```json")
	} else if strings.HasPrefix(s, "```") {
		s = strings.TrimPrefix(s, "```")
	}
	if strings.HasSuffix(s, "```") {
		s = strings.TrimSuffix(s, "```")
	}
	s = strings.TrimSpace(s)

	// Trích xuất substring từ '[' đầu tiên tới ']' cuối cùng (loại bỏ lời dẫn giải thích nếu có)
	start := strings.Index(s, "[")
	end := strings.LastIndex(s, "]")
	if start != -1 && end != -1 && end > start {
		return s[start : end+1]
	}
	return s
}

func parseRetryAfter(h string) time.Duration {
	if h == "" {
		return 0
	}
	h = strings.TrimSpace(h)
	if secs, err := strconv.Atoi(h); err == nil {
		if secs <= 0 {
			return 0
		}
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(h); err == nil {
		d := time.Until(t)
		if d <= 0 {
			return 0
		}
		return d
	}
	return 0
}

// parseRetryDelayFromBody trích xuất retryDelay từ payload JSON lỗi của Google (vd: "retryDelay": "16s")
func parseRetryDelayFromBody(body []byte) time.Duration {
	idx := bytes.Index(body, []byte(`"retryDelay"`))
	if idx == -1 {
		return 0
	}
	sub := body[idx+len(`"retryDelay"`):]
	start := bytes.IndexByte(sub, '"')
	if start == -1 {
		return 0
	}
	sub = sub[start+1:]
	end := bytes.IndexByte(sub, '"')
	if end == -1 {
		return 0
	}
	raw := strings.TrimSpace(string(sub[:end]))
	raw = strings.TrimSuffix(raw, "s")
	if secs, err := strconv.ParseFloat(raw, 64); err == nil && secs > 0 {
		return time.Duration(secs * float64(time.Second))
	}
	return 0
}
