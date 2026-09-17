/**
 * athena.js — ATHENA · ANALYST. Structure from the numbers, nothing else.
 *
 * Supply/demand/liquidity are computed from the price series the feed returns:
 * swing clustering into levels, ATR for the noise floor, moving averages for
 * trend, and distance-to-level as the only tradable fact. Fundamentals are
 * fetched when the plan exposes them and reported as "—" when it does not.
 */
import { report, NO_DATA, stats } from './base.js';
import { fmtPct, fmtPrice, round } from '../util.js';

export const definition = {
  id: 'athena',
  async handle({ symbol, feed }) {
    const sym = symbol || 'SPY';
    const [hist, quote] = await Promise.all([feed.history(sym, { days: 180 }), feed.quote(sym)]);
    if (!hist.ok) {
      return NO_DATA('athena', hist.reason, {
        subject: `structure read on ${sym}`,
        fix: 'Free Finnhub has no candle endpoint — point yfinance at server/data/candles.js or set DEMO_FEED=1 to see the mechanics.',
        symbol: sym,
      });
    }
    const { closes, highs, lows, stamps } = hist;
    const price = quote?.ok ? quote.price : closes[closes.length - 1];
    const atr = stats.atr({ highs, lows, closes }, 14);
    const sma20 = stats.sma(closes, 20);
    const sma50 = stats.sma(closes, 50);
    const sma200 = closes.length >= 200 ? stats.sma(closes, 200) : null;
    const levels = stats.levels({ highs, lows, closes }, { tolerance: 0.008, max: 6 });
    const support = levels.filter((l) => l.price < price && (l.kind !== 'resistance' || l.touches > 1)).sort((a, b) => b.price - a.price)[0];
    const resistance = levels.filter((l) => l.price > price).sort((a, b) => a.price - b.price)[0];
    const ret = stats.returns(closes);
    const vol = stats.stdev(ret) ? round(stats.stdev(ret) * 100, 2) : null;
    const range120 = {
      high: round(Math.max(...highs), 2),
      low: round(Math.min(...lows), 2),
    };
    const posInRange = range120.high > range120.low
      ? round(((price - range120.low) / (range120.high - range120.low)) * 100, 0)
      : null;
    const trend =
      sma20 && sma50 && price > sma20 && sma20 > sma50 ? 'uptrend — higher highs, buyers defending below'
      : sma20 && sma50 && price < sma20 && sma20 < sma50 ? 'downtrend — rallies are being sold'
      : 'transition — the averages disagree, so no trend to lean on';

    const distToSup = support ? round(((price - support.price) / price) * 100, 2) : null;
    const distToRes = resistance ? round(((resistance.price - price) / price) * 100, 2) : null;
    const riskReward =
      support && resistance ? round((resistance.price - price) / Math.max(1e-6, price - support.price), 2) : null;

    const bullets = [
      `Trend: ${trend}. SMA20 ${fmtPrice(sma20)} · SMA50 ${fmtPrice(sma50)}${sma200 ? ` · SMA200 ${fmtPrice(sma200)}` : ' · SMA200 —(series too short)'}.`,
      `Resistance ${resistance ? `$${fmtPrice(resistance.price)} (${distToRes}%, ${resistance.touches} touch${resistance.touches === 1 ? '' : 'es'})` : '—'}.`,
      `Support ${support ? `$${fmtPrice(support.price)} (${distToSup}%, ${support.touches} touch${support.touches === 1 ? '' : 'es'})` : '—'}.`,
      `ATR(14) $${fmtPrice(atr)} — that is the noise floor; a stop inside it is a donation.`,
      `${stamps.length} bars from ${stamps[0]} to ${stamps[stamps.length - 1]}; 120-day range $${fmtPrice(range120.low)}–$${fmtPrice(range120.high)}, price ${posInRange}% of the way up.`,
      vol ? `Daily σ ${vol}% · realised range is doing the talking.` : null,
      riskReward !== null ? `Room to resistance over room to support: ${riskReward}:1. Below 1.5, the trade is a coin flip with fees.` : null,
      hist.reason ? `Note: ${hist.reason}.` : null,
    ].filter(Boolean);

    return report('athena', {
      headline: `${sym} $${fmtPrice(price)} · ${trend.split(' —')[0]} · sup ${support ? '$' + fmtPrice(support.price) : '—'} / res ${resistance ? '$' + fmtPrice(resistance.price) : '—'}`,
      bullets,
      speech: `${sym} is trading ${fmtPrice(price)}, ${quote?.ok ? `${fmtPct(quote.changePct)} on the day, ` : ''}in ${/^[aeiou]/i.test(trend.split(' —')[0]) ? 'an' : 'a'} ${trend.split(' —')[0]}. Demand sits at ${support ? fmtPrice(support.price) : 'nowhere I can prove'}, supply at ${resistance ? fmtPrice(resistance.price) : 'nowhere I can prove'}. Average true range is ${fmtPrice(atr)}, so anything inside that is noise. ${riskReward !== null && riskReward < 1.5 ? 'The reward to risk from here is thin — I would wait for the level.' : 'Structure is workable if the level holds.'}`,
      data: {
        symbol: sym,
        price: round(price, 2),
        trend,
        atr,
        sma20,
        sma50,
        sma200,
        support: support ?? null,
        resistance: resistance ?? null,
        levels,
        range: range120,
        posInRange,
        sigmaDailyPct: vol,
        riskReward,
        bars: stamps.length,
        window: stamps.length ? [stamps[0], stamps[stamps.length - 1]] : null,
        series: closes.slice(-120),
        simulated: Boolean(hist.sim),
        note: hist.reason ?? null,
      },
      sources: [`${hist.source}:candles`, `${quote?.source ?? 'none'}:quote`],
      actions: [
        ...(support ? [{ type: 'chart', action: 'drawLevel', payload: { price: support.price, kind: 'support', label: 'demand', touches: support.touches, symbol: sym } }] : []),
        ...(resistance ? [{ type: 'chart', action: 'drawLevel', payload: { price: resistance.price, kind: 'resistance', label: 'supply', touches: resistance.touches, symbol: sym } }] : []),
        ...(sma50 ? [{ type: 'chart', action: 'drawLevel', payload: { price: sma50, kind: 'sma50', label: 'SMA50', symbol: sym } }] : []),
      ],
    });
  },
};
