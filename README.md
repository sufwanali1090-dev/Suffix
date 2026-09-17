# F.R.I.D.A.Y. — the desk

> One master, nine specialists, one voice. You talk to the desk; the master routes your
> words to the agent whose job it is; the answer comes back out loud; the charts obey.

This is the **buildable version** of the Cloud9 blueprint: a real Electron app with a live
HUD, nine agent services, a market-data layer, a voice pipeline, and one hard rule — money
moves only after the risk officer signs.

**Zero runtime dependencies.** Node 20.11+ runs the whole server. No build step, no install
required to see it work.

```bash
node server/index.js        # → http://localhost:8787   (or: npm start)
```

That's the quickstart. Paste a `FINNHUB_KEY` into `.env` and the tape goes live; without one
the desk runs on a **labelled** simulated feed so every panel stays badged `SIM` — nothing is
ever presented as a real price.

---

## The cast

| seat | agent | job | voice (pitch · rate) |
| --- | --- | --- | --- |
| 0 | **F.R.I.D.A.Y.** · master | routes, synthesizes, answers out loud. Does no specialist work itself | Daniel · 0.92 · 1.02 |
| 1 | **ATLAS** · macro | the Fed, rates, and the market's weather | UK Male · 0.78 · 0.94 |
| 2 | **CAPITOL** · smart money | what Congress, insiders and funds quietly buy | Fred · 0.68 · 0.90 |
| 3 | **SCOUT** · recon | whatever is going viral, before your feed does | Alex · 1.18 · 1.16 |
| 4 | **ATHENA** · analyst | filings and structure: supply, demand, liquidity | Karen · 0.95 · 0.98 |
| 5 | **CHARTIST** · technician | drives the screens — flips symbols, marks the lines | Rocko · 0.62 · 1.06 |
| 6 | **ORACLE** · quant | forecasts as probabilities, never promises | Whisper · 1.45 · 1.10 |
| 7 | **SENTINEL** · risk | sizes it, stops it, holds the veto | Albert · 0.55 · 0.86 |
| 8 | **PILOT** · execution | places it — only on a stamp | Rishi · 0.88 · 1.08 |
| 9 | **LEDGER** · the book | journals every call, especially the bad ones | Grandpa · 0.60 · 0.84 |

Voices are browser-native until you wire local TTS — see [docs/VOICES.md](docs/VOICES.md).

## Four rules, and where they live in code

1. **Claude writes the desk.** Everything here is plain Node + the DOM, so an agent is one
   file: [docs/ADD-AN-AGENT.md](docs/ADD-AN-AGENT.md).
2. **One master, many specialists.** `server/agents/roster.js` is the only table of names. The
   HUD has exactly one way to ask for thought (`POST /api/command`). Set `remote:` on a roster
   entry and that seat becomes its own process: `node server/agent-service.js oracle`.
3. **The charts are part of the desk.** Chartist returns *commands*, not prose, and they go to
   the in-app chart and to your real TradingView over an MCP bridge:
   [docs/TRADINGVIEW-MCP.md](docs/TRADINGVIEW-MCP.md).
4. **The one rule that makes it safe.** `SENTINEL` holds an Ed25519 private key; everyone else
   gets the public half. `PILOT` verifies a stamp it structurally cannot forge, and a stamp is
   single-use. See [docs/SAFETY.md](docs/SAFETY.md).

```
proposal (Pilot drafts) → stamp (Sentinel signs) → confirm (you) → paper fill
```

There is no broker adapter in this build. `EXECUTION_MODE=live` doesn't disable anything — it
refuses, on purpose.

## Try it out loud

```bash
npm start                       # then open http://localhost:8787
```

Say (or type) any of these — the chips under the command bar do the same:

| you say | who answers | what the desk does |
| --- | --- | --- |
| `give me a briefing` | ATLAS + SCOUT + ATHENA + ORACLE | four reports, one spoken answer |
| `pull up NVDA and mark the levels` | ATHENA + CHARTIST | screens flip, supply/demand/stop drawn, R:R stated |
| `what's moving today` | SCOUT | ranks the sweep, reads the loudest name, logs an alert |
| `forecast TSLA 20 day` | ORACLE | Monte-Carlo band on the chart, probabilities only |
| `what has congress bought lately` | CAPITOL | reads `data/smart-money.json`, or says it has no source |
| `buy 200 shares of NVDA` | PILOT → SENTINEL | draft ticket, sized + stamped or vetoed, **never** executed yet |
| `confirm the trade` | PILOT | fills paper only if a valid stamp exists |
| `how is the book health` | LEDGER | entries, vetoes, latency, feed caveats, out loud |

Same commands without the browser:

```bash
curl -s -X POST localhost:8787/api/command -H 'content-type: application/json' \
  -d '{"text":"pull up NVDA and mark the levels"}' | jq -r '.reply.speech'
curl -N localhost:8787/api/stream          # everything the HUD paints, as it happens
```

## Keyboard / mouse / hands

| | |
| --- | --- |
| `space` | talk: press to open the mic, press again to send what it heard |
| `↵` | send what's typed |
| `1`–`9` | focus a seat · `←` `→` cycle |
| `m` | voices: master → all seats → muted |
| `h` | hand tracking (MediaPipe): point to lean the orb, pinch to grab a seat, swipe to flip symbols |
| `f` / `t` | fullscreen · TradingView embed |

Click a ring in Market Pulse to load that symbol on the Screens panel. Click a node on the
orb to hear who it is.

## Scripts

| command | |
| --- | --- |
| `npm start` | the desk (server + HUD) |
| `npm run dev` | same, with `--watch` |
| `npm test` | 29 tests: the gate, routing, guardrails, clocks |
| `npm run agent atlas` | run one specialist as its own service |
| `npm i -D electron && npm run desktop` | the desktop shell (global push-to-talk, mic/camera grants, kiosk) |

## Configuration

Copy `.env.example` → `.env`. Every key is optional; the desk degrades honestly without them.

| key | default | what it buys |
| --- | --- | --- |
| `FINNHUB_KEY` | — | real quotes/news; without it you get the labelled SIM feed |
| `ALLOW_SIM` | `1` | `0` = no simulated numbers at all → panels dash out |
| `QUOTE_POLL_MS` | `60000` | free tier allows ~60 calls/min across symbols |
| `ANTHROPIC_API_KEY` | — | model-routed, model-synthesized answers (a long-context reasoning model is what an orchestrator needs; Fable 5 recommended). Router + template synthesis work without it |
| `WHISPER_BIN` / `WHISPER_MODEL` | — | local speech-in instead of the browser's |
| `TTS_BRIDGE_URL` | — | local TTS (Kokoro/Voicebox) or an ElevenLabs shim |
| `TRADINGVIEW_MCP_URL` | — | chart takeover on your real TradingView |
| `ACCOUNT_EQUITY`, `MAX_RISK_PCT`, `MAX_POSITION_PCT`, `MAX_DAILY_LOSS_PCT` | `25000 · 1 · 10 · 3` | Sentinel's standing limits |
| `EXECUTION_MODE` | `paper` | the only accepted value in this build |

## Layout

```
server/
  master.js          routing, fan-out, gating, synthesis
  agents/            roster.js + nine seats (each: id, handle(ctx) → Report)
  data/              provider.js (no invented numbers), finnhub.js, sim.js, session.js, events.js
  store/             approvals.js (the gate), blotter.js (paper), journal.js, tasks.js
  charting/          mcp-bridge.js (the desk's hands on your charts)
public/              the HUD: orb.js, panels.js, voices.js, hands.js
app/                 Electron shell
docs/                ARCHITECTURE · ADD-AN-AGENT · VOICES · TRADINGVIEW-MCP · SAFETY · HUD-REFERENCE
test/                the rules that must not bend
data/                journal, blotter, keys — gitignored, plus example schemas
```

Start with two seats and the HUD; add the rest one at a time. Three agents is plenty for a
desk shaped to your own trading — the point is the architecture, not the number nine.

---

**Not financial advice.** This is a research and awareness co-pilot with a built-in risk
officer, not a money printer. It surfaces structure and context; it does not tell you what
happens next. Educational, grounded, and always do your own research.

MIT — see [docs/SAFETY.md](docs/SAFETY.md) before you ever point it at money.
