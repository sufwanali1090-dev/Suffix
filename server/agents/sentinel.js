/**
 * sentinel.js — SENTINEL · RISK OFFICER. The only agent with a veto.
 *
 * Sentinel does three things nobody else may do:
 *   1. size a position (capital ÷ stop distance, capped by the concentration limit);
 *   2. set the stop;
 *   3. sign, or refuse to sign, a proposal — with an Ed25519 key it holds and
 *      no other agent receives.
 *
 * Because Pilot verifies against the matching public key, "nothing trades
 * without Sentinel's sign-off" is not a rule someone can forget: it is a
 * signature check. The defaults below are deliberately conservative, and every
 * veto states the number that caused it.
 */
import { config } from '../config.js';
import { report, stats, NO_DATA } from './base.js';
import { fmtPrice, fmtUsd, round } from '../util.js';
import { signDigest } from '../keys.js';

const LIMITS = config.risk;

export function sizePosition({ equity, price, stopDistance, atr, side }) {
  const riskBudget = equity * (LIMITS.maxRiskPct / 100);
  const stop = Number.isFinite(stopDistance) && stopDistance > 0 ? stopDistance : Math.max(atr * 1.5, price * 0.03);
  const byRisk = Math.floor(riskBudget / Math.max(0.01, stop));
  const byConcentration = Math.floor((equity * (LIMITS.maxPositionPct / 100)) / Math.max(0.01, price));
  const qty = Math.max(0, Math.min(byRisk, byConcentration));
  return {
    qty,
    riskPerShare: round(stop, 4),
    riskTotal: round(qty * stop, 2),
    riskPct: round((qty * stop) / Math.max(1, equity) * 100, 2),
    notional: round(qty * price, 2),
    positionPct: round((qty * price) / Math.max(1, equity) * 100, 2),
    caps: { maxRiskPct: LIMITS.maxRiskPct, maxPositionPct: LIMITS.maxPositionPct },
    side: side === 'sell' ? 'sell' : 'buy',
    stopsFrom: `stop distance = ${fmtPrice(stop)} (max of 1.5×ATR ${fmtPrice(atr * 1.5)} and 3% of price ${fmtPrice(price * 0.03)})`,
  };
}

/** The checklist. Returns { approved, reasons, conditions, halve }. */
function evaluate({ proposal, quote, hist, session, nextEvent, blotter, oracle }) {
  const reasons = [];
  const conditions = [];
  let halve = false;
  const price = quote?.ok ? quote.price : null;

  if (!price) {
    reasons.push({ code: 'NO_PRICE', text: `No verified price for ${proposal.symbol} (${quote?.reason ?? 'feed silent'}). I do not size against a guess.`, veto: true });
    return { approved: false, reasons, conditions, halve };
  }
  const atr = hist?.ok ? stats.atr({ highs: hist.highs, lows: hist.lows, closes: hist.closes }, 14) : null;
  if (!Number.isFinite(atr)) {
    reasons.push({ code: 'NO_ATR', text: 'No candle history on this tier, so the stop has no noise floor. Sized on a 3% floor instead — treat that as wide.', veto: false });
    conditions.push('wider stop than usual: no ATR available');
  }
  if (proposal.status !== 'pending' && proposal.status !== undefined && proposal.status !== 'drafted') {
    reasons.push({ code: 'STALE', text: `proposal already ${proposal.status}`, veto: true });
  }
  if (session && session.phase !== 'open') {
    reasons.push({
      code: 'SESSION',
      text: `${session.label} — thin book, wide spreads.`,
      veto: session.phase === 'closed',
    });
    if (session.phase !== 'closed') {
      halve = true;
      conditions.push('size halved for off-hours liquidity');
    }
  }
  if (nextEvent?.imminent) {
    reasons.push({
      code: 'EVENT_RISK',
      text: `${nextEvent.label} in ${nextEvent.daysAway} day${nextEvent.daysAway === 1 ? '' : 's'} — a gap ignores your stop.`,
      veto: false,
    });
    halve = true;
    conditions.push(`half size into ${nextEvent.label}`);
  }
  const exposure = blotter?.exposure?.() ?? { notional: 0, notionalPct: 0, openPositions: 0 };
  const equity = blotter?.state?.equity ?? LIMITS.equity;
  const maxNotional = equity * (LIMITS.maxPositionPct / 100);
  if (exposure.notional + maxNotional > equity * 0.6) {
    reasons.push({ code: 'EXPOSURE', text: `open notional ${fmtUsd(exposure.notional)} (${exposure.notionalPct}% of equity) would breach 60% deployment`, veto: true });
  }
  const atRisk = blotter?.atRisk?.() ?? 0;
  const plannedRisk = round((proposal.qty || 1) * Math.max(0.01, price - (proposal.stop || price * 0.97)), 2);
  if (atRisk + plannedRisk > equity * (LIMITS.maxRiskPct / 100) * 1.0001) {
    reasons.push({
      code: 'HEAT',
      text: `book already risks ${fmtUsd(atRisk)}; this adds ${fmtUsd(plannedRisk)} against a ${fmtUsd(equity * (LIMITS.maxRiskPct / 100))} cap`,
      veto: false,
    });
    halve = true;
    conditions.push('reduced so total heat stays inside the risk budget');
  }
  const dayPnl = blotter?.state ? round(blotter.state.equity - (blotter.state.startEquity || LIMITS.equity), 2) : 0;
  if (dayPnl < 0 && Math.abs(dayPnl) > equity * (LIMITS.maxDailyLossPct / 100)) {
    reasons.push({ code: 'DAILY_STOP', text: `realised ${fmtUsd(dayPnl)} breaches the ${LIMITS.maxDailyLossPct}% daily stop — desk is off for the day`, veto: true });
  }
  if (oracle?.data?.probUpPct !== undefined && proposal.side === 'buy' && oracle.data.probUpPct < 42) {
    reasons.push({ code: 'ODDS', text: `model puts only ${oracle.data.probUpPct}% probability of finishing higher — the quant does not like this one`, veto: false });
    conditions.push('proceed knowing the model leans against you');
  }
  if (feedSim(proposal)) {
    // Deliberate: a simulated price still gets a loud marker rather than a veto,
    // so the gated path is demonstrable — but the stamp records that no real
    // quote stands behind it, and Pilot's fill is labelled the same way.
    reasons.push({ code: 'SIM_FEED', text: 'price came from the labelled SIM feed — nothing here is market-verified', veto: false });
    conditions.push('SIM DATA: stamp is for demonstrating the gate, not for a real book');
  }
  return { approved: !reasons.some((r) => r.veto), reasons, conditions, halve };
}

function feedSim(proposal) {
  return proposal?.context?.simulated === true;
}

export const definition = {
  id: 'sentinel',
  async handle({ params, services, feed, session, nextEvent, reports }) {
    const { approvals, blotter, keys } = services;
    const proposalId = params?.proposalId || params?.proposal;

    // --- Standalone risk read: heat of the book, limits, and what I would veto.
    if (!proposalId) {
      const exposure = blotter.exposure();
      const st = blotter.list();
      const atRisk = blotter.atRisk();
      const budget = round(LIMITS.equity * (LIMITS.maxRiskPct / 100), 2);
      const rows = await feed.quotesFor(feed.watch.slice(0, 4));
      const heat = round((atRisk / Math.max(1, budget)) * 100, 0);
      return report('sentinel', {
        headline: `Heat ${heat}% of the ${fmtUsd(budget)} risk budget · ${exposure.openPositions} open · ${LIMITS.mode} mode`,
        bullets: [
          `Equity ${fmtUsd(st.equity)} · deployed ${fmtUsd(exposure.notional)} (${exposure.notionalPct}%) · capital at risk to stops ${fmtUsd(atRisk)}.`,
          `Standing limits: ${LIMITS.maxRiskPct}% of equity per trade, ${LIMITS.maxPositionPct}% per position, ${LIMITS.maxDailyLossPct}% daily stop.`,
          `Realised in the blotter: ${fmtUsd(exposure.realisedPnl)}.`,
          `Tape right now: ${rows.filter((r) => r.ok && r.changePct < 0).length}/${rows.length} down — I do not add to a falling book without a level.`,
          nextEvent ? `Event risk: ${nextEvent.label} (${nextEvent.date}), ${nextEvent.daysAway}d out.` : 'No scheduled event inside the calendar window.',
          `Execution mode is "${LIMITS.mode}". There is no broker adapter in this build; nothing here can move real money.`,
        ],
        speech: `Book health: ${heat}% of today's risk budget used, ${exposure.openPositions} position${exposure.openPositions === 1 ? '' : 's'} open, ${fmtUsd(atRisk)} at risk against stops. My limits are ${LIMITS.maxRiskPct} percent a trade and ${LIMITS.maxPositionPct} percent in a name. My favourite word is still no.`,
        data: { heatPct: heat, atRisk, equity: st.equity, exposure, limits: LIMITS, vetoesToday: approvals.list().filter((p) => p.status === 'vetoed').length },
        actions: heat > 100 ? [{ type: 'alert', text: `Risk budget exceeded: ${fmtUsd(atRisk)} at risk vs ${fmtUsd(budget)} cap`, severity: 'danger', dedupe: 'sentinel-heat' }] : [],
      });
    }

    // --- The gate itself: read the proposal, run the checklist, sign or refuse.
    const proposal = approvals.get(proposalId);
    if (!proposal) return report('sentinel', { status: 'error', headline: 'Unknown proposal', bullets: [`${proposalId} is not in the approval ledger.`], speech: 'That proposal is not in my ledger. I will not sign what I cannot see.' });

    const [quote, hist] = await Promise.all([feed.quote(proposal.symbol), feed.history(proposal.symbol, { days: 90 })]);
    const verdict = evaluate({ proposal, quote, hist, session, nextEvent, blotter, oracle: reports?.oracle });
    const sizing = sizePosition({
      equity: blotter?.state?.equity ?? LIMITS.equity,
      price: quote?.ok ? quote.price : proposal.entry || 0,
      stopDistance: proposal.entry && proposal.stop ? Math.abs(proposal.entry - proposal.stop) : null,
      atr: hist?.ok ? stats.atr({ highs: hist.highs, lows: hist.lows, closes: hist.closes }, 14) ?? 0 : 0,
      side: proposal.side,
    });
    let qty = sizing.qty;
    if (verdict.halve) qty = Math.floor(qty / 2);
    const stop = proposal.stop ?? round((quote?.ok ? quote.price : proposal.entry) - sizing.riskPerShare, 2);
    const target = proposal.target ?? round((quote?.ok ? quote.price : proposal.entry) + Math.max(sizing.riskPerShare * 2, 0.01), 2);

    const decision = {
      approved: verdict.approved,
      reason: verdict.approved
        ? `sized to ${fmtUsd(sizing.riskTotal)} (${sizing.riskPct}% of equity) with the stop ${fmtPrice(sizing.riskPerShare)} away`
        : verdict.reasons.filter((r) => r.veto).map((r) => r.text).join('; ') || 'not comfortable',
      size: qty,
      stop,
      target,
      conditions: verdict.conditions,
      signedBy: 'sentinel',
    };
    const digest = approvals.digestOf(proposal, decision);
    decision.signature = signDigest(keys.privatePem, digest);
    const stamped = approvals.stamp(proposalId, decision);

    const lines = verdict.reasons.length
      ? verdict.reasons.map((r) => `${r.veto ? 'VETO' : 'note'} · ${r.code}: ${r.text}`)
      : ['no objections on size, session, event risk or book heat'];

    return report('sentinel', {
      status: verdict.approved ? 'ok' : 'veto',
      headline: verdict.approved
        ? `STAMPED ${proposal.side} ${qty} ${proposal.symbol} @ stop ${fmtPrice(stop)} · risk ${fmtUsd(sizing.riskTotal)}`
        : `VETO on ${proposal.symbol} — ${decision.reason.slice(0, 90)}`,
      bullets: [
        ...lines,
        verdict.approved ? `Approved size: ${qty} shares — ${sizing.stopsFrom}.` : `Proposed ${proposal.qty || 'your'} shares. I cut nothing; I said no.`,
        `Position math: risk budget ${fmtUsd(round((blotter?.state?.equity ?? LIMITS.equity) * (LIMITS.maxRiskPct / 100), 2))} ÷ stop distance ${fmtPrice(sizing.riskPerShare)} = ${sizing.qty} shares (concentration cap ${sizing.qty ? Math.floor((LIMITS.equity * (LIMITS.maxPositionPct / 100)) / Math.max(0.01, quote?.price || 1)) : 0}).`,
        `Stamp: ed25519/${verdict.approved ? 'approved' : 'refused'} · digest ${digest.slice(0, 12)}… · Pilot cannot manufacture this.`,
      ],
      speech: verdict.approved
        ? `Stamped. ${qty} shares of ${proposal.symbol}, stop at ${fmtPrice(stop)}, risk ${fmtUsd(sizing.riskTotal)}. ${verdict.conditions.length ? `Conditions: ${verdict.conditions.join(', ')}.` : 'No conditions.'} Pilot may execute once the operator confirms.`
        : `No. ${decision.reason}. That is a veto, and Pilot has nothing to execute.`,
      data: { proposalId, approved: verdict.approved, sizing, decision, checks: verdict.reasons, stampedOk: stamped.ok },
      actions: verdict.approved
        ? [{ type: 'alert', text: `Sentinel stamped ${proposal.side} ${qty} ${proposal.symbol}`, severity: 'info', dedupe: `stamp-${proposalId}` }]
        : [{ type: 'alert', text: `Sentinel VETOED ${proposal.symbol}: ${decision.reason}`, severity: 'danger', dedupe: `veto-${proposalId}` }],
    });
  },
};

export { evaluate as evaluateProposal, LIMITS };
