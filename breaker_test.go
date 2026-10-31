package main

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestBreaker_DefaultConfig kiểm tra cấu hình mặc định tương thích hoàn toàn với Google GTX
func TestBreaker_DefaultConfig(t *testing.T) {
	cfg := DefaultBreakerConfig()
	if cfg.BaseBackoff != 1*time.Minute {
		t.Fatalf("kỳ vọng BaseBackoff = 1m, nhận: %v", cfg.BaseBackoff)
	}
	if cfg.MaxBackoff != 10*time.Minute {
		t.Fatalf("kỳ vọng MaxBackoff = 10m, nhận: %v", cfg.MaxBackoff)
	}
	if cfg.ProbeFailCooldown != 1*time.Minute {
		t.Fatalf("kỳ vọng ProbeFailCooldown = 1m, nhận: %v", cfg.ProbeFailCooldown)
	}
	if cfg.NetworkCooldown != 2*time.Minute {
		t.Fatalf("kỳ vọng NetworkCooldown = 2m, nhận: %v", cfg.NetworkCooldown)
	}
	if cfg.ConsecutiveFailThreshold != 3 {
		t.Fatalf("kỳ vọng ConsecutiveFailThreshold = 3, nhận: %d", cfg.ConsecutiveFailThreshold)
	}
	if cfg.MaxBackoffStep != 6 {
		t.Fatalf("kỳ vọng MaxBackoffStep = 6, nhận: %d", cfg.MaxBackoffStep)
	}
}

// TestBreaker_ZeroValueConfig_FallbacksToDefaults kiểm tra cấu hình truyền struct rỗng (các field = 0)
// được tự động chuẩn hóa về giá trị mặc định, không gây chia cho 0 hay panic.
func TestBreaker_ZeroValueConfig_FallbacksToDefaults(t *testing.T) {
	cb := NewCircuitBreaker(BreakerConfig{})
	if cb.config.BaseBackoff != 1*time.Minute {
		t.Fatalf("kỳ vọng BaseBackoff fallback về 1m, nhận: %v", cb.config.BaseBackoff)
	}
	if cb.config.MaxBackoff != 10*time.Minute {
		t.Fatalf("kỳ vọng MaxBackoff fallback về 10m, nhận: %v", cb.config.MaxBackoff)
	}
	if cb.config.ProbeFailCooldown != 1*time.Minute {
		t.Fatalf("kỳ vọng ProbeFailCooldown fallback về 1m, nhận: %v", cb.config.ProbeFailCooldown)
	}
	if cb.config.NetworkCooldown != 2*time.Minute {
		t.Fatalf("kỳ vọng NetworkCooldown fallback về 2m, nhận: %v", cb.config.NetworkCooldown)
	}
	if cb.config.ConsecutiveFailThreshold != 3 {
		t.Fatalf("kỳ vọng ConsecutiveFailThreshold fallback về 3, nhận: %d", cb.config.ConsecutiveFailThreshold)
	}
	if cb.config.MaxBackoffStep != 6 {
		t.Fatalf("kỳ vọng MaxBackoffStep fallback về 6, nhận: %d", cb.config.MaxBackoffStep)
	}

	// Đảm bảo hoạt động bình thường khi report rate limit
	cb.Report(ErrRateLimited, false)
	if !cb.Blocked() {
		t.Fatalf("kỳ vọng cb bị khóa sau khi gặp ErrRateLimited")
	}
}

// TestBreaker_Concurrent429_DoesNotJumpSteps kiểm tra ba lần Report(ErrRateLimited, false) liên tiếp từ trạng thái mở
// chỉ cho khóa 1 phút và Step() == 1; probe thất bại do 429 thì tăng bậc tiếp.
func TestBreaker_Concurrent429_DoesNotJumpSteps(t *testing.T) {
	cb := NewCircuitBreaker(DefaultBreakerConfig())

	// 3 lần Report(ErrRateLimited, false) liên tiếp từ trạng thái mở (mô phỏng 3 request đồng thời cùng dính 429)
	now := time.Now()
	cb.Report(ErrRateLimited, false)
	cb.Report(ErrRateLimited, false)
	cb.Report(ErrRateLimited, false)

	// Chỉ cho khóa 1 phút và Step() == 1
	if step := cb.backoffStep.Load(); step != 1 {
		t.Fatalf("kỳ vọng step = 1 sau 3 lần 429 thường liên tiếp, nhận: %d", step)
	}
	if !cb.Blocked() {
		t.Fatalf("kỳ vọng breaker bị khóa sau lần 429 đầu tiên")
	}
	blockedUntil := time.Unix(0, cb.blockedUntil.Load())
	dur := blockedUntil.Sub(now)
	if dur < 55*time.Second || dur > 65*time.Second {
		t.Fatalf("kỳ vọng thời gian khóa là 1 phút (bậc 1), nhận: %v", dur)
	}

	// Giả lập cooldown kết thúc, probe thất bại do 429 (isProbe = true) -> tăng bậc tiếp lên 2 (2 phút)
	probeNow := time.Now()
	cb.Report(ErrRateLimited, true)
	if step := cb.backoffStep.Load(); step != 2 {
		t.Fatalf("kỳ vọng step = 2 sau khi probe gặp 429, nhận: %d", step)
	}
	blockedUntil2 := time.Unix(0, cb.blockedUntil.Load())
	dur2 := blockedUntil2.Sub(probeNow)
	if dur2 < 115*time.Second || dur2 > 125*time.Second {
		t.Fatalf("kỳ vọng thời gian khóa là 2 phút (bậc 2) sau khi probe thất bại, nhận: %v", dur2)
	}
}

// TestBreaker_CooldownExpired_NormalRequest429_DoesNotIncrementStep kiểm tra khi cooldown đã hết (blockedUntil ở quá khứ)
// nhưng request thường (isProbe = false) gặp 429 thì không được tăng step hay coi là lần khóa mới.
func TestBreaker_CooldownExpired_NormalRequest429_DoesNotIncrementStep(t *testing.T) {
	cb := NewCircuitBreaker(DefaultBreakerConfig())

	// Bước 1: Khóa lần đầu do rate limit -> step = 1
	cb.Report(ErrRateLimited, false)
	if step := cb.backoffStep.Load(); step != 1 {
		t.Fatalf("kỳ vọng step = 1, nhận: %d", step)
	}

	// Bước 2: Giả lập thời gian trôi qua, cooldown đã hết (blockedUntil ở quá khứ), nhưng chưa có probe thành công
	pastTime := time.Now().Add(-5 * time.Second).UnixNano()
	cb.blockedUntil.Store(pastTime)

	// Blocked() lúc này trả về false vì cooldown đã qua
	if cb.Blocked() {
		t.Fatalf("kỳ vọng Blocked() trả về false khi blockedUntil ở quá khứ")
	}

	// Bước 3: Một request thường (isProbe = false) nhận 429 lúc này
	cb.Report(ErrRateLimited, false)

	// Step vẫn phải giữ nguyên là 1, blockedUntil không bị thay đổi
	if step := cb.backoffStep.Load(); step != 1 {
		t.Fatalf("kỳ vọng step vẫn giữ nguyên 1 khi request thường gặp 429 sau cooldown, nhận: %d", step)
	}
	if until := cb.blockedUntil.Load(); until != pastTime {
		t.Fatalf("kỳ vọng blockedUntil không bị thay đổi, nhận: %d vs %d", until, pastTime)
	}

	// Bước 4: Request probe (isProbe = true) gặp 429 thì MỚI được tăng step lên 2
	cb.Report(ErrRateLimited, true)
	if step := cb.backoffStep.Load(); step != 2 {
		t.Fatalf("kỳ vọng probe thất bại do 429 tăng step lên 2, nhận: %d", step)
	}
}

// TestBreaker_RateLimit_ExponentialBackoff_StepsAndDurations kiểm tra chính xác giá trị từng bậc:
// Bậc 1: 1m
// Bậc 2: 2m
// Bậc 3: 4m
// Bậc 4: 8m
// Bậc 5: 16m -> bị cap ở 10m
// Bậc 6: 32m -> bị cap ở 10m
// Bậc > 6: step bị cap ở 6, thời gian bị cap ở 10m
func TestBreaker_RateLimit_ExponentialBackoff_StepsAndDurations(t *testing.T) {
	cb := NewCircuitBreaker(DefaultBreakerConfig())

	expectedDurations := []time.Duration{
		1 * time.Minute,  // Step 1: 1m * 2^0 = 1m
		2 * time.Minute,  // Step 2: 1m * 2^1 = 2m
		4 * time.Minute,  // Step 3: 1m * 2^2 = 4m
		8 * time.Minute,  // Step 4: 1m * 2^3 = 8m
		10 * time.Minute, // Step 5: 1m * 2^4 = 16m -> cap 10m
		10 * time.Minute, // Step 6: 1m * 2^5 = 32m -> cap 10m
	}

	for i, expectedDur := range expectedDurations {
		expectedStep := int32(i + 1)
		now := time.Now()
		isProbe := (i > 0)
		cb.Report(ErrRateLimited, isProbe)

		if step := cb.backoffStep.Load(); step != expectedStep {
			t.Fatalf("lần %d: kỳ vọng step = %d, nhận: %d", i+1, expectedStep, step)
		}

		blockedUntil := time.Unix(0, cb.blockedUntil.Load())
		actualDur := blockedUntil.Sub(now)

		// Cho phép dung sai 5 giây do CPU scheduling
		diff := actualDur - expectedDur
		if diff < -5*time.Second || diff > 5*time.Second {
			t.Fatalf("lần %d (step %d): kỳ vọng duration xấp xỉ %v, nhận: %v (lệch %v)",
				i+1, expectedStep, expectedDur, actualDur, diff)
		}
	}

	// Gọi thêm 5 lần nữa: step vẫn phải bị cap ở 6, duration vẫn cap ở 10m
	for i := 0; i < 5; i++ {
		now := time.Now()
		cb.Report(ErrRateLimited, true)
		if step := cb.backoffStep.Load(); step != 6 {
			t.Fatalf("sau khi vượt trần: kỳ vọng step = 6, nhận: %d", step)
		}
		blockedUntil := time.Unix(0, cb.blockedUntil.Load())
		actualDur := blockedUntil.Sub(now)
		diff := actualDur - 10*time.Minute
		if diff < -5*time.Second || diff > 5*time.Second {
			t.Fatalf("sau khi vượt trần: kỳ vọng duration xấp xỉ 10m, nhận: %v", actualDur)
		}
	}
}

// TestBreaker_StaleSuccess_DoesNotUnblock kiểm tra request cũ về muộn (isProbe = false, err = nil)
// tuyệt đối không được phép mở breaker hay reset backoff step.
func TestBreaker_StaleSuccess_DoesNotUnblock(t *testing.T) {
	cb := NewCircuitBreaker(DefaultBreakerConfig())

	// Kích hoạt breaker mở do rate limit
	cb.Report(ErrRateLimited, false)
	if !cb.Blocked() {
		t.Fatalf("kỳ vọng breaker mở")
	}
	if cb.backoffStep.Load() != 1 {
		t.Fatalf("kỳ vọng step = 1")
	}

	// Request cũ về muộn thành công (isProbe = false, err = nil)
	cb.Report(nil, false)

	// Breaker vẫn phải tiếp tục khóa và step giữ nguyên
	if !cb.Blocked() {
		t.Fatalf("request cũ về muộn (isProbe=false) không được phép đóng breaker")
	}
	if cb.backoffStep.Load() != 1 {
		t.Fatalf("request cũ về muộn không được phép reset backoff step")
	}
}

// TestBreaker_ProbeSuccess_UnblocksAndResetsStep kiểm tra chỉ probe thành công (isProbe = true, err = nil)
// mới được đóng breaker và reset backoff step về 0.
func TestBreaker_ProbeSuccess_UnblocksAndResetsStep(t *testing.T) {
	cb := NewCircuitBreaker(DefaultBreakerConfig())

	// Đưa breaker lên step 3 (step 1 từ unblocked, step 2 và 3 từ probe thất bại)
	cb.Report(ErrRateLimited, false)
	cb.Report(ErrRateLimited, true)
	cb.Report(ErrRateLimited, true)
	if cb.backoffStep.Load() != 3 {
		t.Fatalf("kỳ vọng step = 3, nhận: %d", cb.backoffStep.Load())
	}

	// Giả lập cooldown đã hết để probe
	cb.blockedUntil.Store(time.Now().Add(-100 * time.Millisecond).UnixNano())
	allowed, isProbe := cb.Allow()
	if !allowed || !isProbe {
		t.Fatalf("kỳ vọng probe được cấp quyền: (%v, %v)", allowed, isProbe)
	}

	// Probe thành công
	cb.Report(nil, isProbe)

	if cb.Blocked() {
		t.Fatalf("kỳ vọng breaker đã đóng hoàn toàn sau probe thành công")
	}
	if step := cb.backoffStep.Load(); step != 0 {
		t.Fatalf("kỳ vọng backoff step được reset về 0, nhận: %d", step)
	}
	if cb.probing.Load() {
		t.Fatalf("cờ probing phải được giải phóng về false")
	}
}

// TestBreaker_ProbeFailure_Cooldown kiểm tra probe thất bại tiếp tục khóa 1 phút và giải phóng cờ probing
func TestBreaker_ProbeFailure_Cooldown(t *testing.T) {
	cb := NewCircuitBreaker(DefaultBreakerConfig())

	// Cooldown hết, goroutine nhận quyền probe
	cb.blockedUntil.Store(time.Now().Add(-100 * time.Millisecond).UnixNano())
	allowed, isProbe := cb.Allow()
	if !allowed || !isProbe {
		t.Fatalf("kỳ vọng được probe")
	}

	// Probe gặp lỗi mạng thông thường
	now := time.Now()
	cb.Report(errors.New("connection reset by peer"), isProbe)

	if cb.probing.Load() {
		t.Fatalf("cờ probing phải được nhả về false qua defer")
	}
	if !cb.Blocked() {
		t.Fatalf("kỳ vọng breaker tiếp tục khóa sau khi probe thất bại")
	}

	// Kiểm tra thời gian khóa thêm xấp xỉ 1 phút
	blockedUntil := time.Unix(0, cb.blockedUntil.Load())
	dur := blockedUntil.Sub(now)
	if dur < 55*time.Second || dur > 65*time.Second {
		t.Fatalf("kỳ vọng probe thất bại khóa 1 phút, nhận: %v", dur)
	}
}

// TestBreaker_ConsecutiveNetworkFailures kiểm tra 3 lỗi mạng liên tiếp khi chạy bình thường kích hoạt khóa 2 phút
func TestBreaker_ConsecutiveNetworkFailures(t *testing.T) {
	cb := NewCircuitBreaker(DefaultBreakerConfig())

	netErr := errors.New("timeout dialing remote host")

	// Lỗi 1
	cb.Report(netErr, false)
	if cb.Blocked() {
		t.Fatalf("lỗi 1 không được khóa breaker")
	}
	if cb.fails.Load() != 1 {
		t.Fatalf("kỳ vọng fails = 1, nhận: %d", cb.fails.Load())
	}

	// Lỗi 2
	cb.Report(netErr, false)
	if cb.Blocked() {
		t.Fatalf("lỗi 2 không được khóa breaker")
	}
	if cb.fails.Load() != 2 {
		t.Fatalf("kỳ vọng fails = 2, nhận: %d", cb.fails.Load())
	}

	// Lỗi 3: Kích hoạt khóa 2 phút và reset fails về 0
	now := time.Now()
	cb.Report(netErr, false)
	if !cb.Blocked() {
		t.Fatalf("lỗi 3 phải kích hoạt khóa breaker")
	}
	if cb.fails.Load() != 0 {
		t.Fatalf("kỳ vọng fails được reset về 0 sau khi khóa, nhận: %d", cb.fails.Load())
	}

	blockedUntil := time.Unix(0, cb.blockedUntil.Load())
	dur := blockedUntil.Sub(now)
	if dur < 115*time.Second || dur > 125*time.Second {
		t.Fatalf("kỳ vọng khóa 2 phút sau 3 lỗi mạng liên tiếp, nhận: %v", dur)
	}
}

// TestBreaker_IgnoredErrors kiểm tra context.Canceled và errEmptyTranslation không phạt breaker
func TestBreaker_IgnoredErrors(t *testing.T) {
	cb := NewCircuitBreaker(DefaultBreakerConfig())

	// Báo lỗi hủy tác vụ
	cb.Report(context.Canceled, false)
	cb.Report(errEmptyTranslation, false)

	if cb.fails.Load() != 0 {
		t.Fatalf("kỳ vọng fails = 0, nhận: %d", cb.fails.Load())
	}
	if cb.Blocked() {
		t.Fatalf("breaker không được phép mở khi gặp lỗi bị hủy hoặc dịch rỗng")
	}
}

// TestBreaker_Blocked_NeverConsumesProbe chứng minh gọi Blocked() 10.000 lần liên tục ở mọi trạng thái
// (đặc biệt là khi cooldown đã hết) KHÔNG BAO GIỜ thay đổi cờ probing hay cướp lượt thử.
func TestBreaker_Blocked_NeverConsumesProbe(t *testing.T) {
	cb := NewCircuitBreaker(DefaultBreakerConfig())

	// Giả lập cooldown vừa hết (half-open candidate)
	cb.blockedUntil.Store(time.Now().Add(-50 * time.Millisecond).UnixNano())

	// Gọi Blocked() 10.000 lần
	for i := 0; i < 10000; i++ {
		blocked := cb.Blocked()
		if blocked {
			t.Fatalf("lần %d: kỳ vọng Blocked() trả về false khi đã qua cooldown", i)
		}
		if cb.probing.Load() {
			t.Fatalf("lần %d: Blocked() đã làm thay đổi cờ probing!", i)
		}
	}

	// Kiểm tra quyền probe vẫn còn nguyên vẹn cho caller gọi Allow() sau đó
	allowed, isProbe := cb.Allow()
	if !allowed || !isProbe {
		t.Fatalf("kỳ vọng Allow() vẫn nhận được probe (true, true) sau 10.000 lần gọi Blocked(), nhận: (%v, %v)",
			allowed, isProbe)
	}
}

// TestBreaker_HalfOpen_SingleProbeAndRelease kiểm tra chỉ đúng 1 goroutine nhận probe khi hết cooldown
func TestBreaker_HalfOpen_SingleProbeAndRelease(t *testing.T) {
	cb := NewCircuitBreaker(DefaultBreakerConfig())

	// Hết cooldown
	cb.blockedUntil.Store(time.Now().Add(-100 * time.Millisecond).UnixNano())

	// Goroutine 1 nhận probe
	a1, p1 := cb.Allow()
	if !a1 || !p1 {
		t.Fatalf("goroutine 1 phải nhận probe")
	}

	// Goroutine 2 gọi đồng thời bị từ chối
	a2, p2 := cb.Allow()
	if a2 || p2 {
		t.Fatalf("goroutine 2 phải bị chặn khi probe đang chạy")
	}

	// Goroutine 1 báo lỗi -> cờ probe phải giải phóng
	cb.Report(ErrRateLimited, p1)
	if cb.probing.Load() {
		t.Fatalf("cờ probing phải giải phóng về false sau Report")
	}
}

// TestBreaker_ConcurrentStress stress test 50 goroutines tranh chấp Allow, Blocked, Report dưới -race
func TestBreaker_ConcurrentStress(t *testing.T) {
	cb := NewCircuitBreaker(DefaultBreakerConfig())
	cb.blockedUntil.Store(time.Now().Add(-10 * time.Millisecond).UnixNano())

	var wg sync.WaitGroup
	var probeWins atomic.Int32
	var blockedChecks atomic.Int32

	// 30 goroutines liên tục kiểm tra Blocked()
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				_ = cb.Blocked()
				blockedChecks.Add(1)
			}
		}()
	}

	// 20 goroutines tranh chấp quyền probe
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			allowed, isProbe := cb.Allow()
			if allowed && isProbe {
				probeWins.Add(1)
				time.Sleep(1 * time.Millisecond)
				cb.Report(ErrRateLimited, true)
			}
		}()
	}

	wg.Wait()

	if wins := probeWins.Load(); wins != 1 {
		t.Fatalf("kỳ vọng đúng 1 goroutine probe ban đầu, nhận: %d", wins)
	}
	if checks := blockedChecks.Load(); checks != 3000 {
		t.Fatalf("kỳ vọng 3000 lần check Blocked, nhận: %d", checks)
	}
}
