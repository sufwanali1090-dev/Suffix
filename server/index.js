/**
 * index.js — the desk's process: wiring, HTTP surface, and the ticker.
 *
 * Nothing in this file does market reasoning. It builds the singletons, hands
 * each seat only the capabilities it needs (Sentinel gets the signing key;
 * everyone else gets the public half), exposes the REST + SSE surface the HUD
 * consumes, and keeps the clock honest.
 *
 * One endpoint carries the whole conversation: POST /api/command. The HUD has
 * no other way to ask for anything, which is the point — the master is the only
 * voice the operator hears.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { config, describeConfig } from './config.js';
import { bus } from './bus.js';
import { journal } from './store/journal.js';
import { TaskQueue } from './store/tasks.js';
import { PaperBlotter } from './store/blotter.js';
import { ApprovalLedger } from './store/approvals.js';
import { DeskFeed } from './data/provider.js';
import { describeSession } from './data/session.js';
import { buildCalendar, nextEventRisk } from './data/events.js';
import { mcpBridge } from './charting/mcp-bridge.js';
import { loadSentinelKeys, publicKeyPem, fingerprint } from './keys.js';
import { buildAgents } from './agents/registry.js';
import { AGENTS, GROUPS, MASTER } from './agents/roster.js';
import { Master } from './master.js';
import { fmtCountdown, truncate } from './util.js';
import { llmAvailable } from './llm.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.webm': 'audio/webm',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

// ── singletons ────────────────────────────────────────────────────────────────
const keys = loadSentinelKeys();
const approvals = new ApprovalLedger({ publicKeyPem: publicKeyPem(), bus, journal });
const blotter = new PaperBlotter({ bus, journal });
const queue = new TaskQueue({ bus });
const feed = new DeskFeed({ bus, journal });

const sharedServices = { bus, journal, approvals, blotter, mcp: mcpBridge };
const registry = buildAgents({ ...sharedServices, queue });
/** Capability scoping: the private half exists only inside Sentinel's slice. */
const servicesFor = (id) => (id === 'sentinel' ? { keys } : { keys: null });

const master = new Master({
  bus, journal, queue, feed, approvals, blotter,
  call: registry.call, load: registry.load, mcp: mcpBridge, servicesFor,
});

const state = {
  bootedAt: new Date().toISOString(),
  agentStates: new Map(AGENTS.map((a) => [a.id, 'idle'])),
  commands: 0,
  session: describeSession(),
  calendar: buildCalendar(),
  nextEvent: nextEventRisk(),
};
master.updateContext({ session: state.session, nextEvent: state.nextEvent, calendar: state.calendar });

bus.on('event', (evt) => {
  if (evt.type === 'agent.state') state.agentStates.set(evt.agent, evt.state);
});

// ── helpers ───────────────────────────────────────────────────────────────────
function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(payload);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error('body must be JSON');
  }
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(config.publicDir, path.normalize(rel));
  if (!file.startsWith(config.publicDir)) return json(res, 403, { error: 'forbidden' });
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA-ish fallback so a refresh on any path still lands on the HUD
      const fallback = path.join(config.publicDir, 'index.html');
      if (!fs.existsSync(fallback)) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
      return fs.createReadStream(fallback).pipe(res);
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function deskSnapshot() {
  const health = feed.health();
  return {
    at: new Date().toISOString(),
    bootedAt: state.bootedAt,
    desk: {
      name: MASTER.name,
      role: MASTER.role,
      tagline: MASTER.tagline,
      mode: health.mode,
      commandsHandled: state.commands,
      signingKey: { algorithm: 'ed25519', fingerprint: fingerprint(), generatedAt: keys.generatedAt },
      llm: llmEnabled ? config.llm.model : 'local-router',
    },
    config: describeConfig(),
    feed: health,
    session: { ...state.session, countdownLabel: fmtCountdown(state.session.countdownMs) },
    calendar: state.calendar,
    nextEvent: state.nextEvent,
    watchlist: feed.watch,
    roster: AGENTS,
    groups: GROUPS,
    agents: AGENTS.map((a) => ({
      ...a,
      state: state.agentStates.get(a.id) ?? 'idle',
      load: registry.load.get(a.id) ?? null,
      remote: a.remote ?? null,
    })),
    tasks: queue.list(8),
    approvals: approvals.list(10),
    blotter: blotter.list(),
    journal: journal.stats(),
    bridge: mcpBridge.status(),
    recentAlerts: bus.recent({ type: 'alert', limit: 24 }),
  };
}

const llmEnabled = llmAvailable();

// ── whisper.cpp bridge ────────────────────────────────────────────────────────
async function transcribe(base64Audio, mimetype = 'audio/wav') {
  if (!config.whisper.bin) {
    return { ok: false, reason: 'WHISPER_BIN not set — the browser Web Speech API handles speech-in until you wire whisper.cpp (docs/VOICES.md)' };
  }
  const ext = mimetype.includes('webm') ? '.webm' : '.wav';
  const file = path.join(os.tmpdir(), `friday-${Date.now()}${ext}`);
  fs.writeFileSync(file, Buffer.from(base64Audio, 'base64'));
  const args = (config.whisper.args || '--language en --model ./MODEL --no-prints --output-txt')
    .replace('WHISPER_MODEL', config.whisper.model)
    .split(' ')
    .filter(Boolean)
    .concat(['-f', file]);
  return new Promise((resolve) => {
    const child = spawn(config.whisper.bin, args, { timeout: 30000 });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', () => {
      const txtPath = `${file}.txt`;
      let text = '';
      try {
        if (fs.existsSync(txtPath)) text = fs.readFileSync(txtPath, 'utf8');
      } catch { /* fall through to stdout parse */ }
      try { fs.unlinkSync(file); fs.existsSync(txtPath) && fs.unlinkSync(txtPath); } catch { /* ignore */ }
      const clean = truncate((text || out).replace(/[\[\(](?:BLANK|noise)[\]\)]/gi, '').trim(), 480);
      resolve(clean ? { ok: true, text: clean, engine: 'whisper.cpp' } : { ok: false, reason: `whisper produced nothing: ${err.slice(0, 160) || 'check WHISPER_MODEL path'}` });
    });
    child.on('error', (e) => resolve({ ok: false, reason: `whisper spawn failed: ${e.message}` }));
  });
}

// ── TTS bridge passthrough ────────────────────────────────────────────────────
async function ttsProxy(res, { text, voice, hint, format }) {
  if (!config.tts.bridgeUrl) {
    return json(res, 501, {
      error: 'no TTS bridge configured',
      hint: 'The HUD falls back to the browser speechSynthesis engine — each agent keeps its own voice. For local Kokoro/Voicebox, set TTS_BRIDGE_URL (docs/VOICES.md).',
    });
  }
  try {
    const upstream = await fetch(config.tts.bridgeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voice, hint, format: format || config.tts.format }),
    });
    if (!upstream.ok) return json(res, upstream.status, { error: `bridge replied ${upstream.status}` });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      'content-type': upstream.headers.get('content-type') ?? `audio/${config.tts.format}`,
      'content-length': buf.length,
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch (err) {
    json(res, 502, { error: `bridge unreachable: ${err.message}` });
  }
}

// ── routes ────────────────────────────────────────────────────────────────────
const routes = {
  'GET /healthz': async () => ({ ok: true, at: new Date().toISOString(), ...feed.health() }),
  'GET /api/desk': async () => deskSnapshot(),
  'GET /api/roster': async () => ({ master: MASTER, agents: ROSTER_LIST, groups: GROUPS }),
  'GET /api/session': async () => state.session,
  'GET /api/calendar': async () => state.calendar,
  'GET /api/quotes': async () => ({ feed: feed.health(), rows: await feed.quotesFor(feed.watch) }),
  'GET /api/quote': async (q) => {
    const symbol = String(q.get('symbol') || 'SPY').toUpperCase();
    return { feed: feed.health(), quote: await feed.quote(symbol) };
  },
  'GET /api/history': async (q) => {
    const symbol = String(q.get('symbol') || 'SPY').toUpperCase();
    const data = await feed.history(symbol, { days: Number(q.get('days')) || 120 });
    return { feed: feed.health(), history: data };
  },
  'GET /api/approvals': async () => ({ proposals: approvals.list(30), limits: config.risk, rule: 'no stamp, no trade' }),
  'GET /api/journal': async (q) => ({ stats: journal.stats(), entries: journal.readRecent({ limit: Number(q.get('limit')) || 80 }) }),
  'GET /api/positions': async () => blotter.list(),
  'GET /api/bridge': async () => mcpBridge.status(),
  'GET /api/tts': async (q, req, res) => {
    await ttsProxy(res, { text: q.get('text'), voice: q.get('voice'), hint: q.get('hint'), format: q.get('format') });
    return null; // response already written
  },
  'POST /api/command': async (q, req) => {
    const body = await readJson(req);
    state.commands += 1;
    const reply = await master.handleCommand(body.text ?? '', { source: body.source || 'typed' });
    return { reply, desk: { approvals: approvals.list(5), tasks: queue.list(5) } };
  },
  'POST /api/mic': async (q, req) => {
    const body = await readJson(req);
    if (!body?.audio) return { ok: false, error: 'expected { audio: base64 }' };
    return transcribe(body.audio, body.mimetype || 'audio/wav');
  },
  'POST /api/approvals': async (q, req) => {
    const body = await readJson(req);
    const rep = await registry.call('pilot', {
      ...master.ctxFor('pilot', `propose ${body.side || 'buy'} ${body.symbol}`, { intents: ['propose'], params: { ...body, symbol: body.symbol }, symbol: body.symbol, session: state.session, nextEvent: state.nextEvent }),
    });
    return { report: rep, approvals: approvals.list(5) };
  },
  'POST /api/approvals/stamp': async (q, req) => {
    const body = await readJson(req);
    const rep = await registry.call('sentinel', {
      ...master.ctxFor('sentinel', `stamp ${body.proposalId}`, { intents: ['approve'], params: { proposalId: body.proposalId }, symbol: null, session: state.session, nextEvent: state.nextEvent }),
    });
    return { report: rep, proposal: approvals.get(body.proposalId) };
  },
  'POST /api/approvals/confirm': async (q, req) => {
    const body = await readJson(req);
    const out = approvals.confirmHuman(body.proposalId, { confirmed: body.confirmed !== false, by: 'operator:ui' });
    bus.emitEvent('approval.updated', { proposal: out.proposal ?? approvals.get(body.proposalId) }, { agent: 'friday' });
    return out;
  },
  'POST /api/approvals/execute': async (q, req) => {
    const body = await readJson(req);
    const rep = await registry.call('pilot', {
      ...master.ctxFor('pilot', `execute ${body.proposalId}`, { intents: ['confirm'], params: { proposalId: body.proposalId, confirm: body.confirm !== false }, symbol: null, session: state.session, nextEvent: state.nextEvent }),
    });
    return { report: rep, proposal: approvals.get(body.proposalId), blotter: blotter.list() };
  },
  'POST /api/chart': async (q, req) => {
    const body = await readJson(req);
    const forwarded = await mcpBridge.send(body.action, body.payload ?? {});
    bus.emitEvent('chart.action', { action: body.action, payload: body.payload ?? {}, origin: 'operator' }, { agent: body.agent || 'chartist' });
    return { ok: true, bridge: forwarded };
  },
  'POST /api/speak': async (q, req) => {
    const body = await readJson(req);
    bus.emitEvent('speak', { text: truncate(body.text || '', 800), agent: body.agent || 'friday' });
    return { ok: true, queued: true };
  },
};

const ROSTER_LIST = AGENTS.filter((a) => a.id !== 'friday');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no',
    });
    const unsubscribe = bus.subscribe(res);
    const ping = setInterval(() => {
      try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* closed */ }
    }, 25000);
    req.on('close', () => { clearInterval(ping); unsubscribe(); });
    return;
  }

  const handler = routes[key];
  if (handler) {
    try {
      const out = await handler(url.searchParams, req, res);
      if (out !== null && out !== undefined) json(res, 200, out);
    } catch (err) {
      console.error(`[api] ${key} →`, err.message);
      json(res, 400, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET') return serveStatic(req, res, url.pathname);
  json(res, 404, { error: 'no such route', tried: key, endpoints: Object.keys(routes) });
});

// ── tickers ───────────────────────────────────────────────────────────────────
function tickClock() {
  state.session = describeSession();
  master.updateContext({ session: state.session });
}
function tickBroadcast() {
  bus.emitEvent('session', {
    ...state.session,
    countdownLabel: fmtCountdown(state.session.countdownMs),
  });
}
function tickLoads() {
  bus.emitEvent('agent.load', { load: [...registry.load.values()], agents: AGENTS.map((a) => ({ id: a.id, state: state.agentStates.get(a.id) })) });
}

let timersStarted = false;
export function startTimers() {
  if (timersStarted) return;
  timersStarted = true;
  feed.start();
  setInterval(tickClock, 1000).unref?.();
  setInterval(tickBroadcast, 5000).unref?.();
  setInterval(tickLoads, 4000).unref?.();
  setInterval(() => {
    state.calendar = buildCalendar();
    state.nextEvent = nextEventRisk();
    master.updateContext({ nextEvent: state.nextEvent, calendar: state.calendar });
    bus.emitEvent('calendar', state.calendar);
  }, 10 * 60 * 1000).unref?.();
  setInterval(() => master.heartbeat(), 3 * 60 * 1000).unref?.();
}

export function banner() {
  const h = feed.health();
  const line = (k, v) => `  ${k.padEnd(12)} ${v}`;
  return [
    '',
    '  ╔═══════════════════════════════════════════════════════════╗',
    '  ║   F·R·I·D·A·Y  ·  one master, nine specialists           ║',
    '  ╚═══════════════════════════════════════════════════════════╝',
    line('hud', `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`),
    line('feed', h.live ? `finnhub (key set) · poll ${config.quotePollMs / 1000}s` : `${h.mode} · ${h.reason}`),
    line('reasoning', llmEnabled ? config.llm.model : 'local router + template synthesis (no key needed)'),
    line('signing', `ed25519 · Sentinel key ${fingerprint()}${keys.fresh ? ' (generated on this boot)' : ' (reused from data/keys)'}`),
    line('execution', `${config.risk.mode.toUpperCase()} only — no broker adapter exists in this build`),
    line('voices', config.tts.bridgeUrl ? `bridge ${config.tts.bridgeUrl}` : 'browser speechSynthesis · 9 distinct profiles'),
    line('ears', config.whisper.bin ? `whisper.cpp ${config.whisper.bin}` : 'browser Web Speech · whisper.cpp bridge ready'),
    line('screens', mcpBridge.configured ? `TradingView bridge ${config.tradingview.mcpUrl}` : 'desk chart only (set TRADINGVIEW_MCP_URL to drive real charts)'),
    '',
    '  Simulated data is badged SIM everywhere. Nothing in this build moves real money.',
    '',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  startTimers();
  server.listen(config.port, config.host, () => {
    console.log(banner());
    journal.append({ kind: 'command', agent: 'friday', text: `desk booted · ${JSON.stringify(describeConfig())}` });
    bus.alert('friday', `Desk online · ${ROSTER_LIST.length} specialists seated · feed: ${feed.health().mode}`, 'info', { dedupe: 'boot' });
    if (!feed.health().live) {
      bus.alert('ledger', feed.health().reason, 'warn', { dedupe: 'boot-feed' });
    }
  });
  const shutdown = () => {
    feed.stop();
    server.close();
    journal.append({ kind: 'command', agent: 'friday', text: 'desk closed' });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export { server, master, feed, bus, approvals, blotter, journal, queue, registry };
