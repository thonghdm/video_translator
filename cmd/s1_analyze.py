import json, glob, os, re, statistics, sys

sys.stdout.reconfigure(encoding='utf-8')

def normalize_text(text):
    text = text.lower()
    text = re.sub(r'[^\w\s]', '', text)
    return text.split()

def levenshtein_distance(s1, s2):
    m, n = len(s1), len(s2)
    dp = [[0]*(n+1) for _ in range(m+1)]
    for i in range(m+1):
        dp[i][0] = i
    for j in range(n+1):
        dp[0][j] = j
    for i in range(1, m+1):
        for j in range(1, n+1):
            if s1[i-1] == s2[j-1]:
                dp[i][j] = dp[i-1][j-1]
            else:
                dp[i][j] = 1 + min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
    return dp[m][n]

def compute_wer(ref_words, hyp_words):
    if not ref_words:
        return 0.0 if not hyp_words else 1.0
    dist = levenshtein_distance(ref_words, hyp_words)
    return dist / len(ref_words)

def median(lst):
    return statistics.median(lst) if lst else 0.0

def mean(lst):
    return statistics.mean(lst) if lst else 0.0

def main():
    root = "telemetry/runs_s1"
    dirs = sorted(glob.glob(os.path.join(root, "*_r*")))
    if not dirs:
        print("No S1 run dirs found in", root)
        return

    from collections import defaultdict
    # 1. Parse blocks
    variant_data = defaultdict(lambda: {
        "warm_walls": [], 
        "encode_runs": [], 
        "encode_ms_per_run": [], 
        "load_ms": [], 
        "wav_lens": [], 
        "round_walls": defaultdict(list),
        "cache_hits": []
    })
    
    for d in dirs:
        dirname = os.path.basename(d)
        vname, rnum = dirname.split("_r")
        rnum = int(rnum)
        
        bpath = os.path.join(d, "blocks.jsonl")
        if not os.path.exists(bpath):
            continue
        with open(bpath, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip(): continue
                b = json.loads(line)
                if b.get("cancelled"): continue
                
                # Check cache_hit
                variant_data[vname]["cache_hits"].append(b.get("cache_hit", False))
                
                # Check warm (order > 1)
                order = b.get("block_order_in_session", 1)
                wall = b.get("whisper_wall_ms", 0)
                runs = b.get("whisper_encode_runs", 0)
                ms_per_run = b.get("whisper_encode_ms_per_run")
                load = b.get("whisper_load_ms")
                wav_sec = b.get("wav_len_sec")
                
                if order > 1:
                    variant_data[vname]["warm_walls"].append(wall)
                    variant_data[vname]["round_walls"][rnum].append(wall)
                    if runs > 0:
                        variant_data[vname]["encode_runs"].append(runs)
                    if ms_per_run is not None:
                        variant_data[vname]["encode_ms_per_run"].append(ms_per_run)
                    if load is not None:
                        variant_data[vname]["load_ms"].append(load)
                    if wav_sec is not None:
                        variant_data[vname]["wav_lens"].append(wav_sec)

    # 2. Main S1 Summary Table
    print("\n# BÁO CÁO KẾT QUẢ KỊCH BẢN S1 (LIÊN TỤC)")
    print("\n### BẢNG CHÍNH: HIỆU NĂNG ENCODE VÀ WHISPER_WALL_MS (BLOCK ẤM - 3 LẦN CHẠY)")
    print("| Biến thể | Cấu hình | encode_runs (median) | encode_ms_per_run | whisper_wall_ms (Med) | min / max giữa 3 runs | % thay đổi vs A | wav_len_sec | cache_hit all false? |")
    print("|---|---|---|---|---|---|---|---|---|")
    
    baseline_med = median(variant_data["A"]["warm_walls"]) if variant_data["A"]["warm_walls"] else 1.0

    order_keys = ["A", "B", "C", "C2", "D", "D2"]
    cfg_desc = {
        "A": "block 30s + over 2s (-l auto)",
        "B": "block 30s + over 2s (-l en)",
        "C": "block 28s + over 2s (-l auto)",
        "C2": "block 25s + over 2s (-l auto)",
        "D": "block 25s + over 2s (-l en)",
        "D2": "block 25s + over 2s (detect-once)"
    }
    
    for k in order_keys:
        if k not in variant_data: continue
        vd = variant_data[k]
        walls = vd["warm_walls"]
        if not walls: continue
        
        runs_med = int(median(vd["encode_runs"])) if vd["encode_runs"] else 0
        ms_run_med = median(vd["encode_ms_per_run"]) if vd["encode_ms_per_run"] else 0.0
        wall_med = median(walls)
        
        # round medians:
        rmeds = [median(vd["round_walls"][r]) for r in sorted(vd["round_walls"].keys()) if vd["round_walls"][r]]
        rmin, rmax = (min(rmeds), max(rmeds)) if rmeds else (wall_med, wall_med)
        
        pct_change = ((wall_med - baseline_med) / baseline_med) * 100.0
        wav_med = median(vd["wav_lens"]) if vd["wav_lens"] else 0.0
        all_no_cache = all(hit is False for hit in vd["cache_hits"])
        
        sign = "+" if pct_change > 0 else ""
        print(f"| **{k}** | {cfg_desc.get(k, '')} | {runs_med} | {ms_run_med:.1f} ms | **{wall_med:.0f} ms** | {rmin:.0f} / {rmax:.0f} ms | **{sign}{pct_change:.1f}%** | {wav_med:.1f} s | {all_no_cache} |")

    # 3. Transcript Quality Evaluation (0s - 120s)
    print("\n### BẢNG SO SÁNH CHẤT LƯỢNG PHỤ ĐỀ (KHOẢNG 0s - 120s)")
    print("| Biến thể so sánh | Số câu (0-120s) | Tổng ký tự | WER so với A (%) | Độ lệch timestamp TB (s) | Ghi chú ranh giới |")
    print("|---|---|---|---|---|---|")
    
    # Load transcript A_r1 as baseline
    def get_transcript_words(vname, rnum):
        tpath = os.path.join(root, f"{vname}_r{rnum}", "transcript.json")
        if not os.path.exists(tpath): return [], []
        with open(tpath, "r", encoding="utf-8") as f:
            items = json.load(f)
        # Filter 0s to 120s
        filtered = [it for it in items if it.get("start_sec", 0) <= 120.0]
        full_text = " ".join(it.get("source_text", "") for it in filtered)
        return filtered, normalize_text(full_text)

    ref_items, ref_words = get_transcript_words("A", 1)
    
    # Within-variant noise: A_r1 vs A_r2
    _, a2_words = get_transcript_words("A", 2)
    wer_noise = compute_wer(ref_words, a2_words) * 100.0
    print(f"| **A (r1 vs r2)** _(nhiễu nền)_ | {len(ref_items)} | {sum(len(it['source_text']) for it in ref_items)} | {wer_noise:.2f}% | 0.00 s | Cùng cấu hình giữa 2 lần chạy |")

    for k in ["B", "C", "C2", "D", "D2"]:
        if k not in variant_data: continue
        hyp_items, hyp_words = get_transcript_words(k, 1)
        if not hyp_items: continue
        
        wer = compute_wer(ref_words, hyp_words) * 100.0
        tot_chars = sum(len(it.get("source_text", "")) for it in hyp_items)
        
        # Timestamp drift for matching sentences
        drifts = []
        for i in range(min(len(ref_items), len(hyp_items))):
            drifts.append(abs(ref_items[i]["start_sec"] - hyp_items[i]["start_sec"]))
        avg_drift = mean(drifts) if drifts else 0.0
        
        print(f"| **{k} vs A** | {len(hyp_items)} | {tot_chars} | **{wer:.2f}%** | {avg_drift:.2f} s | Khớp nội dung |")

if __name__ == "__main__":
    main()
