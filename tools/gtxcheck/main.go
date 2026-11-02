package main

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptrace"
	"net/url"
	"os/exec"
	"strings"
	"time"
)

const targetURL = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=vi&dt=t&q=hello"

const chromeUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"

type Result struct {
	Step        string
	Iteration   int
	Time        string
	Proto       string
	Status      int
	ContentType string
	RetryAfter  string
	DurationMs  int64
	BodySnippet string
	ReqHeaders  http.Header
}

func printResult(r Result) {
	fmt.Printf("[%s] #%d %s | Proto: %s | Status: %d | Content-Type: %s | Retry-After: %s | Time: %dms | Body: %s\n",
		r.Step, r.Iteration, r.Time, r.Proto, r.Status, r.ContentType, r.RetryAfter, r.DurationMs, r.BodySnippet)
}

func runCurl(iteration int) Result {
	t0 := time.Now()
	nowStr := t0.Format("15:04:05.000")
	cmd := exec.Command("curl.exe", "-i", "-s", targetURL)
	out, err := cmd.CombinedOutput()
	dur := time.Since(t0).Milliseconds()

	if err != nil {
		return Result{
			Step:        "curl.exe",
			Iteration:   iteration,
			Time:        nowStr,
			Status:      -1,
			DurationMs:  dur,
			BodySnippet: err.Error(),
		}
	}

	raw := string(out)
	parts := strings.SplitN(raw, "\r\n\r\n", 2)
	headerPart := parts[0]
	bodyPart := ""
	if len(parts) > 1 {
		bodyPart = strings.TrimSpace(parts[1])
		if len(bodyPart) > 60 {
			bodyPart = bodyPart[:60] + "..."
		}
	}

	status := 0
	proto := ""
	ct := ""
	ra := ""

	lines := strings.Split(headerPart, "\r\n")
	if len(lines) > 0 {
		statusLine := lines[0]
		fields := strings.Fields(statusLine)
		if len(fields) >= 2 {
			proto = fields[0]
			fmt.Sscanf(fields[1], "%d", &status)
		}
	}
	for _, l := range lines {
		lower := strings.ToLower(l)
		if strings.HasPrefix(lower, "content-type:") {
			ct = strings.TrimSpace(l[len("content-type:"):])
		} else if strings.HasPrefix(lower, "retry-after:") {
			ra = strings.TrimSpace(l[len("retry-after:"):])
		}
	}

	return Result{
		Step:        "curl.exe",
		Iteration:   iteration,
		Time:        nowStr,
		Proto:       proto,
		Status:      status,
		ContentType: ct,
		RetryAfter:  ra,
		DurationMs:  dur,
		BodySnippet: bodyPart,
	}
}

func runGoRequest(step string, iteration int, client *http.Client, headerMod func(*http.Request)) Result {
	t0 := time.Now()
	nowStr := t0.Format("15:04:05.000")

	req, err := http.NewRequestWithContext(context.Background(), "GET", targetURL, nil)
	if err != nil {
		return Result{Step: step, Iteration: iteration, Time: nowStr, Status: -1, BodySnippet: err.Error()}
	}

	if headerMod != nil {
		headerMod(req)
	}

	var protoUsed string
	trace := &httptrace.ClientTrace{
		GotConn: func(connInfo httptrace.GotConnInfo) {
			if connInfo.Conn != nil {
				// proto will be captured from resp.Proto
			}
		},
	}
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), trace))

	resp, err := client.Do(req)
	dur := time.Since(t0).Milliseconds()
	if err != nil {
		return Result{
			Step:        step,
			Iteration:   iteration,
			Time:        nowStr,
			Status:      -1,
			DurationMs:  dur,
			BodySnippet: err.Error(),
			ReqHeaders:  req.Header.Clone(),
		}
	}
	defer resp.Body.Close()

	protoUsed = resp.Proto
	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	snippet := strings.TrimSpace(string(bodyBytes))
	if len(snippet) > 60 {
		snippet = snippet[:60] + "..."
	}

	return Result{
		Step:        step,
		Iteration:   iteration,
		Time:        nowStr,
		Proto:       protoUsed,
		Status:      resp.StatusCode,
		ContentType: resp.Header.Get("Content-Type"),
		RetryAfter:  resp.Header.Get("Retry-After"),
		DurationMs:  dur,
		BodySnippet: snippet,
		ReqHeaders:  req.Header.Clone(),
	}
}

func main() {
	mode := flag.String("mode", "all", "mode: curl | go-default | go-chrome | go-http1 | go-http2 | go-cookie | go-single-header | headers-diff | all")
	n := flag.Int("n", 3, "number of requests (<= 3)")
	delaySec := flag.Int("delay", 3, "delay in seconds between requests (>= 3)")
	flag.Parse()

	if *n > 3 {
		*n = 3
	}
	if *delaySec < 3 {
		*delaySec = 3
	}

	fmt.Printf("=== GTX Diagnostic Tool (mode=%s, n=%d, delay=%ds) ===\n", *mode, *n, *delaySec)

	runStep := func(stepName string, fn func(i int) Result) {
		fmt.Printf("\n--- Step: %s ---\n", stepName)
		for i := 1; i <= *n; i++ {
			r := fn(i)
			printResult(r)
			if i < *n {
				time.Sleep(time.Duration(*delaySec) * time.Second)
			}
		}
	}

	switch *mode {
	case "curl":
		runStep("1. curl.exe", func(i int) Result {
			return runCurl(i)
		})

	case "go-default":
		// Go net/http giống translateFastGTX trong app: User-Agent: Mozilla/5.0
		client := &http.Client{Timeout: 5 * time.Second}
		runStep("Go default (UA: Mozilla/5.0)", func(i int) Result {
			return runGoRequest("Go default", i, client, func(req *http.Request) {
				req.Header.Set("User-Agent", "Mozilla/5.0")
			})
		})

	case "go-chrome":
		// Go với full header Chrome thật
		client := &http.Client{Timeout: 5 * time.Second}
		runStep("Go Chrome headers", func(i int) Result {
			return runGoRequest("Go Chrome headers", i, client, func(req *http.Request) {
				req.Header.Set("User-Agent", chromeUA)
				req.Header.Set("Accept", "*/*")
				req.Header.Set("Accept-Language", "vi-VN,vi;q=0.9,en;q=0.8")
				req.Header.Set("Referer", "https://translate.google.com/")
				req.Header.Set("Sec-Ch-Ua", `"Not:A-Brand";v="99", "Chromium";v="156", "Google Chrome";v="156"`)
				req.Header.Set("Sec-Ch-Ua-Mobile", "?0")
				req.Header.Set("Sec-Ch-Ua-Platform", `"Windows"`)
				req.Header.Set("Sec-Fetch-Dest", "empty")
				req.Header.Set("Sec-Fetch-Mode", "cors")
				req.Header.Set("Sec-Fetch-Site", "cross-site")
			})
		})

	case "go-http1":
		// Go HTTP/1.1
		tr := &http.Transport{
			TLSNextProto: make(map[string]func(authority string, c *tls.Conn) http.RoundTripper),
		}
		client := &http.Client{Transport: tr, Timeout: 5 * time.Second}
		runStep("Go HTTP/1.1 (ép HTTP/1.1)", func(i int) Result {
			return runGoRequest("Go HTTP/1.1", i, client, func(req *http.Request) {
				req.Header.Set("User-Agent", chromeUA)
				req.Header.Set("Accept", "*/*")
				req.Header.Set("Accept-Language", "vi-VN,vi;q=0.9,en;q=0.8")
				req.Header.Set("Referer", "https://translate.google.com/")
			})
		})

	case "go-http2":
		// Go HTTP/2
		tr := &http.Transport{
			ForceAttemptHTTP2: true,
		}
		client := &http.Client{Transport: tr, Timeout: 5 * time.Second}
		runStep("Go HTTP/2", func(i int) Result {
			return runGoRequest("Go HTTP/2", i, client, func(req *http.Request) {
				req.Header.Set("User-Agent", chromeUA)
				req.Header.Set("Accept", "*/*")
				req.Header.Set("Accept-Language", "vi-VN,vi;q=0.9,en;q=0.8")
				req.Header.Set("Referer", "https://translate.google.com/")
			})
		})

	case "go-cookie":
		jar, _ := cookiejar.New(nil)
		client := &http.Client{Jar: jar, Timeout: 5 * time.Second}
		runStep("Go with CookieJar (2 request liên tiếp)", func(i int) Result {
			res := runGoRequest("Go CookieJar", i, client, func(req *http.Request) {
				req.Header.Set("User-Agent", chromeUA)
				req.Header.Set("Accept", "*/*")
				req.Header.Set("Accept-Language", "vi-VN,vi;q=0.9,en;q=0.8")
				req.Header.Set("Referer", "https://translate.google.com/")
			})
			u, _ := url.Parse("https://translate.googleapis.com")
			cookies := jar.Cookies(u)
			fmt.Printf("   -> Jar cookies count: %d\n", len(cookies))
			return res
		})

	case "go-single-header":
		// Thử nghiệm header dưới HTTP/2
		clientH2 := &http.Client{Timeout: 5 * time.Second}
		runStep("5a. HTTP/2 - Chỉ User-Agent Chrome", func(i int) Result {
			return runGoRequest("H2 Chỉ UA", i, clientH2, func(req *http.Request) {
				req.Header.Set("User-Agent", chromeUA)
			})
		})
		time.Sleep(3 * time.Second)
		runStep("5b. HTTP/2 - Chỉ Referer", func(i int) Result {
			return runGoRequest("H2 Chỉ Referer", i, clientH2, func(req *http.Request) {
				req.Header.Set("Referer", "https://translate.google.com/")
			})
		})
		time.Sleep(3 * time.Second)
		runStep("5c. HTTP/2 - Chỉ Accept-Language", func(i int) Result {
			return runGoRequest("H2 Chỉ Accept-Language", i, clientH2, func(req *http.Request) {
				req.Header.Set("Accept-Language", "vi-VN,vi;q=0.9,en;q=0.8")
			})
		})
		time.Sleep(3 * time.Second)

		// Thử nghiệm header dưới HTTP/1.1
		trH1 := &http.Transport{
			TLSNextProto: make(map[string]func(authority string, c *tls.Conn) http.RoundTripper),
		}
		clientH1 := &http.Client{Transport: trH1, Timeout: 5 * time.Second}
		runStep("5d. HTTP/1.1 - Không header (Go default UA)", func(i int) Result {
			return runGoRequest("H1 Không header", i, clientH1, nil)
		})
		time.Sleep(3 * time.Second)
		runStep("5e. HTTP/1.1 - Chỉ UA Mozilla/5.0", func(i int) Result {
			return runGoRequest("H1 UA Mozilla/5.0", i, clientH1, func(req *http.Request) {
				req.Header.Set("User-Agent", "Mozilla/5.0")
			})
		})
		time.Sleep(3 * time.Second)
		runStep("5f. HTTP/1.1 - Chỉ UA Chrome", func(i int) Result {
			return runGoRequest("H1 UA Chrome", i, clientH1, func(req *http.Request) {
				req.Header.Set("User-Agent", chromeUA)
			})
		})
		time.Sleep(3 * time.Second)
		runStep("5g. HTTP/1.1 - Chỉ Referer", func(i int) Result {
			return runGoRequest("H1 Chỉ Referer", i, clientH1, func(req *http.Request) {
				req.Header.Set("Referer", "https://translate.google.com/")
			})
		})


	case "headers-diff":
		client := &http.Client{Timeout: 5 * time.Second}
		req, _ := http.NewRequest("GET", targetURL, nil)
		req.Header.Set("User-Agent", "Mozilla/5.0")
		fmt.Printf("Headers Go mặc định trong app:\n")
		for k, v := range req.Header {
			fmt.Printf("  %s: %s\n", k, strings.Join(v, ", "))
		}
		res := runGoRequest("Go default check", 1, client, func(r *http.Request) {
			r.Header.Set("User-Agent", "Mozilla/5.0")
		})
		printResult(res)

	case "ab-alternating":
		trH1 := &http.Transport{
			TLSNextProto: make(map[string]func(authority string, c *tls.Conn) http.RoundTripper),
		}
		clientH1 := &http.Client{Transport: trH1, Timeout: 5 * time.Second}
		clientH2 := &http.Client{Timeout: 5 * time.Second} // default enables HTTP/2

		fmt.Println("--- Alternating Test (HTTP/2 vs HTTP/1.1 cùng UA Mozilla/5.0) ---")
		for i := 1; i <= 2; i++ {
			r2 := runGoRequest("H2 (HTTP/2)", i, clientH2, func(r *http.Request) {
				r.Header.Set("User-Agent", "Mozilla/5.0")
			})
			printResult(r2)
			time.Sleep(3 * time.Second)

			r1 := runGoRequest("H1 (HTTP/1.1)", i, clientH1, func(r *http.Request) {
				r.Header.Set("User-Agent", "Mozilla/5.0")
			})
			printResult(r1)
			time.Sleep(3 * time.Second)
		}


	default:
		fmt.Printf("Unknown mode: %s\n", *mode)
	}
}
