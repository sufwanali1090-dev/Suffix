#!/usr/bin/env bash
# =============================================================================
# Clone the optional external agent repositories into modules/.
#
# Every repo here is OPTIONAL: the desk runs, backtests and briefs without any
# of them. They are integration points, not dependencies.
#
#   hermes-agent    — general tool-using agent runtime (research surface)
#   worldmonitor    — Country Instability Index feed consumed by ATLAS
#   TradingAgents   — multi-agent financial research reference implementation
#   whisper.cpp     — local STT for the voice bridge (built by bootstrap --whisper)
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p modules

say() { printf '\033[38;5;44m▸ %s\033[0m\n' "$*"; }
ok() { printf '\033[38;5;42m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[38;5;214m! %s\033[0m\n' "$*" >&2; }

# name|url
REPOS=(
  "hermes-agent|https://github.com/cloud9markets/hermes-agent.git"
  "worldmonitor|https://github.com/cloud9markets/worldmonitor.git"
  "TradingAgents|https://github.com/TauricResearch/TradingAgents.git"
)

for entry in "${REPOS[@]}"; do
  name="${entry%%|*}"
  url="${entry##*|}"
  target="modules/$name"

  if [[ -d "$target/.git" ]]; then
    say "$name already cloned — pulling"
    git -C "$target" pull --ff-only --quiet || warn "$name: pull failed, keeping local copy"
    ok "$name up to date"
    continue
  fi

  say "cloning $name ← $url"
  if git clone --depth 1 --quiet "$url" "$target" 2>/dev/null; then
    ok "$name → $target"
  else
    warn "$name unavailable at $url (private, renamed, or offline) — skipping"
    warn "the desk does not require it; wire your own checkout into modules/$name"
  fi
done

cat <<'EOF'

Checked modules/:
EOF
ls -1 modules 2>/dev/null | sed 's/^/  · /' || echo "  (empty)"

cat <<'EOF'

Integration notes
  · ATLAS reads /health from modules/worldmonitor if you run its API locally;
    otherwise it uses the public CII snapshot and finally the seeded fallback.
  · TradingAgents is a reference for the agent debate pattern only — SUFFIX has
    its own orchestrator (server/orchestrator.py) and does not import it.
  · whisper.cpp is fetched by `bash scripts/bootstrap.sh --whisper`.
EOF
