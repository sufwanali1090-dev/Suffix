/**
 * app.js — the wiring between the desk and the room.
 *
 * Note what is NOT here: any calculation. Every number on screen arrives from
 * the server (quotes, session, agent reports, the approval ledger), and every
 * request goes through one door — POST /api/command. The HUD is an instrument
 * panel, not a second brain, which is the only way an instrument panel stays
 * honest when a feed dies.
 */
import { api, fmt, esc, DASH } from './api.js';
import { Orb } from './orb.js';
import { Voices } from './voices.js';
import { enableHands } from './hands.js';
import * as P from './panels.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  desk: null,
  seats: [],
  agents: [],
  master: null,
  agentStates: new Map(),
  focus: null,
  lastCommand: '',
  lastReply: null,
  symbol: null,
  feed: {},
  listening: false,
  hands: null,
  gate: null,
  load: [],
};

const orb = new Orb($('#orb'), {
  onSteerSeat: (id) => setFocus(id, { soft: true }),
});
let voices = null;

boot();

async function boot() {
  let desk;
  try {
    desk = await api.get('/api/desk');
  } catch (err) {
    P.toast(`desk unreachable: ${err.message} — is the server running?`, true);
    return;
  }
  state.desk = desk;
  state.agents = desk.agents;
  state.master = desk.roster.find((a) => a.id === 'friday');
  state.seats = desk.agents.filter((a) => a.id !== 'friday');
  state.feed = desk.feed;
  orb.configure({ master: state.master, seats: state.seats });

  voices = new Voices({
    seats: state.seats,
    master: state.master,
    onLevel: (v) => orb.setLevel(v),
    onSpeaking: (id) => {
      document.body.classList.toggle('speaking', Boolean(id));
      $('#reply-who').textContent = id ? (state.seats.find((s) => s.id === id)?.name ?? 'F.R.I.D.A.Y.') : 'the desk';
    },
    onState: (id, st) => orb.setState(id, st),
  });
  const vi = await voices.init().catch(() => ({ engine: 'silent', voices: 0 }));
  $('#voice-label').textContent = `voices: ${vi.engine === 'bridge' ? 'local tts bridge' : vi.engine === 'browser-speech' ? `${vi.voices} system voices` : 'captions only'} · ${vi.mode}`;
  $('#ears-label').textContent = voices.sttSupported ? 'ears: browser speech · whisper.cpp bridge' : 'ears: whisper.cpp bridge (no web speech api here)';
  $('#btn-mute').classList.toggle('on', vi.mode !== 'muted');

  // header truth
  P.setFeedBadge(desk.feed);
  $('#gate-label').textContent = `ed25519 ${desk.desk.signingKey.fingerprint.slice(0, 8)}`;
  $('#llm-label').textContent = desk.desk.llm === 'local-router' ? 'local router' : desk.desk.llm;
  $('#pulse-mode').textContent = desk.feed.simulated ? 'simulated series' : desk.feed.live ? 'finnhub · live' : 'no feed';

  P.renderSession(desk.session);
  P.renderCalendar(desk.calendar, desk.nextEvent);
  P.renderQueue(desk.tasks, state.seats);
  state.load = desk.agents.map((a) => a.load).filter(Boolean);
  P.renderLoad(state.agents, state.load, state.agentStates);
  (desk.recentAlerts ?? []).slice().reverse().forEach((a) => P.pushLog(a, state.seats));
  if (desk.approvals?.length) {
    state.gate = desk.approvals[0];
    P.renderGate(state.gate, state.seats);
  }
  if (desk.bridge?.configured) $('#chart-src').textContent = 'tradingview bridge connected';

  const quotes = await api.get('/api/quotes').catch(() => null);
  if (quotes) P.renderPulse(quotes.rows, quotes.feed);

  wireUi();
  subscribe();
  initDesktop();
  await loadSeries(state.symbol || 'NVDA');
}

// ── live stream ───────────────────────────────────────────────────────────────
function subscribe() {
  api.stream({
    quotes: (e) => {
      P.renderPulse(e.rows, e.feed);
      state.feed = e.feed;
      P.setFeedBadge(e.feed);
      if (state.symbol) refreshQuote(state.symbol);
    },
    session: (e) => P.renderSession(e),
    calendar: (e) => P.renderCalendar(e, state.desk?.nextEvent),
    alert: (e) => P.pushLog(e, state.seats),
    command: (e) => {
      $('#orb-sub').textContent = e.text.length > 64 ? `${e.text.slice(0, 64)}…` : e.text;
      orb.setMasterState('listening');
    },
    routing: (e) => {
      orb.setMasterState('thinking');
      orb.route(e.task.agents);
      $('#reply-routed').textContent = `${e.task.agents.length ? e.task.agents.map((a) => a.toUpperCase()).join(' + ') : 'self'} · ${e.task.via}`;
      state.agents.forEach((a) => orb.setState(a.id, a.id === 'friday' ? 'thinking' : 'idle'));
      if (e.task.reasoning) $('#orb-sub').textContent = e.task.reasoning;
    },
    'agent.state': (e) => {
      state.agentStates.set(e.agent, e.state);
      orb.setState(e.agent, e.state);
      P.renderLoad(state.agents, state.load, state.agentStates);
    },
    'agent.report': (e) => {
      const rep = e.report;
      orb.setState(rep.agent, rep.status === 'error' ? 'error' : rep.status === 'veto' ? 'veto' : 'done');
      orb.route([rep.agent], true);
      const seat = state.seats.find((s) => s.id === rep.agent);
      if (seat) {
        P.pushLog({ at: rep.at, agent: rep.agent, text: rep.headline, severity: rep.status === 'veto' ? 'danger' : rep.status === 'error' ? 'warn' : 'info' }, state.seats);
      }
    },
    task: (e) => P.renderQueue([e.task, ...(state.desk?.tasks ?? [])].filter((t, i, a) => a.findIndex((x) => x.id === t.id) === i), state.seats),
    'agent.load': (e) => {
      if (Array.isArray(e.load) && e.load.length) state.load = e.load;
      P.renderLoad(state.agents, state.load, state.agentStates);
    },
    reply: (e) => onReply(e.reply),
    'chart.action': (e) => onChartAction(e.action, e.payload),
    speak: (e) => voices?.speak(e.agent, e.text),
    'trade.stamped': (e) => {
      state.gate = e.proposal;
      P.renderGate(e.proposal, state.seats);
      P.toast('Sentinel stamped the ticket — confirm to execute');
    },
    'trade.vetoed': (e) => {
      state.gate = e.proposal;
      P.renderGate(e.proposal, state.seats);
      P.toast('VETO — nothing was sent to market', true);
    },
    'trade.confirmed': (e) => {
      state.gate = e.proposal;
      P.renderGate(e.proposal, state.seats);
    },
    'trade.executed': (e) => {
      state.gate = e.proposal;
      P.renderGate(e.proposal, state.seats);
      onChartAction('annotate', { symbol: e.proposal.symbol, price: e.proposal.execution?.fillPrice, note: `${e.proposal.execution?.mode} fill ${e.proposal.qty}@${fmt.price(e.proposal.execution?.fillPrice)}` });
    },
  });
}

/** The master's answer: caption it, hand the lines to the voice layer. */
function onReply(reply) {
  state.lastReply = reply;
  const text = $('#reply-text');
  text.innerHTML = reply.speech
    ? esc(reply.speech).replace(/(-?\$?\d[\d,]*\.?\d*\s?(?:%|ms|shares?|:1)?)/g, '<span class="hl">$1</span>')
    : '<span style="color:var(--ink-3)">no reply — the feed refused to answer, so I will not either.</span>';
  $('#reply-when').textContent = new Date(reply.at).toLocaleTimeString();
  $('#reply-routed').textContent = reply.routedBy ? `${(reply.agents ?? []).map((a) => a.toUpperCase()).join(' + ') || 'self'} · ${reply.routedBy}${reply.ms != null ? ` · ${reply.ms}ms` : ''}` : '';
  const card = $('#reply-card');
  if (reply.card) {
    card.hidden = false;
    card.innerHTML = `<span class="k">${esc(reply.card.label)}</span><span class="v">${esc(String(reply.card.value))}</span><span class="s">${esc(reply.card.sub ?? '')}</span>`;
  } else {
    card.hidden = true;
  }
  if (reply.pendingApproval) {
    state.gate = reply.pendingApproval;
    P.renderGate(state.gate, state.seats);
  }
  const lines = [{ agent: 'friday', text: reply.speech }].concat(
    Object.values(reply.reports ?? {})
      .filter((r) => r.speech && r.agent !== 'friday')
      .map((r) => ({ agent: r.agent, text: r.speech }))
  );
  voices?.enqueue(lines);
  orb.setMasterState('idle');
  api.get('/api/desk').then((d) => {
    state.desk = d;
    P.renderQueue(d.tasks, state.seats);
    P.renderLoad(d.agents, d.agents.map((a) => a.load).filter(Boolean), state.agentStates);
    if (d.approvals?.length) {
      state.gate = d.approvals[0];
      P.renderGate(state.gate, state.seats);
    }
  }).catch(() => {});
}

// ── screens ───────────────────────────────────────────────────────────────────
function onChartAction(action, payload) {
  const changed = P.applyChartAction(action, payload ?? {});
  if (P.chartState.symbol && P.chartState.symbol !== state.symbol) {
    state.symbol = P.chartState.symbol;
    loadSeries(state.symbol);
  }
  if (changed) P.drawChart();
}

async function loadSeries(symbol) {
  if (!symbol) return;
  state.symbol = symbol;
  P.chartState.symbol = symbol;
  P.chartState.note = `fetching ${symbol} …`;
  P.drawChart();
  const [hist, q] = await Promise.all([
    api.get(`/api/history?symbol=${encodeURIComponent(symbol)}&days=120`).catch(() => null),
    api.get(`/api/quote?symbol=${encodeURIComponent(symbol)}`).catch(() => null),
  ]);
  if (hist?.history?.ok) {
    P.chartState.series = hist.history.closes;
    P.chartState.source = hist.history.source;
    P.chartState.simulated = Boolean(hist.history.sim || hist.history.simulated);
    P.chartState.note = hist.history.reason ? hist.history.reason : `${hist.history.stamps?.[0] ?? ''} → ${hist.history.stamps?.slice(-1)[0] ?? ''} · ${hist.history.closes.length} bars`;
  } else {
    P.chartState.series = [];
    P.chartState.note = hist?.history?.reason ? `no series: ${hist.history.reason}` : 'no series — showing levels only';
  }
  if (q?.quote?.ok) {
    P.chartState.price = q.quote.price;
    P.chartState.changePct = q.quote.changePct;
    P.chartState.levels = [
      ...P.chartState.levels.filter((l) => l.kind !== 'day-high' && l.kind !== 'day-low'),
      ...(Number.isFinite(q.quote.dayHigh) ? [{ kind: 'day-high', price: q.quote.dayHigh, label: 'day high' }] : []),
      ...(Number.isFinite(q.quote.dayLow) ? [{ kind: 'day-low', price: q.quote.dayLow, label: 'day low' }] : []),
      { kind: 'price', price: q.quote.price, label: 'last' },
    ].sort((a, b) => b.price - a.price);
  }
  P.drawChart();
}

async function refreshQuote(symbol) {
  const q = await api.get(`/api/quote?symbol=${encodeURIComponent(symbol)}`).catch(() => null);
  if (q?.quote?.ok) {
    P.chartState.price = q.quote.price;
    P.chartState.changePct = q.quote.changePct;
    P.drawChart();
  }
}

// ── the gate buttons ──────────────────────────────────────────────────────────
async function gateAction(act, id) {
  const routes = { stamp: '/api/approvals/stamp', confirm: '/api/approvals/confirm', decline: '/api/approvals/confirm' };
  try {
    const out = await api.post(routes[act], { proposalId: id, confirmed: act !== 'decline' });
    if (out?.proposal) {
      state.gate = out.proposal;
      P.renderGate(out.proposal, state.seats);
    }
    if (act === 'stamp') {
      P.toast(out.report?.status === 'veto' ? 'Sentinel vetoed the ticket' : 'Sentinel stamped the ticket — confirm to execute', out.report?.status === 'veto');
    }
    if (act === 'confirm') {
      const exec = await api.post('/api/approvals/execute', { proposalId: id });
      P.toast(exec.report?.status === 'blocked' ? exec.report.headline : exec.report?.headline ?? 'no fill', exec.report?.status === 'blocked');
    }
    const desk = await api.get('/api/desk').catch(() => null);
    if (desk) {
      state.desk = desk;
      P.renderQueue(desk.tasks, state.seats);
    }
  } catch (err) {
    P.toast(err.message, true);
  }
}

// ── commands ──────────────────────────────────────────────────────────────────
async function send(text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  state.lastCommand = clean;
  $('#reply-text').innerHTML = '<span style="color:var(--ink-3)">routing…</span>';
  orb.setMasterState('thinking');
  try {
    const out = await api.command(clean);
    if (out?.reply) onReply(out.reply);
  } catch (err) {
    P.toast(`command failed: ${err.message}`, true);
    orb.setMasterState('idle');
  }
}

// ── focus / seats ─────────────────────────────────────────────────────────────
function setFocus(id, { soft } = {}) {
  state.focus = id;
  orb.focus(id);
  const card = $('#focus-card');
  if (!id) {
    card.hidden = true;
    return;
  }
  const seat = state.seats.find((s) => s.id === id);
  if (!seat) return;
  card.hidden = false;
  $('#fc-glyph').textContent = seat.glyph ?? '◈';
  $('#fc-glyph').style.color = `hsl(${seat.hue} 90% 70%)`;
  $('#fc-name').textContent = seat.name;
  $('#fc-role').textContent = seat.title ?? seat.role;
  $('#fc-bio').textContent = seat.bio ?? seat.tagline;
  card.style.borderColor = `hsla(${seat.hue} 90% 60% / .45)`;
  if (!soft) $('#cmd').focus();
}

// ── ui wiring ─────────────────────────────────────────────────────────────────
function wireUi() {
  $('#cmd-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#cmd').value;
    $('#cmd').value = '';
    send(v);
  });
  $('#chips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (b) send(b.dataset.cmd);
  });
  $('#pulse').addEventListener('picksymbol', (e) => {
    api.post('/api/chart', { action: 'setSymbol', payload: { symbol: e.detail }, agent: 'operator' });
    loadSeries(e.detail);
  });
  $('#log-clear').addEventListener('click', () => ($('#log').innerHTML = '<li class="empty">cleared</li>'));
  $('#focus-close').addEventListener('click', () => setFocus(null));
  $('#fc-route').addEventListener('click', () => send(state.lastCommand || `what does ${state.focus} see`));
  $('#fc-say').addEventListener('click', () => {
    const seat = state.seats.find((s) => s.id === state.focus);
    if (!seat) return P.toast('focus a seat first');
    voices?.speak(seat.id, `${seat.name}. ${seat.tagline}`);
  });
  $('#btn-mute').addEventListener('click', () => {
    const mode = voices.cycleMode();
    $('#btn-mute').classList.toggle('on', mode !== 'muted');
    $('#btn-mute').textContent = mode === 'muted' ? '🔇 voices' : mode === 'all' ? '🔊 seats' : '🔊 voices';
    $('#voice-label').textContent = `voices: ${mode === 'muted' ? 'off — captions only' : `${voices.engine} · ${mode}`}`;
    P.toast(mode === 'all' ? 'every specialist reads its own line' : mode === 'master' ? 'only the master speaks' : 'muted');
  });
  $('#btn-full').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => P.toast('fullscreen refused by the browser'));
  });
  $('#btn-talk').addEventListener('click', toggleTalk);
  $('#btn-hands').addEventListener('click', toggleHands);
  $('#sim-dismiss').addEventListener('click', () => ($('#sim-band').hidden = true));
  $('#gate-body').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (b) gateAction(b.dataset.act, b.dataset.id);
  });
  $('#chart-tf').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('#chart-tf button').forEach((x) => x.classList.toggle('on', x === b));
    P.chartState.interval = b.dataset.tf;
    api.post('/api/chart', { action: 'setInterval', payload: { symbol: state.symbol, interval: b.dataset.tf }, agent: 'operator' });
    P.drawChart();
  });
  $('#btn-tv').addEventListener('click', openTradingView);

  // stage pointer → hover + click on seats, and steering
  const stage = $('#stage');
  stage.addEventListener('pointermove', (e) => {
    const rect = $('#orb').getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
    const ny = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
    orb.steer(nx, ny);
    const id = orb.seatFromEvent(e);
    orb.hoverId = id;
    stage.style.cursor = id ? 'pointer' : '';
  });
  stage.addEventListener('click', (e) => {
    const id = orb.seatFromEvent(e);
    if (id) setFocus(state.focus === id ? null : id);
  });
  window.addEventListener('resize', () => { P.drawChart(); });
  new MutationObserver(() => P.drawChart()).observe($('#chart-wrap'), { childList: true });

  document.addEventListener('keydown', keys);
}

function keys(e) {
  const typing = document.activeElement === $('#cmd');
  if (e.key === 'Escape') { setFocus(null); return; }
  if (typing) return;
  if (e.code === 'Space') { e.preventDefault(); toggleTalk(); return; }
  if (/^[1-9]$/.test(e.key)) {
    const seat = state.seats[Number(e.key) - 1];
    if (seat) setFocus(seat.id);
    return;
  }
  if (e.key === 'm') $('#btn-mute').click();
  if (e.key === 'h') toggleHands();
  if (e.key === 'f') $('#btn-full').click();
  if (e.key === 't') openTradingView();
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const idx = state.seats.findIndex((s) => s.id === state.focus);
    const next = state.seats[(idx + dir + state.seats.length) % state.seats.length] ?? state.seats[0];
    setFocus(next.id);
    orb.route([next.id]);
  }
}

// ── desktop shell hooks (Electron only; harmless in a browser) ───────────────
function initDesktop() {
  const d = window.desk;
  if (!d?.isDesktop) return;
  d.onTalk?.(() => toggleTalk());
  d.onVoices?.(() => $('#btn-mute').click());
  d.onFocusMode?.(() => {
    const kiosk = document.body.classList.toggle('kiosk');
    document.querySelectorAll('.col-l, .col-r').forEach((c) => (c.style.display = kiosk ? 'none' : ''));
    document.querySelector('main.hud')?.style.setProperty('grid-template-columns', kiosk ? '1fr' : '');
  });
  d.info?.().then((i) => (document.title = `F.R.I.D.A.Y. · desk ${i?.version ?? ''}`)).catch(() => {});
}

// ── talking ───────────────────────────────────────────────────────────────────
let recognition = null;
function toggleTalk() {
  if (state.listening) return stopTalk();
  if (!voices?.sttSupported) {
    P.toast('no browser speech engine here — trying whisper.cpp');
    return fallbackListen();
  }
  const res = voices.listen({
    onInterim: (t) => {
      $('#orb-sub').textContent = t || 'listening…';
      $('#cmd').value = t;
    },
    onFinal: (t) => {
      stopTalk();
      if (t) send(t);
    },
    onError: (msg) => {
      stopTalk();
      if (msg !== 'aborted' && msg !== 'no-speech') P.toast(`speech: ${msg}`, true);
    },
  });
  if (!res.ok) return fallbackListen();
  recognition = res;
  state.listening = true;
  $('#btn-talk').setAttribute('aria-pressed', 'true');
  orb.setMasterState('listening');
  $('#orb-sub').textContent = 'listening — say a sentence';
}

function stopTalk() {
  recognition?.stop?.();
  recognition = null;
  state.listening = false;
  $('#btn-talk').setAttribute('aria-pressed', 'false');
  if (orb.masterState === 'listening') orb.setMasterState('idle');
}

async function fallbackListen() {
  try {
    const text = await voices.recordAndTranscribe({ onState: (s) => ($('#orb-sub').textContent = s) });
    if (text) send(text);
  } catch (err) {
    P.toast(err.message, true);
  }
  stopTalk();
}

// ── hands ─────────────────────────────────────────────────────────────────────
async function toggleHands() {
  if (state.hands) {
    state.hands.disable();
    state.hands = null;
    $('.handcam')?.classList.remove('on');
    $('#btn-hands').classList.remove('on');
    return;
  }
  let box = $('.handcam');
  if (!box) {
    box = document.createElement('div');
    box.className = 'handcam';
    box.innerHTML = '<canvas></canvas><div class="st">hands: tracking</div>';
    $('#stage').appendChild(box);
  }
  const btn = $('#btn-hands');
  btn.textContent = '🖐️ connecting…';
  try {
    state.hands = await enableHands({
      videoEl: Object.assign(document.createElement('video'), { playsInline: true, muted: true }),
      canvasEl: box.querySelector('canvas'),
      onSteer: (x, y) => orb.steer(x, y),
      onPinch: (down) => { if (down && state.focus) P.toast(`grabbed ${state.focus.toUpperCase()}`); },
      onSwipe: (dir) => {
        const idx = state.desk?.watchlist?.indexOf(state.symbol ?? '') ?? 0;
        const next = state.desk.watchlist[(idx + dir + state.desk.watchlist.length) % state.desk.watchlist.length];
        loadSeries(next);
        api.post('/api/chart', { action: 'setSymbol', payload: { symbol: next }, agent: 'hands' });
      },
      onFist: () => setFocus(null),
    });
    box.classList.add('on');
    btn.classList.add('on');
    btn.textContent = '🖐️ hands on';
    P.toast('hand tracking live — point at a seat, pinch to focus, swipe to flip symbols');
  } catch (err) {
    btn.textContent = '🖐️ hands n/a';
    P.toast(`hands unavailable: ${err.message}. Mouse and keys drive the orb the same way.`, true);
  }
}

// ── modals ────────────────────────────────────────────────────────────────────
// ── external chart, no overlay ────────────────────────────────────────────────
/**
 * TradingView opens in its own tab. Nothing in this HUD draws a layer over the
 * desk: the panels, the orb and the gate are the interface, and a modal on top
 * of them is strictly worse than a second window the operator can look at while
 * the desk keeps talking.
 */
function openTradingView() {
  const sym = state.symbol || 'SPY';
  const url = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent('NASDAQ:' + sym)}`;
  const win = window.open(url, '_blank');
  if (!win) {
    P.toast('the browser blocked that tab — allow pop-ups for this page (or ⌘/Ctrl-click the button)', true);
    return;
  }
  try { win.opener = null; } catch { /* cross-origin already detached */ }
}

// keep the countdown ticking between SSE pushes
setInterval(() => {
  const s = state.desk?.session;
  if (!s?.countdownMs) return;
  s.countdownMs = Math.max(0, s.countdownMs - 1000);
  s.countdownLabel = fmtCountdown(s.countdownMs);
  $('#sess-countdown').textContent = s.countdownLabel;
}, 1000);

function fmtCountdown(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}
