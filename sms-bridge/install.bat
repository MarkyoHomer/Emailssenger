@echo off
echo ============================================
echo  Palawan Connect - SMS Bridge Setup
echo ============================================
echo.

SET BAT_DIR=%~dp0
SET NODE=%BAT_DIR%..\node-v24.15.0-win-x64\node.exe

echo Node.js version:
"%NODE%" --version
if %ERRORLEVEL% NEQ 0 (
  echo ERROR: Cannot find node.exe
  echo Expected at: %NODE%
  pause & exit /b 1
)

echo.
echo Downloading packages (no npm needed)...
echo.

"%NODE%" "%BAT_DIR%setup.js"

if %ERRORLEVEL% NEQ 0 (
  echo.
  echo ERROR: Setup failed. Check your internet connection.
  pause & exit /b 1
)

echo.
pause
