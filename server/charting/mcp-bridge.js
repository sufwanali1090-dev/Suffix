/**
 * mcp-bridge.js — the desk's hands on the real charts.
 *
 * Chartist never renders a picture of a chart; it issues commands. Two sinks:
 *   1. the in-app SVG chart (always, via the bus → HUD), so the desk works
 *      with nothing installed;
 *   2. your actual TradingView Desktop, when TRADINGVIEW_MCP_URL points at an
 *      MCP bridge that speaks {action, payload} (see docs/TRADINGVIEW-MCP.md).
 *
 * If sink 2 is not configured we say so out loud instead of quietly "drawing"
 * on a chart nobody is looking at.
 */
import { config } from '../config.js';
import { fetchJson, nowIso } from '../util.js';

export const CHART_ACTIONS = [
  'setSymbol',
  'setInterval',
  'drawLevel',
  'clearLevels',
  'annotate',
  'focusOrb',
  'screenshot',
];

/** Action name → the verb your MCP/TradingView tool understands. */
const VERB_MAP = {
  setSymbol: 'switch_symbol',
  setInterval: 'set_timeframe',
  drawLevel: 'add_price_line',
  clearLevels: 'remove_all_price_lines',
  annotate: 'add_note',
  focusOrb: null,
  screenshot: 'capture_chart',
};

export class McpBridge {
  constructor(url = config.tradingview.mcpUrl) {
    this.url = url;
    this.log = [];
    this.lastError = null;
  }

  get configured() {
    return Boolean(this.url);
  }

  status() {
    return {
      configured: this.configured,
      url: this.url || null,
      lastError: this.lastError,
      sent: this.log.length,
      recent: this.log.slice(-8).reverse(),
    };
  }

  async send(action, payload = {}) {
    const record = { at: nowIso(), action, payload, ok: false, reason: null };
    if (!CHART_ACTIONS.includes(action)) {
      record.reason = `unknown chart action "${action}"`;
      this.lastError = record.reason;
      return record;
    }
    if (!this.configured) {
      record.reason = 'TRADINGVIEW_MCP_URL not set — drew on the desk chart only';
      this.log.push(record);
      return record;
    }
    const verb = VERB_MAP[action] ?? action;
    const body = {
      action: verb,
      symbol: payload.symbol ?? undefined,
      interval: payload.interval ?? undefined,
      price: payload.price ?? undefined,
      label: payload.label ?? undefined,
      color: payload.color ?? undefined,
      text: payload.note ?? payload.text ?? undefined,
    };
    const res = await fetchJson(this.url, {
      method: 'POST',
      timeoutMs: 6000,
      headers: { 'content-type': 'application/json' },
      body,
    });
    if (!res.ok) {
      record.reason = `bridge ${res.reason}`;
      this.lastError = record.reason;
    } else {
      record.ok = true;
      record.reply = res.json ?? null;
      this.lastError = null;
    }
    this.log.push(record);
    if (this.log.length > 200) this.log.shift();
    return record;
  }
}

export const mcpBridge = new McpBridge();
