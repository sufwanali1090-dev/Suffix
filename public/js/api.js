/**
 * api.js — the HUD's entire relationship with the desk: two verbs and one
 * stream. Panels never fetch market data on their own; they render what the
 * server published, so a dead feed shows as "—" everywhere at once.
 */
export const DASH = '—';

/** A missing value is `null`, and `Number(null) === 0` — so every formatter here
 *  rejects null/undefined/'' *before* coercion. A dash is a statement about the
 *  feed; a zero is a statement about your account. */
const missing = (v) => v === null || v === undefined || v === '' || !Number.isFinite(Number(v));

export const fmt = {
  price: (v, dp) => {
    const n = Number(v);
    if (missing(v)) return DASH;
    const d = dp ?? (n >= 1000 ? 0 : n >= 1 ? 2 : 4);
    return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  },
  pct: (v, dp = 2) => {
    const n = Number(v);
    if (missing(v)) return DASH;
    return `${n > 0 ? '+' : ''}${n.toFixed(dp)}%`;
  },
  usd: (v) => (!missing(v) ? Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: Math.abs(Number(v)) >= 1000 ? 0 : 2 }) : DASH),
  ms: (v) => (!missing(v) ? `${Math.round(Number(v))}ms` : DASH),
  clock: (d = new Date()) => d.toTimeString().slice(0, 8),
  hhmm: (iso) => (iso ? new Date(iso).toTimeString().slice(0, 5) : '--:--'),
};

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function req(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(json?.error || `${res.status} ${res.statusText}`);
  return json;
}

export const api = {
  get: (p) => req('GET', p),
  post: (p, body) => req('POST', p, body ?? {}),
  /**
   * SSE subscription with reconnect. `handlers` maps event type → fn(event).
   * A special `*` handler sees everything (used for replay/debug).
   */
  stream(handlers) {
    let es;
    let closed = false;
    const connect = () => {
      if (closed) return;
      es = new EventSource('/api/stream');
      es.onopen = () => document.body.classList.remove('offline');
      es.onerror = () => {
        document.body.classList.add('offline');
        es.close();
        setTimeout(connect, 2500);
      };
      for (const type of Object.keys(handlers)) {
        if (type === '*') continue;
        es.addEventListener(type, (e) => {
          try { handlers[type](JSON.parse(e.data)); } catch (err) { console.warn(type, err); }
        });
      }
      es.onmessage = (e) => {
        try { handlers['*']?.(JSON.parse(e.data)); } catch { /* ignore */ }
      };
    };
    connect();
    return () => { closed = true; es?.close(); };
  },
  command: (text) => req('POST', '/api/command', { text, source: 'hud' }),
};
