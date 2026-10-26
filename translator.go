package main

import (
	"context"
	"fmt"
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

// BuildPrompt tạo prompt đơn dòng
func BuildPrompt(line string) string {
	var sb strings.Builder
	sb.WriteString("<|im_start|>system\n")
	sb.WriteString("Dịch phụ đề tiếng Anh sau đây sang tiếng Việt tự nhiên, ngắn gọn. Chỉ trả về bản dịch tiếng Việt, không giải thích, không để nguyên tiếng Anh.\n")
	sb.WriteString("<|im_end|>\n")
	sb.WriteString("<|im_start|>user\n")
	sb.WriteString(line)
	sb.WriteString("\n<|im_end|>\n")
	sb.WriteString("<|im_start|>assistant\n")
	return sb.String()
}

// BuildBatchPrompt tạo prompt gom toàn bộ câu trong block để dịch 1 lần siêu tốc
func BuildBatchPrompt(lines []string) string {
	var sb strings.Builder
	sb.WriteString("<|im_start|>system\n")
	sb.WriteString("Bạn là chuyên gia dịch phụ đề. Hãy dịch từng dòng tiếng Anh sau sang tiếng Việt ngắn gọn, tự nhiên theo đúng định dạng số thứ tự (1., 2., 3...). Chỉ xuất kết quả tiếng Việt theo từng dòng có đánh số, không thêm bất kỳ ghi chú hay giải thích nào.\n")
	sb.WriteString("<|im_end|>\n")
	sb.WriteString("<|im_start|>user\n")
	for i, l := range lines {
		sb.WriteString(fmt.Sprintf("%d. %s\n", i+1, l))
	}
	sb.WriteString("<|im_end|>\n")
	sb.WriteString("<|im_start|>assistant\n")
	return sb.String()
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
	res = strings.Trim(res, `"'“”«»[]`)
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

	// Làm sạch token ChatML
	res := raw
	for _, tok := range []string{"<|im_start|>assistant", "<|im_end|>", "<|endoftext|>", "[end of text]"} {
		res = strings.ReplaceAll(res, tok, "")
	}

	lines := strings.Split(res, "\n")
	for _, l := range lines {
		trimmed := strings.TrimSpace(l)
		if trimmed == "" {
			continue
		}

		// Tìm định dạng "1. Bản dịch" hoặc "1) Bản dịch"
		dotIdx := strings.IndexAny(trimmed, ".)")
		if dotIdx > 0 && dotIdx < 5 {
			numStr := strings.TrimSpace(trimmed[:dotIdx])
			if idx, err := strconv.Atoi(numStr); err == nil {
				if idx >= 1 && idx <= count {
					content := strings.TrimSpace(trimmed[dotIdx+1:])
					content = strings.Trim(content, `"'“”«»[]`)
					if !strings.EqualFold(content, strings.TrimSpace(sourceLines[idx-1])) {
						result[idx-1] = content
					}
				}
			}
		}
	}

	return result
}

// Translate dịch một dòng thoại
func (t *LlamaCliTranslator) Translate(ctx context.Context, line string, _ []string) (string, error) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return "", nil
	}

	if (strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]")) ||
		(strings.HasPrefix(trimmed, "(") && strings.HasSuffix(trimmed, ")")) ||
		strings.Contains(trimmed, "♪") {
		return "", nil
	}

	prompt := BuildPrompt(trimmed)
	args := []string{
		"-m", t.modelPath,
		"-p", prompt,
		"--temp", "0.2",
		"-n", "128",
		"--no-display-prompt",
		"--simple-io",
	}

	t.mu.Lock()
	defer t.mu.Unlock()

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
	maxTokens := len(lines) * 45 // Ước tính khoảng 45 tokens cho mỗi câu dịch
	if maxTokens < 256 {
		maxTokens = 256
	}

	args := []string{
		"-m", t.modelPath,
		"-p", prompt,
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

	// Fallback: Nếu câu nào parse batch bị sót, dịch đơn lẻ bổ sung
	for i := range parsed {
		if parsed[i] == "" && strings.TrimSpace(lines[i]) != "" {
			single, _ := t.Translate(ctx, lines[i], nil)
			parsed[i] = single
		}
	}

	return parsed, nil
}

// Close giải phóng tài nguyên
func (t *LlamaCliTranslator) Close() error {
	return nil
}
