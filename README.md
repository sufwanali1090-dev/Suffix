# SUFFIX TRADING DESK

> **Nine agents, one voice.**
> A cinematic AI desktop trading desk — Electron + React HUD, a FastAPI agent
> bridge, and a self-learning hedge-fund engine under a $100 paper account with
> a hard `$80.00` death line.

```
┌──────────────────────────────┐
│  SUFFIX  (Agent 10, the voice)│
└───────────────┬──────────────┘
   1 ATLAS    macro · rates · Country Instability Index
   2 SCOUT    Finnhub headlines · velocity · sentiment
   3 CAPITOL  13F institutional flows · insider transactions
   4 ATHENA   balance sheets · valuation · quality
   5 CHARTIST indicators · structure · TradingView MCP
   6 ORACLE   bootstrap probability · expected value
   7 SENTINEL risk gate · unilateral VETO · the $100 limit
   8 PILOT    execution → paper / Binance testnet
   9 LEDGER   SQLite book · wins · losses · extinctions
  11 QUANTUM  Optuna + vectorbt strategy evolution
```

---

## Project structure

```
Suffix/
├── electron/
│   ├── main.ts                     Electron main: window, Python supervision, IPC, permissions
│   └── preload.ts                  Frozen contextBridge API (`window.suffix`) — no Node in renderer
│
├── src/                            React HUD (Vite + Tailwind + framer-motion + zustand)
│   ├── App.tsx                     Layout + boot sequence + gesture/voice wiring
│   ├── main.tsx                    React entry
│   ├── index.css                   Tailwind layers, panels, scanlines, drag regions
│   ├── components/
│   │   ├── SuffixOrb.tsx           96-bar SVG audio visualizer orb (rAF, ref-mutated)
│   │   ├── TelemetryRing.tsx       The 10 radial telemetry nodes + sparklines
│   │   ├── RiskGauge.tsx           Death-line buffer, directive constants, last verdict
│   │   ├── QuantumPanel.tsx        Generation state, gate, penalty, graveyard
│   │   ├── AgentDetail.tsx         Focused specialist dossier
│   │   ├── TranscriptFeed.tsx      The single voice + reasoning traces
│   │   ├── PositionsPanel.tsx      Working positions, stops, liquidation, fills
│   │   ├── EquityGraph.tsx         Equity curve pinned to the death line
│   │   ├── EventLog.tsx            Flight recorder
│   │   ├── GestureOverlay.tsx      Camera PiP + skeleton + gesture action log
│   │   ├── CommandBar.tsx          Typed natural-language desk control
│   │   └── TitleBar.tsx            Frameless chrome, kill switch, equity readout
│   ├── hooks/useHandGestures.ts    MediaPipe Hand Landmarker → swipe/palm/fist/pinch
│   ├── lib/bridge.ts               JSON-RPC 2.0 client (HTTP + WebSocket, auto-reconnect)
│   ├── store/desk.ts               Zustand desk store (socket fold + intent methods)
│   └── types/contract.ts           TypeScript mirror of server/contracts.py
│
├── server/                         Python bridge + agents
│   ├── main.py                     FastAPI: REST + JSON-RPC + WebSocket + voice endpoints
│   ├── orchestrator.py             Agent 10 SUFFIX — fan-out, rubric, composition, dispatch
│   ├── config.py                   Single source of truth for every risk constant
│   ├── contracts.py                Pydantic wire models
│   ├── broker.py                   Agent 7 SENTINEL + Agent 8 PILOT (+ Binance testnet)
│   ├── quantum.py                  Agent 11 QUANTUM — Optuna + vectorbt + Do-or-Die gate
│   ├── agents.py                   Agents 1–6 analysts
│   ├── agents_ops.py               Agents 7/8/9/11 reporting surfaces
│   ├── indicators.py               Native NumPy/Pandas TA engine
│   ├── ledger.py                   Agent 9 LEDGER — SQLite journal (WAL)
│   ├── market_data.py              Finnhub + yfinance → cache → deterministic simulator
│   ├── mcp_tradingview.py          TradingView Desktop MCP stdio client
│   └── providers/
│       ├── stt.py                  whisper.cpp (HTTP server → CLI fallback)
│       ├── tts.py                  Kokoro-82M / ElevenLabs
│       └── backtester.py           Sandboxed strategy runner (timeout, validation)
│
├── scripts/
│   ├── bootstrap.sh                venv + npm + optional whisper.cpp build
│   ├── clone_modules.sh            optional hermes-agent / worldmonitor / TradingAgents
│   └── postbuild-electron.mjs      marks dist-electron as CommonJS
│
├── package.json · requirements.txt · .env.example
├── vite.config.ts · tailwind.config.js · postcss.config.js
└── tsconfig.json · tsconfig.electron.json
```

---

## Quick start

```bash
cp .env.example .env          # optional: add FINNHUB_API_KEY for live headlines
bash scripts/bootstrap.sh     # venv + pip + npm

npm run dev                   # API :8000 + HUD :5173 + Electron shell
```

Individual pieces:

```bash
npm run dev:api               # Python bridge only
npm run dev:hud               # browser HUD at :5173 (proxies to the bridge)
npm run build                 # typecheck + dist/ + dist-electron/
```

Everything runs with **no API keys and no network**: `server/market_data.py`
degrades `live → cache → deterministic simulator`, and every simulated frame is
labelled `data_quality: "simulated"` all the way up to the HUD.

---

## The Do-or-Die directive

| Constant | Value |
| --- | --- |
| Starting capital | **$100.00** (paper only) |
| Death line | **$80.00** — −20% total drawdown |
| Risk per trade | **1.0%–2.0%** ($1.00–$2.00), hard-capped at $2.00 |
| Leverage | **3x / 5x / 10x only** — anything else is a VETO |
| Performance gate | OOS **Sharpe > 1.8** and **Profit Factor > 1.5** |
| Consistency | ≥60% of rolling walk-forward windows must independently pass |
| Penalty | `reward × exp(−k · loss_streak)`, `k = 0.55 · (1 + 0.25 · streak)` |
| Generations | 50 per evolution cycle |

### 1. The Death Line
`PaperBroker.on_death_line()` is the single authoritative transition. When
mark-to-market equity reaches `$80.00` it: sets `risk_state = DEAD`, flattens
every position, records the equity snapshot, and fires `kill_hook` — which calls
`QuantumEngine.kill_generation()`. The entire active generation is written to the
LEDGER graveyard, blacklisted (persisted to SQLite, restored on restart so a
killed genome can never resurrect), and purged from active memory.

### 2. The Performance Gate
Every candidate is evaluated across **rolling walk-forward windows** (70/30
in-sample/out-of-sample, stepped). To be promoted it must clear Sharpe > 1.8 and
Profit Factor > 1.5 on the *aggregate* **and** in at least 60% of individual
out-of-sample windows, with ≥12 trades and zero liquidation events. Everything
else is written to `extinctions` and deleted.

Sharpe is computed on **daily-resampled returns**, not bar returns: a strategy
making 11 trades across 3000 bars has thousands of zero-return bars that would
otherwise crush the denominator and manufacture an annualized Sharpe of 6+.
Samples under 30 observations are shrunk toward zero. The gate is meant to be
hard to pass.

### 3. Adaptive Penalty Mutation
On any realized loss, `QuantumEngine.record_live_outcome()` increments the loss
streak, exponentially decays the trial reward, and mutates the incumbent genomes:
**lookback windows are slashed, stops are tightened, risk% and leverage are
reduced, and ADX/volume thresholds rise.** Mutation runs as a post-sample
transform so Optuna's trial distributions stay stable across the 50-generation
run.

---

## How a trade actually happens

```
ORACLE bracket ─┐
CHARTIST regime ┼─► SUFFIX rubric ──► TradeProposal ──► SENTINEL.evaluate()
ATLAS/SCOUT gate┘    (weighted vote)                        │
                                                            ├─ VETO  → logged, no venue call
                                                            └─ APPROVE → HMAC approval token
                                                                            │ (single-use, 30s TTL)
                                                                            ▼
                                                              PILOT.execute() → PaperBroker
                                                                            │
                                                        LEDGER journal ◄────┘
```

SENTINEL runs 11 ordered checks: desk state, death line, daily loss limit,
loss-streak cooldown, concurrency, leverage whitelist, risk band, order geometry,
stop width, duplicate/correlated exposure, and strategy provenance (blacklisted
genomes are rejected outright). Position size is derived from the stop distance
so a stop-out costs exactly the approved dollar risk — leverage is treated as a
*cap*, never a target.

**Live mainnet trading is not implemented anywhere in this codebase.** The
`ExecutionMode` validator demotes `live → testnet`, and the only remote venue is
`testnet.binance.vision`, gated behind `SUFFIX_ALLOW_TESTNET=1` plus credentials.

---

## Gesture navigation

`src/hooks/useHandGestures.ts` runs MediaPipe **Hand Landmarker** in VIDEO mode
over the webcam, classifies gestures geometrically (finger-extension ratios
normalized by palm width + wrist kinematics), and requires two consecutive
agreeing frames plus a per-gesture cooldown before firing.

| Gesture | Action |
| --- | --- |
| swipe left / right | cycle the focused telemetry agent |
| open palm | pause the desk |
| closed fist | resume |
| pinch | spoken briefing |
| thumbs up | build + adjudicate a proposal |
| thumbs down | flatten everything |
| victory | QUANTUM generation state |

Gestures are routed through `gesture.event` on the **server**, so camera input,
voice commands and the API produce identical behaviour. Requires a secure
context; Electron's permission handler grants `media`/`camera`.

---

## Voice

* **STT** — whisper.cpp. Preferred transport is the resident `whisper-server`
  (`--server --port 8082`); falls back to the `whisper-cli` binary. Audio is
  converted to 16 kHz mono with ffmpeg when available.
* **TTS** — Kokoro-82M via `kokoro-fastapi` (`:8880`), or ElevenLabs when
  `SUFFIX_TTS_BACKEND=elevenlabs`.
* **Fallback** — when no sidecar is reachable, the HUD falls back to the browser
  `SpeechSynthesis` API for `alert`/`critical` utterances only. SUFFIX never goes
  mute silently, and the HUD always shows which engine is live.

Set `SUFFIX_STT_BACKEND=disabled` / `SUFFIX_TTS_BACKEND=disabled` to turn them off.

---

## Agent tool integrations

| Tool | Where | Notes |
| --- | --- | --- |
| MediaPipe Hand Landmarker | `src/hooks/useHandGestures.ts` | WASM + model pinned to `@mediapipe/tasks-vision@0.10.14` |
| Electron | `electron/` | contextIsolation on, nodeIntegration off, no remote |
| whisper.cpp | `server/providers/stt.py` | HTTP then CLI |
| Kokoro-82M / ElevenLabs | `server/providers/tts.py` | LRU cache, 1200-char chunks |
| Finnhub | `server/market_data.py` | `company-news` + lexicon sentiment + velocity |
| yfinance | `server/market_data.py` | OHLCV, fundamentals, holders, insider tx |
| TradingView MCP | `server/mcp_tradingview.py` | JSON-RPC 2.0 over stdio; degrades to `mcp_unavailable` |
| Optuna + vectorbt | `server/quantum.py` | vectorbt is an independent cross-check; the native engine is canonical |
| `modules/` repos | `scripts/clone_modules.sh` | hermes-agent, worldmonitor, TradingAgents — all optional |

---

## JSON-RPC surface

44 methods, identical over `POST /rpc` and the `/ws` socket.

```
system.*    ping config status health subscribe shutdown_worker
desk.*      telemetry brief command propose manual_order flatten
            kill_switch resume reset pause
agents.*    list report collate
risk.*      evaluate state
ledger.*    stats trades extinctions verdicts equity
quantum.*   state run_generation evolve kill_generation penalty sandbox signals
market.*    quote candles
voice.*     transcribe speak say
mcp.*       health attach tools call
gesture.event · rpc.describe
```

REST conveniences: `/`, `/health`, `/status`, `/config`, `/telemetry`, `/agents`,
`/events`, `/ledger`, `/quantum`, `/market/{symbol}`, `/tts`, `/stt` (+ `/health`).

---

## Verified behaviour

Exercised against a live bridge, not just imported:

* **Risk gate** — a compliant 2% / 10x proposal is approved and sized to exactly
  `$2.00` risk at 3x effective leverage with a `$40,240` liquidation price; a
  25x proposal is `VETO ['Leverage whitelist']`; replaying a spent approval token
  returns `REJECTED approval token missing, expired or already used`.
* **Death line** — forcing equity to `$79.00` transitions the desk to `DEAD`,
  flattens, and terminates the generation.
* **Trading** — `desk.manual_order` filled `LONG BTC-USD 0.00070981 @ 58,167.77
  (3x)` with correct fees, stop and liquidation; flatten closed it and journalled
  the P&L.
* **Quantum** — a generation runs in ~5–25s: proposes via real Optuna TPE,
  walk-forward evaluates, cross-checks the survivors with vectorbt, promotes the
  passers and buries the rest. Losses drive `decay ×0.5028` (streak 1) →
  `×0.1920` (streak 2) and tighten the sampling space.
* **Transport** — handshake, socket RPC, and all three push channels
  (`telemetry`, `event`, `utterance`) verified directly and through the Vite proxy.

### Known environment limitations

* **Yahoo Finance is unreachable from the build sandbox** (TLS to
  `query2.finance.yahoo.com` is blocked), so the desk runs on its deterministic
  simulator there. Live mode works wherever yfinance can reach Yahoo.
* **Live market data is the only reliable source of a hard gate.** The simulator
  is calibrated to a realistic edge profile (≈43% win rate at 2:1 R:R, PF ≈1.5 on
  a fixed genome) rather than a flattering one — an earlier calibration produced
  a 56% win rate and PF 2.5, which made every trend-follower look like a holy
  grail. Even so, on simulated data Optuna's TPE exploitation finds the passing
  region too easily; against real tape the gate bites far harder.
* TradingView MCP requires the desktop app + local MCP server; without it
  CHARTIST reports `mcp_unavailable` and continues with its own indicator panel.
* Camera gestures need a real webcam and a secure context.

---

## Adding an agent

```python
# server/agents.py
class MyAgent:
    agent = AgentId.MY_AGENT
    designation = "MYAGENT"
    role = "custom"

    async def analyze(self, symbol: str, ctx: DeskContext) -> AgentReport:
        return AgentReport(agent=self.agent, headline="…", confidence=0.7,
                           bias="long", data_quality="live")
```

Then register it in `AgentId`, `AGENT_META` (`src/types/contract.ts`),
`INTENT_AGENT_SETS`, `INTENT_WEIGHTS`, and the orchestrator's `self.agents` dict.
It appears in the radial ring on the next frame.

---

## Safety notes

* Paper trading only. No mainnet ordering path exists.
* The API binds `0.0.0.0`, is unauthenticated, and has CORS/`frame-ancestors`
  relaxed so the HUD can render in a proxied preview. **Bind it to `127.0.0.1`
  (set `SUFFIX_API_HOST=127.0.0.1`) before exposing the desk on any shared
  network.** It can move real testnet orders when configured.
* `.env` is git-ignored; never commit API keys.
* `runtime/` holds the SQLite journal, Optuna study and market cache, and is
  git-ignored.

## Licence

MIT.
