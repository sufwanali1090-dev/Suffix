# Architecture — one master, nine specialists

```
                        ┌──────────────────────────────────────────────┐
   🎙️ your voice        │                 THE DESK                     │
   ─────────────────────►│                                              │
   ⌨️  typed command     │   F.R.I.D.A.Y.  (master)                     │
   🖐️  hand gesture       │   hear → route → delegate → gate → synthesize │
                        └───────┬──────────────────────────────┬───────┘
                                │ POST /api/command            │ SSE /api/stream
                                ▼                              ▼
        ┌───────────────────────────────┐        ┌────────────────────────────┐
        │  INTELLIGENCE  what's happening│        │  the HUD (public/)         │
        │  ATLAS  macro / rates / weather│        │  orb · pulse · queue · log │
        │  CAPITOL congress/insider file │        │  session · calendar · load │
        │  SCOUT  viral / movers / news  │        │  screens · the gate        │
        └───────────────┬───────────────┘        └────────────▲───────────────┘
                        │ handle(ctx) → Report                  │ chart.action
        ┌───────────────▼───────────────┐                       │
        │  ANALYSIS  what it's worth    │───────────────────────┘
        │  ATHENA   structure, levels   │
        │  CHARTIST drives the screens  │────► TradingView MCP bridge (optional)
        │  ORACLE   probabilities only  │
        └───────────────┬───────────────┘
                        │ proposal
        ┌───────────────▼───────────────┐
        │  EXECUTION  where money moves │
        │  SENTINEL sizes + signs  ✍️    │──► ed25519 stamp over the digest
        │  PILOT    executes, gated     │──► paper blotter (data/blotter/)
        │  LEDGER   journals everything │──► data/journal/YYYY-MM-DD.jsonl
        └───────────────────────────────┘
```

## The four rules, and where each one actually lives

| Rule | Where it is enforced | What happens if you break it |
| --- | --- | --- |
| Claude writes the desk | `package.json` has no runtime dependencies | nothing breaks — the desk is plain Node + the DOM |
| One master, many specialists | `server/agents/roster.js` + `server/agents/registry.js`; the browser has exactly one write path (`POST /api/command`) | a panel that fetches its own data is the beginning of two sources of truth; there is no such path |
| The charts are part of the desk | `server/agents/chartist.js` returns `actions[]`; `server/charting/mcp-bridge.js` forwards them to your real TradingView | if the bridge is off, the report says "only the desk chart moved" instead of pretending |
| The one rule that makes it safe | `server/store/approvals.js` verifies an **Ed25519 signature** produced by a key only Sentinel receives | Pilot's execution path returns `{ok:false, requires:'SENTINEL_STAMP'}`; there is no other write to the blotter |

Rule four is the interesting one. It is not a `if (!approved) return` guarded by the same
object that wants to trade. Sentinel holds `data/keys/sentinel_ed25519_private.pem`
(`server/keys.js`); everyone else gets only the public half, which can verify and cannot
forge. `Master.servicesFor(id)` is the single line that scopes it, and it is the line to
read when someone asks "but can't the orchestrator just approve its own trade?" — no: it
never sees the private key, and neither does Pilot.

## Request lifecycle (one spoken command, ~1 file each)

1. **mic / keyboard** → `public/js/voices.js` (Web Speech or whisper.cpp) → `send()` in `public/js/app.js`.
2. **`POST /api/command`** → `server/index.js` → `Master.handleCommand()` (`server/master.js`).
3. **route** — `Master.route()` matches intents deterministically (keyword tables live in the roster), and only if `ANTHROPIC_API_KEY` exists does `server/llm.js` refine the routing. Same result shape either way.
4. **delegate** — seats run in dependency order (`atlas → capitol → scout → athena → oracle → chartist → pilot → sentinel → ledger`) because analysis has to reach the screen before the screen can be drawn, and a draft has to exist before a stamp can be requested. Each seat receives a narrow `ctx`: text, symbol, params, the reports already gathered, `feed`, `session`, `nextEvent`, and only its own capabilities.
5. **chain** — an agent may return `actions:[{type:'route', to:'sentinel', params:{proposalId}}]`. Pilot does this after drafting; the master follows it. Agents never call each other directly, so the graph stays a tree rooted at the master.
6. **gate** — nothing else can move money. `blotter.submit()` is only reachable from Pilot, and only after `approvals.claimForExecution()` verifies the stamp and consumes it.
7. **synthesize** — the master composes one spoken answer from what the seats reported (`composeSpeech`), or the model does it with an explicit "no invented numbers" system prompt. `null` figures stay `null` and render as `—`.
8. **speak + paint** — `reply` and `chart.action` events land on the SSE stream; `public/js/panels.js` paints, `public/js/orb.js` animates, `voices.js` reads it out in each seat's own voice.
9. **journal** — every command, report, veto and fill is one JSON line in `data/journal/`. `GET /api/journal` is the audit trail.

## Agents are services (when you want them to be)

Every seat is an ordinary module exporting `definition = { id, handle(ctx) }`.
`server/agent-service.js` boots any of them on its own port:

```bash
node server/agent-service.js oracle --port 8806
```

then in `roster.js`:

```js
{ id: 'oracle', …, remote: 'http://127.0.0.1:8806' }
```

`registry.js` serialises the context, POSTs to `/invoke`, and reads back the same
`Report`. A tenth agent therefore changes two files, and the other nine are untouched —
which is the point of rule two.

Two seats refuse to go remote: `sentinel` and `pilot` (`agent-service.js` exits 3, and
`registry.call` ignores a `remote:` override for them). The money path needs the approval
ledger and the private key, and those live in the master process on purpose. A risk
officer that runs wherever the money runs is not a risk officer.

## Data integrity rules

* **One provider at a time** (`server/data/provider.js`): Finnhub live, or the labelled sim. Never both, never blended into one panel.
* **No number without a source.** `DeskFeed.quote()` returns `{ok:false, reason}` on any failure; the HUD renders `—`. `0` is never used as a placeholder.
* **`source` travels with every payload** and the SIM badge follows it (`panels.setFeedBadge`). A demo number is never presented as a market number.
* **The quant cannot promise.** `oracle.js` runs every forecast string through `hedge()`, which rewrites "will / definitely / guaranteed" into probabilities. Tested in `test/desk.test.js`.
* **Fundamentals/history that the free plan does not expose report themselves as missing**, rather than being quietly dropped — see the "Missing inputs" bullet in `atlas.js`.

## HTTP surface

| | |
| --- | --- |
| `GET /api/desk` | everything the HUD paints on first frame (roster, feed health, session, calendar, tasks, approvals, blotter, journal stats, bridge status) |
| `POST /api/command` | the only way the HUD asks for thought |
| `GET /api/stream` | SSE: `quotes · session · calendar · alert · command · routing · task · agent.state · agent.report · agent.load · reply · chart.action · speak · trade.*` |
| `GET /api/quote?symbol=` `GET /api/history?symbol=` `GET /api/quotes` | raw panels (and the shape for a screenshot comparison) |
| `POST /api/approvals` `/approvals/stamp` `/approvals/confirm` `/approvals/execute` | the gate, one step per call — UI buttons and voice both end up here |
| `POST /api/chart` | operator-driven chart command, same sink as Chartist's |
| `POST /api/mic` | base64 audio → whisper.cpp → text |
| `GET /api/tts?text=&voice=` | passthrough to your local TTS bridge (Kokoro/Voicebox/ElevenLabs shim) |
| `GET /api/journal` `GET /api/positions` `GET /api/approvals` `GET /api/bridge` `GET /healthz` | audit + status |

## Directory map

```
server/
  index.js            process, HTTP, SSE, tickers, boot banner
  master.js           routing + fan-out + synthesis (F.R.I.D.A.Y.)
  llm.js              optional model layer: route + compose, never compute
  keys.js             ed25519 pair: private half → Sentinel only
  bus.js              event bus → SSE, with a replay ring
  agents/
    roster.js         THE TABLE: names, seats, hues, voices, keywords, remote flags
    base.js           Report contract, instrument(), stats (SMA/EMA/ATR/swing levels/Monte-Carlo)
    atlas|capitol|scout|athena|chartist|oracle|sentinel|pilot|ledger.js
  data/
    provider.js       cache + health + the no-invented-numbers rule
    finnhub.js        live quotes / news / movers / candles
    sim.js            labelled synthetic feed for demos and tests
    session.js        NYSE phase + countdown from America/New_York
    events.js         FOMC + computed OpEx for the calendar dots
  store/
    approvals.js      the gate: pending → stamped → confirmed → executed
    blotter.js        paper fills (the only "execution" that exists)
    journal.js        JSONL per day + desk health
    tasks.js          the task queue panel
  charting/mcp-bridge.js  {action,payload} → your TradingView
public/               the HUD (orb, panels, voices, hands)
app/                  Electron shell (~100 lines)
test/                 28 tests: the gate, routing, guardrails, clocks
docs/                 this file, ADD-AN-AGENT, VOICES, TRADINGVIEW-MCP, SAFETY
```
