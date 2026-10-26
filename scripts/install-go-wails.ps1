# Script install Go (Golang) and Wails v2 for Windows x64
$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "       INSTALLING GOLANG AND WAILS V2 FOR WINDOWS         " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$GoVersion = "go1.22.8"
$GoZipName = "$GoVersion.windows-amd64.zip"
$GoUrl = "https://go.dev/dl/$GoZipName"

$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\Go"
$GoBinPath = Join-Path $InstallDir "bin"
$UserGoBinPath = Join-Path $env:USERPROFILE "go\bin"

# 1. Check if Go already installed
if (-not (Test-Path (Join-Path $GoBinPath "go.exe"))) {
    Write-Host "`n[1/3] Downloading $GoVersion from go.dev..." -ForegroundColor Yellow
    $TempZip = Join-Path $env:TEMP $GoZipName
    
    & curl.exe -L --ssl-no-revoke --retry 5 --progress-bar -o $TempZip $GoUrl
    
    Write-Host "`n[2/3] Extracting Golang to: $InstallDir..." -ForegroundColor Yellow
    if (Test-Path $InstallDir) {
        Remove-Item -Recurse -Force $InstallDir
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir) | Out-Null
    
    Expand-Archive -Path $TempZip -DestinationPath (Split-Path $InstallDir) -Force
    Remove-Item -Force $TempZip
    Write-Host "-> Golang extracted successfully!" -ForegroundColor Green
} else {
    Write-Host "`n[1/3] Golang already installed at: $InstallDir" -ForegroundColor Green
}

# 2. Configure Environment variables
Write-Host "`n[2/3] Configuring GOROOT and PATH environment variables..." -ForegroundColor Yellow
[Environment]::SetEnvironmentVariable("GOROOT", $InstallDir, "User")
$env:GOROOT = $InstallDir

$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
$pathsToAdd = @($GoBinPath, $UserGoBinPath)

$newPathParts = ($currentPath -split ';') | Where-Object { $_ -ne "" }
foreach ($p in $pathsToAdd) {
    if ($newPathParts -notcontains $p) {
        $newPathParts += $p
    }
}
$updatedPath = ($newPathParts | Select-Object -Unique) -join ';'
[Environment]::SetEnvironmentVariable("Path", $updatedPath, "User")

$env:Path = "$GoBinPath;$UserGoBinPath;" + $env:Path

Write-Host "Checking Go version:" -ForegroundColor Cyan
& (Join-Path $GoBinPath "go.exe") version

# 3. Install Wails v2
Write-Host "`n[3/3] Installing Wails v2 CLI (go install)..." -ForegroundColor Yellow
$wailsExe = Join-Path $UserGoBinPath "wails.exe"
& (Join-Path $GoBinPath "go.exe") install github.com/wailsapp/wails/v2/cmd/wails@latest

Write-Host "`n==========================================================" -ForegroundColor Green
Write-Host "       GOLANG AND WAILS V2 INSTALLED SUCCESSFULLY!        " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green

if (Test-Path $wailsExe) {
    Write-Host "Wails CLI ready:" -ForegroundColor Cyan
    & $wailsExe version
}
