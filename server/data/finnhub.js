/**
 * finnhub.js — the only path to live prices.
 *
 * Contract the whole desk depends on: a provider either returns real numbers
 * with a real timestamp, or it returns { ok:false, reason }. It never returns
 * a plausible-looking guess. If this file starts fabricating, the HUD will
 * happily print a lie — so keep the failure path loud and the happy path boring.
 */
import { config } from '../config.js';
import { fetchJson, round } from '../util.js';

const BASE = 'https://finnhub.io/api/v1';

export class FinnhubFeed {
  constructor(key = config.finnhubKey) {
    this.key = key;
    this.name = 'finnhub';
    this.lastOkAt = null;
    this.lastError = null;
  }

  available() {
    return Boolean(this.key);
  }

  url(pathname, params = {}) {
    const q = new URLSearchParams({ ...params, token: this.key });
    return `${BASE}${pathname}?${q}`;
  }

  async get(pathname, params, timeoutMs = 9000) {
    if (!this.available()) return { ok: false, reason: 'FINNHUB_KEY not set' };
    const res = await fetchJson(this.url(pathname, params), { timeoutMs });
    if (!res.ok) {
      this.lastError = res.reason;
      return { ok: false, reason: res.reason, status: res.status };
    }
    const json = res.json;
    if (json && json.error) {
      this.lastError = json.error;
      return { ok: false, reason: String(json.error) };
    }
    this.lastOkAt = new Date().toISOString();
    this.lastError = null;
    return { ok: true, data: json };
  }

  /** Free-tier quote: current, change, %change, day hi/lo, prev close. */
  async quote(symbol) {
    const r = await this.get('/quote', { symbol });
    if (!r.ok) return { ok: false, symbol, reason: r.reason };
    const d = r.data || {};
    if (!Number.isFinite(d.c) || d.c === 0) {
      return { ok: false, symbol, reason: 'quote empty (symbol unknown or market shut)' };
    }
    return {
      ok: true,
      symbol,
      price: round(d.c, 4),
      change: round(d.d, 4),
      changePct: round(d.dp, 3),
      dayHigh: round(d.h, 4),
      dayLow: round(d.l, 4),
      open: round(d.o, 4),
      prevClose: round(d.pc, 4),
      asOf: new Date().toISOString(),
      source: 'finnhub',
    };
  }

  async history(symbol, { days = 180 } = {}) {
    const to = Math.floor(Date.now() / 1000);
    const from = to - days * 86400;
    const r = await this.get('/stock/candle', { symbol, resolution: 'D', from, to });
    if (!r.ok) {
      return { ok: false, symbol, reason: `history unavailable — ${r.reason} (candles need a paid Finnhub plan; yfinance covers history)` };
    }
    const d = r.data;
    if (d?.s !== 'ok' || !Array.isArray(d.c) || !d.c.length) {
      return { ok: false, symbol, reason: 'no candles returned for this symbol' };
    }
    return {
      ok: true,
      symbol,
      closes: d.c.map((v) => round(v, 4)),
      highs: d.h.map((v) => round(v, 4)),
      lows: d.l.map((v) => round(v, 4)),
      volumes: d.v ?? null,
      stamps: (d.t ?? []).map((t) => new Date(t * 1000).toISOString().slice(0, 10)),
      source: 'finnhub',
    };
  }

  async news(symbol, max = 8) {
    const r = await this.get('/news', { symbol, category: 'general' });
    if (!r.ok) return { ok: false, symbol, reason: r.reason };
    const items = (Array.isArray(r.data) ? r.data : [])
      .slice(0, max)
      .map((n) => ({
        headline: n.headline,
        summary: (n.summary || '').slice(0, 220),
        url: n.url,
        at: n.datetime ? new Date(n.datetime * 1000).toISOString() : null,
        source: n.site || 'finnhub',
      }));
    if (!items.length) return { ok: false, symbol, reason: 'no headlines returned' };
    return { ok: true, symbol, items, source: 'finnhub' };
  }

  async movers() {
    const [gainers, losers] = await Promise.all([
      this.get('/stock/top-gainer', {}),
      this.get('/stock/top-loser', {}),
    ]);
    if (!gainers.ok && !losers.ok) {
      return { ok: false, reason: gainers.reason || losers.reason };
    }
    const map = (res) =>
      (Array.isArray(res.data?.peers) ? res.data.peers : res.data?.symbols ? res.data.symbols : [])
        .slice(0, 8)
        .map((p) => ({
          symbol: p.symbol,
          name: p.name,
          changePct: round(p.pctChange ?? p.percent, 3),
          price: round(p.price, 4),
        }));
    return {
      ok: true,
      gainers: gainers.ok ? map(gainers) : null,
      losers: losers.ok ? map(losers) : null,
      partial: !gainers.ok || !losers.ok,
      reason: !gainers.ok ? gainers.reason : !losers.ok ? losers.reason : null,
      source: 'finnhub',
    };
  }

  async marketStatus() {
    const r = await this.get('/stock/market-status', { exchange: 'US' });
    if (!r.ok) return { ok: false, reason: r.reason };
    return {
      ok: true,
      isOpen: Boolean(r.data?.isOpen),
      session: r.data?.session ?? null,
      holiday: r.data?.holidayName ?? null,
      source: 'finnhub',
    };
  }
}
