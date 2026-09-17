/**
 * agent-service.js — run one specialist as its own process.
 *
 *   node server/agent-service.js atlas
 *   node server/agent-service.js oracle --port 8806
 *
 * then in server/agents/roster.js:  { id: 'atlas', ..., remote: 'http://127.0.0.1:8801' }
 *
 * The master then delegates over HTTP instead of in-process — same contract,
 * same report shape, one fewer thing in the main process. Adding a tenth agent
 * this way does not touch the other nine.
 *
 * Refuses to host SENTINEL or PILOT: the gate needs the approval ledger and the
 * signing key, and those deliberately exist only in the master's process. A
 * risk officer you can run separately from the money is not a risk officer.
 */
import http from 'node:http';
import { config } from './config.js';
import { DEFINITIONS, buildStandaloneContext, agentPort } from './agents/registry.js';
import { ROSTER } from './agents/roster.js';
import { describeSession } from './data/session.js';
import { nextEventRisk, buildCalendar } from './data/events.js';
import { nowIso } from './util.js';

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
const portFlag = args.findIndex((a) => a === '--port');
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : agentPort(id);

const MONEY_PATH = ['sentinel', 'pilot'];

if (!id || !DEFINITIONS[id]) {
  console.error(`usage: node server/agent-service.js <${Object.keys(DEFINITIONS).join('|')}> [--port n]`);
  process.exit(id ? 1 : 2);
}
if (MONEY_PATH.includes(id)) {
  console.error([
    '',
    `  ${id.toUpperCase()} will not run as a standalone service.`,
    '',
    '  Stamping proposals needs the approval ledger and Sentinel\'s Ed25519 private',
    '  key, and both live only in the master process (server/index.js). Hosting the',
    '  risk officer somewhere else would put the veto and the money in the same',
    '  place, which is exactly what the one hard rule exists to prevent.',
    '',
    '  Run it in-process (roster: remote: null) and keep the analysis seats remote.',
    '',
  ].join('\n'));
  process.exit(3);
}

const seat = ROSTER.find((a) => a.id === id);
const definition = DEFINITIONS[id];
let calls = 0;

const server = http.createServer(async (req, res) => {
  const send = (code, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    res.end(payload);
  };
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/health'))) {
    return send(200, {
      agent: id, name: seat.name, title: seat.title, seat: seat.seat,
      service: true, at: nowIso(), calls,
      voice: seat.voice,
      note: `${seat.name} is a read-only specialist: no approvals ledger, no signing key, no blotter.`,
    });
  }
  if (req.method !== 'POST' || !req.url.startsWith('/invoke')) return send(404, { error: 'POST /invoke only' });

  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return send(400, { error: 'invalid JSON' });
  }
  calls += 1;
  const ctx = buildStandaloneContext(id, body.ctx ?? {});
  let out;
  try {
    out = await definition.handle(ctx);
  } catch (err) {
    out = { agent: id, status: 'error', headline: `${seat.name} failed`, bullets: [String(err?.message || err)], speech: `${seat.name} is offline.`, actions: [], data: {}, sources: [], at: nowIso() };
  }
  send(200, { report: out, session: describeSession(), nextEvent: nextEventRisk(), calendar: buildCalendar() });
});

server.listen(port, config.host, () => {
  console.log(`\n  ${seat.name} · ${seat.title} — standalone service on http://${config.host}:${port}`);
  console.log(`  POST /invoke { "ctx": { "symbol": "NVDA", "text": "…", "params": {} } }\n`);
});
