package main

import (
	"os"
	"testing"
)

const variantSample = `whisper_print_timings: load time = 120 ms
whisper_print_timings: fallbacks = 1 p / 2 h
whisper_print_timings: mel time = 10.50 ms
whisper_print_timings: encode time = 2500.0 ms / 2 runs ( 1250.0 ms per run)
whisper_print_timings: decode time = 95.2 ms / 5 runs ( 19.04 ms per run)
whisper_print_timings: total time = 2750.75 ms
`

const invalidSample = `some error occurred in whisper
failed to open file
exit code 1
`

func TestParseWhisperTimings_RealSamples(t *testing.T) {
	files := []struct {
		path         string
		expectedRuns int
		expectedLang string
	}{
		{"telemetry/whisper_stderr_sample.txt", 2, "en"},
		{"telemetry/runs/threads_2/whisper_stderr_sample.txt", 3, "en"},
		{"telemetry/runs/threads_4/whisper_stderr_sample.txt", 3, "en"},
		{"telemetry/runs/threads_6/whisper_stderr_sample.txt", 3, "en"},
	}

	for _, tc := range files {
		data, err := os.ReadFile(tc.path)
		if err != nil {
			t.Logf("file %s chưa có, bỏ qua kiểm tra trực tiếp file", tc.path)
			continue
		}
		timings := ParseWhisperTimings(string(data))
		if !timings.Parsed {
			t.Fatalf("file %s: parse thất bại", tc.path)
		}
		if timings.Encode.Runs != tc.expectedRuns {
			t.Errorf("file %s: expected runs %d, got %d", tc.path, tc.expectedRuns, timings.Encode.Runs)
		}
		if timings.DetectedLang != tc.expectedLang {
			t.Errorf("file %s: expected lang %s, got %s", tc.path, tc.expectedLang, timings.DetectedLang)
		}
		if timings.Encode.MsPerRun == nil || *timings.Encode.MsPerRun <= 0 {
			t.Errorf("file %s: invalid MsPerRun %v", tc.path, timings.Encode.MsPerRun)
		}
		if timings.WavLenSec == nil || *timings.WavLenSec <= 0 {
			t.Errorf("file %s: invalid WavLenSec %v", tc.path, timings.WavLenSec)
		}
	}
}

func TestParseWhisperTimings_VariantSample(t *testing.T) {
	timings := ParseWhisperTimings(variantSample)
	if !timings.Parsed {
		t.Fatalf("expected timings.Parsed to be true")
	}
	if timings.LoadMs == nil || *timings.LoadMs != 120.0 {
		t.Errorf("expected LoadMs 120, got %v", timings.LoadMs)
	}
	if timings.Fallbacks != 3 {
		t.Errorf("expected Fallbacks 1+2=3, got %d", timings.Fallbacks)
	}
	if timings.Encode.Runs != 2 {
		t.Errorf("expected Encode.Runs 2, got %d", timings.Encode.Runs)
	}
	if timings.TotalMs == nil || *timings.TotalMs != 2750.75 {
		t.Errorf("expected TotalMs 2750.75, got %v", timings.TotalMs)
	}
}

func TestParseWhisperTimings_InvalidSample(t *testing.T) {
	timings := ParseWhisperTimings(invalidSample)
	if timings.Parsed {
		t.Fatalf("expected timings.Parsed to be false")
	}
	if timings.LoadMs != nil {
		t.Errorf("expected nil LoadMs, got %v", timings.LoadMs)
	}
	if timings.TotalMs != nil {
		t.Errorf("expected nil TotalMs, got %v", timings.TotalMs)
	}
}
