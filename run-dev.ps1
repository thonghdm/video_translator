$env:Path = "$env:LOCALAPPDATA\Programs\Go\bin;$env:USERPROFILE\go\bin;" + $env:Path
$env:WAILS_DEV_ALLOWED_HOSTS = "wails.localhost,localhost,127.0.0.1"
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "       KHOI DONG SUBTRANS (WAILS DEV)                   " -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
wails dev
