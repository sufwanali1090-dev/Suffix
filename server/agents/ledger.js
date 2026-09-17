/**
 * ledger.js — LEDGER · THE BOOK. Every call gets written down; the bad ones
 * get re-read.
 *
 * Ledger is also the desk's health agent: it watches the journal, the feed,
 * the bridge and the blotter, and reports what is broken in plain language.
 * An orchestrator with no watchdog quietly runs on stale data for a week.
 */
import { config } from '../config.js';
import { report } from './base.js';
import { fmtUsd, round } from '../util.js';

export const definition = {
  id: 'ledger',
  async handle({ params, services, feed, session }) {
    const { journal, approvals, blotter, mcp, bus } = services;
    const ask = String(params?.ask || '').toLowerCase();

    if (ask === 'review' || params?.writeReview) {
      const stats = journal.stats();
      const vetoes = approvals.list().filter((p) => p.status === 'vetoed');
      const entries = journal.readRecent({ limit: 12 });
      const rec = journal.append({
        kind: 'command',
        agent: 'ledger',
        text: `session review · ${stats.total} entries · ${stats.counts.veto} vetoes · p95 ${stats.p95LatencyMs}ms`,
      });
      return report('ledger', {
        headline: `Review written to ${journal.path}`,
        bullets: [
          `${stats.total} journal entries in the last 30 days; ${entries.length} in the tail read now.`,
          vetoes.length ? `Vetoed today: ${vetoes.map((v) => `${v.symbol} (${v.stamp?.reason?.slice(0, 40)})`).join(', ')}` : 'No vetoes recorded today.',
          `Average agent latency ${stats.avgLatencyMs ?? '—'}ms; p95 ${stats.p95LatencyMs ?? '—'}ms.`,
          `At ${rec.at}, the book says: the desk is only as honest as this file.`,
        ],
        speech: `Review written. ${stats.total} entries on the books, ${stats.counts.veto} of them vetoes. Average specialist latency ${stats.avgLatencyMs ?? 'unknown'} milliseconds.`,
        data: { stats, rec },
      });
    }

    const stats = journal.stats();
    const book = blotter.list();
    const proposals = approvals.list({ limit: 25 });
    const feedHealth = feed.health();
    const bridge = mcp?.status?.() ?? { configured: false };
    const problems = [];
    if (!feedHealth.live) problems.push('quotes are simulated — every panel wears a SIM badge');
    if (feedHealth.pollErrors > 0) problems.push(`${feedHealth.pollErrors} consecutive poll failures: ${feedHealth.lastError || 'cause unknown'}`);
    if (!bridge.configured) problems.push('no TradingView bridge — the desk draws on its own chart only');
    if (stats.counts.error > 0) problems.push(`${stats.counts.error} agent error entr${stats.counts.error === 1 ? 'y' : 'ies'} in the window`);
    if (session?.phase === 'closed' && !session.holiday) problems.push('outside RTH: quotes may be stale between sessions');

    const byAgent = new Map(stats.perAgent.map((r) => [r.agent, r]));
    const loadRows = (config.allowSim ? [] : []).concat(
      stats.perAgent.map((r) => ({ agent: r.agent, calls: r.calls, avgMs: r.avgMs, errors: r.errors }))
    );

    return report('ledger', {
      headline: `${stats.total} entries · ${stats.counts.veto} veto${stats.counts.veto === 1 ? '' : 's'} · ${stats.counts.execution} fill${stats.counts.execution === 1 ? '' : 's'} · ${problems.length ? problems.length + ' data caveat' + (problems.length === 1 ? '' : 's') : 'all feeds clean'}`,
      bullets: [
        `Kinds: ${Object.entries(stats.counts).map(([k, v]) => `${k} ${v}`).join(' · ')}.`,
        `PnL (paper): realised ${fmtUsd(book.exposure.realisedPnl)} on equity ${fmtUsd(book.equity)} (start ${fmtUsd(book.startEquity)}); ${book.exposure.openPositions} open position(s), ${fmtUsd(book.atRisk)} at risk to stops.`,
        proposals.length
          ? `Latest tickets: ${proosals.slice(0, 4).map((p) => `${p.symbol} ${p.status}${p.stamp && !p.stamp.approved ? '(refused)' : ''}`).join(' · ')}.`
          : 'No trade tickets yet today.',
        `Specialist load: ${loadRows.slice(0, 5).map((r) => `${r.agent} ${r.calls}×/${r.avgMs}ms${r.errors ? `(${r.errors} err)` : ''}`).join(' · ') || '—'}.`,
        problems.length ? `Caveats on the record — ${problems.join('; ')}.` : 'Caveats on the record: none. Every number read today came from a live feed.',
      ],
      speech: `The book: ${stats.total} entries, ${stats.counts.veto} veto${stats.counts.veto === 1 ? '' : 'es'}, ${stats.counts.execution} fill${stats.counts.execution === 1 ? '' : 's'}. Paper equity ${fmtUsd(book.equity)}. ${problems.length ? `Two things you should know: ${problems[0]}${problems[1] ? `, and ${problems[1]}` : ''}.` : 'Every number is from a live feed today.'}`,
      data: {
        stats,
        blotter: book,
        proposals: proposals.map((p) => ({ id: p.id, symbol: p.symbol, side: p.side, qty: p.qty, status: p.status, reason: p.stamp?.reason ?? null })),
        problems,
        feed: feedHealth,
        bridge,
        byAgent: Object.fromEntries([...byAgent.entries()].map(([k, v]) => [k, v.calls])),
      },
      sources: ['journal', 'blotter', 'approvals'],
      actions: problems.length
        ? [{ type: 'alert', text: `Desk health: ${problems[0]}`, severity: 'warn', dedupe: 'ledger-health' }]
        : [],
    });
  },
};
