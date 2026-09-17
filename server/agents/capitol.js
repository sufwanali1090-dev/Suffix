/**
 * capitol.js — CAPITOL · SMART MONEY.
 *
 * Looks for filings the tape hasn't digested: local drops (data/smart-money.json
 * — any CSV/JSON export of congressional, insider or 13F filings you like) and,
 * when the plan allows, Finnhub's insider endpoint.
 *
 * This agent is intentionally unable to "recall" trades from a model. If the
 * file and the endpoint are both empty it returns no-data, because a smart-money
 * agent that improvises is just a rumour agent with a better voice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { report, NO_DATA } from './base.js';
import { round } from '../util.js';

const SOURCE_FILE = path.join(config.root, 'data', 'smart-money.json');

function readLocalDrops() {
  if (!fs.existsSync(SOURCE_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8'));
    const rows = Array.isArray(raw) ? raw : raw.filings ?? [];
    return rows.map((r) => ({
      ticker: String(r.ticker || r.symbol || '').toUpperCase(),
      person: r.person || r.name || 'unnamed',
      party: r.party || null,
      chamber: r.chamber || null,
      action: (r.transaction || r.action || 'buy').toString().toLowerCase(),
      amount: r.amount_range_us ?? r.amount ?? null,
      tradeDate: r.transaction_date || r.tradeDate || null,
      disclosedAt: r.filed_date || r.disclosedAt || null,
      source: r.source || 'local drop',
    }));
  } catch (err) {
    return { error: `data/smart-money.json unreadable: ${err.message}` };
  }
}

function midpoint(amount) {
  if (typeof amount === 'number') return amount;
  const m = String(amount ?? '').match(/(\d[\d,]*)\s*(?:-|to)\s*(\d[\d,]*)/);
  if (!m) return null;
  const lo = Number(m[1].replace(/,/g, ''));
  const hi = Number(m[2].replace(/,/g, ''));
  return (lo + hi) / 2;
}

export const definition = {
  id: 'capitol',
  async handle({ symbol, feed }) {
    const local = readLocalDrops();
    let rows = [];
    let note = null;

    if (Array.isArray(local)) rows = local;
    else if (local?.error) note = local.error;

    if (!rows.length && feed.active.get) {
      const insider = await feed.active.get?.('/stock/insider-transactions', { symbol, limit: 20 }).catch(() => null);
      if (insider?.ok) {
        rows = (insider.data?.data ?? [])
          .filter((t) => t?.symbol === symbol)
          .slice(0, 10)
          .map((t) => ({
            ticker: t.symbol,
            person: t.name || 'insider',
            action: Number(t.change) > 0 ? 'buy' : Number(t.change) < 0 ? 'sell' : 'other',
            amount: t.transactionPrice ? round(Number(t.change) * Number(t.transactionPrice), 0) : null,
            tradeDate: t.transactionDate,
            source: 'finnhub insider',
          }));
      } else {
        note = `insider endpoint unavailable (${insider?.reason ?? 'not on this plan'})`;
      }
    }

    if (!rows.length) {
      return {
        ...NO_DATA('capitol', note || 'no filings source configured', {
          subject: 'smart-money read',
          fix: 'Drop a data/smart-money.json export in, or upgrade the data plan.',
        }),
        actions: [{ type: 'alert', text: 'CAPITOL idle: no filings source wired', severity: 'warn', dedupe: 'capitol-no-source' }],
        data: { howToFix: 'data/smart-money.json → [{ ticker, person, transaction, amount_range_us, transaction_date }]' },
      };
    }

    const focus = symbol ? String(symbol).toUpperCase() : null;
    const filtered = focus ? rows.filter((r) => r.ticker === focus) : rows;
    const pool = (filtered.length ? filtered : rows).slice(0, 12);
    const buys = pool.filter((r) => String(r.action).includes('buy'));
    const sells = pool.filter((r) => String(r.action).includes('sell'));
    const notional = pool.reduce((s, r) => s + (midpoint(r.amount) || 0), 0);
    const byTicker = new Map();
    for (const r of pool) {
      const row = byTicker.get(r.ticker) || { ticker: r.ticker, buys: 0, sells: 0, usd: 0, names: new Set() };
      if (String(r.action).includes('buy')) row.buys += 1;
      if (String(r.action).includes('sell')) row.sells += 1;
      row.usd += midpoint(r.amount) || 0;
      if (r.person) row.names.add(r.person);
      byTicker.set(r.ticker, row);
    }
    const ranked = [...byTicker.values()]
      .map((r) => ({ ...r, names: [...r.names].slice(0, 3), net: r.buys - r.sells }))
      .sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd));
    const top = ranked[0];

    const quote = top ? await feed.quote(top.ticker) : null;
    const tapeLine =
      top && quote?.ok
        ? ` ${top.ticker} is ${quote.changePct > 0 ? 'up' : 'down'} ${Math.abs(quote.changePct).toFixed(2)}% today at $${quote.price}, so the filing is partly in the price.`
        : '';

    return report('capitol', {
      headline: focus
        ? `${pool.length} filing${pool.length === 1 ? '' : 's'} on ${focus} — ${buys.length} buy${buys.length === 1 ? '' : 's'}, ${sells.length} sell${sells.length === 1 ? '' : 's'}`
        : `${pool.length} filings tracked · heaviest: ${top?.ticker} ($${(top?.usd || 0).toLocaleString('en-US')})`,
      bullets: [
        ...ranked.slice(0, 5).map(
          (r) =>
            `${r.ticker} · ${r.buys} buy / ${r.sells} sell · ~$${Math.round(r.usd).toLocaleString('en-US')}${r.names.length ? ` (${r.names.join(', ')})` : ''}`
        ),
        notional ? `Aggregate disclosed notional in view: $${Math.round(notional).toLocaleString('en-US')}.` : null,
        `Disclosure lag is the edge and the trap: filings appear days after the trade.${tapeLine}`,
        note ? `Caveat: ${note}.` : null,
      ].filter(Boolean),
      speech: `${focus ? `${pool.length} filings on ${focus}: ${buys.length} buys, ${sells.length} sells.` : `Heaviest disclosed cluster is ${top?.ticker}.`} Disclosure lag is the whole point — quiet accumulation, not confirmation.${tapeLine}`,
      data: { rows: pool, ranked: ranked.slice(0, 8), lagNote: 'disclosure is 30-45 days behind execution' },
      sources: [`local:${path.relative(config.root, SOURCE_FILE)}`],
      actions: top
        ? [{ type: 'chart', action: 'annotate', payload: { symbol: top.ticker, note: `smart-money cluster: ${top.buys} buys` } }]
        : [],
    });
  },
};
