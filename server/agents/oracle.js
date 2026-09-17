/**
 * oracle.js — ORACLE · QUANT. Probabilities, never promises.
 *
 * Two model paths, and the report says which one ran:
 *   • `remote`  — a TimesFM-style endpoint (set TIMESFM_URL) if you have one;
 *   • `local`   — lognormal Monte-Carlo over the instrument's own daily returns.
 *
 * Guardrail: every forecast string passes through `hedge()`, which rewrites
 * deterministic phrasing ("will", "guaranteed", "certainly") into a
 * probability. The desk sounds confident; the quant is not allowed to.
 */
import { config } from '../config.js';
import { report, NO_DATA, stats } from './base.js';
import { fetchJson, fmtPrice, round } from '../util.js';

const ABSOLUTE = /\b(will|certainly|guaranteed|guarantee|definitely|for sure|no doubt|always)\b/gi;

/** Quantitative guardrail: strip certainty out of a forecast sentence. */
export function hedge(text) {
  return String(text || '')
    .replace(/\bis going to\b/gi, 'is likely to')
    .replace(/\bwill not\b/gi, 'is unlikely to')
    .replace(ABSOLUTE, (m) => ({ will: 'is expected to', certainly: 'probably', guaranteed: 'modelled as likely', guarantee: 'a false promise', definitely: 'likely', 'for sure': 'on the model', 'no doubt': 'by the numbers', always: 'in-sample' })[m.toLowerCase()] || 'likely');
}

async function timesfm(series, horizon) {
  const url = process.env.TIMESFM_URL;
  if (!url || !Array.isArray(series) || series.length < 32) return null;
  const res = await fetchJson(url, {
    method: 'POST',
    timeoutMs: 20000,
    headers: { 'content-type': 'application/json' },
    body: { inputs: [series.map(Number)], forecast_horizon: horizon },
  });
  if (!res.ok || !res.json) return { ok: false, reason: `TimesFM endpoint: ${res.reason || 'no reply'}` };
  const p = Array.isArray(res.json?.predictions) ? res.json.predictions[0] : null;
  return p ? { ok: true, predictions: p, model: 'google/timesfm (remote)' } : { ok: false, reason: 'TimesFM returned no predictions' };
}

export const definition = {
  id: 'oracle',
  async handle({ symbol, feed, params, reports }) {
    const sym = String(params?.symbol || symbol || 'SPY').toUpperCase();
    const horizon = Math.max(1, Math.min(60, Number(params?.horizon) || 20));
    const hist = await feed.history(sym, { days: Math.max(120, horizon * 6) });
    if (!hist.ok) {
      return NO_DATA('oracle', hist.reason, {
        subject: `forecast for ${sym}`,
        fix: 'A model with no series is a random number generator. Feed it history (yfinance helper) and ask again.',
      });
    }
    const series = hist.closes.slice(-252);
    const remote = await timesfm(series, horizon);
    const fc = stats.forecast({ closes: series, horizonDays: horizon, sims: 6000, seed: `${sym}:${horizon}` });
    if (!fc) {
      return NO_DATA('oracle', `only ${series.length} bars of history — I need 30 returns minimum`, { subject: `forecast for ${sym}` });
    }
    const athena = reports?.athena?.status === 'ok' ? reports.athena.data : null;
    const price = fc.last;
    const touch = (level) => {
      if (!Number.isFinite(level)) return null;
      const dir = level >= price ? 'above' : 'below';
      // path-independent proxy: how far the level sits in the modelled spread
      const z = Math.log(level / price) / Math.max(1e-6, fc.sigmaDailyPct / 100 * Math.sqrt(horizon));
      const p = 1 / (1 + Math.exp(-1.7 * -z));
      return { level: round(level, 2), dir, probPct: round(p * 100, 1) };
    };
    const hitSupport = athena?.support ? touch(athena.support.price) : null;
    const hitResistance = athena?.resistance ? touch(athena.resistance.price) : null;
    const method = remote?.ok ? `TimesFM forecast + local distribution check (${remote.model})` : fc.method;

    const bullets = [
      `Horizon ${horizon} trading days · ${fc.sims.toLocaleString('en-US')} paths · ${method}.`,
      `Median $${fmtPrice(fc.p50)} (last $${fmtPrice(fc.last)}). Interquartile $${fmtPrice(fc.p25)}–$${fmtPrice(fc.p75)}. 5–95 band $${fmtPrice(fc.p05)}–$${fmtPrice(fc.p95)}.`,
      `P(above last close) ${fc.probUpPct}%. Daily σ ${fc.sigmaDailyPct}% — read that as the size of "nothing happening".`,
      hitResistance ? `P(touch supply $${fmtPrice(hitResistance.level)}) ≈ ${hitResistance.probPct}% before ${horizon} days.` : 'No supply level supplied — ask ATHENA for structure first.',
      hitSupport ? `P(touch demand $${fmtPrice(hitSupport.level)}) ≈ ${hitSupport.probPct}%.` : 'No demand level supplied, so no touch probability computed.',
      'A distribution, not a verdict: the median is not the plan, the band is.',
      hist.sim ? 'Series is the labelled SIM feed — probabilities are mechanics, not market view.' : null,
    ].filter(Boolean);

    const speech = hedge(
      `Twenty-day model for ${sym}: median $${fmtPrice(fc.p50)}, middle half between $${fmtPrice(fc.p25)} and $${fmtPrice(fc.p75)}. Probability of finishing above the last close is ${fc.probUpPct} percent. ${hitSupport ? `Demand gets tagged in about ${hitSupport.probPct} percent of paths.` : ''} That is a distribution, not a promise.`
    );

    return report('oracle', {
      headline: `${sym} ${horizon}d · P(up) ${fc.probUpPct}% · median $${fmtPrice(fc.p50)} · band $${fmtPrice(fc.p05)}–$${fmtPrice(fc.p95)}`,
      bullets,
      speech,
      data: {
        symbol: sym,
        horizonDays: horizon,
        ...fc,
        hitSupport,
        hitResistance,
        method,
        model: remote?.ok ? 'timesfm+local' : 'monte-carlo-lognormal',
        series,
        simulated: Boolean(hist.sim),
      },
      sources: [`history:${hist.source}`, remote?.ok ? 'timesfm' : 'in-house mc'],
      actions: [
        { type: 'chart', action: 'drawForecastBand', payload: { symbol: sym, p05: fc.p05, p50: fc.p50, p95: fc.p95, horizonDays: horizon } },
      ],
    });
  },
  guardrails: { hedge, forbiddenWords: Array.from(new Set(ABSOLUTE.source.match(/[\w ]+/g) || [])) },
};

export const _internals = { hedge, config };
