/**
 * base.js — the contract every specialist implements.
 *
 *   handle(ctx) -> Report
 *
 *   Report = {
 *     agent, status: 'ok'|'no-data'|'blocked'|'veto'|'error',
 *     headline,        // one line the master can read verbatim
 *     bullets[],       // what shows in the HUD card
 *     speech,          // what the agent's own voice says (short!)
 *     data,            // structured, for panels
 *     actions[],       // side effects: chart.*, alert.*, trade.*
 *     sources[],       // where the numbers came from (empty => we say so)
 *   }
 *
 * Two habits enforced here so no agent has to remember them:
 *   1. an agent that ends up with no real number returns `noData(...)` — the
 *      HUD renders "—" and the master says the feed is missing;
 *   2. every throw is converted into an error report, never a crash of the desk.
 */
import { clamp, nowIso, round, truncate } from '../util.js';

export function report(agent, part = {}) {
  return {
    agent,
    at: nowIso(),
    status: 'ok',
    headline: '',
    bullets: [],
    speech: '',
    data: {},
    actions: [],
    sources: [],
    ms: null,
    ...part,
  };
}

export const NO_DATA = (agent, reason, extra = {}) =>
  report(agent, {
    status: 'no-data',
    headline: 'No verified data',
    bullets: [reason],
    speech: `I have no ${extra.subject || 'data'} I am willing to read out. ${extra.fix || 'Wire the feed and ask again.'}`,
    reason,
    ...extra,
  });

/** Wrap an async handler: timed, state-broadcast, crash-proof. */
export function instrument(definition, { bus, journal }) {
  const run = async (ctx) => {
    const started = Date.now();
    bus?.agentState(definition.id, 'thinking', ctx.intent || '');
    try {
      const out = await definition.handle(ctx);
      out.ms = Date.now() - started;
      out.agent = definition.id;
      out.headline = truncate(out.headline || '', 160);
      out.speech = truncate(String(out.speech || out.headline || '').replace(/\s+/g, ' ').trim(), 420);
      out.bullets = (out.bullets || []).filter(Boolean).map((b) => truncate(String(b), 220));
      for (const a of out.actions || []) {
        if (a.type === 'chart') bus?.emitEvent('chart.action', { action: a.action, payload: a.payload }, { agent: definition.id });
        if (a.type === 'alert') bus?.alert(definition.id, a.text, a.severity || 'info', { dedupe: a.dedupe });
      }
      journal?.append({
        kind: 'report',
        agent: definition.id,
        status: out.status,
        text: out.headline,
        ms: out.ms,
        intent: ctx.intent ?? null,
        symbol: ctx.symbol ?? null,
      });
      bus?.agentState(definition.id, 'done', out.status);
      return out;
    } catch (err) {
      const out = report(definition.id, {
        status: 'error',
        headline: `${definition.name} failed`,
        bullets: [String(err?.message || err)],
        speech: `${definition.name} is offline on that one.`,
        ms: Date.now() - started,
      });
      journal?.append({ kind: 'error', agent: definition.id, text: String(err?.message || err), ms: out.ms });
      bus?.alert(definition.id, `agent error: ${String(err?.message || err)}`, 'danger');
      bus?.agentState(definition.id, 'error', 'fault');
      return out;
    }
  };
  return { ...definition, run };
}

/** Shared, dependency-free technical stats used by Athena / Oracle / Sentinel. */
export const stats = {
  sma(values, n) {
    if (!Array.isArray(values) || values.length < n) return null;
    const slice = values.slice(-n);
    return round(slice.reduce((a, b) => a + b, 0) / n, 4);
  },
  ema(values, n) {
    if (!Array.isArray(values) || values.length < n) return null;
    const k = 2 / (n + 1);
    let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
    for (let i = n; i < values.length; i++) e = values[i] * k + e * (1 - k);
    return round(e, 4);
  },
  stdev(values) {
    if (!Array.isArray(values) || values.length < 2) return null;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
  },
  returns(values) {
    if (!Array.isArray(values) || values.length < 2) return [];
    const out = [];
    for (let i = 1; i < values.length; i++) {
      if (values[i - 1]) out.push(values[i] / values[i - 1] - 1);
    }
    return out;
  },
  atr({ highs, lows, closes }, n = 14) {
    if (!highs?.length || !closes?.length || highs.length < n + 1) return null;
    const trs = [];
    for (let i = 1; i < highs.length; i++) {
      trs.push(
        Math.max(
          highs[i] - lows[i],
          Math.abs(highs[i] - closes[i - 1]),
          Math.abs(lows[i] - closes[i - 1])
        )
      );
    }
    return round(trs.slice(-n).reduce((a, b) => a + b, 0) / n, 4);
  },
  swings({ highs, lows, closes }, lookback = 3) {
    if (!highs?.length) return { highs: [], lows: [] };
    const sh = [];
    const sl = [];
    for (let i = lookback; i < highs.length - lookback; i++) {
      const win = highs.slice(i - lookback, i + lookback + 1);
      if (highs[i] === Math.max(...win)) sh.push({ i, price: round(highs[i], 4) });
      const winL = lows.slice(i - lookback, i + lookback + 1);
      if (lows[i] === Math.min(...winL)) sl.push({ i, price: round(lows[i], 4) });
    }
    if (!sh.length && closes?.length) {
      sh.push({ i: closes.length - 1, price: round(Math.max(...closes), 4) });
      sl.push({ i: 0, price: round(Math.min(...closes), 4) });
    }
    return { highs: sh, lows: sl };
  },
  /** Cluster swing points into levels: within 0.75% they merge into one line. */
  levels({ highs, lows, closes }, { tolerance = 0.0075, max = 4 } = {}) {
    const { highs: sh, lows: sl } = stats.swings({ highs, lows, closes });
    const price = closes?.length ? closes[closes.length - 1] : null;
    const all = [
      ...sh.map((p) => ({ price: p.price, kind: 'resistance', touches: 1 })),
      ...sl.map((p) => ({ price: p.price, kind: 'support', touches: 1 })),
    ].sort((a, b) => b.price - a.price);
    const merged = [];
    for (const lv of all) {
      const near = merged.find(
        (m) => Math.abs(m.price - lv.price) / m.price <= tolerance
      );
      if (near) {
        near.touches += 1;
        near.price = round((near.price * (near.touches - 1) + lv.price) / near.touches, 4);
        if (near.kind !== lv.kind) near.kind = 'level';
      } else merged.push(lv);
    }
    const withDistance = merged
      .map((m) => ({ ...m, distancePct: price ? round(((m.price - price) / price) * 100, 2) : null }))
      .sort((a, b) => Math.abs(a.distancePct ?? 99) - Math.abs(b.distancePct ?? 99));
    return withDistance.slice(0, max);
  },
  percentile(values, p) {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const idx = clamp(Math.floor((s.length - 1) * p), 0, s.length - 1);
    return s[idx];
  },
  /** Lognormal quantile forecast — real maths on real history, no narrative. */
  forecast({ closes, horizonDays = 20, sims = 4000, seed = 'oracle' }) {
    const rets = stats.returns(closes);
    if (rets.length < 30) return null;
    const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sigma = stats.stdev(rets) || 0.02;
    const last = closes[closes.length - 1];
    let s = 2166136261;
    for (const ch of seed) s = (Math.imul(s ^ ch.charCodeAt(0), 16777619)) >>> 0;
    const rand = () => {
      s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
    const gauss = () => {
      const u = Math.max(1e-9, rand());
      const v = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    // mu and sigma are measured per bar, so the drift of one step is one step:
    // no annualisation factors in the loop (that bug made bands 250× too tight).
    const drift = mu - (sigma ** 2) / 2; // log-drift under a GBM
    const terminal = [];
    for (let i = 0; i < sims; i++) {
      let logMove = 0;
      for (let d = 0; d < horizonDays; d++) logMove += drift + sigma * gauss();
      terminal.push(last * Math.exp(logMove));
    }
    const q = (p) => round(stats.percentile(terminal, p), 2);
    const up = terminal.filter((v) => v > last).length / terminal.length;
    return {
      last: round(last, 2),
      horizonDays,
      sigmaDailyPct: round(sigma * 100, 3),
      sigmaHorizonPct: round(sigma * Math.sqrt(horizonDays) * 100, 2),
      p05: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95),
      probUpPct: round(up * 100, 1),
      sims,
      method: 'lognormal Monte-Carlo on 1-day returns from the price series',
    };
  },
};
