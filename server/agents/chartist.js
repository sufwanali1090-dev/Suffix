/**
 * chartist.js — CHARTIST · TECHNICIAN. Owns the screens.
 *
 * The agent that most desks fake. Chartist's "answer" is not prose, it is a
 * list of commands: flip the symbol, change the timeframe, draw these three
 * lines, screenshot the result. Each command goes to the HUD chart and, when a
 * bridge is configured, to your real TradingView via the MCP server.
 *
 * Where to buy and where to run come from measured numbers: the demand level
 * and the ATR floor decide the stop; the supply shelf decides the target.
 */
import { report, stats } from './base.js';
import { fmtPrice, round } from '../util.js';

const INTERVAL_WORDS = {
  '1d': 'D', daily: 'D', '1w': 'W', weekly: 'W', '1h': '60', hourly: '60',
  '15m': '15', '5m': '5', '4h': '240', monthly: 'M', '1m': '1',
};

function planLevels(athenaData, hist) {
  if (athenaData?.price) return athenaData;
  const { closes, highs, lows } = hist || {};
  if (!closes?.length) return null;
  const price = closes[closes.length - 1];
  const atr = stats.atr({ highs, lows, closes }, 14);
  const levels = stats.levels({ highs, lows, closes }, { tolerance: 0.008, max: 4 });
  const support = levels.filter((l) => l.price < price).sort((a, b) => b.price - a.price)[0] ?? null;
  const resistance = levels.filter((l) => l.price > price).sort((a, b) => a.price - b.price)[0] ?? null;
  return { symbol: undefined, price: round(price, 2), atr, support, resistance, levels };
}

export const definition = {
  id: 'chartist',
  async handle({ symbol, feed, params, reports, services }) {
    const sym = String(params?.symbol || symbol || 'SPY').toUpperCase();
    const interval =
      INTERVAL_WORDS[String(params?.interval || '').toLowerCase()] ||
      (params?.interval ? String(params.interval).toUpperCase() : null);
    const clear = /^(clear|reset|clean)/i.test(String(params?.action || ''));

    const actions = [];
    const bullets = [];
    if (clear) {
      actions.push({ type: 'chart', action: 'clearLevels', payload: { symbol: sym } });
      bullets.push('Overlays cleared. Chart is yours again.');
    } else {
      actions.push({ type: 'chart', action: 'setSymbol', payload: { symbol: sym } });
      if (interval) actions.push({ type: 'chart', action: 'setInterval', payload: { symbol: sym, interval } });
      actions.push({ type: 'chart', action: 'focusOrb', payload: { symbol: sym, agent: 'chartist' } });

      const athenaData = reports?.athena?.data?.price ? reports.athena.data : null;
      const hist = athenaData ? null : await feed.history(sym, { days: 120 });
      const plan = planLevels(athenaData, hist?.ok ? hist : null);

      if (!plan) {
        bullets.push(`Switched the screen to ${sym}. No price series came back, so I drew nothing — I will not sketch levels from memory.`);
      } else {
        const quote = await feed.quote(sym);
        const price = quote?.ok ? quote.price : plan.price;
        const atr = plan.atr ?? 0;
        const stop = plan.support
          ? round(plan.support.price - Math.max(atr * 0.5, price * 0.004), 2)
          : round(price - Math.max(atr * 1.5, price * 0.03), 2);
        const target = plan.resistance ? round(plan.resistance.price, 2) : round(price + Math.max(atr * 2, price * 0.04), 2);
        const risk = Math.max(0.01, price - stop);
        const reward = target - price;
        const rr = round(reward / risk, 2);

        const drawn = [
          { price: plan.resistance?.price ?? target, kind: 'resistance', label: 'supply / target' },
          { price, kind: 'price', label: `last ${fmtPrice(price)}` },
          { price: plan.support?.price ?? round(price - atr, 2), kind: 'support', label: 'demand' },
          { price: stop, kind: 'stop', label: 'where to run' },
        ].filter((l) => Number.isFinite(l.price));

        for (const l of drawn) {
          actions.push({ type: 'chart', action: 'drawLevel', payload: { symbol: sym, ...l } });
        }
        bullets.push(`Screen: ${sym}${interval ? ` @ ${interval}` : ''}. ${drawn.length} lines drawn from the series, not from me.`);
        bullets.push(
          `Entry zone $${fmtPrice(price)} · demand $${fmtPrice(plan.support?.price ?? price - atr)} · stop $${fmtPrice(stop)} (risk $${fmtPrice(risk)}/share) · target $${fmtPrice(target)}.`
        );
        bullets.push(
          `That is ${rr}:1 reward-to-risk. ${rr < 1.5 ? 'Thin — the exit is too close to the shelf above.' : rr < 2.5 ? 'Workable, if the level holds.' : 'Rich, if you can hold through the noise.'}`
        );
        bullets.push(`ATR(14) $${fmtPrice(atr)}: inside that band a line touch means nothing.`);
        plan.levels?.length &&
          bullets.push(`Other levels in play: ${plan.levels.map((l) => `$${fmtPrice(l.price)} (${l.touches}×)`).join(' · ')}`);
      }
    }

    const drewLines = actions.some((a) => a.action === 'drawLevel');
    const bridgeStatus = services?.mcp?.status?.() ?? null;
    const mcpNote = !drewLines
      ? null
      : !bridgeStatus?.configured
        ? 'No MCP bridge configured, so only the desk chart moved.'
        : bridgeStatus.lastError
          ? `TradingView bridge errored: ${bridgeStatus.lastError}`
          : 'Sent to TradingView over the MCP bridge.';

    if (mcpNote) bullets.push(mcpNote);

    return report('chartist', {
      headline: clear ? `Cleared overlays on ${sym}` : `Screen up: ${sym}${interval ? ` · ${interval}` : ''} — levels marked`,
      bullets,
      speech: clear
        ? `Overlays off. ${sym} is clean.`
        : `${sym} on the screen${interval ? `, ${interval} bars` : ''}. ${bullets[1] || 'No series, so no lines.'} Marked where to buy, marked where to run. ${mcpNote || ''}`.trim(),
      data: { symbol: sym, interval, actionCount: actions.length, mcpNote },
      actions,
      sources: ['desk-chart', 'tradingview-mcp (if configured)'],
    });
  },

  /** Called by the master after routing: push the commands to the bridge. */
  async drive(bridge, actions) {
    const results = [];
    for (const a of actions.filter((x) => x.type === 'chart')) {
      results.push(await bridge.send(a.action, a.payload));
    }
    return results;
  },
};
