@echo off
title MyHome Connect
color 0A

:: ── Paths ────────────────────────────────────────────────────
set "ROOT=%~dp0"
set "NODE=%ROOT%node-v24.15.0-win-x64\node.exe"
set "EMAIL_SERVER=%ROOT%sms-bridge\email-server.js"
set "SMS_SERVER=%ROOT%sms-bridge\server.js"
set "APP=%ROOT%index.html"
set "EMAIL_PORT=3001"
set "SMS_PORT=3000"

:: ── Check if email server is already running ─────────────────
netstat -ano | findstr ":%EMAIL_PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel% == 0 (
    echo  [OK] Email server already running on port %EMAIL_PORT%
    goto :open_browser
)

:: ── Start email bridge server in background ──────────────────
echo  Starting email bridge server...
start /B "" "%NODE%" "%EMAIL_SERVER%" > "%ROOT%sms-bridge\email-server.log" 2>&1

:: ── Wait up to 5 seconds for server to be ready ──────────────
set /a tries=0
:wait_loop
timeout /t 1 /nobreak >nul
netstat -ano | findstr ":%EMAIL_PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel% == 0 goto :server_ready
set /a tries+=1
if %tries% lss 5 goto :wait_loop

echo  [WARN] Server may still be starting — opening app anyway...
goto :open_browser

:server_ready
echo  [OK] Email server ready on http://localhost:%EMAIL_PORT%

:: ── Also start SMS bridge if not running ─────────────────────
:open_browser
netstat -ano | findstr ":%SMS_PORT% " | findstr "LISTENING" >nul 2>&1
if not %errorlevel% == 0 (
    echo  Starting SMS bridge server...
    start /B "" "%NODE%" "%SMS_SERVER%" > "%ROOT%sms-bridge\sms-server.log" 2>&1
)

:: ── Open the app in the default browser ──────────────────────
echo  Opening MyHome Connect...
start "" "%APP%"

:: ── Keep window open briefly to show status, then minimize ───
timeout /t 2 /nobreak >nul
exit
