# Báo cáo telemetry thực tế

- Thời điểm xuất: 2026-10-27 11:10:28
- Máy: windows/amd64, 8 logical CPU
- Nguồn dữ liệu: `telemetry\runs`
- Định nghĩa nhóm: **Block nguội** = block đầu tiên hoàn tất của run; **Block đầu sau tua** = block có `block_order_in_session=1` không phải block nguội; **Block ấm** = các block còn lại (không bị hủy).

---

## threads_2

- whisper_threads: **2**
- Block hoàn tất: 16 | bị hủy: 4 | tier-1: 5 | tier-2: 11
- Block không parse được whisper timings: 0
- Block có llama đã nạp: 0
- Nguồn: map[local:16] | tổng câu: 104 | tổng ký tự: 7704

**Block nguội (block đầu tiên của run)** (1 block)

| Chỉ số | Mẫu | Min | Median | P95 | Max |
|---|---|---|---|---|---|
| ffmpeg_cut_ms | 1 | 107.0ms | 107.0ms | 107.0ms | 107.0ms |
| whisper_wall_ms | 1 | 9176.0ms | 9176.0ms | 9176.0ms | 9176.0ms |
| whisper_load_ms | 1 | 117.2ms | 117.2ms | 117.2ms | 117.2ms |
| whisper_encode_ms | 1 | 7801.4ms | 7801.4ms | 7801.4ms | 7801.4ms |
| whisper_decode_ms | 1 | 712.5ms | 712.5ms | 712.5ms | 712.5ms |
| whisper_total_ms (whisper tự báo) | 1 | 9073.7ms | 9073.7ms | 9073.7ms | 9073.7ms |
| load / whisper_wall_ms | 1 | 1.3% | 1.3% | 1.3% | 1.3% |
| load / block_total_ms | 1 | 1.2% | 1.2% | 1.2% | 1.2% |
| translate_ms | 1 | 192.0ms | 192.0ms | 192.0ms | 192.0ms |
| queue_wait_ms | 1 | 0.0ms | 0.0ms | 0.0ms | 0.0ms |
| compute_wait_ms | 1 | 0.0ms | 0.0ms | 0.0ms | 0.0ms |
| block_total_ms | 1 | 9478.0ms | 9478.0ms | 9478.0ms | 9478.0ms |

**Block đầu sau tua** (3 block)

| Chỉ số | Mẫu | Min | Median | P95 | Max |
|---|---|---|---|---|---|
| ffmpeg_cut_ms | 3 | 112.0ms | 121.0ms | 123.7ms | 124.0ms |
| whisper_wall_ms | 3 | 8522.0ms | 8870.0ms | 9773.6ms | 9874.0ms |
| whisper_load_ms | 3 | 110.5ms | 125.2ms | 127.7ms | 128.0ms |
| whisper_encode_ms | 3 | 7311.6ms | 7542.8ms | 8317.2ms | 8403.2ms |
| whisper_decode_ms | 3 | 616.2ms | 690.9ms | 776.8ms | 786.3ms |
| whisper_total_ms (whisper tự báo) | 3 | 8424.5ms | 8763.7ms | 9670.1ms | 9770.8ms |
| load / whisper_wall_ms | 3 | 1.3% | 1.3% | 1.4% | 1.4% |
| load / block_total_ms | 3 | 1.2% | 1.3% | 1.4% | 1.4% |
| translate_ms | 3 | 146.0ms | 188.0ms | 248.3ms | 255.0ms |
| queue_wait_ms | 3 | 0.0ms | 0.0ms | 0.0ms | 0.0ms |
| compute_wait_ms | 3 | 0.0ms | 0.0ms | 0.0ms | 0.0ms |
| block_total_ms | 3 | 8902.0ms | 9185.0ms | 10040.9ms | 10136.0ms |

**Block ấm** (12 block)

| Chỉ số | Mẫu | Min | Median | P95 | Max |
|---|---|---|---|---|---|
| ffmpeg_cut_ms | 12 | 113.0ms | 120.5ms | 145.5ms | 162.0ms |
| whisper_wall_ms | 12 | 8424.0ms | 8946.0ms | 10911.5ms | 11368.0ms |
| whisper_load_ms | 12 | 117.6ms | 124.1ms | 161.1ms | 165.5ms |
| whisper_encode_ms | 12 | 7111.8ms | 7751.2ms | 9262.7ms | 9744.3ms |
| whisper_decode_ms | 12 | 566.6ms | 735.1ms | 858.6ms | 910.6ms |
| whisper_total_ms (whisper tự báo) | 12 | 8316.8ms | 8827.1ms | 10753.2ms | 11253.8ms |
| load / whisper_wall_ms | 12 | 1.1% | 1.4% | 1.7% | 1.9% |
| load / block_total_ms | 12 | 0.2% | 0.5% | 0.7% | 0.7% |
| translate_ms | 12 | 65.0ms | 71.0ms | 154.8ms | 184.0ms |
| queue_wait_ms | 12 | 0.0ms | 0.0ms | 25580.7ms | 26294.0ms |
| compute_wait_ms | 12 | 0.0ms | 0.0ms | 0.0ms | 0.0ms |
| block_total_ms | 12 | 17881.0ms | 31473.5ms | 63153.1ms | 64032.0ms |

**Block bị hủy giữa chừng**

| block | tier-order | whisper_wall_ms (tới lúc bị kill) | block_total_ms |
|---|---|---|---|
| 4 | 5 | 280 | 35695 |
| 25 | 3 | 131 | 17446 |
| 18 | 3 | 205 | 17636 |
| 18 | 9 | 96 | 54489 |

**Độ trễ khi tua (seek)**

| # | tới (s) | seek_latency_ms | Tier-2 cũ đang chạy | block cũ | thời gian chờ worker cũ thoát (ms) | computeMu nhả sau cancel (ms) |
|---|---|---|---|---|---|---|
| 1 | 700 | 8645 | true | 8 | 1 | 13 |
| 2 | 481 | 8996 | true | 4 | 0 | 5 |
| 3 | 262 | 9987 | true | 18 | 1 | 4 |

seek_latency_ms: n=3, min=8645, median=8996, p95=9888, max=9987

_Mẫu stderr thô: `telemetry/runs/threads_2/whisper_stderr_sample.txt`_

---

## threads_4

- whisper_threads: **4**
- Block hoàn tất: 16 | bị hủy: 4 | tier-1: 5 | tier-2: 11
- Block không parse được whisper timings: 0
- Block có llama đã nạp: 0
- Nguồn: map[local:16] | tổng câu: 104 | tổng ký tự: 7704

**Block nguội (block đầu tiên của run)** (1 block)

| Chỉ số | Mẫu | Min | Median | P95 | Max |
|---|---|---|---|---|---|
| ffmpeg_cut_ms | 1 | 479.0ms | 479.0ms | 479.0ms | 479.0ms |
| whisper_wall_ms | 1 | 7318.0ms | 7318.0ms | 7318.0ms | 7318.0ms |
| whisper_load_ms | 1 | 164.6ms | 164.6ms | 164.6ms | 164.6ms |
| whisper_encode_ms | 1 | 5979.9ms | 5979.9ms | 5979.9ms | 5979.9ms |
| whisper_decode_ms | 1 | 620.4ms | 620.4ms | 620.4ms | 620.4ms |
| whisper_total_ms (whisper tự báo) | 1 | 7104.9ms | 7104.9ms | 7104.9ms | 7104.9ms |
| load / whisper_wall_ms | 1 | 2.2% | 2.2% | 2.2% | 2.2% |
| load / block_total_ms | 1 | 1.7% | 1.7% | 1.7% | 1.7% |
| translate_ms | 1 | 1766.0ms | 1766.0ms | 1766.0ms | 1766.0ms |
| queue_wait_ms | 1 | 0.0ms | 0.0ms | 0.0ms | 0.0ms |
| compute_wait_ms | 1 | 0.0ms | 0.0ms | 0.0ms | 0.0ms |
| block_total_ms | 1 | 9567.0ms | 9567.0ms | 9567.0ms | 9567.0ms |

**Block đầu sau tua** (3 block)

| Chỉ số | Mẫu | Min | Median | P95 | Max |
|---|---|---|---|---|---|
| ffmpeg_cut_ms | 3 | 103.0ms | 109.0ms | 185.5ms | 194.0ms |
| whisper_wall_ms | 3 | 5841.0ms | 6780.0ms | 6945.6ms | 6964.0ms |
| whisper_load_ms | 3 | 109.0ms | 116.7ms | 242.9ms | 256.9ms |
| whisper_encode_ms | 3 | 4730.2ms | 5459.9ms | 5792.5ms | 5829.5ms |
| whisper_decode_ms | 3 | 576.4ms | 588.1ms | 643.9ms | 650.1ms |
| whisper_total_ms (whisper tự báo) | 3 | 5746.3ms | 6625.8ms | 6852.7ms | 6877.9ms |
| load / whisper_wall_ms | 3 | 1.7% | 1.9% | 3.6% | 3.8% |
| load / block_total_ms | 3 | 1.1% | 1.3% | 3.1% | 3.3% |
| translate_ms | 3 | 792.0ms | 2667.0ms | 3898.2ms | 4035.0ms |
| queue_wait_ms | 3 | 0.0ms | 0.0ms | 0.0ms | 0.0ms |
| compute_wait_ms | 3 | 0.0ms | 0.0ms | 0.0ms | 0.0ms |
| block_total_ms | 3 | 7769.0ms | 8620.0ms | 10856.5ms | 11105.0ms |

**Block ấm** (12 block)

| Chỉ số | Mẫu | Min | Median | P95 | Max |
|---|---|---|---|---|---|
| ffmpeg_cut_ms | 12 | 99.0ms | 132.5ms | 191.7ms | 206.0ms |
| whisper_wall_ms | 12 | 5359.0ms | 6584.0ms | 8157.7ms | 8601.0ms |
| whisper_load_ms | 12 | 108.7ms | 126.0ms | 159.9ms | 161.4ms |
| whisper_encode_ms | 12 | 4396.4ms | 5178.0ms | 6461.8ms | 6477.1ms |
| whisper_decode_ms | 12 | 421.6ms | 615.8ms | 1117.0ms | 1159.1ms |
| whisper_total_ms (whisper tự báo) | 12 | 5268.8ms | 6486.5ms | 8046.4ms | 8496.9ms |
| load / whisper_wall_ms | 12 | 1.5% | 2.0% | 2.7% | 2.9% |
| load / block_total_ms | 12 | 0.3% | 0.6% | 1.1% | 1.2% |
| translate_ms | 12 | 222.0ms | 846.0ms | 1251.3ms | 1297.0ms |
| queue_wait_ms | 12 | 0.0ms | 0.0ms | 18157.3ms | 19985.0ms |
| compute_wait_ms | 12 | 0.0ms | 0.0ms | 0.0ms | 0.0ms |
| block_total_ms | 12 | 11957.0ms | 21683.5ms | 47300.3ms | 48661.0ms |

**Block bị hủy giữa chừng**

| block | tier-order | whisper_wall_ms (tới lúc bị kill) | block_total_ms |
|---|---|---|---|
| 4 | 5 | 740 | 23301 |
| 25 | 3 | 408 | 11643 |
| 18 | 3 | 993 | 15664 |
| 18 | 9 | 998 | 42406 |

**Độ trễ khi tua (seek)**

| # | tới (s) | seek_latency_ms | Tier-2 cũ đang chạy | block cũ | thời gian chờ worker cũ thoát (ms) | computeMu nhả sau cancel (ms) |
|---|---|---|---|---|---|---|
| 1 | 700 | 5951 | true | 6 | 0 | 21 |
| 2 | 481 | 7068 | true | 25 | 1 | 19 |
| 3 | 262 | 6976 | true | 20 | 1 | 26 |

seek_latency_ms: n=3, min=5951, median=6976, p95=7059, max=7068

_Mẫu stderr thô: `telemetry/runs/threads_4/whisper_stderr_sample.txt`_

---

## threads_6

- whisper_threads: **6**
- Block hoàn tất: 16 | bị hủy: 4 | tier-1: 5 | tier-2: 11
- Block không parse được whisper timings: 0
- Block có llama đã nạp: 0
- Nguồn: map[local:16] | tổng câu: 104 | tổng ký tự: 7704

**Block nguội (block đầu tiên của run)** (1 block)

| Chỉ số | Mẫu | Min | Median | P95 | Max |
|---|---|---|---|---|---|
| ffmpeg_cut_ms | 1 | 112.0ms | 112.0ms | 112.0ms | 112.0ms |
| whisper_wall_ms | 1 | 5423.0ms | 5423.0ms | 5423.0ms | 5423.0ms |
| whisper_load_ms | 1 | 127.3ms | 127.3ms | 127.3ms | 127.3ms |
| whisper_encode_ms | 1 | 4361.3ms | 4361.3ms | 4361.3ms | 4361.3ms |
| whisper_decode_ms | 1 | 567.8ms | 567.8ms | 567.8ms | 567.8ms |
| whisper_total_ms (whisper tự báo) | 1 | 5331.6ms | 5331.6ms | 5331.6ms | 5331.6ms |
| load / whisper_wall_ms | 1 | 2.3% | 2.3% | 2.3% | 2.3% |
| load / block_total_ms | 1 | 2.2% | 2.2% | 2.2% | 2.2% |
| translate_ms | 1 | 190.0ms | 190.0ms | 190.0ms | 190.0ms |
| queue_wait_ms | 1 | 0.0ms | 0.0ms | 0.0ms | 0.0ms |
| compute_wait_ms | 1 | 0.0ms | 0.0ms | 0.0ms | 0.0ms |
| block_total_ms | 1 | 5730.0ms | 5730.0ms | 5730.0ms | 5730.0ms |

**Block đầu sau tua** (3 block)

| Chỉ số | Mẫu | Min | Median | P95 | Max |
|---|---|---|---|---|---|
| ffmpeg_cut_ms | 3 | 115.0ms | 122.0ms | 217.4ms | 228.0ms |
| whisper_wall_ms | 3 | 6063.0ms | 6598.0ms | 7467.4ms | 7564.0ms |
| whisper_load_ms | 3 | 117.0ms | 131.4ms | 163.1ms | 166.6ms |
| whisper_encode_ms | 3 | 4984.1ms | 5254.4ms | 6108.0ms | 6202.8ms |
| whisper_decode_ms | 3 | 568.7ms | 765.0ms | 798.5ms | 802.2ms |
| whisper_total_ms (whisper tự báo) | 3 | 5958.5ms | 6488.0ms | 7331.1ms | 7424.7ms |
| load / whisper_wall_ms | 3 | 1.8% | 2.2% | 2.2% | 2.2% |
| load / block_total_ms | 3 | 1.7% | 2.1% | 2.1% | 2.1% |
| translate_ms | 3 | 127.0ms | 204.0ms | 249.9ms | 255.0ms |
| queue_wait_ms | 3 | 0.0ms | 0.0ms | 0.0ms | 0.0ms |
| compute_wait_ms | 3 | 0.0ms | 0.0ms | 0.0ms | 0.0ms |
| block_total_ms | 3 | 6385.0ms | 6851.0ms | 7931.0ms | 8051.0ms |

**Block ấm** (12 block)

| Chỉ số | Mẫu | Min | Median | P95 | Max |
|---|---|---|---|---|---|
| ffmpeg_cut_ms | 12 | 105.0ms | 173.0ms | 351.0ms | 411.0ms |
| whisper_wall_ms | 12 | 5186.0ms | 5855.5ms | 7943.0ms | 8740.0ms |
| whisper_load_ms | 12 | 112.6ms | 119.7ms | 131.0ms | 133.0ms |
| whisper_encode_ms | 12 | 4062.7ms | 4699.8ms | 6356.6ms | 7169.3ms |
| whisper_decode_ms | 12 | 524.6ms | 687.0ms | 1031.7ms | 1036.4ms |
| whisper_total_ms (whisper tự báo) | 12 | 5082.5ms | 5733.6ms | 7814.9ms | 8631.6ms |
| load / whisper_wall_ms | 12 | 1.4% | 2.1% | 2.4% | 2.4% |
| load / block_total_ms | 12 | 0.3% | 0.6% | 1.1% | 1.1% |
| translate_ms | 12 | 66.0ms | 69.5ms | 142.1ms | 157.0ms |
| queue_wait_ms | 12 | 0.0ms | 0.0ms | 15405.1ms | 16185.0ms |
| compute_wait_ms | 12 | 0.0ms | 0.0ms | 0.0ms | 0.0ms |
| block_total_ms | 12 | 10302.0ms | 19234.5ms | 40854.6ms | 41590.0ms |

**Block bị hủy giữa chừng**

| block | tier-order | whisper_wall_ms (tới lúc bị kill) | block_total_ms |
|---|---|---|---|
| 4 | 5 | 180 | 23471 |
| 25 | 3 | 147 | 12843 |
| 18 | 3 | 185 | 12657 |
| 18 | 9 | 125 | 35911 |

**Độ trễ khi tua (seek)**

| # | tới (s) | seek_latency_ms | Tier-2 cũ đang chạy | block cũ | thời gian chờ worker cũ thoát (ms) | computeMu nhả sau cancel (ms) |
|---|---|---|---|---|---|---|
| 1 | 700 | 7795 | true | 7 | 1 | 8 |
| 2 | 481 | 6179 | true | 25 | 0 | 5 |
| 3 | 262 | 6722 | true | 21 | 0 | 10 |

seek_latency_ms: n=3, min=6179, median=6722, p95=7688, max=7795

_Mẫu stderr thô: `telemetry/runs/threads_6/whisper_stderr_sample.txt`_

---

## So sánh số thread (chỉ khối **Block ấm**)

| threads | số block ấm | load_ms median | load_ms p95 | load/wall median | load/wall p95 | whisper_wall_ms median | block_total_ms median |
|---|---|---|---|---|---|---|---|
| 2 | 12 | 124.1 | 161.1 | 1.4% | 1.7% | 8946 | 31474 |
| 4 | 12 | 126.0 | 159.9 | 2.0% | 2.7% | 6584 | 21684 |
| 6 | 12 | 119.7 | 131.0 | 2.1% | 2.4% | 5856 | 19234 |
