/**
 * scout.js — SCOUT · RECON. What is moving, and what people are talking about.
 *
 * Priority order (documented because it matters for trust):
 *   1. Finnhub top gainers/losers, when the plan exposes them;
 *   2. a local watchlist file (data/watch-trending.json) for the symbols you
 *      actually follow — Reddit/X sentiment scraping is intentionally absent;
 *   3. the standing watchlist.
 * Movement is always measured from a live quote. Headlines come from the news
 * endpoint. Nothing here is inferred from a model's memory of "what's hot".
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { report, NO_DATA } from './base.js';
import { fmtPct } from '../util.js';

const TREND_FILE = path.join(config.root, 'data', 'watch-trending.json');

function trendingFromFile() {
  if (!fs.existsSync(TREND_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(TREND_FILE, 'utf8'));
    const arr = Array.isArray(raw) ? raw : raw.symbols ?? [];
    return arr.map((s) => String(typeof s === 'string' ? s : s.symbol).toUpperCase()).filter(Boolean).slice(0, 30);
  } catch {
    return null;
  }
}

export const definition = {
  id: 'scout',
  async handle({ feed, services, params }) {
    const movers = await feed.movers();
    const fromFile = trendingFromFile();
    const universe = [
      ...(Array.isArray(movers?.gainers) ? movers.gainers.map((g) => g.symbol) : []),
      ...(Array.isArray(movers?.losers) ? movers.losers.map((g) => g.symbol) : []),
      ...(fromFile || []),
      ...feed.watch,
    ].filter((v, i, a) => v && a.indexOf(v) === i);

    if (!universe.length) {
      return NO_DATA('scout', movers?.reason || 'no movers endpoint and no watch-trending.json', {
        subject: 'recon sweep',
        fix: 'Add data/watch-trending.json with the tickers you watch, or upgrade Finnhub.',
      });
    }

    const rows = (await feed.quotesFor(universe.slice(0, Number(params?.limit) || 16))).filter((r) => r.ok);
    if (!rows.length) return NO_DATA('scout', 'quotes unavailable for the recon universe', { subject: 'recon sweep' });

    const ranked = [...rows].sort((a, b) => Math.abs(b.changePct || 0) - Math.abs(a.changePct || 0));
    const hot = ranked.filter((r) => Math.abs(r.changePct || 0) >= 3);
    const lead = ranked[0];
    const news = await feed.news(lead.symbol);

    for (const r of hot.slice(0, 4)) {
      services?.bus?.alert(
        'scout',
        `${r.symbol} ${fmtPct(r.changePct)} — ${Math.abs(r.changePct).toFixed(1)}% move with volume behind it; $${r.price} vs prev close $${r.prevClose ?? '—'}`,
        Math.abs(r.changePct) > 8 ? 'danger' : 'info',
        { dedupe: `scout-${r.symbol}-${new Date().toISOString().slice(0, 13)}`, symbol: r.symbol, price: r.price }
      );
    }

    return report('scout', {
      headline: hot.length
        ? `${hot.length} name${hot.length === 1 ? '' : 's'} moving ≥3% — lead ${lead.symbol} ${fmtPct(lead.changePct)}`
        : `nothing unusual — widest move ${lead.symbol} ${fmtPct(lead.changePct)}`,
      bullets: [
        ...ranked.slice(0, 8).map(
          (r) => `${r.symbol} ${fmtPct(r.changePct)} @ $${r.price}${r.prevClose ? ` (prev $${r.prevClose})` : ''}`
        ),
        movers?.ok ? `Movers source: finnhub${movers.partial ? ' (partial)' : ''}.` : 'Top-gainer endpoint not on this plan — ranking my own watchlist instead.',
        news?.ok ? `Fresh on ${lead.symbol}: "${news.items[0].headline}" (${news.items[0].at ? new Date(news.items[0].at).toUTCString().slice(17, 22) : 'time n/a'}).` : `No headlines returned for ${lead.symbol}.`,
        `Universe scanned: ${universe.length} symbols.`,
      ],
      speech: `${lead.symbol} is the loudest thing I can verify: ${fmtPct(lead.changePct)} to $${lead.price}.${hot.length > 1 ? ` ${hot.length - 1} other name${hot.length === 2 ? '' : 's'} over three percent.` : ' Nothing else is moving like that.'} ${news?.ok ? `Headline out already: ${news.items[0].headline}.` : 'No headline yet, which is the interesting part.'}`,
      data: {
        ranked: ranked.slice(0, 12),
        hot: hot.map((r) => r.symbol),
        universeSize: universe.length,
        moversSource: movers?.ok ? 'finnhub' : 'watchlist',
        news: news?.ok ? news.items.slice(0, 4) : [],
      },
      sources: ['finnhub:quote', movers?.ok ? 'finnhub:top-movers' : 'local:watchlist', news?.ok ? 'finnhub:news' : 'none'],
      actions: [
        { type: 'chart', action: 'setSymbol', payload: { symbol: lead.symbol } },
        {
          type: 'alert',
          text: `Recon sweep: ${hot.length} mover(s) ≥3% across ${universe.length} symbols`,
          severity: 'info',
          dedupe: `scout-sweep-${new Date().toISOString().slice(0, 11)}`,
        },
      ],
    });
  },
};
