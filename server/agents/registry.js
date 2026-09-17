/**
 * registry.js — where a definition becomes a running agent.
 *
 * Each specialist is an ordinary module exporting `definition`. The registry
 * instruments it (timing, state broadcast, crash containment) and decides
 * whether to call it in-process or over HTTP. Same interface either way, so
 * "one master, many independent services" is a config value, not a rewrite:
 *
 *   1. add a file in server/agents/ and an entry in roster.js
 *   2. `npm run agent oracle` starts it on its own port
 *   3. set `remote: 'http://127.0.0.1:8806'` on the roster entry
 *   4. nothing else in the desk changes — including the master
 */
import { ROSTER } from './roster.js';
import { instrument, report } from './base.js';
import { fetchJson } from '../util.js';
import { describeSession } from '../data/session.js';
import { buildCalendar, nextEventRisk } from '../data/events.js';
import { DeskFeed } from '../data/provider.js';
import { journal as sharedJournal } from '../store/journal.js';
import { mcpBridge } from '../charting/mcp-bridge.js';

import { definition as atlas } from './atlas.js';
import { definition as capitol } from './capitol.js';
import { definition as scout } from './scout.js';
import { definition as athena } from './athena.js';
import { definition as chartist } from './chartist.js';
import { definition as oracle } from './oracle.js';
import { definition as sentinel } from './sentinel.js';
import { definition as pilot } from './pilot.js';
import { definition as ledger } from './ledger.js';

export const DEFINITIONS = { atlas, capitol, scout, athena, chartist, oracle, sentinel, pilot, ledger };

const PORT_BASE = 8800;
export function agentPort(id) {
  const idx = ROSTER.findIndex((a) => a.id === id);
  return PORT_BASE + (idx < 0 ? 99 : idx + 1);
}

/** Serialise the live context an agent needs; nothing sensitive goes over HTTP. */
export function serializeContext(ctx) {
  return {
    text: ctx.text,
    intent: ctx.intent,
    symbol: ctx.symbol,
    params: ctx.params ?? {},
    reports: ctx.reports
      ? Object.fromEntries(Object.entries(ctx.reports).map(([k, v]) => [k, { status: v.status, data: v.data, headline: v.headline }]))
      : undefined,
    session: ctx.session,
    nextEvent: ctx.nextEvent,
    feedMode: ctx.feed?.mode,
  };
}

/**
 * @param {object} services { bus, journal, approvals, blotter, keys, mcp }
 * @returns {{ agents: Map, call: Function, load: Map }}
 */
export function buildAgents(services) {
  const agents = new Map();
  for (const def of Object.values(DEFINITIONS)) {
    const seat = ROSTER.find((a) => a.id === def.id) ?? {};
    // Roster metadata travels with the runtime agent so error copy and state
    // broadcasts can name the seat, not the module.
    agents.set(def.id, instrument({ ...seat, ...def }, services));
  }
  const load = new Map(ROSTER.map((a) => [a.id, { agent: a.id, calls: 0, ms: 0, errors: 0, vetoes: 0, lastAt: null, state: 'idle' }]));

  const bump = (id, patch = {}) => {
    const row = load.get(id) || { agent: id, calls: 0, ms: 0, errors: 0, vetoes: 0, lastAt: null, state: 'idle' };
    row.calls += 1;
    row.lastAt = new Date().toISOString();
    load.set(id, { ...row, ...patch });
    services.bus?.emitEvent('agent.load', { load: [...load.values()] }, { agent: id });
  };

  async function call(id, ctx) {
    const seat = ROSTER.find((a) => a.id === id);
    if (!seat) return report(id, { status: 'error', headline: `unknown agent "${id}"` });
    const started = Date.now();
    let out;
    const moneyPath = id === 'sentinel' || id === 'pilot';
    if (seat.remote && !moneyPath) {
      // Independent service: same contract over HTTP.
      const res = await fetchJson(`${String(seat.remote).replace(/\/$/, '')}/invoke`, {
        method: 'POST',
        timeoutMs: 30000,
        headers: { 'content-type': 'application/json' },
        body: { ctx: serializeContext(ctx) },
      });
      out = res.ok && res.json?.report
        ? res.json.report
        : report(id, {
            status: 'error',
            headline: `${seat.name} service unreachable`,
            bullets: [`${seat.remote}/invoke → ${res.reason}`, 'The seat is configured as a remote service. Start it with `npm run agent ' + id + '`, or set remote: null in roster.js.'],
            speech: `${seat.name}'s service is not answering.`,
          });
    } else {
      out = await agents.get(id).run(ctx);
      if (seat.remote && moneyPath) {
        services.bus?.alert('ledger', `${seat.name} is marked remote but the money path must run in-process — the signing key never leaves this process, so the local instance was used`, 'warn', { dedupe: `remote-ignored-${id}` });
      }
    }
    if (out.status === 'error') bump(id, { ms: out.ms ?? Date.now() - started, errors: 1 });
    else bump(id, { ms: out.ms ?? Date.now() - started, vetoes: out.status === 'veto' ? 1 : 0 });
    return out;
  }

  return { agents, call, load };
}

/**
 * Context used by a standalone agent service (server/agent-service.js).
 * Deliberately narrow: no approvals ledger, no signing key. A specialist that
 * is running as its own service cannot approve its own trades by construction.
 */
export function buildStandaloneContext(id, ctx = {}) {
  const feed = new DeskFeed({ bus: null, journal: sharedJournal });
  const now = new Date();
  return {
    text: ctx.text ?? '',
    intent: ctx.intent ?? 'standalone',
    symbol: ctx.symbol ?? null,
    params: ctx.params ?? {},
    reports: ctx.reports ?? {},
    feed,
    session: ctx.session ?? describeSession(now),
    nextEvent: ctx.nextEvent ?? nextEventRisk(now),
    calendar: ctx.calendar ?? buildCalendar(now),
    services: {
      bus: { emitEvent: () => {}, alert: () => {}, agentState: () => {} },
      journal: sharedJournal,
      // Sentinel-only capabilities are absent by design in standalone mode.
      approvals: null,
      blotter: null,
      keys: null,
      mcp: mcpBridge,
    },
  };
}
