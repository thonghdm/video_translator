package main

import (
	"context"
	"fmt"
	"math"
	"os"
	"time"
)

const (
	// pcm_s16le 16kHz mono = 32000 byte/giây; phần đầu WAV (RIFF + LIST do ffmpeg thêm) chừa dư 100 byte
	wavBytesPerSec = 32000
	wavHeaderSlack = 100
)

// spoolSource là phần của DriveSpool mà slicer cần (tách ra để test được bằng nguồn giả).
type spoolSource interface {
	Acquire(ctx context.Context, fileID string, startSec, lenSec, totalDurationSec float64) (path string, ok bool, complete bool)
}

// sliceParams gom các đầu vào để cắt audio một block.
type sliceParams struct {
	tools        *ToolsPaths
	videoPath    string
	spool        spoolSource         // nil = không dùng spool
	resolveInput func(string) string // nil = ResolveMediaInput
	durationSec  float64
}

// buildSliceArgs dựng lệnh ffmpeg Fast Seek: -ss trước -i, chỉ lấy audio 16kHz mono PCM.
// networkInput=true bật seekable/reconnect cho nguồn HTTP (proxy Drive).
func buildSliceArgs(input string, networkInput bool, r BlockRange, wavPath string) []string {
	var args []string
	if networkInput {
		args = append(args, "-seekable", "1", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5")
	}
	return append(args,
		"-ss", fmt.Sprintf("%.3f", r.ExtractStart),
		"-i", input,
		"-t", fmt.Sprintf("%.3f", r.ExtractLen),
		"-vn",
		"-acodec", "pcm_s16le",
		"-ar", "16000",
		"-ac", "1",
		"-threads", "2",
		"-y",
		wavPath,
	)
}

// wavSecondsFromSize ước lượng độ dài WAV theo kích thước file (đủ chính xác để bắt trường hợp cắt hụt).
func wavSecondsFromSize(path string) (float64, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	data := fi.Size() - wavHeaderSlack
	if data < 0 {
		data = 0
	}
	return float64(data) / wavBytesPerSec, nil
}

// minAcceptableSeconds: độ dài WAV tối thiểu chấp nhận được cho một block dài want giây.
func minAcceptableSeconds(want float64) float64 {
	return math.Max(want-1.0, want*0.5)
}

// sliceBlockAudio cắt WAV cho một block.
//
// Với video Drive, nếu spool đưa ra file cục bộ thì đọc từ đó. ffmpeg đọc file đang tải dở thường
// KHÔNG báo lỗi mà chỉ trả WAV ngắn/rỗng, nên khi file chưa tải xong, kết quả luôn được kiểm tra độ dài;
// hụt hoặc lỗi → cắt lại bằng đường proxy. usedSpool cho biết kết quả cuối cùng lấy từ file cục bộ.
func sliceBlockAudio(ctx context.Context, sp sliceParams, bRange BlockRange, wavPath string) (usedSpool bool, err error) {
	resolve := sp.resolveInput
	if resolve == nil {
		resolve = ResolveMediaInput
	}
	run := func(input string, network bool, timeout time.Duration) error {
		_, e := RunCommand(ctx, sp.tools.FFmpeg, buildSliceArgs(input, network, bRange, wavPath), timeout, nil)
		return e
	}

	if !IsDrivePath(sp.videoPath) {
		return false, run(resolve(sp.videoPath), false, 60*time.Second)
	}

	if sp.spool != nil {
		fileID := DriveFileIDFromPath(sp.videoPath)
		if local, ok, complete := sp.spool.Acquire(ctx, fileID, bRange.ExtractStart, bRange.ExtractLen, sp.durationSec); ok {
			t0 := time.Now()
			serr := run(local, false, 60*time.Second)
			if ctx.Err() != nil {
				return false, ctx.Err()
			}
			if complete {
				// File đã đủ trên đĩa: lỗi ffmpeg ở đây là lỗi thật, không phải do thiếu dữ liệu
				return serr == nil, serr
			}
			got, gerr := wavSecondsFromSize(wavPath)
			want := bRange.ExtractLen
			switch {
			case serr == nil && gerr == nil && got >= minAcceptableSeconds(want):
				return true, nil
			case serr != nil:
				DiagLog("[slice] block start=%.1f spool lỗi sau %dms → proxy: %v", bRange.ExtractStart, time.Since(t0).Milliseconds(), serr)
			default:
				DiagLog("[slice] block start=%.1f spool cho WAV hụt (%.2fs/%.2fs) → proxy", bRange.ExtractStart, got, want)
			}
		}
	}

	// Đường proxy loopback Drive: bật seekable + reconnect để ffmpeg seek bằng HTTP Range
	return false, run(resolve(sp.videoPath), true, 120*time.Second)
}
