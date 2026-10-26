package main

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Translator là giao diện chuẩn cho các engine dịch thuật (CLI hoặc Server)
type Translator interface {
	Translate(ctx context.Context, line string, prevContext []string) (string, error)
	Close() error
}

// LlamaCliTranslator triển khai gọi llama-cli cho từng dòng
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
		return nil, fmt.Errorf("smoke test llama-cli thất bại (kiểm tra file exe hoặc model): %w", err)
	}
	if strings.TrimSpace(out) == "" {
		return nil, fmt.Errorf("smoke test llama-cli trả về kết quả rỗng")
	}

	return t, nil
}

// BuildPrompt tạo prompt chuẩn ChatML cho LLM dịch phụ đề
func BuildPrompt(line string, prevContext []string) string {
	var sb strings.Builder

	sb.WriteString("<|im_start|>system\n")
	sb.WriteString("You are a video subtitle translator. Translate the user's English line into natural, concise Vietnamese. Output only the translation. No explanations, no notes, no quotation marks.\n")
	sb.WriteString("<|im_end|>\n")

	sb.WriteString("<|im_start|>user\n")
	if len(prevContext) > 0 {
		sb.WriteString("[Context only, do not translate]:\n")
		// Lấy tối đa 2 dòng trước
		start := 0
		if len(prevContext) > 2 {
			start = len(prevContext) - 2
		}
		for _, ctxLine := range prevContext[start:] {
			sb.WriteString("- " + ctxLine + "\n")
		}
		sb.WriteString("\n[Translate this line]:\n")
	}
	sb.WriteString(line)
	sb.WriteString("\n<|im_end|>\n")
	sb.WriteString("<|im_start|>assistant\n")

	return sb.String()
}

// CleanLLMOutput loại bỏ token ChatML, ngoặc kép và kiểm tra độ dài bất thường
func CleanLLMOutput(raw, sourceLine string) string {
	res := raw

	// Cắt bỏ các token ChatML đặc biệt
	specialTokens := []string{
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

	// Lấy dòng không rỗng đầu tiên
	lines := strings.Split(res, "\n")
	var firstNonEmpty string
	for _, l := range lines {
		trimmed := strings.TrimSpace(l)
		if trimmed != "" {
			firstNonEmpty = trimmed
			break
		}
	}
	res = firstNonEmpty

	// Cắt dấu ngoặc kép hoặc ngoặc vuông bao ngoài
	res = strings.Trim(res, `"'“”«»[]`)
	res = strings.TrimSpace(res)

	// Kiểm tra độ dài bất thường (> 4x độ dài nguồn + 40 ký tự)
	maxLen := len(sourceLine)*4 + 40
	if len(res) > maxLen {
		return ""
	}

	return res
}

// Translate dịch một dòng thoại
func (t *LlamaCliTranslator) Translate(ctx context.Context, line string, prevContext []string) (string, error) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return "", nil
	}

	// Nếu là âm thanh nền (nhạc, tiếng động) bỏ qua dịch
	if (strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]")) ||
		(strings.HasPrefix(trimmed, "(") && strings.HasSuffix(trimmed, ")")) ||
		strings.Contains(trimmed, "♪") {
		return "", nil
	}

	prompt := BuildPrompt(trimmed, prevContext)

	// Llama-cli CLI flags
	args := []string{
		"-m", t.modelPath,
		"-p", prompt,
		"--temp", "0.2",
		"-n", "128",
		"--no-display-prompt",
		"-no-cnv",
	}

	// Đồng bộ tránh chạy song song quá nhiều luồng llama-cli gây nghẽn RAM
	t.mu.Lock()
	defer t.mu.Unlock()

	result, err := RunCommand(ctx, t.llamaCLI, args, 90*time.Second, nil)
	if err != nil {
		return "", err
	}

	cleaned := CleanLLMOutput(result.Stdout, trimmed)
	return cleaned, nil
}

// Close giải phóng tài nguyên nếu có
func (t *LlamaCliTranslator) Close() error {
	return nil
}
