@echo off
title MyHome Connect — Email Bridge Server
color 0B
echo.
echo  ╔══════════════════════════════════════════╗
echo  ║  MyHome Connect — Email Bridge Server    ║
echo  ╚══════════════════════════════════════════╝
echo.
echo  Starting on http://localhost:3001
echo  Press Ctrl+C to stop
echo.
"%~dp0..\node-v24.15.0-win-x64\node.exe" "%~dp0email-server.js"
if %errorlevel% neq 0 (
  echo.
  echo  ✗ Server failed. Run install-email-deps.js first:
  echo    ..\node-v24.15.0-win-x64\node.exe install-email-deps.js
  pause
)
