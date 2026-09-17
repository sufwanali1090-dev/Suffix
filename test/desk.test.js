/**
 * desk.test.js — routing, the data rules, and the quant guardrail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDesk } from './helpers.js';

test('one command finds the right seats', async () => {
  const { master } = await makeDesk();
  const cases = [
    ['pull up NVDA and mark the levels', ['athena', 'chartist'], 'NVDA'],
    ["what's the macro picture", ['atlas'], null],
    ['forecast TSLA 20 day', ['oracle'], 'TSLA'],
    ['what is moving today', ['scout'], null],
    ["what's moving", ['scout'], null],
    ['who is up today', ['scout'], null],
    ['what has congress bought lately', ['capitol'], null],
    ['how much risk is in the book', ['sentinel'], null],
    ['journal a review of the session', ['ledger'], null],
  ];
  for (const [text, agents, symbol] of cases) {
    const r = master.route(text);
    assert.deepEqual(r.agents, agents, text);
    if (symbol) assert.equal(r.symbol, symbol, text);
  }
});

test('the money path always includes the risk officer', async () => {
  const { master } = await makeDesk();
  for (const text of ['buy 200 shares of NVDA', 'sell 10 TSLA', 'place an order on AAPL', 'execute the trade']) {
    const r = master.route(text);
    assert.ok(r.agents.includes('pilot'), text);
    assert.ok(r.agents.includes('sentinel'), `${text} must include sentinel`);
    assert.ok(r.agents.indexOf('pilot') < r.agents.indexOf('sentinel'), 'pilot drafts before sentinel stamps');
  }
});

test('analysis never reaches for the trigger', async () => {
  const { master } = await makeDesk();
  for (const text of ['what does the structure look like on NVDA', 'forecast SPY', 'give me a briefing']) {
    const r = master.route(text);
    assert.ok(!r.agents.includes('pilot'), `${text} must not execute`);
  }
});

test('sizes and sides are read out of the sentence', async () => {
  const { master } = await makeDesk();
  const buy = master.route('buy 250 shares of NVDA');
  assert.equal(buy.params.qty, 250);
  assert.equal(buy.params.side, 'buy');
  const sell = master.route('sell 40 AMD');
  assert.equal(sell.params.side, 'sell');
  assert.equal(sell.params.qty, 40);
});

test('a dead feed shows as no data, never as a number', async () => {
  const { feed, master } = await makeDesk();
  const original = feed.active;
  feed.active = { name: 'broken', quote: async () => ({ ok: false, reason: 'upstream 502' }), history: async () => ({ ok: false, reason: 'upstream 502' }), news: async () => ({ ok: false, reason: 'no news' }), movers: async () => ({ ok: false, reason: 'no movers' }) };
  try {
    feed.histCache.clear();
    feed.quoteCache.clear();
    const q = await feed.quote('NVDA');
    assert.equal(q.ok, false);
    assert.equal(q.price, null, 'a missing price must be null so the HUD renders a dash');
    const rep = await feed.history('NVDA');
    assert.equal(rep.ok, false);
  } finally {
    feed.active = original;
  }
});

test('the quant may not promise', async () => {
  const { hedge } = await import('../server/agents/oracle.js');
  assert.match(hedge('NVDA will break out tomorrow'), /is expected to/);
  assert.doesNotMatch(hedge('this will rally, guaranteed, definitely higher'), /\b(will|guaranteed|definitely)\b/i);
  const clean = hedge('The model says it will run.');
  assert.ok(!/\bwill\b/i.test(clean), clean);
});

test('forecast quantiles are ordered and probabilities are probabilities', async () => {
  const { feed } = await makeDesk();
  const { stats } = await import('../server/agents/base.js');
  const hist = await feed.history('NVDA', { days: 180 });
  assert.equal(hist.ok, true);
  const fc = stats.forecast({ closes: hist.closes, horizonDays: 20, sims: 2000, seed: 'test' });
  assert.ok(fc.p05 < fc.p25 && fc.p25 < fc.p50 && fc.p50 < fc.p75 && fc.p75 < fc.p95, JSON.stringify(fc));
  assert.ok(fc.probUpPct >= 0 && fc.probUpPct <= 100);
  assert.ok(fc.sigmaHorizonPct > 0);
  const short = stats.forecast({ closes: [1, 2, 3], horizonDays: 5, sims: 100, seed: 'x' });
  assert.equal(short, null, 'thirty returns is the floor: too little data must refuse, not guess');
});

test('session clock reads New York, not the sandbox', async () => {
  const { describeSession } = await import('../server/data/session.js');
  const thursday10am = new Date('2026-09-17T14:00:00Z'); // 10:00 ET in DST
  const s = describeSession(thursday10am);
  assert.equal(s.phase, 'open');
  assert.equal(s.nyClock, '10:00');
  assert.equal(s.countdownMs, 6 * 3600 * 1000, '10:00 ET → 16:00 close is exactly six hours');
  const weekend = describeSession(new Date('2026-09-19T15:00:00Z'));
  assert.equal(weekend.phase, 'closed');
  const holiday = describeSession(new Date('2026-12-25T15:00:00Z'));
  assert.equal(holiday.holiday, true);
});

test('calendar marks FOMC and expiry', async () => {
  const { buildCalendar, opexDate } = await import('../server/data/events.js');
  const sep = buildCalendar(new Date('2026-09-10T12:00:00Z'));
  const fomc = sep.cells.find((c) => c.iso === '2026-09-16');
  assert.ok(fomc?.events.some((e) => e.kind === 'fomc'), 'FOMC decision day must be marked');
  assert.equal(opexDate(2026, 8), '2026-09-18', 'third Friday of September 2026');
  const opex = sep.cells.find((c) => c.iso === '2026-09-18');
  assert.ok(opex?.events.some((e) => e.kind === 'opex'), 'expiry must be marked');
});

test('sim quotes are always labelled sim, and real mode is always unlabelled', async () => {
  const { feed } = await makeDesk();
  const rows = await feed.quotesFor(['NVDA', 'AAPL']);
  for (const r of rows) {
    assert.equal(r.source, 'sim');
    assert.equal(r.sim, true);
    assert.ok(Number.isFinite(r.price));
  }
  assert.equal(feed.health().simulated, true);
  assert.equal(feed.health().live, false);
});

test('the ledger records every command, including refusals', async () => {
  const { master, journal } = await makeDesk();
  await master.handleCommand('what is the macro read');
  await master.handleCommand('buy 500000 shares of NVDA');
  const entries = journal.readRecent({ days: 2, limit: 200 });
  assert.ok(entries.some((e) => e.kind === 'command' && /macro read/.test(e.text)));
  assert.ok(entries.some((e) => e.kind === 'report' && e.agent === 'friday'), 'the master journals what it said');
  const stats = journal.stats();
  assert.ok(stats.total >= 3);
});

test('one spoken command produces one spoken answer', async () => {
  const { master } = await makeDesk();
  const reply = await master.handleCommand('give me a briefing');
  assert.ok(reply.speech.length > 40, reply.speech);
  assert.ok(reply.agents.length >= 3, 'briefing should consult several seats');
  assert.equal(typeof reply.ms, 'number');
  assert.ok(!/undefined|NaN|\[object/.test(reply.speech), `answer must never leak internals: ${reply.speech}`);
});
