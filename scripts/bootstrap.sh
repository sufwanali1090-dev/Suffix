#!/usr/bin/env bash
# =============================================================================
# SUFFIX TRADING DESK — one-shot bootstrap.
#
#   bash scripts/bootstrap.sh [--whisper] [--no-node] [--no-python] [--modules]
#
#   --whisper   also build whisper.cpp and fetch the base.en model (~150 MB)
#   --no-node   skip npm install
#   --no-python skip the virtualenv + pip install
#   --modules   clone the optional agent repositories into modules/
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUILD_WHISPER=0
DO_NODE=1
DO_PYTHON=1
DO_MODULES=0

for arg in "$@"; do
  case "$arg" in
    --whisper)   BUILD_WHISPER=1 ;;
    --no-node)   DO_NODE=0 ;;
    --no-python) DO_PYTHON=0 ;;
    --modules)   DO_MODULES=1 ;;
    -h|--help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[38;5;44m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[38;5;214m! %s\033[0m\n' "$*" >&2; }
ok() { printf '\033[38;5;42m✓ %s\033[0m\n' "$*"; }

say "SUFFIX TRADING DESK bootstrap → $ROOT"

# --------------------------------------------------------------------------- #
#  1. Environment template
# --------------------------------------------------------------------------- #
if [[ ! -f .env ]]; then
  cp .env.example .env
  ok "created .env from .env.example (add FINNHUB_API_KEY for live headlines)"
else
  ok ".env already present — leaving it untouched"
fi

# --------------------------------------------------------------------------- #
#  2. Python
# --------------------------------------------------------------------------- #
if [[ "$DO_PYTHON" == "1" ]]; then
  PY="${PYTHON:-python3}"
  if ! command -v "$PY" >/dev/null 2>&1; then
    warn "python3 not found on PATH; set PYTHON=/path/to/python3"
    exit 1
  fi

  if [[ ! -d .venv ]]; then
    say "creating virtualenv (.venv)"
    "$PY" -m venv .venv
  fi
  # shellcheck disable=SC1091
  source .venv/bin/activate

  say "installing Python quant/agent stack (this pulls vectorbt + numba)"
  python -m pip install --upgrade pip setuptools wheel --quiet
  pip install -r requirements.txt

  ok "python: $(python --version)"
  python - <<'PY'
import importlib
for mod in ("fastapi", "uvicorn", "numpy", "pandas", "yfinance"):
    try:
        importlib.import_module(mod)
    except Exception as exc:  # noqa: BLE001
        print(f"  ! missing {mod}: {exc}")
optional = []
for mod in ("optuna", "vectorbt"):
    try:
        importlib.import_module(mod)
        optional.append(f"{mod}:ok")
    except Exception as exc:  # noqa: BLE001
        optional.append(f"{mod}:MISSING ({exc})")
print("  optional engines → " + ", ".join(optional))
PY
fi

# --------------------------------------------------------------------------- #
#  3. Node / Electron
# --------------------------------------------------------------------------- #
if [[ "$DO_NODE" == "1" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    warn "npm not found; skipping the desktop shell"
  else
    say "installing Node dependencies (Electron, React, Vite, MediaPipe)"
    # Headless CI boxes cannot fetch the Electron binary; the renderer still builds.
    if [[ -n "${CI:-}" || -n "${ELECTRON_SKIP_BINARY_DOWNLOAD:-}" ]]; then
      ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --no-audit --no-fund
    else
      npm install --no-audit --no-fund
    fi
    ok "node: $(node --version), npm: $(npm --version)"
  fi
fi

# --------------------------------------------------------------------------- #
#  4. Optional agent repositories
# --------------------------------------------------------------------------- #
if [[ "$DO_MODULES" == "1" ]]; then
  bash scripts/clone_modules.sh || warn "module clone step failed (optional)"
fi

# --------------------------------------------------------------------------- #
#  5. whisper.cpp (optional STT sidecar)
# --------------------------------------------------------------------------- #
if [[ "$BUILD_WHISPER" == "1" ]]; then
  if [[ ! -d modules/whisper.cpp ]]; then
    say "cloning whisper.cpp"
    mkdir -p modules
    git clone --depth 1 https://github.com/ggerganov/whisper.cpp modules/whisper.cpp
  fi
  say "building whisper.cpp"
  cmake -S modules/whisper.cpp -B modules/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release
  cmake --build modules/whisper.cpp/build --config Release -j "$(nproc 2>/dev/null || echo 2)"
  say "fetching ggml-base.en model"
  bash modules/whisper.cpp/models/download-ggml-model.sh base.en
  ok "whisper.cpp ready → modules/whisper.cpp/build/bin/whisper-cli"
fi

# --------------------------------------------------------------------------- #
#  6. Smoke check
# --------------------------------------------------------------------------- #
say "verifying the desk boots"
PYTHONPATH="$ROOT" .venv/bin/python - <<'PY' || warn "python import check failed"
import warnings; warnings.filterwarnings("ignore")
from server.config import settings
import server.main  # noqa: F401
print(f"  capital ${settings.suffix_starting_capital:.2f} | "
      f"death line ${settings.suffix_death_line:.2f} | "
      f"risk ${settings.risk_min_usd:.2f}–${settings.risk_max_usd:.2f} | "
      f"leverage {settings.allowed_leverage} | "
      f"mode {settings.suffix_execution_mode}")
PY

cat <<'EOF'

────────────────────────────────────────────────────────────────────────────
 SUFFIX is ready.

   npm run dev        # API (:8000) + HUD (:5173) + Electron shell
   npm run dev:api    # Python bridge only
   npm run build      # production bundles (dist/, dist-electron/)

 Optional sidecars (each independent — the desk runs without all of them):
   Kokoro TTS   : uvicorn kokoro_fastapi:app --port 8880
   whisper.cpp  : bash scripts/bootstrap.sh --whisper
                  modules/whisper.cpp/build/bin/whisper-server \
                    -m modules/whisper.cpp/models/ggml-base.en.bin --port 8082

 Trading is PAPER ONLY. Live mainnet ordering is not implemented anywhere.
────────────────────────────────────────────────────────────────────────────
EOF
