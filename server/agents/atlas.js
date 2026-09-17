/**
 * atlas.js — ATLAS · MACRO. The tide everything else floats on.
 *
 * Honest scope: with a free Finnhub key there is no rates feed here. So Atlas
 * reports what it can actually verify — session phase, event risk from the
 * calendar, and the tape's own weather (breadth + dispersion across the
 * watchlist) — and says out loud which macro inputs are missing.
 */
import { report, NO_DATA } from './base.js';
import { fmtPct, round } from '../util.js';

export const definition = {
  id: 'atlas',
  async handle({ feed, session, nextEvent, services }) {
    const rows = await feed.quotesFor(feed.watch.slice(0, 6));
    const live = rows.filter((r) => r.ok);
    if (!live.length) {
      return NO_DATA('atlas', rows[0]?.reason || 'no quotes', {
        subject: 'macro read',
        fix: 'With a live tape I can at least call breadth — paste FINNHUB_KEY.',
      });
    }
    const ups = live.filter((r) => r.changePct > 0).length;
    const breadth = round((ups / live.length) * 100, 0);
    const avgMove = round(live.reduce((s, r) => s + Math.abs(r.changePct || 0), 0) / live.length, 2);
    const dispersion = round(Math.max(...live.map((r) => r.changePct || 0)) - Math.min(...live.map((r) => r.changePct || 0)), 2);
    const spy = live.find((r) => r.symbol === 'SPY');
    const leader = [...live].sort((a, b) => (b.changePct || 0) - (a.changePct || 0))[0];
    const laggard = [...live].sort((a, b) => (a.changePct || 0) - (b.changePct || 0))[0];

    const regime =
      dispersion > 8 ? 'rotation — names pulling opposite ways'
      : breadth >= 66 && avgMove < 2.2 ? 'risk-on, orderly'
      : breadth <= 33 ? 'defensive — breadth narrow'
      : 'two-way tape, no clear tide';

    const weather = `${session?.label ?? 'Session'} · ${ups}/${live.length} up · dispersion ${dispersion.toFixed(2)} pts`;
    const bullets = [
      `Breadth on the watched tape: ${ups}/${live.length} up (${breadth}%). Average move ${avgMove.toFixed(2)}%.`,
      `Weather: ${regime}.`,
      spy?.ok ? `SPY ${fmtPct(spy.changePct)} — the index itself is the tide.` : 'SPY unavailable — index read shows "—".',
      `Fastest: ${leader.symbol} ${fmtPct(leader.changePct)} · Slowest: ${laggard.symbol} ${fmtPct(laggard.changePct)}.`,
      nextEvent
        ? `Event risk: ${nextEvent.label} on ${nextEvent.date} — ${nextEvent.daysAway} day${nextEvent.daysAway === 1 ? '' : 's'} out${nextEvent.imminent ? ', so size is the decision, not the idea.' : '.'}`
        : 'No FOMC/expiry inside the calendar window.',
      'Missing inputs (not fetched on this tier): fed funds path, 2s10s, CPI prints, DXY, VIX term structure.',
    ];

    const speech = [
      `Macro: ${regime}. ${ups} of ${live.length} names on the screen green.`,
      spy?.ok ? `SPY ${fmtPct(spy.changePct)}.` : 'Index read unavailable, so I will not guess it.',
      nextEvent?.imminent ? `Careful — ${nextEvent.label} in ${nextEvent.daysAway} day${nextEvent.daysAway === 1 ? '' : 's'}.` : '',
      'I have no rates feed on this tier, so that part shows as dashes.',
    ]
      .filter(Boolean)
      .join(' ');

    if (nextEvent?.imminent) {
      services?.bus?.alert('atlas', `Event risk: ${nextEvent.label} in ${nextEvent.daysAway}d — halve size into the print`, 'warn', {
        dedupe: `atlas-event-${nextEvent.date}`,
      });
    }

    return report('atlas', {
      headline: `${regime} · ${ups}/${live.length} up${nextEvent?.imminent ? ` · ${nextEvent.label} in ${nextEvent.daysAway}d` : ''}`,
      bullets,
      speech,
      data: {
        breadth,
        ups,
        downs: live.length - ups,
        avgMovePct: avgMove,
        dispersionPct: dispersion,
        regime,
        spyChangePct: spy?.ok ? spy.changePct : null,
        fastest: leader.symbol,
        slowest: laggard.symbol,
        event: nextEvent,
        session: session?.label ?? null,
        simulated: Boolean(feed.active.sim),
      },
      sources: live.map((r) => `finnhub:${r.symbol}`).slice(0, 3),
      actions: [
        {
          type: 'alert',
          text: `Macro weather: ${regime} (${ups}/${live.length} up)`,
          severity: breadth >= 66 || breadth <= 33 ? 'info' : 'info',
          dedupe: `atlas-breadth-${new Date().toISOString().slice(0, 13)}`,
        },
      ],
    });
  },
};
