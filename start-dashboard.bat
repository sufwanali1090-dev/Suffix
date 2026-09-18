@echo off
setlocal EnableExtensions EnableDelayedExpansion
title SUFFIX TRADING DESK - Dashboard
cd /d "%~dp0"

REM --- helper re-entry ---------------------------------------------------------
REM  When this file is launched with --open-when-ready it does NOT start a desk;
REM  it waits for the bridge to answer, opens the browser and exits. The parent
REM  spawns it right before starting the server, so the browser never lands on a
REM  connection-refused page while uvicorn is still booting.
if /i "%~1"=="--open-when-ready" goto open_when_ready

REM ===========================================================================
REM  SUFFIX TRADING DESK - start the dashboard
REM
REM    start-dashboard.bat [--port N] [--no-open] [--dev] [--testnet] [--help]
REM
REM    --port N     serve on a different port          (default 8000)
REM    --no-open    do not launch a browser
REM    --dev        run the Vite dev server with hot reload (port 5173)
REM    --testnet    arm the Binance testnet rehearsal  (still never mainnet)
REM
REM  Paper trading only. Starting capital is $100.00, the death line is $80.00,
REM  and live mainnet ordering does not exist anywhere in this codebase.
REM ===========================================================================

set "ROOT=%CD%"
set "VPY=%ROOT%\.venv\Scripts\python.exe"
set "PORT=8000"
set "VISITPORT=8000"
set "BINDHOST=0.0.0.0"
set "OPENBRW=1"
set "DEVMODE=0"
set "TESTNET=0"
set "LOGLVL=info"
set "FAILED=0"

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--port"    goto take_port
if /i "%~1"=="--no-open" set "OPENBRW=0"
if /i "%~1"=="--dev"     set "DEVMODE=1"
if /i "%~1"=="--testnet" set "TESTNET=1"
if /i "%~1"=="--help"    goto usage
if /i "%~1"=="-h"        goto usage
echo   unknown option: %~1
goto usage

:take_port
set "PORT=%~2"
shift
shift
goto parse

:parsed

REM --- port: environment, then .env, then validate -----------------------------
if defined SUFFIX_API_PORT set "PORT=%SUFFIX_API_PORT%"
if not exist ".env" goto port_check
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="SUFFIX_API_PORT" set "PORT=%%b"
)

:port_check
echo %PORT%| findstr /r /c:"^[0-9][0-9]*$" >nul
if errorlevel 1 (
    echo   [warn] unusable port "%PORT%" - falling back to 8000
    set "PORT=8000"
)
set "VISITPORT=%PORT%"

REM The desk is always paper or testnet; "live" is demoted to testnet by
REM server/config.py and mainnet ordering is not implemented at all.
set "EXECUTIONMODE=paper"
if "%TESTNET%"=="1" set "EXECUTIONMODE=testnet"

echo.
echo   ============================================================
echo     SUFFIX TRADING DESK
echo   ============================================================
echo.

REM --- preflight ---------------------------------------------------------------
if not exist "%VPY%" goto need_install

if "%DEVMODE%"=="1" goto dev_checks

REM A build is what lets one port serve both the HUD and the bridge.
if exist "dist\index.html" goto have_dist

echo   no dist\index.html - building the HUD once ...
where node >nul 2>&1
if errorlevel 1 goto need_install
if not exist "node_modules" (
    echo   installing renderer packages ...
    call npm install --no-fund --no-audit
    if errorlevel 1 goto node_failed
)
call npm run build
if errorlevel 1 goto build_failed
if not exist "dist\index.html" goto build_failed

:have_dist
goto launch

:dev_checks
if not exist "node_modules" goto need_install
if not "%PORT%"=="8000" echo   [warn] the Vite proxy targets 127.0.0.1:8000 - dev mode with --port is likely to fail
set "VISITPORT=5173"

REM ---------------------------------------------------------------------------
REM  Launch
REM ---------------------------------------------------------------------------
:launch
echo   mode     : %EXECUTIONMODE%
echo   bridge   : http://127.0.0.1:%PORT%/
if "%DEVMODE%"=="1" echo   hud      : http://127.0.0.1:5173/  ^(Vite dev, hot reload^)
if "%DEVMODE%"=="0" echo   hud      : http://127.0.0.1:%PORT%/  ^(served by the bridge^)
echo   stop     : press Ctrl+C in this window
echo.

if "%TESTNET%"=="1" (
    set "SUFFIX_EXECUTION_MODE=testnet"
    set "SUFFIX_ALLOW_TESTNET=1"
    echo   [mode] Binance TESTNET rehearsal armed. Mainnet ordering is not
    echo          implemented - server/config.py demotes "live" to "testnet".
    echo.
)

if "%DEVMODE%"=="1" (
    echo   starting Vite dev server in a second window ...
    start "SUFFIX vite" cmd /c npm run dev:hud
)

if "%OPENBRW%"=="1" start "SUFFIX open" /min cmd /c call "%~f0" --open-when-ready %VISITPORT%

if "%DEVMODE%"=="1" echo   bridge coming up - the HUD appears at http://127.0.0.1:5173/
echo.

"%VPY%" -m uvicorn server.main:app --host %BINDHOST% --port %PORT% --log-level %LOGLVL%

REM uvicorn has exited (Ctrl+C or a fatal error).
echo.
echo   SUFFIX bridge stopped.
if "%DEVMODE%"=="1" echo   The Vite window is still open - close it if you are done.
echo.
echo   Note: open paper positions live in memory only. Restarting the bridge
echo         returns the desk to $100.00 flat; the ledger history persists in
echo         runtime\ledger.db.
echo.
pause
exit /b %FAILED%

REM ===========================================================================
REM  Browser helper - runs in its own minimised window
REM ===========================================================================
:open_when_ready
set "WPORT=%~2"
if "%WPORT%"=="" set "WPORT=8000"

REM curl.exe ships with Windows 10 1803+. Without it we cannot probe, so we
REM fall back to a fixed delay that covers a normal cold start.
where curl >nul 2>&1
if errorlevel 1 (
    ping -n 7 127.0.0.1 >nul
    goto owr_open
)

set /a TRIES=0
:owr_wait
set /a TRIES+=1
if %TRIES% GTR 60 goto owr_giveup
curl -s -o nul --max-time 2 "http://127.0.0.1:%WPORT%/health" >nul 2>&1
if not errorlevel 1 goto owr_open
ping -n 2 127.0.0.1 >nul
goto owr_wait

:owr_open
start "" "http://127.0.0.1:%WPORT%/"
exit /b 0

:owr_giveup
echo.
echo   [warn] the bridge did not answer on port %WPORT% within 60 seconds.
echo          Check the main window for a Python traceback.
ping -n 6 127.0.0.1 >nul
exit /b 1

REM ===========================================================================
REM  Failure paths
REM ===========================================================================
:need_install
echo.
echo   [X] SUFFIX is not set up yet.
echo.
echo       Double-click  install.bat  first - it installs the Python packages,
echo       the renderer packages and builds the HUD.
echo.
set "FAILED=1"
goto end

:node_failed
echo.
echo   [X] npm install failed. Check your internet connection and re-run.
echo.
set "FAILED=1"
goto end

:build_failed
echo.
echo   [X] Could not build the HUD.
echo       Run "npm run build" to see the full error, or try:
echo         start-dashboard.bat --dev
echo.
set "FAILED=1"
goto end

:usage
echo.
echo   SUFFIX TRADING DESK - start the dashboard
echo.
echo     start-dashboard.bat [options]
echo.
echo     --port N     serve on a different port        ^(default 8000^)
echo     --no-open    do not launch a browser
echo     --dev        Vite dev server with hot reload  ^(port 5173^)
echo     --testnet    arm the Binance testnet rehearsal
echo     --help       show this text
echo.
echo   Paper trading only: $100.00 start, $80.00 death line, 3x/5x/10x max.
echo.

:end
echo.
pause
exit /b %FAILED%
