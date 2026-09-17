/**
 * journal.js — Ledger's memory. Every call the desk makes is appended as one
 * JSON line per day. Analysis, vetoes, executions, failures — all of it, with
 * bad calls given the same fidelity as good ones.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { nowIso } from '../util.js';

const day = (d = new Date()) => d.toISOString().slice(0, 10);

export class Journal {
  constructor(dir = config.journalDir) {
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.buffer = [];
  }

  file(dayStr = day()) {
    return path.join(this.dir, `${dayStr}.jsonl`);
  }

  append(entry) {
    const rec = { at: nowIso(), ...entry };
    this.buffer.push(rec);
    try {
      fs.appendFileSync(this.file(), `${JSON.stringify(rec)}\n`);
    } catch (err) {
      // A dead ledger is a real problem, not a silent one: shout about it.
      console.error('[journal] write failed:', err.message);
      rec.writeError = err.message;
    }
    return rec;
  }

  readRecent({ days = 30, limit = 500 } = {}) {
    const out = [];
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse()
      .slice(0, days);
    for (const f of files) {
      try {
        const lines = fs
          .readFileSync(path.join(this.dir, f), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean);
        for (const line of lines.reverse()) {
          try {
            out.push(JSON.parse(line));
          } catch {
            /* skip malformed line */
          }
          if (out.length >= limit) return out.reverse();
        }
      } catch {
        /* ignore unreadable file */
      }
    }
    return out.reverse();
  }

  /** Desk health: what Ledger reports to the Agent Load / health panel. */
  stats() {
    const entries = this.readRecent({ days: 30, limit: 5000 });
    const by = { command: 0, report: 0, veto: 0, approval: 0, execution: 0, error: 0 };
    const latencies = [];
    const byAgent = new Map();
    for (const e of entries) {
      if (by[e.kind] !== undefined) by[e.kind] += 1;
      if (Number.isFinite(e.ms)) latencies.push(e.ms);
      if (e.agent) {
        const row = byAgent.get(e.agent) || { agent: e.agent, calls: 0, ms: 0, errors: 0 };
        row.calls += 1;
        row.ms += Number.isFinite(e.ms) ? e.ms : 0;
        if (e.status === 'error' || e.status === 'blocked') row.errors += 1;
        byAgent.set(e.agent, row);
      }
    }
    const total = entries.length;
    return {
      total,
      counts: by,
      vetoRate:
        by.approval + by.veto > 0 ? (by.veto / (by.approval + by.veto)) * 100 : null,
      avgLatencyMs: latencies.length
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : null,
      p95LatencyMs: latencies.length
        ? [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)] ?? null
        : null,
      perAgent: [...byAgent.values()]
        .map((r) => ({ ...r, avgMs: r.calls ? Math.round(r.ms / r.calls) : 0 }))
        .sort((a, b) => b.calls - a.calls),
      files: fs.readdirSync(this.dir).filter((f) => f.endsWith('.jsonl')).length,
      path: `data/journal/${day()}.jsonl`,
    };
  }
}

export const journal = new Journal();
