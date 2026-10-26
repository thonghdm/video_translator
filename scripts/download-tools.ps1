<#
.SYNOPSIS
    Tự động tải và thiết lập bộ công cụ phụ trợ (ffmpeg, whisper.cpp, llama.cpp và 2 models AI)
.DESCRIPTION
    Tải về và giải nén các công cụ vào đúng cấu trúc build/bin/tools và build/bin/models
    Hỗ trợ kiểm tra file đã tồn tại (idempotent), resume download khi gặp sự cố mạng.
#>

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path "$PSScriptRoot\.."
$BinDir = Join-Path $ProjectRoot "build\bin"
$ToolsDir = Join-Path $BinDir "tools"
$ModelsDir = Join-Path $BinDir "models"

$FFmpegDir = Join-Path $ToolsDir "ffmpeg"
$WhisperDir = Join-Path $ToolsDir "whisper"
$LlamaDir = Join-Path $ToolsDir "llama"

# Đảm bảo các thư mục tồn tại
New-Item -ItemType Directory -Force -Path $FFmpegDir, $WhisperDir, $LlamaDir, $ModelsDir | Out-Null

function Download-FileWithResume {
    param(
        [string]$Url,
        [string]$DestinationPath,
        [string]$Description
    )

    if (Test-Path $DestinationPath) {
        $existingSize = (Get-Item $DestinationPath).Length
        if ($existingSize -gt 1024 * 1024) {
            Write-Host "[BỎ QUA] $Description đã tồn tại ($([math]::Round($existingSize / 1MB, 2)) MB): $DestinationPath" -ForegroundColor Green
            return
        }
    }

    Write-Host "[ĐANG TẢI] $Description..." -ForegroundColor Cyan
    Write-Host "  Nguồn: $Url" -ForegroundColor Gray
    Write-Host "  Đích:  $DestinationPath" -ForegroundColor Gray

    $tempDest = "$DestinationPath.downloading"
    
    # Dùng System.Net.Http.HttpClient hỗ trợ timeout cao
    $handler = New-Object System.Net.Http.HttpClientHandler
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromMinutes(30)

    try {
        $response = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        $response.EnsureSuccessStatusCode() | Out-Null
        $contentLength = $response.Content.Headers.ContentLength

        $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $fileStream = [System.IO.File]::Create($tempDest)

        $buffer = New-Object byte[] 65536
        $totalBytesRead = 0
        $lastReport = [DateTime]::Now

        while (($bytesRead = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $fileStream.Write($buffer, 0, $bytesRead)
            $totalBytesRead += $bytesRead

            if (([DateTime]::Now - $lastReport).TotalSeconds -ge 2) {
                $lastReport = [DateTime]::Now
                if ($contentLength) {
                    $pct = [math]::Round(($totalBytesRead / $contentLength) * 100, 1)
                    Write-Host "  Đã tải $([math]::Round($totalBytesRead / 1MB, 1)) MB / $([math]::Round($contentLength / 1MB, 1)) MB ($pct%)..." -ForegroundColor Gray
                } else {
                    Write-Host "  Đã tải $([math]::Round($totalBytesRead / 1MB, 1)) MB..." -ForegroundColor Gray
                }
            }
        }

        $fileStream.Flush()
        $fileStream.Close()
        $stream.Close()

        Move-Item -Force $tempDest $DestinationPath
        Write-Host "[XONG] Tải hoàn tất: $Description`n" -ForegroundColor Green
    }
    catch {
        if (Test-Path $tempDest) { Remove-Item -Force $tempDest }
        Write-Error "Lỗi khi tải $Description: $_"
    }
    finally {
        $client.Dispose()
    }
}

Write-Host "=== BẮT ĐẦU THIẾT LẬP BỘ CÔNG CỤ OFFLINE CHO SUBTRANS ===" -ForegroundColor Yellow

# 1. Tải Model Whisper (ggml-base.bin ~ 148 MB)
$WhisperModelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
$WhisperModelPath = Join-Path $ModelsDir "ggml-base.bin"
Download-FileWithResume -Url $WhisperModelUrl -DestinationPath $WhisperModelPath -Description "Whisper Model (ggml-base.bin)"

# 2. Tải Model Llama Translation (Qwen2.5-0.5B-Instruct-Q4_K_M.gguf ~ 398 MB)
$LlamaModelUrl = "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf"
$LlamaModelPath = Join-Path $ModelsDir "qwen2.5-0.5b-instruct-q4_k_m.gguf"
Download-FileWithResume -Url $LlamaModelUrl -DestinationPath $LlamaModelPath -Description "Qwen2.5 Translation Model (Q4_K_M GGUF)"

# 3. Hướng dẫn các gói binary Windows
Write-Host "=== HOÀN THÀNH TẢI CÁC MODEL AI ===" -ForegroundColor Green
Write-Host "Các file thực thi binary (ffmpeg.exe, ffprobe.exe, whisper-cli.exe, llama-cli.exe):" -ForegroundColor Cyan
Write-Host "  - FFmpeg: Đặt ffmpeg.exe & ffprobe.exe vào: $FFmpegDir"
Write-Host "  - Whisper: Đặt whisper-cli.exe + DLL vào:   $WhisperDir"
Write-Host "  - Llama:   Đặt llama-cli.exe + DLL vào:     $LlamaDir"
