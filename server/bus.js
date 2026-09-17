/**
 * bus.js — the desk's nervous system.
 *
 * Every agent publishes here (alerts, chart actions, state changes); the HUD
 * subscribes over Server-Sent Events. Agents never talk to the browser
 * directly — the master is the only voice the operator hears, and the bus is
 * the only thing the panels read from.
 */
import { EventEmitter } from 'node:events';
import { nowIso } from './util.js';

const RING_MAX = 400;

export class DeskBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
    this.clients = new Set();
    this.ring = []; // recent events, so a late-loading HUD can replay context
    this.seq = 0;
  }

  /**
   * @param {string} type   e.g. 'alert' | 'agent.state' | 'chart.action' | 'task' | 'reply'
   * @param {object} data
   * @param {object} [meta] { agent, severity, dedupe }
   */
  emitEvent(type, data = {}, meta = {}) {
    const evt = {
      id: ++this.seq,
      type,
      at: nowIso(),
      agent: meta.agent ?? 'friday',
      severity: meta.severity ?? (type === 'alert' ? 'info' : undefined),
      ...data,
    };
    if (meta.dedupe) {
      const last = this.ring.find((e) => e.dedupeKey === meta.dedupe);
      if (last && Date.now() - Date.parse(last.at) < (meta.dedupeMs ?? 120000)) return evt;
      evt.dedupeKey = meta.dedupe;
    }
    this.ring.push(evt);
    if (this.ring.length > RING_MAX) this.ring.shift();
    this.emit('event', evt);
    const payload = `id: ${evt.id}\nevent: ${type}\ndata: ${JSON.stringify(evt)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
    return evt;
  }

  alert(agent, text, severity = 'info', extra = {}) {
    return this.emitEvent('alert', { text, ...extra }, { agent, severity, dedupe: extra.dedupe });
  }

  /** HUD state broadcast: which agent is listening/thinking/speaking. */
  agentState(agent, state, detail = '') {
    return this.emitEvent('agent.state', { state, detail }, { agent });
  }

  subscribe(res) {
    res.write('retry: 3000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ at: nowIso(), replay: this.ring.length })}\n\n`);
    for (const evt of this.ring.slice(-80)) {
      res.write(`id: ${evt.id}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
    }
    this.clients.add(res);
    return () => this.clients.delete(res);
  }

  recent({ type, agent, limit = 50 } = {}) {
    let items = this.ring;
    if (type) items = items.filter((e) => e.type === type);
    if (agent) items = items.filter((e) => e.agent === agent);
    return items.slice(-limit).reverse();
  }
}

export const bus = new DeskBus();
