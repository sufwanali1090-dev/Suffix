/**
 * provider.js — the desk's single view of market data.
 *
 * Rules baked in here:
 *   • one upstream at a time (Finnhub live, or the labelled sim);
 *   • every payload carries its source and its age;
 *   • a failed lookup resolves to { ok:false } → the HUD renders "—".
 *     There is no code path that manufactures a number.
 */
import { config } from '../config.js';
import { FinnhubFeed } from './finnhub.js';
import { SimFeed } from './sim.js';
import { nowIso, round } from '../util.js';

const HISTORY_TTL_MS = 15 * 60 * 1000;

export const WATCHLIST = ['NVDA', 'AAPL', 'MSFT', 'SPY', 'QQQ', 'TSLA'];

export class DeskFeed {
  constructor({ bus, journal }) {
    this.bus = bus;
    this.journal = journal;
    this.finnhub = new FinnhubFeed(config.finnhubKey);
    this.sim = new SimFeed();
    this.useSim = config.allowSim && (!this.finnhub.available() || config.demoFeed);
    this.active = this.useSim ? this.sim : this.finnhub;
    this.quoteCache = new Map(); // symbol -> { quote, at }
    this.histCache = new Map(); // symbol -> { data, at }
    this.lastPollAt = null;
    this.pollErrors = 0;
    this.watch = [...WATCHLIST, ...config.tradingview.symbols].filter(
      (v, i, a) => a.indexOf(v) === i
    );
  }

  get mode() {
    if (!this.finnhub.available()) return 'sim:no-key';
    return this.useSim ? 'sim:forced' : 'finnhub';
  }

  health() {
    return {
      mode: this.mode,
      live: !this.useSim,
      simulated: Boolean(this.active.sim),
      symbol: this.useSim ? 'SIM' : 'LIVE',
      keyConfigured: this.finnhub.available(),
      lastOkAt: this.finnhub.lastOkAt || (this.useSim ? nowIso() : null),
      lastPollAt: this.lastPollAt,
      pollErrors: this.pollErrors,
      lastError: this.finnhub.lastError,
      reason: !this.finnhub.available()
        ? 'No FINNHUB_KEY — running the labelled sim feed. Paste a free key in .env for real quotes.'
        : this.finnhub.lastError
          ? `Live feed error: ${this.finnhub.lastError}`
          : 'Finnhub reachable',
      quotePollMs: config.quotePollMs,
    };
  }

  /** Normalized "no data" shape — the HUD turns any of these into an em dash. */
  static missing(symbol, reason) {
    return { ok: false, symbol, price: null, change: null, changePct: null, reason, asOf: nowIso() };
  }

  async quote(symbol, { maxAgeMs = 20000 } = {}) {
    const s = String(symbol || '').toUpperCase().trim();
    if (!s || s.length > 8) return DeskFeed.missing(symbol, 'invalid symbol');
    const cached = this.quoteCache.get(s);
    if (cached && Date.now() - cached.at < maxAgeMs && cached.quote?.ok) return cached.quote;
    const q = await this.active.quote(s);
    const norm = q?.ok ? q : DeskFeed.missing(s, q?.reason || 'feed unavailable');
    this.quoteCache.set(s, { quote: norm, at: Date.now() });
    return norm;
  }

  async quotesFor(symbols) {
    const rows = await Promise.all(symbols.map((s) => this.quote(s)));
    return rows.map((r, i) => ({ ...r, symbol: r.symbol ?? symbols[i] }));
  }

  async history(symbol, { days = 180 } = {}) {
    const s = String(symbol || '').toUpperCase();
    const cached = this.histCache.get(s);
    if (cached && Date.now() - cached.at < HISTORY_TTL_MS && cached.data?.ok) return cached.data;
    let data = await this.active.history(s, { days });
    if (!data?.ok && !this.useSim && config.allowSim) {
      // Free-tier Finnhub has no candle endpoint: fall back to the labelled sim
      // so the level-drawing works, and say so in the payload + the log.
      const fallback = await this.sim.history(s, { days });
      fallback.reason = `${data?.reason ?? 'history unavailable'} — showing simulated history`;
      data = fallback;
      this.bus?.alert('athena', `${s}: history not on this Finnhub tier — using labelled sim series`, 'warn', {
        dedupe: `hist:${s}`,
      });
    }
    const norm = data?.ok ? data : { ok: false, symbol: s, closes: [], reason: data?.reason || 'no history' };
    this.histCache.set(s, { data: norm, at: Date.now() });
    return norm;
  }

  news(symbol) {
    return this.active.news(String(symbol || '').toUpperCase());
  }

  movers() {
    return this.active.movers();
  }

  /** Simple daily-return series for the pulse rings. */
  async seriesFor(symbol, points = 60) {
    const h = await this.history(symbol, { days: points });
    if (!h.ok) return null;
    return h.closes.slice(-points);
  }

  async pollWatchlist() {
    this.lastPollAt = nowIso();
    const rows = await this.quotesFor(this.watch);
    const missing = rows.filter((r) => !r.ok);
    if (missing.length === rows.length) this.pollErrors += 1;
    else this.pollErrors = 0;
    this.bus.emitEvent('quotes', {
      rows: rows.map((r) => ({
        symbol: r.symbol,
        price: r.price,
        changePct: r.changePct,
        change: r.change,
        dayHigh: r.dayHigh,
        dayLow: r.dayLow,
        prevClose: r.prevClose,
        ok: r.ok,
        reason: r.reason ?? null,
        asOf: r.asOf,
        source: r.source ?? (r.ok ? this.mode : null),
      })),
      feed: this.health(),
      session: null,
    });
    if (missing.length && !this.useSim) {
      this.bus.alert(
        'ledger',
        `${missing.length}/${rows.length} quotes unavailable (${missing[0].reason}) — panels showing "—" until the feed recovers`,
        'warn',
        { dedupe: 'feed-degraded' }
      );
    }
    return rows;
  }

  start() {
    this.pollWatchlist().catch((e) => console.error('[feed] poll failed:', e.message));
    this.timer = setInterval(() => {
      this.pollWatchlist().catch((e) => console.error('[feed] poll failed:', e.message));
    }, config.quotePollMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Everything the HUD renders on first paint. */
  async snapshot({ session, calendar }) {
    const rows = await this.quotesFor(this.watch);
    return {
      at: nowIso(),
      feed: this.health(),
      watch: rows.map((r) => ({
        symbol: r.symbol,
        price: r.price,
        changePct: r.changePct === null || r.changePct === undefined ? null : round(r.changePct, 2),
        change: r.change,
        ok: r.ok,
        reason: r.reason ?? null,
        asOf: r.asOf,
      })),
      session,
      calendar,
    };
  }
}
