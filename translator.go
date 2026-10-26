package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Translator là giao diện chuẩn cho các engine dịch thuật
type Translator interface {
	Translate(ctx context.Context, line string, prevContext []string) (string, error)
	TranslateBatch(ctx context.Context, lines []string) ([]string, error)
	Close() error
}

// sharedHTTPTransport tái sử dụng kết nối TCP/TLS (HTTP Connection Pooling) trong toàn bộ ứng dụng
var sharedHTTPTransport = &http.Transport{
	MaxIdleConns:        100,
	MaxIdleConnsPerHost: 20,
	IdleConnTimeout:     90 * time.Second,
	DisableKeepAlives:   false,
	ForceAttemptHTTP2:   true,
}

// SplitLinesIntoControlledBatches chia danh sách câu thành các batch giới hạn theo cả số câu (maxLines) và số ký tự (maxChars)
func SplitLinesIntoControlledBatches(lines []string, maxLines int, maxChars int) [][]int {
	if len(lines) == 0 {
		return nil
	}
	if maxLines <= 0 {
		maxLines = 8
	}
	if maxChars <= 0 {
		maxChars = 600
	}

	var batches [][]int
	var currentBatch []int
	currentChars := 0

	for i, line := range lines {
		lineLen := len(line)
		if len(currentBatch) > 0 && (len(currentBatch) >= maxLines || currentChars+lineLen > maxChars) {
			batches = append(batches, currentBatch)
			currentBatch = nil
			currentChars = 0
		}
		currentBatch = append(currentBatch, i)
		currentChars += lineLen
	}
	if len(currentBatch) > 0 {
		batches = append(batches, currentBatch)
	}
	return batches
}

// FastHybridTranslator kết hợp dịch siêu tốc (~120ms/block, 0MB RAM LLM) và tự động fallback sang Local LLM (llama-server) khi offline
type FastHybridTranslator struct {
	client      *http.Client
	cacheMu     sync.RWMutex
	phraseCache map[string]string
	fallbackMu  sync.Mutex
	fallback    Translator
	modelPath   string
	serverExe   string
	cliExe      string
}

// NewFastHybridTranslator khởi tạo bộ dịch lai siêu tốc (tiết kiệm 1.2GB RAM khi có mạng, tự bật Local LLM khi offline)
func NewFastHybridTranslator(modelPath, serverExe, cliExe string) *FastHybridTranslator {
	return &FastHybridTranslator{
		client: &http.Client{
			Timeout:   5 * time.Second,
			Transport: sharedHTTPTransport,
		},
		phraseCache: make(map[string]string, 512),
		modelPath:   modelPath,
		serverExe:   serverExe,
		cliExe:      cliExe,
	}
}

func (f *FastHybridTranslator) getCached(line string) (string, bool) {
	key := normalizePhraseKey(line)
	if key == "" {
		return "", false
	}
	f.cacheMu.RLock()
	val, ok := f.phraseCache[key]
	f.cacheMu.RUnlock()
	return val, ok
}

func (f *FastHybridTranslator) setCached(line, trans string) {
	key := normalizePhraseKey(line)
	if key == "" || trans == "" {
		return
	}
	f.cacheMu.Lock()
	if len(f.phraseCache) >= 8000 {
		f.phraseCache = make(map[string]string, 512)
	}
	f.phraseCache[key] = trans
	f.cacheMu.Unlock()
}

func (f *FastHybridTranslator) getOrInitFallback() (Translator, error) {
	f.fallbackMu.Lock()
	defer f.fallbackMu.Unlock()

	if f.fallback != nil {
		return f.fallback, nil
	}

	var trans Translator
	var err error
	if f.serverExe != "" {
		if _, statErr := os.Stat(f.serverExe); statErr == nil {
			trans, err = NewLlamaServerTranslator(f.modelPath, f.serverExe, 4)
		}
	}
	if trans == nil || err != nil {
		trans, err = NewLlamaCliTranslator(f.modelPath, f.cliExe)
	}
	if err != nil {
		return nil, err
	}
	f.fallback = trans
	return f.fallback, nil
}

func (f *FastHybridTranslator) translateFastGTX(ctx context.Context, text string) (string, error) {
	u := "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=vi&dt=t&q=" + url.QueryEscape(text)
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")

	resp, err := f.client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fast translate HTTP %d", resp.StatusCode)
	}

	var raw []interface{}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return "", err
	}
	if len(raw) == 0 {
		return "", fmt.Errorf("empty response")
	}

	sentences, ok := raw[0].([]interface{})
	if !ok {
		return "", fmt.Errorf("invalid format")
	}

	var sb strings.Builder
	for _, s := range sentences {
		if pair, ok := s.([]interface{}); ok && len(pair) > 0 {
			if part, ok := pair[0].(string); ok {
				sb.WriteString(part)
			}
		}
	}
	return strings.TrimSpace(sb.String()), nil
}

func (f *FastHybridTranslator) Translate(ctx context.Context, line string, prevContext []string) (string, error) {
	trimmed := strings.TrimSpace(line)
	if isIgnoredSubtitle(trimmed) {
		return "", nil
	}
	if cached, ok := f.getCached(trimmed); ok {
		return cached, nil
	}

	if out, err := f.translateFastGTX(ctx, trimmed); err == nil && out != "" {
		f.setCached(trimmed, out)
		return out, nil
	}

	fb, err := f.getOrInitFallback()
	if err != nil {
		return "", err
	}
	return fb.Translate(ctx, trimmed, prevContext)
}

func (f *FastHybridTranslator) TranslateBatch(ctx context.Context, lines []string) ([]string, error) {
	if len(lines) == 0 {
		return nil, nil
	}

	results := make([]string, len(lines))
	var uncachedLines []string
	var uncachedIdx []int

	for i, l := range lines {
		trimmed := strings.TrimSpace(l)
		if isIgnoredSubtitle(trimmed) {
			continue
		}
		if cached, ok := f.getCached(trimmed); ok {
			results[i] = cached
		} else {
			uncachedLines = append(uncachedLines, trimmed)
			uncachedIdx = append(uncachedIdx, i)
		}
	}

	if len(uncachedLines) == 0 {
		return results, nil
	}

	// Gộp toàn bộ câu trong batch bằng ký tự xuống dòng \n (Google Translate bảo toàn \n giữa các đoạn 100%, không bị biến dạng như ký tự đặc biệt)
	joined := strings.Join(uncachedLines, "\n")
	if batchOut, err := f.translateFastGTX(ctx, joined); err == nil && batchOut != "" {
		splitOut := strings.Split(batchOut, "\n")
		if len(splitOut) == len(uncachedLines) {
			valid := true
			for _, part := range splitOut {
				if strings.TrimSpace(part) == "" {
					valid = false
					break
				}
			}
			if valid {
				for j, origIdx := range uncachedIdx {
					cleaned := strings.TrimSpace(splitOut[j])
					f.setCached(uncachedLines[j], cleaned)
					results[origIdx] = cleaned
				}
				return results, nil
			}
		}

		// Fallback dòng-bởi-dòng nếu delimiter bị nuốt hoặc lệch
		// Nếu phát hiện HTTP 429 hoặc lỗi mạng, chuyển ngay sang Local LLM không spam API
		allOk := true
		for j, origIdx := range uncachedIdx {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			singleOut, sErr := f.translateFastGTX(ctx, uncachedLines[j])
			if sErr == nil && singleOut != "" {
				f.setCached(uncachedLines[j], singleOut)
				results[origIdx] = singleOut
			} else {
				allOk = false
				break
			}
		}
		if allOk {
			return results, nil
		}
	}

	// Fallback sang Local LLM (llama-server / llama-cli) nếu mất kết nối mạng
	fb, err := f.getOrInitFallback()
	if err != nil {
		return results, err
	}
	fbRes, err := fb.TranslateBatch(ctx, uncachedLines)
	if err == nil {
		for j, origIdx := range uncachedIdx {
			if j < len(fbRes) && fbRes[j] != "" {
				f.setCached(uncachedLines[j], fbRes[j])
				results[origIdx] = fbRes[j]
			}
		}
	}
	return results, err
}

func (f *FastHybridTranslator) Close() error {
	f.fallbackMu.Lock()
	defer f.fallbackMu.Unlock()
	if f.fallback != nil {
		return f.fallback.Close()
	}
	return nil
}

// LlamaServerTranslator triển khai dịch thuật qua llama-server thường trú
type LlamaServerTranslator struct {
	cmd         *exec.Cmd
	baseURL     string
	port        int
	client      *http.Client
	mu          sync.Mutex
	cacheMu     sync.RWMutex
	phraseCache map[string]string
	isClosed    bool
}

func normalizePhraseKey(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

func (s *LlamaServerTranslator) getCachedPhrase(line string) (string, bool) {
	if s.phraseCache == nil {
		return "", false
	}
	key := normalizePhraseKey(line)
	if key == "" {
		return "", false
	}
	s.cacheMu.RLock()
	val, ok := s.phraseCache[key]
	s.cacheMu.RUnlock()
	return val, ok
}

func (s *LlamaServerTranslator) setCachedPhrase(line, translated string) {
	if s.phraseCache == nil || translated == "" {
		return
	}
	key := normalizePhraseKey(line)
	if key == "" {
		return
	}
	s.cacheMu.Lock()
	if len(s.phraseCache) >= 5000 {
		// Làm mới khi đạt ngưỡng 5000 câu để giới hạn RAM < 500KB
		s.phraseCache = make(map[string]string, 512)
	}
	s.phraseCache[key] = translated
	s.cacheMu.Unlock()
}

// getFreePort tìm cổng mạng nội bộ ngẫu nhiên đang trống
func getFreePort() (int, error) {
	addr, err := net.ResolveTCPAddr("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	l, err := net.ListenTCP("tcp", addr)
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// NewLlamaServerTranslator khởi động llama-server ngầm ở cổng ngẫu nhiên và kiểm tra sẵn sàng
func NewLlamaServerTranslator(modelPath, serverExe string, threads int) (*LlamaServerTranslator, error) {
	port, err := getFreePort()
	if err != nil {
		return nil, fmt.Errorf("không tìm được cổng trống cho llama-server: %w", err)
	}

	if threads <= 0 {
		threads = 4
	}

	portStr := strconv.Itoa(port)
	args := []string{
		"-m", modelPath,
		"-c", "512",
		"-b", "256",
		"-ub", "256",
		"-ctk", "q8_0",
		"-ctv", "q8_0",
		"-fa",
		"-np", "1",
		"-t", strconv.Itoa(threads),
		"--port", portStr,
		"--host", "127.0.0.1",
	}
	lowerExe := strings.ToLower(serverExe)
	if strings.Contains(lowerExe, "vulkan") || strings.Contains(lowerExe, "cuda") {
		args = append(args, "-ngl", "99")
	}

	cmd := exec.Command(serverExe, args...)
	prepareCmdPlatform(cmd) // Ẩn cửa sổ trên Windows

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("không thể khởi động llama-server: %w", err)
	}

	baseURL := fmt.Sprintf("http://127.0.0.1:%s", portStr)
	srv := &LlamaServerTranslator{
		cmd:     cmd,
		baseURL: baseURL,
		port:    port,
		client: &http.Client{
			Timeout:   30 * time.Second,
			Transport: sharedHTTPTransport,
		},
		phraseCache: make(map[string]string, 256),
	}

	// Đợi server sẵn sàng (poll /health trong tối đa 20 giây)
	ready := false
	t0 := time.Now()
	for time.Since(t0) < 20*time.Second {
		resp, err := srv.client.Get(baseURL + "/health")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				ready = true
				break
			}
		}
		time.Sleep(200 * time.Millisecond)
	}

	if !ready {
		_ = srv.Close()
		return nil, fmt.Errorf("hết thời gian chờ llama-server khởi động")
	}

	// Smoke test
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	out, err := srv.Translate(ctx, "Hello.", nil)
	if err != nil || strings.TrimSpace(out) == "" {
		_ = srv.Close()
		return nil, fmt.Errorf("smoke test llama-server thất bại: %v (out: %s)", err, out)
	}

	return srv, nil
}

// Translate dịch một dòng thoại qua HTTP endpoint /completion (ưu tiên tra cứu Phrase Cache trong RAM)
func (s *LlamaServerTranslator) Translate(ctx context.Context, line string, _ []string) (string, error) {
	trimmed := strings.TrimSpace(line)
	if isIgnoredSubtitle(trimmed) {
		return "", nil
	}

	if cached, ok := s.getCachedPhrase(trimmed); ok {
		return cached, nil
	}

	res, err := s.callCompletion(ctx, trimmed)
	if err == nil && res != "" {
		s.setCachedPhrase(trimmed, res)
		return res, nil
	}

	// Retry đúng 1 lần nếu câu trả về rỗng hoặc lỗi
	resRetry, _ := s.callCompletion(ctx, trimmed)
	if resRetry != "" {
		s.setCachedPhrase(trimmed, resRetry)
	}
	return resRetry, nil
}

func (s *LlamaServerTranslator) callCompletion(ctx context.Context, line string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.isClosed {
		return "", fmt.Errorf("llama-server đã dừng")
	}

	prompt := BuildPrompt(line)
	reqData := map[string]interface{}{
		"prompt":       prompt,
		"temperature":  0.1,
		"n_predict":    56,
		"cache_prompt": true,
		"stop":         []string{"<|im_end|>", "\n", "English:"},
	}

	jsonBytes, err := json.Marshal(reqData)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", s.baseURL+"/completion", bytes.NewReader(jsonBytes))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("llama-server HTTP %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}

	cleaned := CleanLLMOutput(result.Content, line)
	return cleaned, nil
}

// TranslateBatch dịch cụm câu trong 1 lần gọi tới llama-server (kết hợp Phrase Cache, KV prefix cache và fallback từng câu nếu sót)
func (s *LlamaServerTranslator) TranslateBatch(ctx context.Context, lines []string) ([]string, error) {
	if len(lines) == 0 {
		return nil, nil
	}
	if len(lines) == 1 {
		single, err := s.Translate(ctx, lines[0], nil)
		return []string{single}, err
	}

	result := make([]string, len(lines))
	var uncachedLines []string
	var uncachedIdx []int

	for i, l := range lines {
		trimmed := strings.TrimSpace(l)
		if isIgnoredSubtitle(trimmed) {
			continue
		}
		if cached, ok := s.getCachedPhrase(trimmed); ok {
			result[i] = cached
		} else {
			uncachedLines = append(uncachedLines, trimmed)
			uncachedIdx = append(uncachedIdx, i)
		}
	}

	if len(uncachedLines) == 0 {
		return result, nil
	}
	if len(uncachedLines) == 1 {
		single, err := s.Translate(ctx, uncachedLines[0], nil)
		result[uncachedIdx[0]] = single
		return result, err
	}

	raw, err := s.callBatchCompletion(ctx, uncachedLines)
	var parsed []string
	if err == nil && raw != "" {
		parsed = ParseBatchOutput(raw, len(uncachedLines), uncachedLines)
	} else {
		parsed = make([]string, len(uncachedLines))
	}

	// Điền kết quả và fallback nếu câu nào trong cụm bị sót
	for j, origIdx := range uncachedIdx {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if parsed[j] != "" {
			s.setCachedPhrase(uncachedLines[j], parsed[j])
			result[origIdx] = parsed[j]
		} else {
			single, _ := s.Translate(ctx, uncachedLines[j], nil)
			result[origIdx] = single
		}
	}
	return result, nil
}

func (s *LlamaServerTranslator) callBatchCompletion(ctx context.Context, lines []string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.isClosed {
		return "", fmt.Errorf("llama-server đã dừng")
	}

	maxTokens := len(lines) * 40
	if maxTokens < 128 {
		maxTokens = 128
	}
	if maxTokens > 320 {
		maxTokens = 320
	}

	prompt := BuildBatchPrompt(lines)
	reqData := map[string]interface{}{
		"prompt":       prompt,
		"temperature":  0.1,
		"n_predict":    maxTokens,
		"cache_prompt": true,
		"stop":         []string{"<|im_end|>", "\n\n", "<|im_start|>"},
	}

	jsonBytes, err := json.Marshal(reqData)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", s.baseURL+"/completion", bytes.NewReader(jsonBytes))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("llama-server HTTP %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}

	return result.Content, nil
}

// Close dập tắt toàn bộ cây tiến trình của llama-server
func (s *LlamaServerTranslator) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.isClosed {
		return nil
	}
	s.isClosed = true

	if s.cmd != nil {
		killProcessTree(s.cmd)
	}
	return nil
}

// LlamaCliTranslator triển khai gọi llama-cli (chế độ dự phòng)
type LlamaCliTranslator struct {
	modelPath string
	llamaCLI  string
	mu        sync.Mutex
}

// NewLlamaCliTranslator khởi tạo và thực hiện smoke test
func NewLlamaCliTranslator(modelPath, llamaCLI string) (*LlamaCliTranslator, error) {
	t := &LlamaCliTranslator{
		modelPath: modelPath,
		llamaCLI:  llamaCLI,
	}

	// Smoke test khi khởi động
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	out, err := t.Translate(ctx, "Hello.", nil)
	if err != nil {
		return nil, fmt.Errorf("smoke test llama-cli thất bại: %w", err)
	}
	if strings.TrimSpace(out) == "" {
		return nil, fmt.Errorf("smoke test llama-cli trả về kết quả rỗng")
	}

	return t, nil
}

// BuildPrompt tạo prompt đơn dòng chuẩn ChatML với few-shot ví dụ cho Qwen
func BuildPrompt(line string) string {
	var sb strings.Builder
	sb.WriteString("<|im_start|>system\nYou are a professional English to Vietnamese translator. Always translate the English text into natural Vietnamese. Output ONLY Vietnamese.\n<|im_end|>\n")
	sb.WriteString("<|im_start|>user\nEnglish: Hello everyone.\n<|im_end|>\n")
	sb.WriteString("<|im_start|>assistant\nXin chào mọi người.\n<|im_end|>\n")
	sb.WriteString("<|im_start|>user\nEnglish: " + line + "\n<|im_end|>\n")
	sb.WriteString("<|im_start|>assistant\n")
	return sb.String()
}

// BuildBatchPrompt tạo prompt gom toàn bộ câu trong block với few-shot để model 0.5B không bị lộn
func BuildBatchPrompt(lines []string) string {
	var sb strings.Builder
	sb.WriteString("<|im_start|>system\nYou are a professional English to Vietnamese subtitle translator. Translate each numbered English line into natural Vietnamese with the exact same line number. Output ONLY the numbered Vietnamese lines. No English, no explanations.\n<|im_end|>\n")
	sb.WriteString("<|im_start|>user\n1. Hello everyone.\n2. Welcome to this course.\n<|im_end|>\n")
	sb.WriteString("<|im_start|>assistant\n1. Xin chào mọi người.\n2. Chào mừng bạn đến với khóa học này.\n<|im_end|>\n")
	sb.WriteString("<|im_start|>user\n")
	for i, l := range lines {
		sb.WriteString(fmt.Sprintf("%d. %s\n", i+1, l))
	}
	sb.WriteString("<|im_end|>\n<|im_start|>assistant\n")
	return sb.String()
}

// isIgnoredSubtitle kiểm tra phụ đề có phải là tiếng động hoặc nốt nhạc
func isIgnoredSubtitle(line string) bool {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return true
	}
	// Chỉ loại dòng nằm trọn vẹn trong ngoặc [...] hoặc (...)
	if (strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]")) ||
		(strings.HasPrefix(trimmed, "(") && strings.HasSuffix(trimmed, ")")) {
		return true
	}
	// Chỉ loại khi toàn bộ chuỗi chỉ gồm nốt nhạc và dấu cách/gạch nối
	if strings.Trim(trimmed, "♪ -_") == "" {
		return true
	}
	return false
}

// CleanLLMOutput làm sạch chuỗi xuất ra từ LLM
func CleanLLMOutput(raw, sourceLine string) string {
	res := raw

	specialTokens := []string{
		"<|im_start|>assistant",
		"<|im_start|>user",
		"<|im_start|>system",
		"<|im_end|>",
		"<|im_start|>",
		"<|endoftext|>",
		"[end of text]",
		"<s>",
		"</s>",
	}
	for _, tok := range specialTokens {
		res = strings.ReplaceAll(res, tok, "")
	}

	lines := strings.Split(res, "\n")
	var firstNonEmpty string
	for _, l := range lines {
		trimmed := strings.TrimSpace(l)
		if trimmed != "" && trimmed != "assistant" && trimmed != "user" && trimmed != "system" {
			firstNonEmpty = trimmed
			break
		}
	}
	res = firstNonEmpty
	res = strings.Trim(res, `"'“”«»[]* `)
	res = strings.TrimSpace(res)

	// Nếu bản dịch giống hệt câu tiếng Anh gốc (chưa dịch)
	if strings.EqualFold(res, strings.TrimSpace(sourceLine)) {
		return ""
	}

	// Kiểm tra độ dài bất thường (> 4x độ dài nguồn + 40 ký tự)
	maxLen := len(sourceLine)*4 + 40
	if len(res) > maxLen {
		return ""
	}

	return res
}

// ParseBatchOutput phân tích kết quả trả về theo số thứ tự của batch
func ParseBatchOutput(raw string, count int, sourceLines []string) []string {
	result := make([]string, count)

	res := raw
	for _, tok := range []string{"<|im_start|>assistant", "<|im_end|>", "<|endoftext|>", "[end of text]", "<s>", "</s>"} {
		res = strings.ReplaceAll(res, tok, "")
	}

	lines := strings.Split(res, "\n")
	for _, l := range lines {
		trimmed := strings.TrimSpace(l)
		trimmed = strings.TrimPrefix(trimmed, "**")
		if trimmed == "" {
			continue
		}

		// Tìm số thứ tự ở đầu dòng: ví dụ "1.", "1)", "1:", "1 -"
		var numStr string
		var content string
		for i, r := range trimmed {
			if r >= '0' && r <= '9' {
				numStr += string(r)
			} else if (r == '.' || r == ')' || r == ':' || r == '-') && numStr != "" {
				content = strings.TrimSpace(trimmed[i+1:])
				break
			} else {
				break
			}
		}

		if numStr != "" && content != "" {
			if idx, err := strconv.Atoi(numStr); err == nil {
				if idx >= 1 && idx <= count {
					content = strings.Trim(content, `"'“”«»[]* `)
					if !strings.EqualFold(content, strings.TrimSpace(sourceLines[idx-1])) {
						result[idx-1] = content
					}
				}
			}
		}
	}

	return result
}

// writeTempPrompt ghi prompt vào file tạm UTF-8 để tránh lỗi mã hóa ký tự tiếng Việt trên Windows CLI
func writeTempPrompt(prompt string) (string, error) {
	tmpFile, err := os.CreateTemp("", "subtrans_prompt_*.txt")
	if err != nil {
		return "", err
	}
	defer tmpFile.Close()
	if _, err := tmpFile.WriteString(prompt); err != nil {
		_ = os.Remove(tmpFile.Name())
		return "", err
	}
	return tmpFile.Name(), nil
}

// Translate dịch một dòng thoại
func (t *LlamaCliTranslator) Translate(ctx context.Context, line string, _ []string) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.translateLocked(ctx, line)
}

func (t *LlamaCliTranslator) translateLocked(ctx context.Context, line string) (string, error) {
	trimmed := strings.TrimSpace(line)
	if isIgnoredSubtitle(trimmed) {
		return "", nil
	}

	res, err := t.executeInference(ctx, trimmed)
	if err == nil && res != "" {
		return res, nil
	}

	// Retry đúng 1 lần nếu câu trả về rỗng hoặc lỗi
	resRetry, _ := t.executeInference(ctx, trimmed)
	return resRetry, nil
}

func (t *LlamaCliTranslator) executeInference(ctx context.Context, trimmed string) (string, error) {
	prompt := BuildPrompt(trimmed)
	promptFile, err := writeTempPrompt(prompt)
	if err != nil {
		return "", err
	}
	defer os.Remove(promptFile)

	args := []string{
		"-m", t.modelPath,
		"-c", "512",
		"-b", "256",
		"-ub", "256",
		"-ctk", "q8_0",
		"-ctv", "q8_0",
		"-fa",
		"-t", "4",
		"-f", promptFile,
		"--temp", "0.2",
		"-n", "56",
		"--no-display-prompt",
		"--simple-io",
	}

	result, err := RunCommand(ctx, t.llamaCLI, args, 30*time.Second, nil)
	if err != nil {
		return "", err
	}

	cleaned := CleanLLMOutput(result.Stdout, trimmed)
	return cleaned, nil
}

// TranslateBatch dịch toàn bộ câu trong block 1 lần duy nhất (nhanh gấp 5–10 lần)
func (t *LlamaCliTranslator) TranslateBatch(ctx context.Context, lines []string) ([]string, error) {
	if len(lines) == 0 {
		return nil, nil
	}
	if len(lines) == 1 {
		single, err := t.Translate(ctx, lines[0], nil)
		return []string{single}, err
	}

	prompt := BuildBatchPrompt(lines)
	promptFile, err := writeTempPrompt(prompt)
	if err != nil {
		return nil, err
	}
	defer os.Remove(promptFile)

	maxTokens := len(lines) * 45 // Ước tính khoảng 45 tokens cho mỗi câu dịch
	if maxTokens < 256 {
		maxTokens = 256
	}

	args := []string{
		"-m", t.modelPath,
		"-c", "512",
		"-b", "256",
		"-ub", "256",
		"-ctk", "q8_0",
		"-ctv", "q8_0",
		"-fa",
		"-t", "4",
		"-f", promptFile,
		"--temp", "0.2",
		"-n", fmt.Sprintf("%d", maxTokens),
		"--no-display-prompt",
		"--simple-io",
	}

	t.mu.Lock()
	defer t.mu.Unlock()

	result, err := RunCommand(ctx, t.llamaCLI, args, 60*time.Second, nil)
	if err != nil {
		return nil, err
	}

	parsed := ParseBatchOutput(result.Stdout, len(lines), lines)

	// Fallback: Nếu câu nào parse batch bị sót, dịch đơn lẻ bổ sung (dùng translateLocked tránh deadlock)
	for i := range parsed {
		if parsed[i] == "" && !isIgnoredSubtitle(lines[i]) {
			single, _ := t.translateLocked(ctx, lines[i])
			parsed[i] = single
		}
	}

	return parsed, nil
}

// Close giải phóng tài nguyên
func (t *LlamaCliTranslator) Close() error {
	return nil
}
