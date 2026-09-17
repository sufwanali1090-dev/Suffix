/**
 * blotter.js — PAPER blotter. There is no broker adapter in this codebase and
 * that is deliberate: `EXECUTION_MODE=live` refuses to run rather than pretend.
 * Positions live in data/blotter/positions.json so a restart doesn't forget
 * the desk's open risk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { nowIso, round, uid } from '../util.js';

export class PaperBlotter {
  constructor({ bus, journal } = {}) {
    this.bus = bus;
    this.journal = journal;
    this.file = path.join(config.blotterDir, 'positions.json');
    this.state = { opened: [], closed: [], equity: config.risk.equity, startEquity: config.risk.equity };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (!Number.isFinite(this.state.startEquity)) this.state.startEquity = config.risk.equity;
      }
    } catch {
      /* corrupt file: start clean rather than crash the desk */
    }
  }

  save() {
    try {
      fs.mkdirSync(config.blotterDir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    } catch (err) {
      this.journal?.append({ kind: 'error', agent: 'ledger', text: `blotter write failed: ${err.message}` });
    }
  }

  exposure() {
    const cost = this.state.opened.reduce(
      (sum, p) => sum + (p.qty || 0) * (p.avgPrice || p.entry || 0),
      0
    );
    return {
      openPositions: this.state.opened.length,
      notional: round(cost, 2),
      notionalPct: this.state.equity ? round((cost / this.state.equity) * 100, 2) : null,
      realisedPnl: round(
        this.state.closed.reduce((s, p) => s + (p.pnl || 0), 0),
        2
      ),
    };
  }

  atRisk() {
    // Sum of distance to stop for open positions: the number Sentinel guards.
    const risk = this.state.opened.reduce((sum, p) => {
      const stopDist = Math.abs((p.avgPrice || p.entry || 0) - (p.stop || 0));
      return sum + stopDist * (p.qty || 0);
    }, 0);
    return round(risk, 2);
  }

  submit({ proposal, quote }) {
    if (config.risk.mode !== 'paper') {
      return {
        ok: false,
        error: `EXECUTION_MODE=${config.risk.mode} is not supported by this build — no broker adapter exists. Use "paper".`,
      };
    }
    const { symbol, side, qty, entry, stop, target } = proposal;
    const price = Number(entry) || Number(quote?.price) || 0;
    if (!symbol || !qty || !price) {
      return { ok: false, error: 'incomplete proposal (symbol/qty/entry required)' };
    }
    const fills = round(price, 4);
    const existing = this.state.opened.find((p) => p.symbol === symbol && p.side === side);
    if (existing) {
      const total = existing.qty + qty;
      existing.avgPrice = round((existing.avgPrice * existing.qty + fills * qty) / total, 4);
      existing.qty = total;
      existing.stop = stop ?? existing.stop;
      existing.target = target ?? existing.target;
      existing.at = nowIso();
    } else {
      this.state.opened.push({
        id: uid('pos'),
        symbol,
        side,
        qty,
        avgPrice: fills,
        entry: fills,
        stop: stop ?? null,
        target: target ?? null,
        proposalId: proposal.id,
        at: nowIso(),
      });
    }
    this.state.equity = round(this.state.equity, 2);
    this.save();
    const fill = {
      ok: true,
      mode: 'paper',
      symbol,
      side,
      qty,
      fillPrice: fills,
      stop: stop ?? null,
      target: target ?? null,
      ticket: `PAPER-${Date.now().toString(36).toUpperCase()}`,
      note: 'Simulated fill. No order left this machine.',
    };
    this.bus?.emitEvent('trade.fill', { fill }, { agent: 'pilot' });
    this.journal?.append({
      kind: 'execution',
      agent: 'pilot',
      text: `paper ${side} ${qty} ${symbol} @ ${fills} (stamp ${proposal.stamp?.digest?.slice(0, 8)})`,
      ms: 0,
      status: 'ok',
    });
    return fill;
  }

  close(positionId) {
    const idx = this.state.opened.findIndex((p) => p.id === positionId);
    if (idx === -1) return { ok: false, error: 'unknown position' };
    const [pos] = this.state.opened.splice(idx, 1);
    const exit = pos.lastPrice ?? pos.avgPrice;
    const pnl = round((exit - pos.avgPrice) * pos.qty * (pos.side === 'sell' ? -1 : 1), 2);
    this.state.closed.push({ ...pos, exit, pnl, closedAt: nowIso() });
    this.state.equity = round(this.state.equity + pnl, 2);
    this.save();
    return { ok: true, position: pos, pnl };
  }

  list() {
    return { ...this.state, exposure: this.exposure(), atRisk: this.atRisk() };
  }
}
