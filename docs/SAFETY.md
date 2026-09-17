# Safety model — read this before you let it talk back

## What this is

A research and awareness co-pilot with a risk officer built into its architecture. It
surfaces structure and context in language you can hear while your eyes stay on the tape.

## What this is not

* **Not a money printer.** It does not tell you what happens next. The only agent that
  produces forward-looking numbers (ORACLE) is contractually barred from promising —
  `oracle.js#hedge()` rewrites "will / definitely / guaranteed" into probabilities, and
  `test/desk.test.js` fails if that ever stops being true.
* **Not an auto-trader.** There is no broker adapter in this codebase. `EXECUTION_MODE=live`
  is not a disabled feature, it is an absent one, and `store/blotter.js` refuses anything but
  `paper`. Fills are written to `data/blotter/positions.json` and nowhere else on Earth.
* **Not a source of prices.** Every number originates in `server/data/`. If the feed is
  down, panels render `—` and the agents say the feed is down.

## The four invariants

1. **Nothing is invented.** `DeskFeed` returns `{ok:false, reason}` on failure. The HUD has no
   `0`/last-value fallback: `fmt.price(null) === '—'`. A dash is a claim about the world; a
   plausible number is a claim about your account.
2. **Analysis cannot execute.** Athena, Atlas, Scout, Capitol, Chartist, Oracle and Ledger
   receive no `approvals`, no `blotter`, no signing key — see `Master.servicesFor`. Their
   worst possible action is an alert.
3. **Execution cannot self-authorize.** Pilot's only route to a fill runs through
   `approvals.claimForExecution()`, which requires a stamp that verifies against Sentinel's
   Ed25519 **public** key. Pilot was never given the private half. This is arithmetic, not
   policy.
4. **The risk officer can always say no.** Sentinel's checklist can only shrink or kill a
   trade: no verified price → veto; outside RTH → half size; FOMC/expiry within 2 days → half
   size; heat over budget → shrink to fit; daily stop breached → veto for the day; SIM-priced
   ticket → stamped with the data caveat written into the stamp itself.

A fifth one, cheap to enforce and worth having: **the stamp is single-use.**
`claimForExecution` consumes it, so a replayed request cannot fund a second trade (tested).

## Human-in-the-loop, specifically

Two keys turn, and neither is the desk's:

```
proposal (Pilot drafts) → stamp (Sentinel signs) → confirm (you say "confirm" or click) → fill
```

The UI cannot skip step 2 — the "confirm & execute" button only exists when
`status === 'stamped'`. The voice cannot skip step 3 — "do it" without a stamp returns
`blocked`, with the reason read aloud. And Sentinel's veto does not ask you to override it;
the ticket is dead and it is journaled as dead.

## What happens when things break

| failure | desk behaviour |
| --- | --- |
| Finnhub key missing | labelled SIM feed + a banner on every panel; nothing is presented as market data |
| `ALLOW_SIM=0` with no key | every market panel shows `—`; agents refuse to answer numerically |
| feed dies mid-session | `pollErrors` increments, an alert lands in the signal log, panels dash out |
| history endpoint not on your plan | Athena says it cannot call structure; Chartist switches the screen and draws **no** lines |
| TTS/STT unavailable | captions only; `—` in the voice label. The desk stays fully operable by keyboard |
| TradingView bridge down | the desk chart takes the levels and the report says only the desk chart moved |
| agent throws | `instrument()` converts it to an error report; the master reports the seat as offline; nothing else in the desk notices |
| journal unwritable | `journal.js` logs to stderr loudly — a desk that can't keep its book should not keep trading |

## Before anyone gets near real money

None of this is a switch you flip; each line is a new system to test:

* [ ] a broker adapter, behind the **same** `claimForExecution` gate, with its own kill switch;
* [ ] idempotency keys per order at the broker, not just per stamp here;
* [ ] a hard daily loss cap enforced *outside* this process (a second account rule the desk
      cannot read, let alone rewrite);
* [ ] order-level audit (OMS/broker timestamps) alongside the JSONL journal;
* [ ] a "no data → no voice" lockdown: if the feed is stale, the desk goes silent;
* [ ] review of every journaled veto for a month before you allow a single stamped ticket;
* [ ] your broker's terms, and your jurisdiction's rules on automation. Algorithmic order
      flow usually needs to be disclosed to the broker, sometimes to the exchange.

## Not financial advice

Educational. Grounded in feeds you can audit. The desk is a mirror for your own process —
its most valuable output is the journal, because that is the part that remembers your bad
calls. Always do your own research. Cloud9 builds tools, not trades.
