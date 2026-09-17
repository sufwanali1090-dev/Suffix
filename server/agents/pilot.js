/**
 * pilot.js — PILOT · EXECUTION. Hands, not opinions.
 *
 * Pilot's entire authority comes from a stamp it cannot produce. Look at the
 * order of operations: it reads the approval ledger, asks the ledger to
 * `claimForExecution` (which verifies the Ed25519 signature and consumes the
 * stamp), and only then touches a blotter. If that claim returns false, there
 * is no code path below it that places anything.
 *
 * What "places" means: a paper fill into data/blotter/. There is no broker
 * adapter in this build, and `EXECUTION_MODE=live` refuses outright.
 */
import { config } from '../config.js';
import { report } from './base.js';
import { fmtPrice, fmtUsd, round } from '../util.js';

export const definition = {
  id: 'pilot',
  async handle({ symbol, params, services, feed, reports }) {
    const { approvals, blotter } = services;
    const proposedQty = Number(params?.qty);
    const side = String(params?.side || 'buy').toLowerCase() === 'sell' ? 'sell' : 'buy';
    const targetSym = String(params?.symbol || symbol || '').toUpperCase();

    // ── Case 1: no stamp yet. Draft the proposal, hand it to Sentinel, do nothing else.
    if (!params?.proposalId) {
      if (!targetSym) {
        return report('pilot', { status: 'blocked', headline: 'No symbol, no proposal', speech: 'Give me a symbol before I write anything down.', bullets: ['usage: "buy 200 NVDA" or "propose a sell on TSLA"'] });
      }
      const quote = await feed.quote(targetSym);
      if (!quote.ok) {
        return report('pilot', {
          status: 'blocked',
          headline: `Cannot draft ${targetSym} — ${quote.reason}`,
          bullets: ['A proposal without a real price is how a desk starts an incident report.', 'Panels showing "—" mean exactly what they say.'],
          speech: `I can't draft that. ${quote.reason}. I will not write a ticket against a number I do not have.`,
          actions: [{ type: 'alert', text: `Pilot blocked: no verified price for ${targetSym}`, severity: 'warn', dedupe: `pilot-noquote-${targetSym}` }],
        });
      }
      const athena = reports?.athena?.status === 'ok' ? reports.athena.data : null;
      const stop = athena?.support ? round(athena.support.price * 0.996, 2) : round(quote.price * 0.97, 2);
      const proposal = approvals.create({
        symbol: targetSym,
        side,
        qty: Number.isFinite(proposedQty) && proposedQty > 0 ? proposedQty : 0, // Sentinel sizes it
        entry: quote.price,
        stop,
        target: athena?.resistance ? athena.resistance.price : round(quote.price * 1.06, 2),
        thesis: reports?.athena?.headline || reports?.oracle?.headline || `operator request: ${side} ${targetSym}`,
        context: {
          requestedAt: quote.asOf,
          quoteSource: quote.source,
          simulated: Boolean(feed.active.sim),
          structure: athena ? { support: athena.support?.price, resistance: athena.resistance?.price, atr: athena.atr } : null,
        },
      });
      return report('pilot', {
        status: 'pending',
        headline: `Drafted ${side} ${targetSym} @ ${fmtPrice(quote.price)} — awaiting Sentinel`,
        bullets: [
          `Ticket ${proposal.id}. Entry ${fmtPrice(proposal.entry)}, protective stop ${fmtPrice(proposal.stop)}, first target ${fmtPrice(proposal.target)}.`,
          proposedQty > 0
            ? `You asked for ${proposedQty} shares. I wrote that as a request, not an order: Sentinel caps it against the risk budget.`
            : 'Size is deliberately 0 in the draft: sizing is the risk officer\'s job, not mine.',
          'Nothing is live until Sentinel stamps it and you confirm. That is the whole design.',
        ],
        speech: `Proposal drafted: ${side} ${targetSym} near ${fmtPrice(quote.price)}. I have not executed anything. Sentinel has to stamp it, then you confirm, then I act.`,
        data: { proposalId: proposal.id, status: proposal.status },
        actions: [
          { type: 'alert', text: `Pilot drafted ${side} ${targetSym} — needs Sentinel's stamp`, severity: 'info', dedupe: `draft-${proposal.id}` },
          { type: 'route', to: 'sentinel', params: { proposalId: proposal.id } },
        ],
      });
    }

    // ── Case 2: a stamp was referenced. Verify first, execute second, journal third.
    // The operator's voice is a human confirmation, but it is still recorded as
    // one — two keys turn, and this branch cannot turn the first one for them.
    if (params?.confirm) {
      const target = approvals.get(params.proposalId);
      if (target?.status === 'stamped') {
        approvals.confirmHuman(params.proposalId, { confirmed: true, by: 'operator:voice' });
      } else if (target?.status === 'pending') {
        return report('pilot', {
          status: 'blocked',
          headline: `Nothing to confirm on ${target.symbol} — Sentinel has not stamped it`,
          bullets: ['Your "confirm" was heard, but there is no stamp to confirm against.', `Ticket ${target.id} is still pending risk review.`],
          speech: 'I hear you, but there is no stamp yet. Sentinel has to sign first. Say "approve it" and I will walk the ticket through.',
          actions: [{ type: 'route', to: 'sentinel', params: { proposalId: target.id } }],
        });
      }
    }
    const claim = approvals.claimForExecution(params.proposalId);
    if (!claim.ok) {
      const proposal = approvals.get(params.proposalId);
      return report('pilot', {
        status: 'blocked',
        headline: `Refused to execute — ${claim.error}`,
        bullets: [
          `Proposal ${params.proposalId} is "${proposal?.status ?? 'unknown'}".`,
          claim.requires === 'SENTINEL_STAMP'
            ? 'The gate is one-way: no signed stamp, no fill. Ask the risk officer.'
            : 'Fix the ticket before asking me again.',
          `Execution mode: ${config.risk.mode}.`,
        ],
        speech: `No. ${claim.error}. Nothing goes out until Sentinel signs. That is not me being slow — that is the design.`,
        data: { proposalId: params.proposalId, reason: claim.error },
        actions: [{ type: 'alert', text: `Pilot refused execution: ${claim.error}`, severity: 'warn', dedupe: `refuse-${params.proposalId}` }],
      });
    }

    const quote = await feed.quote(claim.proposal.symbol);
    const fill = blotter.submit({ proposal: claim.proposal, quote: quote?.ok ? quote : null });
    if (!fill.ok) {
      return report('pilot', {
        status: 'blocked',
        headline: `Execution refused by the blotter — ${fill.error}`,
        bullets: [fill.error],
        speech: 'The blotter refused. Read me: nothing was sent anywhere.',
        actions: [{ type: 'alert', text: `Pilot hard stop: ${fill.error}`, severity: 'danger' }],
      });
    }
    approvals.markExecuted(params.proposalId, { ok: true, ...fill });
    const notional = round(fill.fillPrice * fill.qty, 2);
    return report('pilot', {
      headline: `${fill.mode.toUpperCase()} fill: ${fill.side} ${fill.qty} ${fill.symbol} @ ${fmtPrice(fill.fillPrice)}`,
      bullets: [
        `Ticket ${fill.ticket} · notional ${fmtUsd(notional)} · stop ${fmtPrice(fill.stop)} · target ${fmtPrice(fill.target)}.`,
        'This is a simulated fill written to data/blotter/positions.json. No order left this machine.',
        'Stamp consumed — the same approval cannot fund a second trade.',
      ],
      speech: `Filled. ${fill.side} ${fill.qty} shares of ${fill.symbol} at ${fmtPrice(fill.fillPrice)}, paper ticket ${fill.ticket}. Stop ${fmtPrice(fill.stop)}, target ${fmtPrice(fill.target)}. Nothing real moved.`,
      data: { ...fill, notional, mode: fill.mode },
      actions: [
        { type: 'alert', text: `${fill.mode} fill ${fill.side} ${fill.qty} ${fill.symbol} @ ${fmtPrice(fill.fillPrice)}`, severity: 'info', dedupe: `fill-${fill.ticket}` },
        { type: 'chart', action: 'annotate', payload: { symbol: fill.symbol, note: `fill ${fill.qty} @ ${fmtPrice(fill.fillPrice)}`, price: fill.fillPrice, kind: 'fill' } },
      ],
    });
  },
};
