@echo off
set "PATH=%LOCALAPPDATA%\Programs\Go\bin;%USERPROFILE%\go\bin;%PATH%"
set "WAILS_DEV_ALLOWED_HOSTS=wails.localhost,localhost,127.0.0.1"
echo ========================================================
echo       KHOI DONG SUBTRANS DEVELOPMENT SERVER
echo ========================================================
wails dev
pause
