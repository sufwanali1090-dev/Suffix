@echo off
setlocal EnableExtensions EnableDelayedExpansion
title SUFFIX TRADING DESK - Setup
cd /d "%~dp0"

REM ===========================================================================
REM  SUFFIX TRADING DESK - Windows one-shot setup
REM
REM    install.bat [--no-build] [--modules] [--whisper] [--help]
REM
REM    --no-build   skip the HUD production build (default: build it so that
REM                 the dashboard can be served from a single port)
REM    --modules    clone the optional agent repositories into modules\
REM    --whisper    build whisper.cpp + fetch the base.en model (needs cmake)
REM
REM  Safe to re-run: every step is skipped when it is already satisfied.
REM  Runs with no API keys and no network beyond pip/npm - SUFFIX falls back to
REM  its deterministic simulator when market data is unreachable.
REM ===========================================================================

set "ROOT=%CD%"
set "VPY=%ROOT%\.venv\Scripts\python.exe"
set "PY="
set "PYVER="
set "NODEVER="
set "NODEMAJOR=0"
set "DO_BUILD=1"
set "DO_MODULES=0"
set "DO_WHISPER=0"
set "FAILED=0"

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--no-build" set "DO_BUILD=0"
if /i "%~1"=="--modules"  set "DO_MODULES=1"
if /i "%~1"=="--whisper"  set "DO_WHISPER=1"
if /i "%~1"=="--help"     goto usage
if /i "%~1"=="-h"         goto usage
echo   unknown option: %~1
goto usage

:parsed
echo.
echo   ============================================================
echo     SUFFIX TRADING DESK  -  setup
echo     Nine agents, one voice.
echo   ============================================================
echo   root: %ROOT%
echo.

REM ---------------------------------------------------------------------------
REM  1/5  Python 3.11+
REM ---------------------------------------------------------------------------
echo   [1/5] Python 3.11+
call :find_python
if not defined PY goto no_python
for /f "delims=" %%v in ('%PY% -c "import sys;print(sys.version.split()[0])" 2^>nul') do set "PYVER=%%v"
echo         found Python %PYVER%  ^(%PY%^)

REM ---------------------------------------------------------------------------
REM  2/5  virtualenv + Python packages
REM ---------------------------------------------------------------------------
echo   [2/5] Python packages

if exist "%VPY%" goto venv_ready
echo         creating .venv ...
%PY% -m venv .venv
if errorlevel 1 goto venv_failed

:venv_ready
if not exist "%VPY%" goto venv_failed

echo         upgrading pip ...
"%VPY%" -m pip install --upgrade pip setuptools wheel --quiet --disable-pip-version-check
if errorlevel 1 echo         [warn] pip self-upgrade failed - continuing

echo         installing requirements.txt ^(this can take a few minutes^) ...
"%VPY%" -m pip install -r requirements.txt --disable-pip-version-check
if errorlevel 1 goto pip_failed

echo         verifying imports ...
"%VPY%" -c "import fastapi, uvicorn, numpy, pandas, scipy, yfinance, httpx, pydantic; print('        core stack ok')"
if errorlevel 1 goto import_failed

REM vectorbt pulls a numba/llvmlite toolchain that is optional by design: if it
REM will not build, QUANTUM degrades to its native NumPy backtester.
"%VPY%" -c "import vectorbt; print('        vectorbt ' + vectorbt.__version__)" 2>nul
if errorlevel 1 echo         [warn] vectorbt unavailable - QUANTUM will use its native backtester

"%VPY%" -c "import optuna; print('        optuna ' + optuna.__version__)" 2>nul
if errorlevel 1 echo         [warn] optuna unavailable - QUANTUM will use its built-in sampler

"%VPY%" -c "import server.main; print('        bridge module ok')"
if errorlevel 1 goto import_failed

REM ---------------------------------------------------------------------------
REM  3/5  Node.js 18+ and the renderer packages
REM ---------------------------------------------------------------------------
echo   [3/5] Node packages

where node >nul 2>&1
if errorlevel 1 goto no_node
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODEVER=%%v"
for /f "tokens=1 delims=." %%a in ("!NODEVER:v=!") do set "NODEMAJOR=%%a"
if !NODEMAJOR! LSS 18 goto node_old
echo         found Node %NODEVER%

if exist "node_modules" echo         node_modules present - refreshing
call npm install --no-fund --no-audit
if errorlevel 1 goto npm_failed
echo         npm packages ok

REM ---------------------------------------------------------------------------
REM  4/5  HUD production build  (lets one port serve the whole desk)
REM ---------------------------------------------------------------------------
echo   [4/5] HUD build

if "%DO_BUILD%"=="0" (
    echo         skipped ^(--no-build^) - run "npm run build" before starting
) else (
    call npm run build
    if errorlevel 1 goto build_failed
    if exist "dist\index.html" (
        echo         dist\index.html ready - the dashboard can be served from one port
    ) else (
        rem Non-fatal: the dev server still works without a build.
        echo         [warn] build finished but dist\index.html is missing
    )
)

REM ---------------------------------------------------------------------------
REM  5/5  Optional extras
REM ---------------------------------------------------------------------------
echo   [5/5] Optional extras

if "%DO_MODULES%"=="1" (
    call :clone_modules
) else (
    echo         modules\ skipped ^(pass --modules to clone the agent repos^)
)

if "%DO_WHISPER%"=="1" (
    call :build_whisper
) else (
    echo         whisper.cpp skipped ^(pass --whisper to enable voice input^)
)

if not exist ".env" (
    if exist ".env.example" (
        echo.
        echo   note: no .env yet - SUFFIX runs without one, using simulated data.
        echo         For live headlines: copy .env.example .env and add FINNHUB_API_KEY
    )
)

echo.
echo   ============================================================
if "%FAILED%"=="0" (
    echo     SETUP COMPLETE
    echo.
    echo     Start the desk by double-clicking:  start-dashboard.bat
    echo     Then open:                          http://127.0.0.1:8000/
) else (
    echo     SETUP FINISHED WITH ERRORS - see the messages above
)
echo   ============================================================
echo.
pause
exit /b %FAILED%


REM ===========================================================================
REM  Subroutines
REM ===========================================================================

:find_python
set "PY="
py -3 -c "import sys;sys.exit(0 if sys.version_info>=(3,11) else 1)" >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if defined PY goto :eof
python -c "import sys;sys.exit(0 if sys.version_info>=(3,11) else 1)" >nul 2>&1
if not errorlevel 1 set "PY=python"
goto :eof


:clone_modules
if not exist "modules" mkdir "modules"
call :clone_one hermes-agent  https://github.com/cloud9markets/hermes-agent.git
call :clone_one worldmonitor  https://github.com/cloud9markets/worldmonitor.git
call :clone_one TradingAgents https://github.com/TauricResearch/TradingAgents.git
goto :eof

:clone_one
if exist "modules\%~1" (
    echo         %~1 already present - skipping
    goto :eof
)
echo         cloning %~1 ...
git clone --depth 1 --quiet "%~2" "modules\%~1"
if errorlevel 1 echo         [warn] could not clone %~1 ^(offline?^) - SUFFIX runs without it
goto :eof


:build_whisper
where git >nul 2>&1
if errorlevel 1 (
    echo         [skip] git not found - cannot fetch whisper.cpp
    goto :eof
)
where cmake >nul 2>&1
if errorlevel 1 (
    echo         [skip] cmake not found - voice input stays disabled
    echo                Install CMake ^(https://cmake.org/download/^) and re-run with --whisper
    goto :eof
)
if exist "modules\whisper.cpp" (
    echo         whisper.cpp already present - skipping clone
) else (
    echo         cloning whisper.cpp ...
    git clone --depth 1 --quiet https://github.com/ggerganov/whisper.cpp.git modules\whisper.cpp
    if errorlevel 1 (
        echo         [warn] could not clone whisper.cpp
        goto :eof
    )
)
echo         building whisper.cpp ...
pushd "modules\whisper.cpp"
cmake -B build -DCMAKE_BUILD_TYPE=Release >nul
cmake --build build --config Release --target whisper-cli >nul
set "BUILT=%ERRORLEVEL%"
popd
if not "%BUILT%"=="0" (
    echo         [warn] whisper.cpp build failed - voice input stays disabled
    goto :eof
)
if not exist "modules\whisper.cpp\models" mkdir "modules\whisper.cpp\models"
if exist "modules\whisper.cpp\models\ggml-base.en.bin" (
    echo         model already downloaded
) else (
    echo         downloading ggml-base.en.bin ^(~150 MB^) ...
    curl -L -s -o "modules\whisper.cpp\models\ggml-base.en.bin" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
    if errorlevel 1 echo         [warn] model download failed - voice input stays disabled
)
echo         whisper.cpp ready
goto :eof


REM ===========================================================================
REM  Failure paths
REM ===========================================================================

:no_python
echo.
echo   [X] Python 3.11 or newer was not found.
echo.
echo       Install it from https://www.python.org/downloads/
echo       On the first screen of the installer, TICK "Add python.exe to PATH".
echo.
set "FAILED=1"
goto end

:venv_failed
echo.
echo   [X] Could not create the virtualenv at .venv
echo       Check that you have write permission to %ROOT%
echo.
set "FAILED=1"
goto end

:pip_failed
echo.
echo   [X] pip install -r requirements.txt failed.
echo.
echo       Common causes:
echo         * no internet, or a corporate proxy blocking pypi.org
echo         * a Python other than 3.11+ ^(check: %PY% --version^)
echo         * vectorbt's numba/llvmlite toolchain could not build
echo       Retry just the core stack:
echo         "%VPY%" -m pip install fastapi uvicorn numpy pandas scipy yfinance
echo.
set "FAILED=1"
goto end

:import_failed
echo.
echo   [X] The Python packages installed but will not import.
echo       Re-run this installer; if it persists, delete .venv and try again.
echo.
set "FAILED=1"
goto end

:no_node
echo.
echo   [X] Node.js was not found.
echo.
echo       Install the LTS release from https://nodejs.org/
echo       SUFFIX needs version 18 or newer ^(20+ recommended^).
echo.
set "FAILED=1"
goto end

:node_old
echo.
echo   [X] Node %NODEVER% is too old - SUFFIX needs 18 or newer.
echo       Upgrade from https://nodejs.org/
echo.
set "FAILED=1"
goto end

:npm_failed
echo.
echo   [X] npm install failed.
echo       Check your internet connection, then re-run this installer.
echo.
set "FAILED=1"
goto end

:build_failed
echo.
echo   [X] The HUD build failed.
echo       Try it on its own to see the full error:
echo         npm run build
echo       You can still run the desk in dev mode: start-dashboard.bat --dev
echo.
set "FAILED=1"
goto end

:usage
echo.
echo   SUFFIX TRADING DESK - Windows setup
echo.
echo     install.bat [options]
echo.
echo     --no-build   skip the HUD production build
echo     --modules    clone optional agent repos into modules\
echo     --whisper    build whisper.cpp for voice input ^(needs cmake^)
echo     --help       show this text
echo.

:end
echo.
pause
exit /b %FAILED%
