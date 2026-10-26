# SubTrans - Download & Setup Tools (ffmpeg, whisper, llama) and Models
$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path "$PSScriptRoot\.."
$BinDir = Join-Path $ProjectRoot "build\bin"
$ToolsDir = Join-Path $BinDir "tools"
$ModelsDir = Join-Path $BinDir "models"

$FFmpegDir = Join-Path $ToolsDir "ffmpeg"
$WhisperDir = Join-Path $ToolsDir "whisper"
$LlamaDir = Join-Path $ToolsDir "llama"

# Create directories
New-Item -ItemType Directory -Force -Path $FFmpegDir, $WhisperDir, $LlamaDir, $ModelsDir | Out-Null

function Download-WithCurl {
    param(
        [string]$Url,
        [string]$DestinationPath,
        [string]$Description
    )

    if (Test-Path $DestinationPath) {
        $existingSize = (Get-Item $DestinationPath).Length
        if ($existingSize -gt 1024 * 1024) {
            Write-Host "[SKIP] $Description already exists ($([math]::Round($existingSize / 1MB, 2)) MB): $DestinationPath" -ForegroundColor Green
            return
        }
    }

    Write-Host "[DOWNLOADING] $Description..." -ForegroundColor Cyan
    Write-Host "  Source: $Url" -ForegroundColor Gray
    Write-Host "  Target: $DestinationPath" -ForegroundColor Gray

    $tempDest = "$DestinationPath.downloading"

    & curl.exe -L -C - --ssl-no-revoke --retry 10 --retry-all-errors --retry-delay 3 --progress-bar -o $tempDest $Url

    if ($LASTEXITCODE -eq 0 -and (Test-Path $tempDest)) {
        Move-Item -Force $tempDest $DestinationPath
        $finalSize = (Get-Item $DestinationPath).Length
        Write-Host "[DONE] Downloaded: $Description ($([math]::Round($finalSize / 1MB, 2)) MB)`n" -ForegroundColor Green
    } else {
        Write-Error "Failed to download $Description."
    }
}

Write-Host "==========================================================" -ForegroundColor Yellow
Write-Host "       SUBTRANS - AI MODELS SETUP                         " -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Yellow

# 1. Download Whisper Base Model (ggml-base.bin ~ 148 MB)
$WhisperModelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
$WhisperModelPath = Join-Path $ModelsDir "ggml-base.bin"
Download-WithCurl -Url $WhisperModelUrl -DestinationPath $WhisperModelPath -Description "Whisper Model (ggml-base.bin)"

# 2. Download Qwen2.5 0.5B Translation Model (GGUF ~ 398 MB)
$LlamaModelUrl = "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf"
$LlamaModelPath = Join-Path $ModelsDir "qwen2.5-0.5b-instruct-q4_k_m.gguf"
Download-WithCurl -Url $LlamaModelUrl -DestinationPath $LlamaModelPath -Description "Qwen2.5 Translation Model (Q4_K_M GGUF)"

Write-Host "==========================================================" -ForegroundColor Yellow
Write-Host "       SUBTRANS - CLI TOOLS SETUP                         " -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Yellow

# 3. Check FFmpeg & FFprobe
$ffmpegExe = Join-Path $FFmpegDir "ffmpeg.exe"
$ffprobeExe = Join-Path $FFmpegDir "ffprobe.exe"
if ((Test-Path $ffmpegExe) -and (Test-Path $ffprobeExe)) {
    Write-Host "[OK] FFmpeg & FFprobe ready: $ffmpegExe" -ForegroundColor Green
} else {
    Write-Host "[DOWNLOADING] FFmpeg Essentials..." -ForegroundColor Cyan
    $ffmpegZip = Join-Path $FFmpegDir "ffmpeg.zip"
    $ffmpegUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
    & curl.exe -L --ssl-no-revoke --retry 5 --progress-bar -o $ffmpegZip $ffmpegUrl
    if ($LASTEXITCODE -eq 0) {
        Expand-Archive -Path $ffmpegZip -DestinationPath "$FFmpegDir\temp" -Force
        Get-ChildItem -Path "$FFmpegDir\temp" -Filter "ffmpeg.exe" -Recurse | Move-Item -Destination $FFmpegDir -Force
        Get-ChildItem -Path "$FFmpegDir\temp" -Filter "ffprobe.exe" -Recurse | Move-Item -Destination $FFmpegDir -Force
        Remove-Item -Recurse -Force "$FFmpegDir\temp", $ffmpegZip
        Write-Host "[DONE] FFmpeg installed successfully!`n" -ForegroundColor Green
    }
}

# 4. Download Whisper CLI (Windows x64 v1.6.0)
$whisperExe = Join-Path $WhisperDir "whisper-cli.exe"
if (-not (Test-Path $whisperExe)) {
    $whisperZip = Join-Path $WhisperDir "whisper.zip"
    $whisperUrl = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.6.0/whisper-bin-x64.zip"
    Write-Host "[DOWNLOADING] Whisper CLI (v1.6.0)..." -ForegroundColor Cyan
    & curl.exe -L --ssl-no-revoke --retry 5 --progress-bar -o $whisperZip $whisperUrl
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[EXTRACTING] Extracting whisper-cli.exe and DLLs..." -ForegroundColor Cyan
        Expand-Archive -Path $whisperZip -DestinationPath $WhisperDir -Force
        $mainExe = Join-Path $WhisperDir "main.exe"
        if (Test-Path $mainExe) { Move-Item -Force $mainExe $whisperExe }
        Remove-Item -Force $whisperZip
        Write-Host "[DONE] Whisper CLI installed successfully!`n" -ForegroundColor Green
    }
} else {
    Write-Host "[OK] whisper-cli.exe ready: $whisperExe" -ForegroundColor Green
}

# 5. Download Llama CLI (Windows x64 AVX2 b3400)
$llamaExe = Join-Path $LlamaDir "llama-cli.exe"
if (-not (Test-Path $llamaExe)) {
    $llamaZip = Join-Path $LlamaDir "llama.zip"
    $llamaUrl = "https://github.com/ggml-org/llama.cpp/releases/download/b3400/llama-b3400-bin-win-avx2-x64.zip"
    Write-Host "[DOWNLOADING] Llama CLI (b3400)..." -ForegroundColor Cyan
    & curl.exe -L --ssl-no-revoke --retry 5 --progress-bar -o $llamaZip $llamaUrl
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[EXTRACTING] Extracting llama-cli.exe and DLLs..." -ForegroundColor Cyan
        Expand-Archive -Path $llamaZip -DestinationPath $LlamaDir -Force
        Remove-Item -Force $llamaZip
        Write-Host "[DONE] Llama CLI installed successfully!`n" -ForegroundColor Green
    }
} else {
    Write-Host "[OK] llama-cli.exe ready: $llamaExe" -ForegroundColor Green
}

Write-Host "==========================================================" -ForegroundColor Green
Write-Host "       ALL TOOLS AND MODELS ARE 100% READY!               " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
