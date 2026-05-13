@echo off
title Palawan Connect — SMS Bridge Server
color 0A

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║   Palawan Connect — SMS Bridge Server    ║
echo  ╚══════════════════════════════════════════╝
echo.

:: ── Check ADB ────────────────────────────────────────────────
echo  Checking ADB (USB SMS transport)...
where adb >nul 2>&1
if %errorlevel% == 0 (
    echo  ✓ ADB found in PATH
    adb devices 2>nul | findstr /i "device" | findstr /v "List" >nul
    if %errorlevel% == 0 (
        echo  ✓ Android device connected via USB
        echo    USB Debugging is active — ADB SMS polling will start automatically
    ) else (
        echo  ℹ No Android device detected via USB
        echo    To enable USB SMS: connect phone with USB Debugging ON
        echo    The server will auto-detect when you plug in the phone
    )
) else (
    echo  ℹ ADB not found in PATH
    echo    To enable USB SMS:
    echo    1. Download platform-tools from developer.android.com
    echo    2. Set ADB_PATH in sms-bridge\.env
    echo    OR add platform-tools folder to your Windows PATH
)

echo.

:: ── Check WiFi Gateway ────────────────────────────────────────
findstr /i "SMS_GATEWAY_IP=" "%~dp0.env" | findstr /v "^#" | findstr /v "=$" >nul 2>&1
if %errorlevel% == 0 (
    echo  ✓ WiFi Gateway IP configured in .env
) else (
    echo  ℹ WiFi Gateway not configured ^(SMS_GATEWAY_IP empty in .env^)
    echo    USB/ADB will be used as primary SMS transport
)

echo.
echo  Starting server on http://localhost:3000
echo  Dashboard: http://localhost:3000
echo  Press Ctrl+C to stop
echo.

:: ── Start Node ────────────────────────────────────────────────
"%~dp0..\node-v24.15.0-win-x64\node.exe" "%~dp0server.js"

if %errorlevel% neq 0 (
    echo.
    echo  ✗ Server failed to start. Check the error above.
    pause
)
