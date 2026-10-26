package main

import (
	"context"
	"fmt"
	"os"
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

// LlamaCliTranslator triển khai gọi llama-cli
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
		"-c", "2048",
		"-t", "4",
		"-f", promptFile,
		"--temp", "0.2",
		"-n", "64",
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
		"-c", "2048",
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
