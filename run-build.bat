@echo off
set "PATH=%LOCALAPPDATA%\Programs\Go\bin;%USERPROFILE%\go\bin;%PATH%"
echo ========================================================
echo       DANG DONG GOI UNG DUNG SUBTRANS (.EXE)
echo ========================================================
wails build -clean
echo ========================================================
echo       BUILD HOAN TAT! FILE NAM TAI: build\bin\subtrans.exe
echo ========================================================
pause
