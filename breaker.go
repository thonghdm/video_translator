package main

import (
	"context"
	"errors"
	"log"
	"sync/atomic"
	"time"
)

// RateLimitError đóng gói lỗi rate limit kèm thời gian giãn cách nếu nhà cung cấp trả về Retry-After
type RateLimitError struct {
	RetryAfter time.Duration
	Message    string
}

func (e *RateLimitError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return "rate limited (429)"
}

func (e *RateLimitError) Is(target error) bool {
	return target == ErrRateLimited
}

// Breaker định nghĩa giao diện chuẩn cho bộ ngắt mạch bảo vệ dịch thuật
type Breaker interface {
	Allow() (allowed bool, isProbe bool)
	Report(err error, isProbe bool)
	Blocked() bool
}

// BreakerConfig chứa các tham số cấu hình cho CircuitBreaker
type BreakerConfig struct {
	BaseBackoff              time.Duration // Mặc định 1 phút: thời gian khóa cơ sở cho exponential backoff
	MaxBackoff               time.Duration // Mặc định 10 phút: trần thời gian khóa khi bị rate limit
	ProbeFailCooldown        time.Duration // Mặc định 1 phút: thời gian khóa tiếp khi probe thất bại
	NetworkCooldown          time.Duration // Mặc định 2 phút: thời gian khóa khi gặp 3 lỗi mạng liên tiếp
	ConsecutiveFailThreshold int32         // Mặc định 3: số lỗi mạng liên tiếp kích hoạt khóa
	MaxBackoffStep           int32         // Mặc định 6: số bậc lũy thừa tối đa (1m, 2m, 4m, 8m, 16m->10m, 32m->10m)
}

// DefaultBreakerConfig cung cấp cấu hình chuẩn tương thích hoàn toàn 100% với Google GTX
func DefaultBreakerConfig() BreakerConfig {
	return BreakerConfig{
		BaseBackoff:              1 * time.Minute,
		MaxBackoff:               10 * time.Minute,
		ProbeFailCooldown:        1 * time.Minute,
		NetworkCooldown:          2 * time.Minute,
		ConsecutiveFailThreshold: 3,
		MaxBackoffStep:           6,
	}
}

// CircuitBreaker cài đặt cơ chế ngắt mạch an toàn luồng bằng lock-free atomics
type CircuitBreaker struct {
	blockedUntil atomic.Int64
	probing      atomic.Bool
	fails        atomic.Int32
	backoffStep  atomic.Int32
	config       BreakerConfig
}

// NewCircuitBreaker khởi tạo CircuitBreaker với cấu hình đã cho.
// Nếu bất kỳ giá trị cấu hình nào <= 0, hàm sẽ tự động chuẩn hóa về giá trị mặc định tương ứng.
func NewCircuitBreaker(cfg BreakerConfig) *CircuitBreaker {
	if cfg.BaseBackoff <= 0 {
		cfg.BaseBackoff = 1 * time.Minute
	}
	if cfg.MaxBackoff <= 0 {
		cfg.MaxBackoff = 10 * time.Minute
	}
	if cfg.ProbeFailCooldown <= 0 {
		cfg.ProbeFailCooldown = 1 * time.Minute
	}
	if cfg.NetworkCooldown <= 0 {
		cfg.NetworkCooldown = 2 * time.Minute
	}
	if cfg.ConsecutiveFailThreshold <= 0 {
		cfg.ConsecutiveFailThreshold = 3
	}
	if cfg.MaxBackoffStep <= 0 {
		cfg.MaxBackoffStep = 6
	}
	return &CircuitBreaker{config: cfg}
}

// Blocked chỉ đọc cờ khóa bằng atomic load (read-only, non-CAS, zero allocation).
// Tuyệt đối không tiêu tốn lượt probe trong trạng thái Half-Open khi UI hoặc Scheduler truy vấn.
func (cb *CircuitBreaker) Blocked() bool {
	until := cb.blockedUntil.Load()
	return until != 0 && time.Now().UnixNano() < until
}

// Allow kiểm tra và cấp quyền gửi request tới nhà cung cấp.
// Trả về: (allowed bool, isProbe bool).
// - Closed (bình thường): allowed = true, isProbe = false.
// - Open (đang bị khóa): allowed = false, isProbe = false.
// - Half-Open (vừa hết cooldown): duy nhất 1 goroutine nhận allowed = true, isProbe = true qua CAS; các goroutine khác nhận false, false.
func (cb *CircuitBreaker) Allow() (allowed bool, isProbe bool) {
	until := cb.blockedUntil.Load()
	if until == 0 {
		return true, false
	}
	if time.Now().UnixNano() < until {
		return false, false
	}
	// Hết cooldown: chỉ đúng 1 goroutine nhận cờ probe thử lại (half-open)
	if cb.probing.CompareAndSwap(false, true) {
		return true, true
	}
	return false, false
}

// Report cập nhật trạng thái breaker sau khi thực hiện request.
// Luôn giải phóng cờ probe (cb.probing) ở mọi đường thoát qua defer khi isProbe == true.
func (cb *CircuitBreaker) Report(err error, isProbe bool) {
	if isProbe {
		defer cb.probing.Store(false)
	}
	switch {
	case err == nil:
		cb.fails.Store(0)
		if isProbe {
			// Chỉ reset breaker và backoff khi request probe thành công
			// Tránh request cũ về muộn vô tình mở breaker sớm
			cb.blockedUntil.Store(0)
			cb.backoffStep.Store(0)
		}
	case errors.Is(err, context.Canceled), errors.Is(err, errEmptyTranslation):
		// Tua video hoặc câu dịch rỗng: không phải lỗi của nhà cung cấp dịch vụ
	case errors.Is(err, ErrRateLimited):
		// Bị rate limit / HTTP 429: Khóa với exponential backoff hoặc theo Retry-After cụ thể.
		// Chỉ tăng step và đặt blockedUntil khi breaker hoàn toàn đóng (blockedUntil == 0) hoặc khi là probe.
		// Request thường nhận 429 lúc breaker đã khóa hoặc đang half-open (blockedUntil != 0) thì bỏ qua.
		if !isProbe && cb.blockedUntil.Load() != 0 {
			return
		}

		var rlErr *RateLimitError
		if errors.As(err, &rlErr) && rlErr.RetryAfter > 0 {
			dur := rlErr.RetryAfter
			// Đặt sàn tối thiểu 15s để tránh breaker bị đóng-mở liên tục nếu Retry-After quá ngắn
			if dur < 15*time.Second {
				dur = 15 * time.Second
			}
			if dur > cb.config.MaxBackoff {
				dur = cb.config.MaxBackoff
			}

			// Nếu là probe thất bại: bắt buộc tăng bậc backoff để không bị kẹt ở Retry-After ngắn
			if isProbe {
				step := cb.backoffStep.Add(1)
				maxStep := cb.config.MaxBackoffStep
				if step > maxStep {
					cb.backoffStep.Store(maxStep)
					step = maxStep
				}
				expDur := cb.config.BaseBackoff * time.Duration(1<<(step-1))
				if expDur > cb.config.MaxBackoff || expDur <= 0 {
					expDur = cb.config.MaxBackoff
				}
				if expDur > dur {
					dur = expDur
				}
				cb.blockedUntil.Store(time.Now().Add(dur).UnixNano())
				log.Printf("[CircuitBreaker] Probe thất bại theo Retry-After: bậc %d, thời lượng %v", step, dur)
				return
			}

			// Khi bị khóa lần đầu hoặc không phải probe:
			// Giữ max(step hiện tại, 1), tuyệt đối không hạ bậc backoff nếu trước đó đã ở bậc cao hơn
			curStep := cb.backoffStep.Load()
			if curStep < 1 {
				cb.backoffStep.Store(1)
				curStep = 1
			}
			cb.blockedUntil.Store(time.Now().Add(dur).UnixNano())
			log.Printf("[CircuitBreaker] Khóa breaker theo Retry-After: bậc %d, thời lượng %v", curStep, dur)
			return
		}

		// Bậc 1: 1m, Bậc 2: 2m, Bậc 3: 4m, Bậc 4: 8m, Bậc 5: 16m (cap 10m), Bậc 6: 32m (cap 10m)
		step := cb.backoffStep.Add(1)
		maxStep := cb.config.MaxBackoffStep
		if step > maxStep {
			cb.backoffStep.Store(maxStep)
			step = maxStep
		}
		dur := cb.config.BaseBackoff * time.Duration(1<<(step-1))
		if dur > cb.config.MaxBackoff || dur <= 0 {
			dur = cb.config.MaxBackoff
		}
		cb.blockedUntil.Store(time.Now().Add(dur).UnixNano())
		log.Printf("[CircuitBreaker] Khóa breaker: bậc %d, thời lượng %v", step, dur)
	default: // Lỗi mạng / timeout
		if isProbe {
			// Probe thất bại: tiếp tục khóa probeFailCooldown (mặc định 1 phút)
			cb.blockedUntil.Store(time.Now().Add(cb.config.ProbeFailCooldown).UnixNano())
		} else if cb.fails.Add(1) >= cb.config.ConsecutiveFailThreshold {
			// Ngưỡng lỗi mạng liên tiếp khi chạy bình thường: khóa networkCooldown (mặc định 2 phút)
			cb.blockedUntil.Store(time.Now().Add(cb.config.NetworkCooldown).UnixNano())
			cb.fails.Store(0)
		}
	}
}
