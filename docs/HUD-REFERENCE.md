# HUD reference — the screenshot you hand to Claude Code

The page says: *save the screenshot, drag it into your prompt, ask Claude Code to match the
layout, the glow and the panels.* Here the screenshot is a command, because the HUD in this
repo **is** the reference.

## 1. Get the shot

```bash
npm start                       # desk on http://localhost:8787
# then, with any headless Chrome:
chrome --headless --window-size=1600,960 --screenshot=hud.png http://localhost:8787
# or just press ⌘/Ctrl+Shift+4 (or Win+Shift+S) on the running window
```

Capture it **mid-session**, not on boot: send one command first so the orb is lit, the task
queue has rows, the signal log has alerts and Screens has levels drawn. A dead HUD screenshots
like a template; a working one screenshots like a desk.

```bash
curl -s -X POST localhost:8787/api/command -H 'content-type: application/json' \
  -d '{"text":"give me a briefing"}' > /dev/null
curl -s -X POST localhost:8787/api/command -H 'content-type: application/json' \
  -d '{"text":"pull up NVDA and mark the levels"}' > /dev/null
curl -s -X POST localhost:8787/api/command -H 'content-type: application/json' \
  -d '{"text":"buy 200 shares of NVDA"}' > /dev/null     # puts a ticket in The Gate
```

## 2. The layout, named

| region | what it shows | where it comes from |
| --- | --- | --- |
| header | feed badge (LIVE / SIM / NO FEED), NYSE phase, gate key fingerprint, reasoning layer, ET clock | `/api/desk`, `session` SSE |
| left · Market pulse | six rings, one per watched symbol; arc = |%| vs prev close, green/red; dead feed = `—` | `quotes` SSE ← Finnhub (or SIM) |
| left · Task queue | the master's routing decisions: command → which seats → how long | `task` SSE ← `store/tasks.js` |
| left · Signal log | agent alerts, colour-coded by severity, oldest at the bottom | `alert` SSE ← any seat |
| centre · the orb | one light source: listening / routing / speaking / veto; nine seats on the ring, connector arcs light as work travels | `public/js/orb.js` |
| centre · reply | the master's spoken answer + the one number to look at (the "card") | `reply` SSE ← `master.js` |
| centre · Screens | the desk chart the technician drives: series, level lines, forecast band, fill markers | `chart.action` SSE |
| right · Market session | real NYSE phase + live countdown to the next boundary | `data/session.js` |
| right · Calendar | month grid; dots mark FOMC and options expiry | `data/events.js` |
| right · Agent load | calls and latency per seat; dot colour = that seat's state | `agent.load` SSE ← `registry.load` |
| right · The Gate | the ticket lifecycle: drafted → pending → stamped → confirmed → executed, plus the signature it verified | `store/approvals.js` |
| bottom | talk button, the command bar, quick chips | `public/js/app.js` |

Three things worth copying on purpose:

* the **orb carries state, not decoration** — it pulses on the voice's own amplitude, and
  particles travel orb→seat while work is delegated;
* every number on screen has a source, and the **SIM badge rides with the data** into each
  panel rather than living in a disclaimer at the bottom;
* **the veto is a first-class UI element**. A desk that can only ever say "yes" is a
  recommendation engine with a voice.

## 3. The prompt to paste into Claude Code

Attach `hud.png` and send:

```text
Here's a screenshot of the F.R.I.D.A.Y. trading desk HUD (attached).
Use it as the visual reference for my desk's HUD:
- same layout: left column (market pulse, task queue, signal log),
  a glowing central orb with my agent nodes around it,
  right column (market session, calendar, agent load)
- wire the market panels to REAL data: Finnhub quotes for the pulse rings,
  the live NYSE session + countdown, my event calendar
- the signal log streams alerts from MY sub-agents: [list your agents]
- never show invented numbers on a market panel — if a feed is down, show "—"
Build the static HUD first, then wire one panel at a time.
```

Then the follow-ups that actually move the needle, in this order:

```text
1. Match the light source: one gold orb, one hue per agent, everything else below 6% white.
   No gradients on cards, no drop shadows except glow.
2. Add the em-dash rule everywhere: a shared fmt.price(null) → "—", never 0, never a stale value.
3. Make the orb a state machine (idle/listening/thinking/speaking/veto) and drive its radius
   from the TTS analyser, not from a CSS animation.
4. Give me a "Gate" panel: proposal → risk stamp → my confirm → fill, with the execute button
   absent until a stamp exists.
```

## 4. If you want the marketing page too

The page this repo implements lives at `cloud9markets.com/nimbus-desk.html`. This section is
the repo-side half of it: the blueprint, the rules and the free parts list. Keep the page a
page — this folder is the thing you run.
