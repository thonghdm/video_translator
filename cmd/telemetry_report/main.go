// telemetry_report đọc telemetry/runs/*/blocks.jsonl và seeks.jsonl rồi xuất báo cáo Markdown.
// Cách dùng: go run ./cmd/telemetry_report [-dir telemetry/runs] [-out telemetry/REPORT.md]
// Chỉ in số đo; không đưa ra kết luận hay khuyến nghị.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

type BlockRecord struct {
	SessionID            int64    `json:"session_id"`
	BlockIndex           int      `json:"block_index"`
	BlockStartSec        float64  `json:"block_start_sec"`
	BlockLenSec          float64  `json:"block_len_sec"`
	Tier                 int      `json:"tier"`
	SourceType           string   `json:"source_type"`
	BlockOrderInSession  int      `json:"block_order_in_session"`
	WhisperThreads       int      `json:"whisper_threads"`
	FfmpegCutMs          int64    `json:"ffmpeg_cut_ms"`
	WhisperWallMs        int64    `json:"whisper_wall_ms"`
	WhisperLoadMs        *float64 `json:"whisper_load_ms"`
	WhisperEncodeMs      *float64 `json:"whisper_encode_ms"`
	WhisperDecodeMs      *float64 `json:"whisper_decode_ms"`
	WhisperTotalMs       *float64 `json:"whisper_total_ms"`
	WhisperTimingsParsed bool     `json:"whisper_timings_parsed"`
	TranslateMs          int64    `json:"translate_ms"`
	TranslatorUsed       string   `json:"translator_used"`
	SentenceCount        int      `json:"sentence_count"`
	CharCount            int      `json:"char_count"`
	QueueWaitMs          int64    `json:"queue_wait_ms"`
	ComputeWaitMs        int64    `json:"compute_wait_ms"`
	BlockTotalMs         int64    `json:"block_total_ms"`
	Cancelled            bool     `json:"cancelled"`
}

type SeekRecord struct {
	Timestamp          string  `json:"timestamp"`
	TargetSec          float64 `json:"target_sec"`
	OldSessionID       int64   `json:"old_session_id"`
	NewSessionID       int64   `json:"new_session_id"`
	OldTier2WasRunning bool    `json:"old_tier2_was_running"`
	OldBlockRunningIdx int     `json:"old_block_running_idx"`
	Tier2DrainMs       int64   `json:"tier2_drain_ms"`
	ComputeMuDrainMs   int64   `json:"compute_mu_drain_ms"`
	FirstSubLatencyMs  int64   `json:"first_sub_latency_ms"`
}

type stat struct {
	N                      int
	Min, Median, P95, Max float64
}

func percentile(sorted []float64, p float64) float64 {
	n := len(sorted)
	if n == 0 {
		return 0
	}
	if n == 1 {
		return sorted[0]
	}
	rank := p / 100.0 * float64(n-1)
	lo, hi := int(math.Floor(rank)), int(math.Ceil(rank))
	if lo == hi {
		return sorted[lo]
	}
	w := rank - float64(lo)
	return sorted[lo]*(1-w) + sorted[hi]*w
}

func calc(v []float64) stat {
	if len(v) == 0 {
		return stat{}
	}
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	return stat{N: len(s), Min: s[0], Median: percentile(s, 50), P95: percentile(s, 95), Max: s[len(s)-1]}
}

func readJSONL[T any](path string) []T {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []T
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	for sc.Scan() {
		if len(sc.Bytes()) == 0 {
			continue
		}
		var r T
		if json.Unmarshal(sc.Bytes(), &r) == nil {
			out = append(out, r)
		}
	}
	return out
}

func row(sb *strings.Builder, name string, s stat, unit string) {
	if s.N == 0 {
		fmt.Fprintf(sb, "| %s | 0 | n/a | n/a | n/a | n/a |\n", name)
		return
	}
	fmt.Fprintf(sb, "| %s | %d | %.1f%s | %.1f%s | %.1f%s | %.1f%s |\n", name, s.N, s.Min, unit, s.Median, unit, s.P95, unit, s.Max, unit)
}

func group(sb *strings.Builder, title string, list []BlockRecord) {
	fmt.Fprintf(sb, "\n**%s** (%d block)\n\n", title, len(list))
	if len(list) == 0 {
		sb.WriteString("_không có mẫu_\n")
		return
	}
	var cut, wall, load, enc, dec, tot, ratio, trans, queue, comp, btot, wallVsTot []float64
	for _, b := range list {
		cut = append(cut, float64(b.FfmpegCutMs))
		wall = append(wall, float64(b.WhisperWallMs))
		trans = append(trans, float64(b.TranslateMs))
		queue = append(queue, float64(b.QueueWaitMs))
		comp = append(comp, float64(b.ComputeWaitMs))
		btot = append(btot, float64(b.BlockTotalMs))
		if b.WhisperLoadMs != nil {
			load = append(load, *b.WhisperLoadMs)
			if b.WhisperWallMs > 0 {
				ratio = append(ratio, *b.WhisperLoadMs/float64(b.WhisperWallMs)*100)
			}
			if b.BlockTotalMs > 0 {
				wallVsTot = append(wallVsTot, *b.WhisperLoadMs/float64(b.BlockTotalMs)*100)
			}
		}
		if b.WhisperEncodeMs != nil {
			enc = append(enc, *b.WhisperEncodeMs)
		}
		if b.WhisperDecodeMs != nil {
			dec = append(dec, *b.WhisperDecodeMs)
		}
		if b.WhisperTotalMs != nil {
			tot = append(tot, *b.WhisperTotalMs)
		}
	}
	sb.WriteString("| Chỉ số | Mẫu | Min | Median | P95 | Max |\n|---|---|---|---|---|---|\n")
	row(sb, "ffmpeg_cut_ms", calc(cut), "ms")
	row(sb, "whisper_wall_ms", calc(wall), "ms")
	row(sb, "whisper_load_ms", calc(load), "ms")
	row(sb, "whisper_encode_ms", calc(enc), "ms")
	row(sb, "whisper_decode_ms", calc(dec), "ms")
	row(sb, "whisper_total_ms (whisper tự báo)", calc(tot), "ms")
	row(sb, "load / whisper_wall_ms", calc(ratio), "%")
	row(sb, "load / block_total_ms", calc(wallVsTot), "%")
	row(sb, "translate_ms", calc(trans), "ms")
	row(sb, "queue_wait_ms", calc(queue), "ms")
	row(sb, "compute_wait_ms", calc(comp), "ms")
	row(sb, "block_total_ms", calc(btot), "ms")
}

func main() {
	dir := flag.String("dir", filepath.Join("telemetry", "runs"), "thư mục chứa các run (threads_N)")
	out := flag.String("out", filepath.Join("telemetry", "REPORT.md"), "file báo cáo Markdown")
	flag.Parse()

	runs, _ := filepath.Glob(filepath.Join(*dir, "threads_*"))
	sort.Strings(runs)
	if len(runs) == 0 {
		fmt.Println("Không tìm thấy dữ liệu trong", *dir)
		os.Exit(1)
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "# Báo cáo telemetry thực tế\n\n")
	fmt.Fprintf(&sb, "- Thời điểm xuất: %s\n- Máy: %s/%s, %d logical CPU\n- Nguồn dữ liệu: `%s`\n", time.Now().Format("2006-01-02 15:04:05"), runtime.GOOS, runtime.GOARCH, runtime.NumCPU(), *dir)
	sb.WriteString("- Định nghĩa nhóm: **Block nguội** = block đầu tiên hoàn tất của run; **Block đầu sau tua** = block có `block_order_in_session=1` không phải block nguội; **Block ấm** = các block còn lại (không bị hủy).\n")

	type summary struct {
		threads             int
		warmN               int
		warmLoadMed, warmLoadP95   float64
		warmRatioMed, warmRatioP95 float64
		warmWallMed         float64
		warmTotalMed        float64
	}
	var sums []summary

	for _, run := range runs {
		blocks := readJSONL[BlockRecord](filepath.Join(run, "blocks.jsonl"))
		seeks := readJSONL[SeekRecord](filepath.Join(run, "seeks.jsonl"))
		fmt.Fprintf(&sb, "\n---\n\n## %s\n", filepath.Base(run))
		if len(blocks) == 0 {
			sb.WriteString("\n_không có bản ghi block_\n")
			continue
		}

		var done, cancelled []BlockRecord
		for _, b := range blocks {
			if b.Cancelled {
				cancelled = append(cancelled, b)
			} else {
				done = append(done, b)
			}
		}
		var cold, afterSeek, warm []BlockRecord
		for i, b := range done {
			switch {
			case i == 0:
				cold = append(cold, b)
			case b.BlockOrderInSession == 1:
				afterSeek = append(afterSeek, b)
			default:
				warm = append(warm, b)
			}
		}

		unparsed, tier1, tier2, llama := 0, 0, 0, 0
		src := map[string]int{}
		var sent, chars int
		for _, b := range done {
			if !b.WhisperTimingsParsed {
				unparsed++
			}
			if b.Tier == 1 {
				tier1++
			} else {
				tier2++
			}
			if strings.Contains(b.TranslatorUsed, "llama") {
				llama++
			}
			src[b.SourceType]++
			sent += b.SentenceCount
			chars += b.CharCount
		}
		thr := done[0].WhisperThreads
		fmt.Fprintf(&sb, "\n- whisper_threads: **%d**\n- Block hoàn tất: %d | bị hủy: %d | tier-1: %d | tier-2: %d\n- Block không parse được whisper timings: %d\n- Block có llama đã nạp: %d\n- Nguồn: %v | tổng câu: %d | tổng ký tự: %d\n", thr, len(done), len(cancelled), tier1, tier2, unparsed, llama, src, sent, chars)

		group(&sb, "Block nguội (block đầu tiên của run)", cold)
		group(&sb, "Block đầu sau tua", afterSeek)
		group(&sb, "Block ấm", warm)

		// Tóm tắt phục vụ so sánh giữa các lần chạy
		var wl, wr, ww, wt []float64
		for _, b := range warm {
			if b.WhisperLoadMs != nil {
				wl = append(wl, *b.WhisperLoadMs)
				if b.WhisperWallMs > 0 {
					wr = append(wr, *b.WhisperLoadMs / float64(b.WhisperWallMs) * 100)
				}
			}
			ww = append(ww, float64(b.WhisperWallMs))
			wt = append(wt, float64(b.BlockTotalMs))
		}
		l, r, w, t := calc(wl), calc(wr), calc(ww), calc(wt)
		sums = append(sums, summary{thr, len(warm), l.Median, l.P95, r.Median, r.P95, w.Median, t.Median})

		sb.WriteString("\n**Block bị hủy giữa chừng**\n\n")
		if len(cancelled) == 0 {
			sb.WriteString("_không có_\n")
		} else {
			sb.WriteString("| block | tier-order | whisper_wall_ms (tới lúc bị kill) | block_total_ms |\n|---|---|---|---|\n")
			for _, c := range cancelled {
				fmt.Fprintf(&sb, "| %d | %d | %d | %d |\n", c.BlockIndex, c.BlockOrderInSession, c.WhisperWallMs, c.BlockTotalMs)
			}
		}

		sb.WriteString("\n**Độ trễ khi tua (seek)**\n\n")
		if len(seeks) == 0 {
			sb.WriteString("_không có bản ghi tua_\n")
		} else {
			sb.WriteString("| # | tới (s) | seek_latency_ms | Tier-2 cũ đang chạy | block cũ | thời gian chờ worker cũ thoát (ms) | computeMu nhả sau cancel (ms) |\n|---|---|---|---|---|---|---|\n")
			var lat []float64
			for i, s := range seeks {
				lat = append(lat, float64(s.FirstSubLatencyMs))
				fmt.Fprintf(&sb, "| %d | %.0f | %d | %v | %d | %d | %d |\n", i+1, s.TargetSec, s.FirstSubLatencyMs, s.OldTier2WasRunning, s.OldBlockRunningIdx, s.Tier2DrainMs, s.ComputeMuDrainMs)
			}
			ls := calc(lat)
			fmt.Fprintf(&sb, "\nseek_latency_ms: n=%d, min=%.0f, median=%.0f, p95=%.0f, max=%.0f\n", ls.N, ls.Min, ls.Median, ls.P95, ls.Max)
		}

		if sample, err := os.ReadFile(filepath.Join(run, "whisper_stderr_sample.txt")); err == nil {
			_ = sample
			fmt.Fprintf(&sb, "\n_Mẫu stderr thô: `%s`_\n", filepath.ToSlash(filepath.Join(run, "whisper_stderr_sample.txt")))
		}
	}

	sb.WriteString("\n---\n\n## So sánh số thread (chỉ khối **Block ấm**)\n\n")
	sb.WriteString("| threads | số block ấm | load_ms median | load_ms p95 | load/wall median | load/wall p95 | whisper_wall_ms median | block_total_ms median |\n|---|---|---|---|---|---|---|---|\n")
	sort.Slice(sums, func(i, j int) bool { return sums[i].threads < sums[j].threads })
	for _, s := range sums {
		fmt.Fprintf(&sb, "| %d | %d | %.1f | %.1f | %.1f%% | %.1f%% | %.0f | %.0f |\n", s.threads, s.warmN, s.warmLoadMed, s.warmLoadP95, s.warmRatioMed, s.warmRatioP95, s.warmWallMed, s.warmTotalMed)
	}

	if err := os.MkdirAll(filepath.Dir(*out), 0755); err == nil {
		_ = os.WriteFile(*out, []byte(sb.String()), 0644)
	}
	fmt.Print(sb.String())
	fmt.Printf("\n(đã ghi %s)\n", *out)
}
