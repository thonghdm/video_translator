$env:Path = "$env:LOCALAPPDATA\Programs\Go\bin;$env:USERPROFILE\go\bin;" + $env:Path
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "       DANG DONG GOI UNG DUNG SUBTRANS (.EXE)           " -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
wails build -clean
Write-Host "`nBUILD HOAN TAT! FILE NAM TAI: build\bin\subtrans.exe" -ForegroundColor Green
