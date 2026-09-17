# Adding a tenth agent (10 minutes, 2 files)

The desk was built so this is a config change, not a refactor. Three copies of the same
pattern are already in `server/agents/` — steal the smallest one (`atlas.js`).

## 1. Write the service

`server/agents/vix.js`:

```js
/**
 * vol.js — VOL · THE FEAR GAUGE. A brand-new seat, in one file.
 * Reads realised vol off the tape and says what fear costs today.
 */
import { report, NO_DATA, stats } from './base.js';
import { round } from '../util.js';

export const definition = {
  id: 'vol',
  async handle({ symbol, feed }) {
    const hist = await feed.history(symbol || 'SPY', { days: 90 });
    if (!hist.ok) return NO_DATA('vol', hist.reason, { subject: 'a vol read' });
    const sigma = stats.stdev(stats.returns(hist.closes));
    const ann = round(sigma * Math.sqrt(252) * 100, 2);
    return report('vol', {
      headline: `${symbol ?? 'SPY'} realised vol ${ann}% (daily σ ${round(sigma * 100, 2)}%)`,
      bullets: [`From ${hist.closes.length} bars, ${hist.source}.`],
      speech: `Realised vol on ${symbol ?? 'SPY'} is ${ann} percent annualised. That is the number fear should be priced against.`,
      data: { annualisedPct: ann, sigma },
      sources: [`${hist.source}:candles`],
    });
  },
};
```

Rules a seat must keep:

* **return a Report, never throw** — `base.js#instrument` turns a throw into an error
  report, but "no data" is your call to make: `NO_DATA(...)`, not a guess;
* **no state hoarding** — take what you need from `ctx.feed` / `ctx.reports`;
* **no side effects beyond `actions[]`** — chart moves, alerts, and (for Pilot only)
  the blotter;
* **never mint a number** — if the feed is down, your answer is a dash and a reason.

## 2. Register it

`server/agents/roster.js` — one entry (the HUD, the router, the voice layer and the load
panel all read this table, so nothing else needs to change):

```js
{
  id: 'vol', name: 'VOL', title: 'FEAR GAUGE', group: 'analysis', seat: 10,
  hue: 320, glyph: '⚡',
  voice: { voiceHint: 'Kathy', pitch: 1.32, rate: 1.14, lang: 'en-US' },
  tagline: 'Prices fear from realised vol, so you know what panic costs.',
  keywords: ['vol', 'vix', 'fear', 'implied', 'sigma'],
  remote: null,
}
```

## 3. Teach the master about it

Two ways, both declarative:

* `keywords` on the roster entry (used by `llm.js` when a model is doing the routing);
* an `INTENTS` row in `server/master.js` for the deterministic router:

```js
{ id: 'vol', re: /\b(vol|vix|fear|sigma|implied (vol|vix))\b/i, agents: ['vol'] },
```

Put it above the `risk` row if "vol" should mean the gauge, below it if it should mean
position sizing. Routing precedence is deliberate, so say what you mean.

## 4. Decide what it may touch

`server/index.js` builds every seat through `buildAgents(services)`; the seat's `ctx.services`
is whatever the wiring hands it. Analysis seats get `bus` and `journal`. Only `sentinel`
gets `keys.privatePem`, only `pilot` and `sentinel` get `approvals`/`blotter`. A new seat
that asks for those gets `null` and should fail loudly (that's `NO_DATA`, not a fallback).

## 5. Run it out of process (optional)

```bash
node server/agent-service.js vol --port 8810
# roster.js →  { id: 'vol', …, remote: 'http://127.0.0.1:8810' }
node server/index.js
```

Ask it directly while you develop, without the master in the loop:

```bash
curl -s localhost:8810/invoke -H 'content-type: application/json' \
  -d '{"ctx":{"symbol":"SPY","text":"how expensive is fear","params":{}}}' | jq .report.headline
```

If `/api/command "what is implied vol doing"` answers in VOL's voice and the seat lights
up on the orb, you are done: the other nine seats never changed.

## Adding an agent that *moves money*

Don't. Add an analysis seat that produces a proposal-shaped report and let Pilot draft it:

```js
return report('vol', {
  data: { … },
  actions: [{ type: 'route', to: 'pilot', params: { symbol: 'SPY', side: 'buy' } }],
});
```

The proposal still has to walk: `pending → stamped (Sentinel's signature) → confirmed
(you) → executed`. That path is one file (`store/approvals.js`) and it is the reason this
desk is safe to leave running.
