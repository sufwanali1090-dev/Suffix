/**
 * panels.js — rendering for the six side panels and the screens.
 *
 * One rule repeated in every function: `null`/`undefined`/`NaN` renders as an
 * em dash. A dash is a claim about the world ("this feed is down"); a zero or a
 * leftover value from the last symbol is a lie. The chart refuses to draw a
 * level it cannot source, and the SIM flag rides along with the data everywhere
 * it came from.
 */
import { fmt, esc, DASH } from './api.js';

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

export const chartState = {
  symbol: null,
  series: [],
  levels: [],
  markers: [],
  band: null,
  source: null,
  simulated: false,
  note: 'no symbol loaded — CHARTIST drives this panel',
  interval: 'D',
  price: null,
  changePct: null,
};

// ── market pulse ──────────────────────────────────────────────────────────────
export function renderPulse(rows = [], feed = {}) {
  const host = $('#pulse');
  if (!host) return;
  const size = 62;
  const c = Math.PI * (size - 6);
  if (host.children.length !== rows.length) {
    host.innerHTML = '';
    for (const r of rows) {
      const node = el('div', 'ring');
      node.dataset.symbol = r.symbol;
      node.innerHTML = `
        <svg viewBox="0 0 ${size} ${size}"><g transform="translate(${size / 2} ${size / 2})">
          <circle class="track" r="${(size - 6) / 2}"></circle>
          <circle class="arc" r="${(size - 6) / 2}" stroke-dasharray="${c}" stroke-dashoffset="${c}"></circle>
        </g></svg>
        <div class="sym">${esc(r.symbol)}</div><div class="pct">${DASH}</div><div class="px">${DASH}</div>`;
      node.title = `${r.symbol} — click to load it on the screens`;
      node.addEventListener('click', () => host.dispatchEvent(new CustomEvent('picksymbol', { detail: r.symbol, bubbles: true })));
      host.appendChild(node);
    }
  }
  rows.forEach((r, i) => {
    const node = host.children[i];
    if (!node) return;
    const pct = Number(r.changePct);
    const up = r.ok && pct >= 0;
    node.classList.toggle('up', !!up);
    node.classList.toggle('down', r.ok && !up);
    node.classList.toggle('dead', !r.ok);
    const arc = node.querySelector('.arc');
    const frac = Number.isFinite(pct) ? Math.min(1, Math.abs(pct) / 6) : 0;
    arc.style.stroke = r.ok ? (up ? 'var(--up)' : 'var(--down)') : 'rgba(255,255,255,.12)';
    arc.setAttribute('stroke-dashoffset', String(c * (1 - frac)));
    node.querySelector('.pct').textContent = r.ok ? fmt.pct(pct) : DASH;
    node.querySelector('.px').textContent = r.ok ? `$${fmt.price(r.price)}` : DASH;
    node.title = r.ok
      ? `${r.symbol} · $${fmt.price(r.price)} · ${fmt.pct(pct)} · as of ${new Date(r.asOf).toLocaleTimeString()}`
      : `${r.symbol} · no data — ${r.reason ?? 'feed unavailable'}`;
    if (r.ok && Math.abs(pct - (node._last ?? pct)) > 0.35) {
      node.classList.remove('flash');
      void node.offsetWidth;
      node.classList.add('flash');
    }
    node._last = pct;
  });
  $('#pulse-updated').textContent = feed.lastPollAt ? `refreshed ${fmt.hhmm(feed.lastPollAt)}` : '—';
  $('#pulse-mode').textContent = feed.simulated ? 'simulated series' : feed.live ? 'finnhub · 1-min' : 'no feed';
  $('#panel-pulse')?.dataset && ($('#panel-pulse').dataset.sim = feed.simulated ? '1' : '0');
}

// ── task queue ────────────────────────────────────────────────────────────────
export function renderQueue(tasks = [], seats = []) {
  const host = $('#queue');
  if (!host) return;
  if (!tasks.length) {
    host.innerHTML = '<li class="empty">nothing routed yet — say something</li>';
    return;
  }
  host.innerHTML = '';
  for (const t of tasks) {
    const li = el('li');
    li.dataset.s = t.status;
    const pips = (t.agents || [])
      .map((id) => {
        const s = seats.find((x) => x.id === id);
        return `<span class="seatpip" title="${esc(s?.name ?? id)}" style="background:hsl(${s?.hue ?? 44} 90% 60%)"></span>`;
      })
      .join('');
    li.innerHTML = `<span class="st"></span>
      <span class="txt"><b>${esc(t.command?.slice(0, 58) ?? '')}</b>
      <small>${esc((t.done || []).length + (t.failed || []).length)}/${(t.agents || []).length} seats answered${t.symbol ? ` · ${esc(t.symbol)}` : ''}</small>
      <span class="seats">${pips}</span></span>
      <span class="ms">${t.ms != null ? `${t.ms}ms` : '…'}</span>`;
    li.title = t.summary || t.detail || '';
    host.appendChild(li);
  }
}

// ── signal log ────────────────────────────────────────────────────────────────
export function pushLog(evt, seats) {
  const host = $('#log');
  if (!host) return;
  if (host.firstElementChild?.classList.contains('empty')) host.innerHTML = '';
  const seat = seats.find((s) => s.id === evt.agent);
  const li = el('li');
  li.dataset.sev = evt.severity || 'info';
  li.innerHTML = `<time>${fmt.hhmm(evt.at)}</time>
    <p><span class="ag" style="color:hsl(${seat?.hue ?? 44} 90% 70%)">${esc(seat?.name ?? evt.agent)}</span>
    &nbsp;${highlight(evt.text)}</p>`;
  host.prepend(li);
  while (host.children.length > 90) host.lastElementChild.remove();
}

/** Numbers in agent copy get a little weight: the eye should land on figures. */
function highlight(text) {
  return esc(text)
    .replace(/(-?\$?\d[\d,]*\.?\d*\s?(?:%|ms|:1)?)/g, '<b>$1</b>')
    .replace(/\b(VETO|STAMPED|no\.?)\b/gi, '<b>$1</b>');
}

// ── session ───────────────────────────────────────────────────────────────────
export function renderSession(s) {
  if (!s) return;
  $('#sess-dot').dataset.tone = s.tone;
  $('#sess-label').textContent = s.label;
  $('#sess-sub').textContent = `${s.weekday} ${s.nyDate} · ${s.nyClock} ET${s.holiday ? ' · NYSE holiday' : ''}`;
  $('#sess-count-label').textContent = s.countingTo ? `to ${s.countingTo.split(' · ')[1] ?? 'next'}` : 'next';
  $('#sess-countdown').textContent = s.countdownLabel || fmt.countdown?.(s.countdownMs) || DASH;
  $('#sess-hint').textContent = s.tickerHint || '';
  $('#session-top').textContent = `${s.label.toUpperCase()} ${s.countdownLabel ? `· ${s.countdownLabel}` : ''}`;
  $('#stat-session').dataset.state = s.phase === 'open' ? 'live' : s.phase === 'closed' ? 'down' : 'sim';
  $('#clock-et').textContent = `${s.nyClock}:${String(s.nySeconds ?? 0).padStart(2, '0')} ET`;
}

// ── calendar ──────────────────────────────────────────────────────────────────
export function renderCalendar(cal, nextEvent) {
  const host = $('#cal');
  if (!host || !cal) return;
  $('#cal-month').textContent = cal.label;
  const today = new Date().toISOString().slice(0, 10);
  const heads = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => `<span>${d}</span>`).join('');
  const cells = cal.cells
    .map((cell) => {
      if (cell.blank) return `<div class="cell blank"></div>`;
      const dots = cell.events.map((e) => `<i class="${e.kind}" title="${esc(e.label)}"></i>`).join('');
      const title = cell.events.length ? cell.events.map((e) => e.label).join(' + ') : '';
      return `<div class="cell${cell.weekend ? ' weekend' : ''}${cell.iso === today ? ' today' : ''}" title="${esc(title)}">
        <span>${cell.day}</span>${dots ? `<span class="dots">${dots}</span>` : ''}</div>`;
    })
    .join('');
  host.innerHTML = `<div class="head">${heads}</div><div class="row">${cells}</div>`;
  $('#cal-next').textContent = nextEvent
    ? `next: ${nextEvent.label} · ${nextEvent.date}${nextEvent.daysAway === 0 ? ' (today)' : nextEvent.daysAway ? ` · ${nextEvent.daysAway}d` : ''}`
    : 'no scheduled events in range';
}

// ── agent load ────────────────────────────────────────────────────────────────
export function renderLoad(agents = [], load = [], stateMap = new Map()) {
  const host = $('#load');
  if (!host) return;
  const rows = agents.filter((a) => a.id !== 'friday');
  const maxCalls = Math.max(1, ...load.map((l) => l.calls || 0));
  host.innerHTML = rows
    .map((a) => {
      const l = load.find((x) => x.agent === a.id) ?? {};
      const avgMs = l.avgMs ?? (l.calls ? Math.round((l.ms || 0) / l.calls) : null);
      const st = stateMap.get(a.id) ?? a.state ?? 'idle';
      const pct = Math.round(((l.calls || 0) / maxCalls) * 100);
      return `<li data-state="${esc(st)}">
        <span class="nm"><i></i>${esc(a.name)}</span>
        <span class="num">${l.calls ?? 0}× · ${avgMs != null ? avgMs + 'ms' : DASH}${l.errors ? ` · ${l.errors}err` : ''}</span>
        <span class="bar"><span style="width:${pct}%;background:hsl(${a.hue} 90% 62%)"></span></span>
      </li>`;
    })
    .join('');
}

// ── the gate ──────────────────────────────────────────────────────────────────
const GATE_STEPS = ['pending', 'stamped', 'confirmed', 'executed'];

export function renderGate(proposal, seats) {
  const body = $('#gate-body');
  const empty = $('#gate-empty');
  if (!body || !empty) return;
  if (!proposal) {
    body.hidden = true;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  body.hidden = false;
  const seat = seats.find((s) => s.id === 'sentinel');
  const stamp = proposal.stamp;
  const stepIdx = GATE_STEPS.indexOf(proposal.status);
  const vetoed = proposal.status === 'vetoed';
  const steps = ['drafted', ...GATE_STEPS]
    .map((label, i) => {
      const on = vetoed && label === 'stamped' ? 'v' : i <= stepIdx + 1 ? '1' : '0';
      return `<span class="step" data-on="${on}">${label}</span>`;
    })
    .join('');
  const verdict = vetoed
    ? `<div class="verdict veto"><b>VETO · ${esc(seat?.name ?? 'SENTINEL')}:</b> ${esc(stamp?.reason ?? 'no reason recorded')}</div>`
    : stepIdx >= 1 && stamp?.approved
      ? `<div class="verdict ok"><b>STAMPED:</b> ${esc(stamp.reason || 'within limits')}${stamp.conditions?.length ? `<ul class="reasons">${stamp.conditions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}</div>`
      : `<div class="verdict wait"><b>AWAITING SIGN-OFF.</b> Analysis cannot execute and execution cannot self-authorize. Ask Sentinel to review it.</div>`;

  body.innerHTML = `
    <div class="steps">${steps}</div>
    <div class="ticket">
      <div class="row"><span>ticket</span><span>${esc(proposal.id)}</span></div>
      <div class="row"><span>order</span><span>${esc((proposal.side || 'buy').toUpperCase())} ${proposal.qty || 0} ${esc(proposal.symbol)}</span></div>
      <div class="row"><span>entry</span><span>$${fmt.price(proposal.entry)}</span></div>
      <div class="row"><span>stop</span><span>${proposal.stop != null ? `$${fmt.price(proposal.stop)}` : DASH}</span></div>
      <div class="row"><span>target</span><span>${proposal.target != null ? `$${fmt.price(proposal.target)}` : DASH}</span></div>
      <div class="row"><span>source</span><span>${esc(proposal.context?.quoteSource ?? '—')}${proposal.context?.simulated ? ' · SIM' : ''}</span></div>
      ${proposal.execution ? `<div class="row"><span>fill</span><span>${esc(proposal.execution.ticket)} @ $${fmt.price(proposal.execution.fillPrice)}</span></div>` : ''}
    </div>
    ${verdict}
    ${stamp?.digest ? `<div class="sig">ed25519 stamp · ${esc(String(stamp.digest).slice(0, 32))}… · verified by the public key in the master process</div>` : ''}
    <div class="actions">
      ${proposal.status === 'pending' ? `<button class="btn" data-act="stamp" data-id="${esc(proposal.id)}">request sentinel stamp</button>` : ''}
      ${proposal.status === 'stamped' ? `<button class="btn ok" data-act="confirm" data-id="${esc(proposal.id)}">confirm &amp; execute</button>` : ''}
      ${['pending', 'stamped'].includes(proposal.status) ? `<button class="btn danger" data-act="decline" data-id="${esc(proposal.id)}">decline</button>` : ''}
      ${proposal.status === 'executed' ? `<span class="hint" style="margin:0">closed · stamp consumed</span>` : ''}
    </div>`;
}

// ── the screens (SVG chart driven by CHARTIST) ────────────────────────────────
export function drawChart(host = $('#chart')) {
  if (!host) return;
  const wrap = host.parentElement;
  const w = Math.max(240, wrap.clientWidth);
  const h = Math.max(120, wrap.clientHeight);
  host.setAttribute('viewBox', `0 0 ${w} ${h}`);
  host.setAttribute('width', w);
  host.setAttribute('height', h);
  const st = chartState;
  const pad = { l: 8, r: 56, t: 10, b: 12 };
  const series = (st.series || []).map(Number).filter(Number.isFinite);
  const prices = [...series, ...st.levels.map((l) => l.price), ...st.markers.map((m) => m.price), st.price].filter((v) => Number.isFinite(v));
  if (!prices.length) {
    host.innerHTML = `<defs><linearGradient id="fadeUp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(255,255,255,.22)"/><stop offset="1" stop-color="rgba(255,255,255,0)"/></linearGradient></defs>`;
    $('#chart-tags').innerHTML = '';
    $('#chart-note').textContent = st.note;
    $('#chart-src').textContent = '—';
    return;
  }
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  const pad2 = (hi - lo) * 0.08 || hi * 0.02 || 1;
  lo -= pad2;
  hi += pad2;
  const X = (i) => pad.l + (i / Math.max(1, series.length - 1)) * (w - pad.l - pad.r);
  const Y = (p) => pad.t + (1 - (p - lo) / (hi - lo)) * (h - pad.t - pad.b);

  const defs = `<defs><linearGradient id="fadeUp" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="rgba(255,255,255,.22)"/><stop offset="1" stop-color="rgba(255,255,255,0)"/></linearGradient></defs>`;
  const grid = Array.from({ length: 4 }, (_, i) => {
    const y = pad.t + ((h - pad.t - pad.b) / 3) * i;
    return `<line class="grid" x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}"/>`;
  }).join('');
  const line = series.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p).toFixed(1)}`).join(' ');
  const area = series.length > 1 ? `<path class="area" d="${line} L${X(series.length - 1).toFixed(1)},${h - pad.b} L${pad.l},${h - pad.b} Z"/>` : '';

  const band = st.band
    ? `<rect class="band" x="${X(Math.max(0, series.length - 1))}" y="${Y(st.band.p95)}"
        width="${Math.max(10, (w - pad.l - pad.r) * 0.16)}" height="${Math.max(2, Y(st.band.p05) - Y(st.band.p95))}"/>`
    : '';

  const kindColor = { support: '#2fe08a', resistance: '#ff5d6c', stop: '#ffb648', price: '#cfe0ff', sma50: '#7ec8ff', fill: '#ffcb52', level: '#9fb0cc' };
  const levels = st.levels
    .map((l, i) => {
      const y = Y(l.price);
      const col = kindColor[l.kind] ?? kindColor.level;
      return `<g><line class="lvl" x1="${pad.l}" y1="${y}" x2="${w - pad.r}" stroke="${col}"/>
        <text class="lvl-label" x="${w - pad.r + 4}" y="${y + 3}" fill="${col}">${esc((l.label ?? l.kind ?? '').slice(0, 12))}</text>
        <text class="lvl-label" x="${w - 4}" y="${y - 5}" text-anchor="end" fill="${col}" opacity=".85">${fmt.price(l.price)}</text></g>`;
    })
    .join('');

  const markers = st.markers
    .map((m) => {
      const x = X(Math.max(0, Math.min(series.length - 1, m.i ?? series.length - 1)));
      const y = Y(m.price);
      return `<g><path class="marker" d="M${x - 5},${y - 6} L${x + 5},${y - 6} L${x},${y + 1} Z" fill="#ffcb52" stroke="#04060c"/>
        <text x="${x + 8}" y="${y - 4}" fill="#ffcb52">${esc(m.label ?? 'fill')}</text></g>`;
    })
    .join('');

  const last = series.length ? series[series.length - 1] : st.price;
  const lastY = Y(last);
  const lastX = X(Math.max(0, series.length - 1));
  const dot = `<circle cx="${lastX}" cy="${lastY}" r="3.4" fill="#fff" opacity=".92"><animate attributeName="r" values="3;4.6;3" dur="2.4s" repeatCount="indefinite"/></circle>`;

  host.innerHTML = defs + grid + area + `<path class="line" d="${line}"/>` + band + levels + markers + dot;

  $('#chart-tags').innerHTML = st.levels
    .slice(0, 5)
    .map((l) => `<span class="tag" data-kind="${esc(l.kind)}">${esc(l.kind)} ${fmt.price(l.price)}${l.touches ? ` ${l.touches}×` : ''}</span>`)
    .join('');
  $('#chart-symbol').textContent = st.symbol ? `${st.symbol} · $${fmt.price(st.price ?? last)}${st.changePct != null ? ` · ${fmt.pct(st.changePct)}` : ''}` : '—';
  $('#chart-note').textContent = st.note;
  $('#chart-src').textContent = st.source ? `${st.source}${st.simulated ? ' · SIM' : ''} · ${st.levels.length} line(s)` : '—';
}

export function applyChartAction(action, payload = {}) {
  const st = chartState;
  switch (action) {
    case 'setSymbol':
      st.symbol = payload.symbol ?? st.symbol;
      st.levels = [];
      st.markers = [];
      st.band = null;
      st.note = `${st.symbol}: series requested`;
      break;
    case 'setInterval':
      st.interval = payload.interval ?? st.interval;
      break;
    case 'drawLevel': {
      const price = Number(payload.price);
      if (payload.price === null || payload.price === undefined || !Number.isFinite(price) || price <= 0) {
        st.note = 'a level was rejected: no numeric price — nothing drawn';
        break;
      }
      st.levels = [
        ...st.levels.filter((l) => !(l.kind === payload.kind && Math.abs(l.price - payload.price) / payload.price < 0.0015)),
        { kind: payload.kind ?? 'level', price, label: payload.label ?? payload.kind, touches: payload.touches },
      ].sort((a, b) => b.price - a.price);
      break;
    }
    case 'clearLevels':
      st.levels = [];
      st.markers = [];
      st.band = null;
      st.note = 'overlays cleared';
      break;
    case 'drawForecastBand': {
      const b = [payload.p05, payload.p50, payload.p95].map(Number);
      if (!b.every(Number.isFinite)) { st.note = 'forecast band rejected: incomplete quantiles'; break; }
      st.band = { p05: b[0], p50: b[1], p95: b[2] };
      st.note = `ORACLE band · 5–95 percentile over ${payload.horizonDays ?? '?'}d`;
      break;
    }
    case 'annotate': {
      const price = Number(payload.price);
      if (payload.price !== null && payload.price !== undefined && Number.isFinite(price) && price > 0) {
        st.markers = [...st.markers, { price, label: payload.note?.slice(0, 24) ?? 'note' }];
      }
      st.note = payload.note ? String(payload.note).slice(0, 120) : st.note;
      break;
    }
    default:
      return false;
  }
  return true;
}

// ── misc ──────────────────────────────────────────────────────────────────────
export function setFeedBadge(feed) {
  const stat = $('#stat-feed');
  if (!stat) return;
  const sim = Boolean(feed?.simulated);
  const live = Boolean(feed?.live);
  stat.dataset.state = live ? 'live' : sim ? 'sim' : 'down';
  $('#feed-label').textContent = live ? 'LIVE · FINNHUB' : sim ? 'SIM' : 'NO FEED';
  const band = $('#sim-band');
  if (band) band.hidden = !sim;
  const reason = $('#sim-reason');
  if (reason && feed?.reason) reason.textContent = feed.reason;
  document.querySelectorAll('.panel').forEach((p) => {
    if (p.id !== 'panel-pulse') p.dataset.sim = sim ? '1' : '0';
  });
  chartState.simulated = sim;
}

export function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.classList.toggle('bad', bad);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), bad ? 5200 : 3000);
}
