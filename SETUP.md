# HƯỚNG DẪN CÀI ĐẶT & CHẠY SUBTRANS

SubTrans là ứng dụng desktop Windows chơi video tương tự VLC/IINA, hỗ trợ phiên dịch phụ đề tiếng Anh sang tiếng Việt theo thời gian thực hoàn toàn offline.

---

## 1. Yêu cầu môi trường

- **Hệ điều hành:** Windows 10/11 (64-bit).
- **Node.js:** v18 trở lên (đã kiểm tra tương thích tốt với Node v22.16.0).
- **Go (Golang):** Phiên bản $\ge$ 1.21.
  - Tải bộ cài chính thức tại: [https://go.dev/dl/](https://go.dev/dl/) (chọn file `goX.X.X.windows-amd64.msi`).
- **Wails v2:** 
  - Cài đặt bằng lệnh: `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
- **C Compiler (MinGW-w64):** Nếu cần biên dịch CGO (khuyên dùng [w64devkit](https://github.com/skeeto/w64devkit/releases) hoặc TDM-GCC).

---

## 2. Cấu trúc thư mục công cụ phụ trợ (Offline Binaries & Models)

Ứng dụng yêu cầu các công cụ đặt đúng vị trí độc lập để tránh xung đột DLL:

```
build/bin/
├── tools/
│   ├── ffmpeg/
│   │   ├── ffmpeg.exe
│   │   └── ffprobe.exe
│   ├── whisper/
│   │   ├── whisper-cli.exe
│   │   └── *.dll (ggml.dll, whisper.dll...)
│   └── llama/
│       ├── llama-cli.exe
│       └── *.dll (ggml.dll, llama.dll...)
└── models/
    ├── ggml-base.bin                        (~148 MB - Whisper model)
    └── qwen2.5-0.5b-instruct-q4_k_m.gguf    (~398 MB - Translation model)
```

Chạy script PowerShell sau để tự động tải các model AI:
```powershell
powershell -ExecutionPolicy Bypass -File scripts\download-tools.ps1
```

---

## 3. Khởi chạy ở chế độ phát triển (Development)

Trong thư mục gốc dự án:
```powershell
# Chạy với giao diện dev và live-reload
wails dev
```

---

## 4. Biên dịch bản phân phối (Production Build)

```powershell
wails build -clean -nsis
```
File thực thi cuối cùng sẽ được tạo tại `build/bin/subtrans.exe`.

---

## 5. Chạy bộ kiểm thử tự động (Test Suite)

```powershell
# Chạy toàn bộ Unit Test Go (bao gồm kiểm tra Race Condition)
go test -v -race ./...

# Chạy Unit Test Frontend (Node.js test runner tích hợp sẵn)
node --test frontend/src/lib/subtitles.node-test.mjs
```
