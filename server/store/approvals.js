/**
 * approvals.js — the single gated path between "the desk has an idea" and
 * "money moved".
 *
 * Lifecycle:
 *   drafted ──► pending ──► stamped | vetoed        (Sentinel signs or vetoes)
 *                              │
 *                        confirmed (human)
 *                              │
 *                        executed (Pilot, one shot, idempotent)
 *
 * Invariants enforced here, not in prose:
 *   • a stamp is only valid if it carries an Ed25519 signature from the
 *     Sentinel key over the canonical digest of the proposal + decision;
 *   • `stampedBy` must be 'sentinel' — an agent that is not Sentinel cannot
 *     produce a signature that verifies, so self-authorization is impossible
 *     by construction rather than by policy;
 *   • execution consumes the stamp: the same approval can never fund two trades.
 */
import { config } from '../config.js';
import { canonicalJson, nowIso, sha256, uid, round } from '../util.js';
import { verifyDigest } from '../keys.js';

export const PROPOSAL_STATES = [
  'drafted',
  'pending',
  'stamped',
  'vetoed',
  'confirmed',
  'executed',
  'failed',
];

export class ApprovalLedger {
  constructor({ publicKeyPem, bus, journal }) {
    this.publicKeyPem = publicKeyPem;
    this.bus = bus;
    this.journal = journal;
    this.byId = new Map();
  }

  digestOf(proposal, decision) {
    return sha256(
      canonicalJson({
        id: proposal.id,
        symbol: proposal.symbol,
        side: proposal.side,
        qty: proposal.qty,
        entry: proposal.entry,
        stop: proposal.stop,
        target: proposal.target,
        decision: decision.decision,
        conditions: decision.conditions ?? null,
      })
    );
  }

  create(input) {
    const proposal = {
      id: uid('prop'),
      at: nowIso(),
      requestedBy: input.requestedBy ?? 'operator',
      symbol: String(input.symbol || '').toUpperCase(),
      side: input.side === 'sell' ? 'sell' : 'buy',
      qty: round(Number(input.qty) || 0, 4),
      entry: round(Number(input.entry), 4),
      stop: round(Number(input.stop), 4),
      target: input.target === undefined ? null : round(Number(input.target), 4),
      thesis: input.thesis ?? '',
      context: input.context ?? {},
      status: 'pending',
      stamp: null,
      humanConfirmedAt: null,
      execution: null,
    };
    this.byId.set(proposal.id, proposal);
    this.bus.emitEvent('trade.proposed', { proposal }, { agent: 'pilot' });
    this.journal.append({
      kind: 'command',
      agent: 'pilot',
      text: `proposal ${proposal.id} ${proposal.side} ${proposal.qty} ${proposal.symbol}`,
    });
    return proposal;
  }

  get(id) {
    return this.byId.get(id) ?? null;
  }

  list({ limit = 50 } = {}) {
    return [...this.byId.values()].slice(-limit).reverse();
  }

  pending() {
    return [...this.byId.values()].filter((p) => p.status === 'pending' || p.status === 'stamped');
  }

  /**
   * Called by Sentinel only. `signature` must sign `digestOf(proposal, decision)`.
   */
  stamp(proposalId, decision) {
    const proposal = this.byId.get(proposalId);
    if (!proposal) return { ok: false, error: 'unknown proposal' };
    if (proposal.status !== 'pending') {
      return { ok: false, error: `proposal already ${proposal.status}` };
    }
    const expected = this.digestOf(proposal, decision);
    const signed = decision.signature && verifyDigest(this.publicKeyPem, expected, decision.signature);
    if (!signed) {
      this.bus.alert('sentinel', `Rejected an unstamped/unverifiable approval for ${proposal.symbol}`, 'danger');
      return { ok: false, error: 'signature invalid — only Sentinel can stamp a proposal' };
    }
    if (decision.signedBy !== 'sentinel') {
      return { ok: false, error: `stamp must come from the risk officer, got "${decision.signedBy}"` };
    }
    if (decision.approved) {
      proposal.status = 'stamped';
      proposal.stamp = {
        approved: true,
        signedAt: nowIso(),
        signedBy: 'sentinel',
        size: decision.size ?? proposal.qty,
        stop: decision.stop ?? proposal.stop,
        target: decision.target ?? proposal.target,
        conditions: decision.conditions ?? [],
        reason: decision.reason ?? '',
        signature: decision.signature,
        digest: expected,
      };
      proposal.qty = proposal.stamp.size; // the risk officer sizes the trade
      proposal.stop = proposal.stamp.stop;
      proposal.target = proposal.stamp.target;
      this.journal.append({
        kind: 'approval',
        agent: 'sentinel',
        text: `stamped ${proposal.id} ${proposal.side} ${proposal.qty} ${proposal.symbol}`,
        reason: decision.reason,
      });
      this.bus.emitEvent('trade.stamped', { proposal }, { agent: 'sentinel' });
      return { ok: true, proposal };
    }
    proposal.status = 'vetoed';
    proposal.stamp = {
      approved: false,
      signedAt: nowIso(),
      signedBy: 'sentinel',
      reason: decision.reason ?? 'veto',
      conditions: decision.conditions ?? [],
      signature: decision.signature,
      digest: expected,
    };
    this.journal.append({
      kind: 'veto',
      agent: 'sentinel',
      text: `vetoed ${proposal.id} ${proposal.symbol} — ${decision.reason ?? 'no reason given'}`,
      reason: decision.reason,
    });
    this.bus.emitEvent('trade.vetoed', { proposal }, { agent: 'sentinel', severity: 'warn' });
    return { ok: true, proposal };
  }

  /** The operator's nod. Needed on top of the stamp: two keys turn. */
  confirmHuman(proposalId, { confirmed = true, by = 'operator' } = {}) {
    const proposal = this.byId.get(proposalId);
    if (!proposal) return { ok: false, error: 'unknown proposal' };
    if (proposal.status !== 'stamped') {
      return { ok: false, error: `nothing to confirm (status: ${proposal.status})` };
    }
    if (!confirmed) {
      proposal.status = 'vetoed';
      proposal.stamp = { ...proposal.stamp, approved: false, reason: 'declined by operator' };
      this.bus.emitEvent('trade.vetoed', { proposal }, { agent: 'friday', severity: 'warn' });
      return { ok: true, proposal, declined: true };
    }
    proposal.humanConfirmedAt = nowIso();
    proposal.confirmedBy = by;
    proposal.status = 'confirmed';
    this.bus.emitEvent('trade.confirmed', { proposal }, { agent: 'friday' });
    return { ok: true, proposal };
  }

  /** Pilot calls this. A stamp that has already funded a trade is worthless. */
  claimForExecution(proposalId) {
    const proposal = this.byId.get(proposalId);
    if (!proposal) return { ok: false, error: 'unknown proposal' };
    if (proposal.status !== 'confirmed') {
      return {
        ok: false,
        error:
          proposal.status === 'stamped'
            ? 'stamped but not confirmed by operator'
            : `no valid stamp (status: ${proposal.status})`,
        requires: 'SENTINEL_STAMP',
      };
    }
    if (proposal.execution) return { ok: false, error: 'stamp already consumed' };
    return { ok: true, proposal };
  }

  markExecuted(proposalId, execution) {
    const proposal = this.byId.get(proposalId);
    if (!proposal) return null;
    proposal.execution = { ...execution, at: nowIso() };
    proposal.status = execution?.ok ? 'executed' : 'failed';
    this.bus.emitEvent('trade.executed', { proposal }, { agent: 'pilot' });
    return proposal;
  }
}

export const riskLimits = config.risk;
