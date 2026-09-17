/**
 * sim.js — a LABELED synthetic feed for demos, screenshots and tests.
 *
 * It exists so the HUD can be exercised with no API key. It is never silently
 * mixed into "real" output: every payload carries source:'sim', the HUD wears a
 * SIM badge over every panel that reads it, and the journal records it. If you
 * ever use these numbers to make a decision, that is the feed's fault and not
 * the desk's — which is why live mode needs a real key.
 */
import { rng, round } from '../util.js';
import { NYSE_HOLIDAYS } from './session.js';

const ANCHORS = {
  NVDA: 181.4, AAPL: 232.1, MSFT: 429.6, SPY: 642.9, QQQ: 567.2,
  TSLA: 386.4, AMD: 158.7, META: 719.3, AMZN: 218.4, GOOGL: 196.5,
  PLTR: 134.2, COIN: 264.8, NFLX: 812.6, AVGO: 268.3, SMCI: 43.9,
};

const HEADLINES = [
  'Suppliers flag tighter allocation into next quarter',
  'Options desks report heavy call skew into expiry',
  'Sell-side note lifts estimates on datacenter mix',
  'Insider filings show a cluster of discretionary buys',
  'Index rebalance flows expected to lift demand',
  'Guidance reiterated after channel checks',
];

function anchor(symbol) {
  if (Number.isFinite(ANCHORS[symbol])) return ANCHORS[symbol];
  const r = rng(symbol);
  return round(20 + r() * 480, 2);
}

export class SimFeed {
  constructor({ seedDrift = true } = {}) {
    this.name = 'sim';
    this.sim = true;
    this.t0 = Date.now();
    this.seedDrift = seedDrift;
    this.state = new Map();
  }

  available() {
    return true;
  }

  walk(symbol, step = 1) {
    const minute = Math.floor(Date.now() / 60000 / step);
    let s = this.state.get(symbol);
    if (!s) {
      const r = rng(`${symbol}:boot`);
      s = { price: anchor(symbol), drift: (r() - 0.5) * 0.0009, minute };
      this.state.set(symbol, s);
    }
    while (s.minute < minute) {
      const r = rng(`${symbol}:${s.minute}`);
      s.price = round(s.price * (1 + s.drift + (r() - 0.5) * 0.004), 4);
      s.minute += 1;
    }
    return s;
  }

  async quote(symbol) {
    const s = this.walk(symbol);
    // A seeded daily gap, so the tape has breadth and dispersion to read rather
    // than six flat lines. Deterministic per symbol per UTC day: refreshing the
    // HUD does not shuffle yesterday's story, and no poll mutates the state.
    const daySeed = rng(`${symbol}:${new Date().toISOString().slice(0, 10)}`);
    const prevClose = round(anchor(symbol), 4);
    const gap = 1 + (daySeed() - 0.48) * 0.035;
    const open = round(prevClose * gap, 4);
    const price = round(s.price * (1 + (gap - 1) * 0.5), 4);
    const change = round(price - prevClose, 4);
    return {
      ok: true,
      sim: true,
      symbol,
      price,
      change,
      changePct: round((change / prevClose) * 100, 3),
      dayHigh: round(Math.max(price, open) * 1.004, 4),
      dayLow: round(Math.min(price, open) * 0.996, 4),
      open,
      prevClose,
      asOf: new Date().toISOString(),
      source: 'sim',
    };
  }

  async history(symbol, { days = 180 } = {}) {
    const n = Math.min(days, 180);
    let price = anchor(symbol) * 0.78;
    const closes = [];
    const highs = [];
    const lows = [];
    const stamps = [];
    for (let i = 0; i < n; i++) {
      const r = rng(`${symbol}:${i}`);
      price = price * (1 + (r() - 0.47) * 0.03);
      closes.push(price);
      highs.push(price * (1 + r() * 0.012));
      lows.push(price * (1 - r() * 0.012));
      stamps.push(new Date(Date.now() - (n - i) * 86400000).toISOString().slice(0, 10));
    }
    // Pin the last bar to the live quote: a chart that disagrees with the quote
    // panel is the fastest way to lose an operator's trust, even in demo mode.
    const { price: live } = await this.quote(symbol);
    const k = closes.length ? live / closes[closes.length - 1] : 1;
    const scale = (arr) => arr.map((v) => round(v * k, 4));
    return {
      ok: true, sim: true, symbol,
      closes: scale(closes), highs: scale(highs), lows: scale(lows),
      stamps, volumes: null, source: 'sim',
    };
  }

  async news(symbol, max = 5) {
    const items = Array.from({ length: max }, (_, i) => {
      const r = rng(`${symbol}:news:${i}`);
      return {
        headline: HEADLINES[Math.floor(r() * HEADLINES.length)],
        summary: `Simulated headline for ${symbol}. Wire FINNHUB_KEY for real news flow.`,
        url: null,
        at: new Date(Date.now() - i * 3600_000).toISOString(),
        source: 'sim',
      };
    });
    return { ok: true, sim: true, symbol, items, source: 'sim' };
  }

  async movers() {
    const rows = await Promise.all(
      Object.keys(ANCHORS).map(async (symbol) => {
        const q = await this.quote(symbol);
        return { symbol, name: symbol, changePct: q.changePct, price: q.price };
      })
    );
    const sorted = [...rows].sort((a, b) => b.changePct - a.changePct);
    return {
      ok: true,
      sim: true,
      gainers: sorted.slice(0, 5),
      losers: sorted.slice(-5).reverse(),
      partial: false,
      reason: null,
      source: 'sim',
    };
  }

  async marketStatus() {
    const nyToday = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    return {
      ok: true,
      sim: true,
      isOpen: !NYSE_HOLIDAYS.includes(nyToday),
      session: 'sim',
      holiday: NYSE_HOLIDAYS.includes(nyToday) ? 'sim holiday' : null,
      source: 'sim',
    };
  }
}
