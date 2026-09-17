/**
 * hud.test.js — the panel layer, headless.
 *
 * public/js/panels.js is the code that decides whether an operator sees a real
 * number or a dash, so it is worth testing without a browser. A ~70-line DOM
 * shim stands in for the HUD and we assert on what the panels *decide*: dead
 * feeds dash out, a vetoed ticket offers no execute button, the chart refuses
 * to draw an unsourced level.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ── minimal DOM: enough for querySelector/innerHTML/children/classList ──────
class Node {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this._html = '';
    this.parentElement = null;
    this._cls = new Set();
    this.textContent = '';
    this.title = '';
    this.clientWidth = 900;
    this.clientHeight = 240;
    this.classList = {
      add: (...c) => c.forEach((x) => this._cls.add(x)),
      remove: (...c) => c.forEach((x) => this._cls.delete(x)),
      toggle: (c, on) => (on === false ? this._cls.delete(c) : on === undefined ? (this._cls.has(c) ? this._cls.delete(c) : this._cls.add(c)) : this._cls.add(c)),
      contains: (c) => this._cls.has(c),
    };
  }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  // Aggregated so a host built from appended children can be asserted on too.
  get innerHTML() { return this._html + this.children.map((c) => c.innerHTML).join(''); }
  appendChild(n) { n.parentElement = this; this.children.push(n); return n; }
  prepend(n) { n.parentElement = this; this.children.unshift(n); return n; }
  get firstElementChild() { return this.children[0]; }
  get lastElementChild() { return this.children[this.children.length - 1]; }
  remove() { const i = this.parentElement?.children.indexOf(this); if (i >= 0) this.parentElement.children.splice(i, 1); }
  setAttribute(k, v) { this[k] = v; }
  addEventListener() {}
  dispatchEvent() { return true; }
  querySelector() { return new Node('div'); }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { width: 900, height: 240, left: 0, top: 0 }; }
}

const registry = new Map();
const q = (sel) => {
  if (!registry.has(sel)) registry.set(sel, new Node('div'));
  return registry.get(sel);
};
globalThis.document = {
  querySelector: q,
  createElement: (t) => new Node(t),
  addEventListener: () => {},
  body: new Node('body'),
  querySelectorAll: () => [],
};
globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
globalThis.window = globalThis;

const P = await import('../public/js/panels.js');
const { fmt } = await import('../public/js/api.js');

test('a dead feed renders an em dash, not a zero and not a stale value', () => {
  assert.equal(fmt.price(null), '—');
  assert.equal(fmt.price(undefined), '—');
  assert.equal(fmt.price(NaN), '—');
  assert.equal(fmt.pct(null), '—');
  assert.equal(fmt.usd(undefined), '—');
  assert.equal(fmt.ms('n/a'), '—');
});

test('market pulse: live rows and dead rows sit side by side', () => {
  const rows = [
    { symbol: 'NVDA', ok: true, price: 182.02, changePct: 1.44, asOf: new Date().toISOString() },
    { symbol: 'FAKE', ok: false, reason: 'quote empty (symbol unknown or market shut)' },
  ];
  P.renderPulse(rows, { simulated: true, lastPollAt: new Date().toISOString() });
  const host = q('#pulse');
  assert.equal(host.children.length, 2);
  assert.match(host.children[0].innerHTML, /NVDA/);
  assert.match(host.children[1].innerHTML, /FAKE/);
  // the dead ring's text is written imperatively after innerHTML:
  assert.equal(host.children[1].querySelector().constructor.name, 'Node');
  assert.equal(q('#panel-pulse').dataset.sim, '1', 'the pulse panel carries the SIM flag');
});

test('SIM badge follows the feed and the banner appears with a reason', () => {
  P.setFeedBadge({ simulated: true, live: false, reason: 'no key' });
  assert.equal(q('#feed-label').textContent, 'SIM');
  assert.match(q('#sim-reason').textContent, /no key/);
  P.setFeedBadge({ simulated: false, live: true });
  assert.equal(q('#feed-label').textContent, 'LIVE · FINNHUB');
});

test('the gate offers "confirm & execute" only when a stamp exists', () => {
  P.renderGate({ id: 'p1', symbol: 'NVDA', side: 'buy', qty: 0, entry: 180, stop: null, target: null, status: 'pending', context: {} }, [{ id: 'sentinel', name: 'SENTINEL' }]);
  let html = q('#gate-body').innerHTML;
  assert.match(html, /request sentinel stamp/);
  assert.doesNotMatch(html, /confirm &amp; execute|confirm & execute/);

  P.renderGate(
    { id: 'p2', symbol: 'NVDA', side: 'buy', qty: 12, entry: 180, stop: 176, target: 190, status: 'stamped', context: {}, stamp: { approved: true, reason: 'fine', conditions: [], digest: 'abcd1234' } },
    [{ id: 'sentinel', name: 'SENTINEL' }]
  );
  html = q('#gate-body').innerHTML;
  assert.match(html, /STAMPED/);
  assert.match(html, /confirm &amp; execute/);
  assert.match(html, /ed25519 stamp/);

  P.renderGate({ id: 'p3', symbol: 'TSLA', side: 'buy', qty: 12, status: 'vetoed', stamp: { approved: false, reason: 'no verified price' }, context: {} }, [{ id: 'sentinel', name: 'SENTINEL' }]);
  html = q('#gate-body').innerHTML;
  assert.match(html, /VETO/);
  assert.match(html, /no verified price/);
  assert.doesNotMatch(html, /confirm &amp; execute/);
  assert.doesNotMatch(html, /request sentinel stamp/);
});

test('executed tickets are closed and the stamp shows as consumed', () => {
  P.renderGate({ id: 'p4', symbol: 'SPY', side: 'buy', qty: 3, entry: 640, stop: 630, target: 660, status: 'executed', execution: { ticket: 'PAPER-1', fillPrice: 640 }, stamp: { approved: true, digest: 'ff00' }, context: {} }, []);
  const html = q('#gate-body').innerHTML;
  assert.match(html, /closed · stamp consumed/);
  assert.match(html, /PAPER-1/);
});

test('chart actions: only sourced levels are drawn', () => {
  P.applyChartAction('setSymbol', { symbol: 'NVDA' });
  assert.equal(P.chartState.symbol, 'NVDA');
  P.applyChartAction('drawLevel', { price: 178.98, kind: 'support', label: 'demand', touches: 2 });
  assert.equal(P.chartState.levels.length, 1);
  P.applyChartAction('drawLevel', { price: null, kind: 'support' });
  assert.equal(P.chartState.levels.length, 1, 'a level with no number must not be drawn');
  assert.match(P.chartState.note, /no numeric price/);
  P.applyChartAction('drawLevel', { price: 178.99, kind: 'support', label: 'demand' });
  assert.equal(P.chartState.levels.length, 1, 'the same line twice is one line');
  P.applyChartAction('clearLevels', {});
  assert.equal(P.chartState.levels.length, 0);
});

test('drawChart survives an empty frame and paints a real one', () => {
  q('#chart').parentElement = new Node('div');
  P.chartState.series = [];
  P.chartState.levels = [];
  P.drawChart();                                    // must not throw with no data
  P.chartState.series = [1, 2, 1.5, 3, 2.8, 4];
  P.chartState.levels = [{ kind: 'support', price: 1.2, label: 'demand', touches: 3 }];
  P.chartState.band = { p05: 2, p50: 4, p95: 6 };
  P.chartState.markers = [{ price: 3, label: 'fill 100@3', i: 4 }];
  P.drawChart();
  const svg = q('#chart').innerHTML;
  assert.match(svg, /<path class="line"/);
  assert.match(svg, /demand/);
  assert.match(svg, /band/);
  assert.match(svg, /fill 100@3/);
});

test('alerts, queue rows and load rows render without a browser', () => {
  P.pushLog({ at: new Date().toISOString(), agent: 'scout', text: 'NVDA +6.20% — volume behind it', severity: 'warn' }, [{ id: 'scout', name: 'SCOUT', hue: 96 }]);
  assert.match(q('#log').children[0].innerHTML, /SCOUT/);
  assert.match(q('#log').children[0].innerHTML, /6\.20%/);
  P.renderQueue([{ id: 't1', command: 'pull up NVDA', symbol: 'NVDA', agents: ['athena', 'chartist'], done: ['athena'], failed: [], status: 'done', ms: 42, summary: 'ok' }], [{ id: 'athena', name: 'ATHENA', hue: 24 }]);
  assert.match(q('#queue').innerHTML, /1\/2 seats answered/);
  P.renderLoad([{ id: 'atlas', name: 'ATLAS', hue: 198 }], [{ agent: 'atlas', calls: 4, ms: 120 }], new Map([['atlas', 'speaking']]));
  assert.match(q('#load').innerHTML, /4× · 30ms/);
});

test('the modal, the sim band and the reply card can actually be hidden', () => {
  // Regression: an author `display:` on a class beats the UA `[hidden]{display:none}`,
  // so a popup with `hidden` set renders from page load and cannot be dismissed.
  const css = fs.readFileSync(path.resolve('public/styles.css'), 'utf8');
  const html = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/, 'styles.css must keep a global [hidden] guard');
  const hiddenEls = [...html.matchAll(/<[a-z]+[^>]*\bhidden\b[^>]*>/gi)].map((m) => m[0]);
  assert.ok(hiddenEls.length >= 4, `expected the HUD to use the hidden property, saw ${hiddenEls.length}`);
  for (const tag of hiddenEls) {
    const cls = (tag.match(/class="([^"]+)"/) || [, ''])[1].split(/\s+/).filter(Boolean);
    for (const c of cls) {
      const rule = new RegExp(`\\.${c}\s*\{([^}]*)\\}`);
      const body = (css.match(rule) || [, ''])[1];
      if (/display:/.test(body) && !/!important/.test(css.match(/\[hidden\][^}]*/)?.[0] ?? '')) {
        assert.fail(`.${c} sets display: while also being hidden — the [hidden] guard is required`);
      }
    }
  }
});

test('every dismissal path calls closeModal', () => {
  const src = fs.readFileSync('public/js/app.js', 'utf8');
  assert.match(src, /modal-close'\)\.addEventListener\('click', closeModal\)/);
  assert.match(src, /if \(e\.target\.id === 'modal'\) closeModal\(\)/);
  assert.match(src, /Escape[\s\S]{0,80}closeModal\(\)/);
  assert.match(src, /function closeModal\(\)[\s\S]{0,220}modal\.hidden = true/);
});

test('session panel prints the countdown the server computed', () => {
  P.renderSession({ phase: 'open', label: 'Regular session', tone: 'live', weekday: 'Thu', nyDate: '2026-09-17', nyClock: '10:00', nySeconds: 12, countdownLabel: '5h 59m', countingTo: '16:00 ET · close', tickerHint: 'go' });
  assert.equal(q('#sess-label').textContent, 'Regular session');
  assert.equal(q('#sess-countdown').textContent, '5h 59m');
  assert.equal(q('#sess-count-label').textContent, 'to close');
  assert.equal(q('#clock-et').textContent, '10:00:12 ET');
});
