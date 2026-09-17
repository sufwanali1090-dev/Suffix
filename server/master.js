/**
 * master.js — F.R.I.D.A.Y., the only agent that talks to you.
 *
 * The pipeline for one spoken command:
 *
 *   hear → route → delegate (parallel wave) → follow chains → gate → synthesize → speak
 *
 * The master holds no opinions about markets. It answers from what the
 * specialists reported, verbatim numbers or nothing, and it cannot approve a
 * trade — Sentinel's signature is checked in approvals.js, not here, so the
 * master can't grant what it doesn't have.
 */
import { config } from './config.js';
import { ROSTER } from './agents/roster.js';
import { truncate, uid, round } from './util.js';
import { llmAvailable, synthesizeReply, routeWithModel } from './llm.js';

/** Execution order inside a wave: read the tape → value it → draw it → gate money. */
const ORDER = { atlas: 0, capitol: 1, scout: 2, athena: 3, oracle: 4, chartist: 5, pilot: 6, sentinel: 7, ledger: 8 };

const NAME_TO_TICKER = {
  nvidia: 'NVDA', apple: 'AAPL', microsoft: 'MSFT', tesla: 'TSLA', meta: 'META',
  facebook: 'META', amazon: 'AMZN', google: 'GOOGL', alphabet: 'GOOGL', alphabet: 'GOOGL',
  netflix: 'NFLX', broadcom: 'AVGO', amd: 'AMD', supermicro: 'SMCI', palantir: 'PLTR',
  coinbase: 'COIN', sp500: 'SPY', 's&p': 'SPY', spx: 'SPY', spy: 'SPY', nasdaq: 'QQQ', qqq: 'QQQ',
};

const SHOUTY_NOISE = new Set(['I', 'A', 'US', 'OK', 'AI', 'ETF', 'API', 'AM', 'PM', 'ET', 'TV', 'GO', 'DO', 'IT', 'MY', 'NO', 'SO', 'UP', 'ATM', 'FX', 'GDP', 'CPI', 'FED', 'IPO']);

const INTENTS = [
  { id: 'confirm', re: /\b(confirm|i approve|go ahead|finali[sz]e it|do it|yes, (place|send|execute))\b/i, agents: ['pilot'], note: 'operator confirmation' },
  { id: 'approve', re: /\b(approve|stamp|sign ?off|sign it|green ?light|risk it|bless it|clear it)\b/i, agents: ['sentinel'], note: 'risk sign-off requested' },
  { id: 'review', re: /\b(journal|log it|review|debrief|what did we (get wrong|do)|mistake|p&?l|pnl|performance|health|stats|audit|how are we)\b/i, agents: ['ledger'] },
  { id: 'execute', re: /\b(buy|sell|execute|place|send it|order|long|short|get me in|open a position|size (me )?(up|in))\b/i, agents: ['pilot', 'sentinel'], note: 'money path — gated' },
  { id: 'propose', re: /\b(propose|draft|pitch|intend|set up (a|an|the))\b/i, agents: ['pilot', 'athena'] },
  { id: 'chart', re: /\b(chart|pull up|bring up|fire up|show me|flip|switch|time ?frame|draw|mark|lines?|overlay|clean up|clear (it|the)|screenshot|screen)\b/i, agents: ['athena', 'chartist'], note: 'screens driven' },
  { id: 'forecast', re: /\b(forecast|predict|model|odds|probabilit|scenario|timesfm|monte ?carlo|where (does|is|will) (it|this|that) (go|end|head)|chances|distribution)\b/i, agents: ['oracle'] },
  { id: 'risk', re: /\b(risk|size|how (much|many) (shares|can i)|stop ?loss|stop|heat|exposure|veto|draw ?down|position limit)\b/i, agents: ['sentinel'] },
  { id: 'structure', re: /\b(levels?|support|resistance|structure|supply|demand|thesis|fundamental|valuation|earnings|breakout|liquidity|chart (looks|read)|fair value)\b/i, agents: ['athena'] },
  { id: 'smartmoney', re: /\b(congress|politician|senator|representative|insider|13f|smart money|institutional|hedge fund|whale|big money)\b/i, agents: ['capitol'] },
  { id: 'recon', re: /\b(viral|trend|movers?|gappers?|buzz|what(?:'?s| is) (?:moving|hot|up|jumping)|who(?:'s| is) (?:moving|up|hot)|retail flow|top gainers?|most active|attention|recon|leaders)\b/i, agents: ['scout'] },
  { id: 'macro', re: /\b(fed|fomc|macro|rates?|yields?|inflation|cpi|pce|liquidity|dollar|bond|treasur|soft landing|hawkish|dovish)\b/i, agents: ['atlas'] },
  { id: 'briefing', re: /\b(brief|briefing|morning|report in|status (of )?the desk|what.?s the (tape|read|state)|where are we|catch me up)\b/i, agents: ['atlas', 'scout', 'athena', 'oracle'] },
  { id: 'roster', re: /\b(who (are you|is here|are the)|agents?|roster|team|what can you do|help|commands?)\b/i, agents: [] },
];

const AMOUNT_RE = /\b(?:buy|sell|long|short)?\s*(\d{1,6})\s*(?:shares?(?:\s+of)?|contracts?|@)?\s*([A-Z]{1,5})?\b/i;

function extractSymbol(text) {
  const lower = String(text).toLowerCase();
  for (const [name, t] of Object.entries(NAME_TO_TICKER)) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) return t;
  }
  // "buy 500 shares of FAKETKR" — after a trade verb a short token is a ticker,
  // even a weird-looking one: looking it up and failing beats shrugging.
  const afterVerb = lower.match(/\b(?:buy|sell|short|long|flip|quote|chart|pull up|show me|load)\s+(?:\d+\s*(?:shares?|contracts?|units?)\s*(?:of)?\s*)?([a-z]{1,7})\b/g);
  const NOISE = new Set(['the', 'it', 'me', 'up', 'on', 'a', 'an', 'some', 'stock', 'shares', 'of', 'now', 'and', 'to', 'more', 'less', 'my', 'our', 'with', 'half', 'double', 'at', 'for']);
  for (const frag of afterVerb ?? []) {
    const tok = frag.split(/\s+/).pop().toUpperCase();
    if (tok && !NOISE.has(tok.toLowerCase()) && /^[A-Z]{1,7}$/.test(tok)) return tok;
  }
  const caps = String(text).match(/\b[A-Z]{2,6}\b/g) ?? [];
  const known = [...config.tradingview.symbols, ...['NVDA', 'AAPL', 'MSFT', 'SPY', 'QQQ', 'TSLA', 'AMD', 'META', 'AMZN', 'GOOGL', 'NFLX', 'AVGO', 'SMCI', 'PLTR', 'COIN', 'SOXL', 'IWM', 'DIA', 'BTC-USD', 'GC=F']];
  for (const c of caps) {
    if (known.includes(c)) return c;
  }
  for (const c of caps) {
    if (!SHOUTY_NOISE.has(c) && c.length >= 2 && !/^(AND|THE|OR|TO|IT|IS|ARE|CAN)$/i.test(c)) return c;
  }
  return null;
}

function extractParams(text) {
  const params = {};
  if (/\b(clear|reset|clean up|wipe|remove (the )?(lines|overlays|levels))\b/i.test(text)) params.action = 'clear';
  const qty = text.match(/\b(\d{1,6})\s*(?:shares?|contracts?|units?)\b/i) || text.match(/\b(?:buy|sell|long|short)\s+(\d{1,6})\b/i);
  if (qty) params.qty = Number(qty[1]);
  if (/\b(sell|short|close|exit)\b/i.test(text)) params.side = 'sell';
  else if (/\b(buy|long|add)\b/i.test(text)) params.side = 'buy';
  const tf = text.match(/\b(weekly|daily|hourly|monthly|(?:1|5|15|60)\s?(?:m|min|hour|d|day|w|week))\b/i);
  if (tf) params.interval = tf[1].toLowerCase().replace(/\s/g, '');
  const horizon = text.match(/\b(\d{1,3})[- ]?(?:day|d)\b/i);
  if (horizon) params.horizon = Number(horizon[1]);
  const limit = text.match(/\b(top|first)\s+(\d{1,2})\b/i);
  if (limit) params.limit = Number(limit[2]);
  const prop = text.match(/\bprop[_ ]?(?:id)?\s+([a-z0-9_]{6,})/i);
  if (prop) params.proposalId = prop[1];
  const ref = text.match(/#([a-z0-9_]{6,})/i);
  if (ref) params.proposalId = ref[1];
  return params;
}

export class Master {
  constructor({ bus, journal, queue, feed, approvals, blotter, call, load, mcp, servicesFor }) {
    this.bus = bus;
    this.journal = journal;
    this.queue = queue;
    this.feed = feed;
    this.approvals = approvals;
    this.blotter = blotter;
    this.call = call; // registry call(): in-process or over HTTP, per roster
    this.load = load;
    this.mcp = mcp;
    // Capability scoping lives with the wiring, not with me: Sentinel is the
    // only seat that ever receives the signing key, and I cannot read it.
    this.servicesFor = servicesFor ?? (() => ({}));
    this.id = uid('friday');
    this.state = 'idle';
    this.lastError = null;
    this.session = null;
    this.nextEvent = null;
    this.calendar = null;
  }

  /** Live clock context, refreshed by the server ticker. */
  updateContext({ session, nextEvent, calendar }) {
    this.session = session ?? this.session;
    this.nextEvent = nextEvent ?? this.nextEvent;
    this.calendar = calendar ?? this.calendar;
  }

  setState(state, detail = '') {
    this.state = state;
    this.bus?.agentState('friday', state, detail);
  }

  /** Deterministic routing. The LLM path refines it; nothing depends on it. */
  route(text) {
    const clean = String(text || '').trim();
    const hits = INTENTS.filter((i) => i.re.test(clean));
    const seen = new Set();
    const agentIds = [];
    for (const hit of hits) {
      for (const id of hit.agents) if (!seen.has(id)) { seen.add(id); agentIds.push(id); }
    }
    const priority = hits[0] ? [...hits].sort((a, b) => INTENTS.indexOf(a) - INTENTS.indexOf(b))[0] : null;
    const route0 = { params: extractParams(clean) };
    // Analysis never executes: strip Pilot if the only signal is analytical.
    let agents = agentIds.slice(0, 4);
    if (priority?.id === 'approve' || priority?.id === 'confirm') agents = priority.agents.slice();
    if (priority?.id === 'risk') agents = ['sentinel'];
    // Wiping overlays is a keystroke, not a research task: one seat, no analyst.
    if (route0?.params?.action === 'clear') agents = ['chartist'];
    agents.sort((a, b) => (ORDER[a] ?? 99) - (ORDER[b] ?? 99));
    return {
      agents,
      symbol: extractSymbol(clean),
      params: extractParams(clean),
      intents: hits.map((h) => h.id),
      note: priority?.note ?? null,
      via: 'local-router',
    };
  }

  seatFor(id) {
    return ROSTER.find((a) => a.id === id);
  }

  ctxFor(id, text, route, reports = {}) {
    return {
      ...this.ctxBase(text, route),
      reports,
      services: { ...this.ctxBase(text, route).services, ...this.servicesFor(id) },
    };
  }

  ctxBase(text, route) {
    const now = new Date();
    return {
      text,
      intent: route.intents[0] ?? 'general',
      symbol: route.symbol,
      params: route.params,
      reports: {},
      feed: this.feed,
      session: this.session ?? null,
      nextEvent: this.nextEvent ?? null,
      calendar: this.calendar ?? null,
      services: {
        bus: this.bus,
        journal: this.journal,
        approvals: this.approvals,
        blotter: this.blotter,
        mcp: this.mcp,
        keys: null, // overwritten per seat by servicesFor() — Sentinel only
      },
    };
  }

  /**
   * Voice commands refer to "it". Resolve it against the approval ledger so the
   * operator never has to say a ticket id out loud.
   */
  resolveProposal(route) {
    if (route.params.proposalId) return route;
    const list = this.approvals.list({ limit: 20 });
    if (route.intents.includes('approve')) {
      const pending = list.find((p) => p.status === 'pending');
      if (pending) route.params.proposalId = pending.id;
    } else if (route.intents.includes('confirm') || route.intents.includes('execute')) {
      const ready = list.find((p) => p.status === 'stamped') || list.find((p) => p.status === 'pending');
      if (ready) {
        route.params.proposalId = ready.id;
        if (route.intents.includes('confirm')) route.params.confirm = true;
      }
    }
    return route;
  }

  /** One command in, one spoken answer out. */
  async handleCommand(text, { source = 'typed' } = {}) {
    const started = Date.now();
    const clean = truncate(String(text || '').trim(), 480);
    if (!clean) return { error: 'empty command' };
    this.setState('listening', source);
    this.journal.append({ kind: 'command', agent: 'friday', text: clean, source });
    this.bus.emitEvent('command', { text: clean, source });

    let route = this.route(clean);
    if (llmAvailable() && route.agents.length !== 1) {
      const refined = await routeWithModel({ command: clean, agentIds: ROSTER.map((a) => a.id) }).catch(() => null);
      if (refined?.agents?.length) {
        route = {
          ...route,
          agents: refined.agents.slice(0, 4).sort((a, b) => (ORDER[a] ?? 99) - (ORDER[b] ?? 99)),
          symbol: refined.symbol ? String(refined.symbol).toUpperCase() : route.symbol,
          params: { ...route.params, ...(refined.params || {}) },
          via: `${config.llm.model} · ${route.via}`,
          reasoning: refined.reasoning,
        };
      }
    }
    if (!route.agents.length) {
      const reply = {
        ok: true,
        speech: this.intro(),
        card: null,
        agents: [],
        reports: {},
        at: new Date().toISOString(),
        ms: Date.now() - started,
        intents: route.intents,
      };
      this.setState('speaking', 'self');
      this.bus.emitEvent('reply', { reply });
      this.setState('idle');
      return reply;
    }

    this.resolveProposal(route);

    const task = this.queue.open({ command: clean, agents: route.agents, symbol: route.symbol });
    this.bus.emitEvent('routing', { task: { id: task.id, agents: route.agents, symbol: route.symbol, intents: route.intents, via: route.via, reasoning: route.reasoning } });

    // ── wave 1: fan out in dependency order; each seat gets only its own capabilities
    const ctx0 = this.ctxBase(clean, route);
    const reports = {};
    for (const id of route.agents) {
      const ctx = this.ctxFor(id, clean, route, { ...reports });
      this.bus.agentState(id, 'thinking', route.intents.join('/'));
      const out = await this.call(id, ctx);
      reports[id] = out;
      this.queue.step(task.id, id, out.status === 'error' ? 'failed' : 'done', out.headline);
      this.bus.emitEvent('agent.report', { report: out }, { agent: id });
      this.bus.agentState(id, out.status === 'error' ? 'error' : 'speaking', out.status);
    }

    // ── wave 2: honour explicit chains (Pilot drafting → Sentinel must see it)
    const chained = [];
    for (const rep of Object.values(reports)) {
      for (const a of rep.actions || []) {
        if (a.type !== 'route') continue;
        const alreadyRan = route.agents.includes(a.to);
        const carriesNewArgs = Object.keys(a.params || {}).some((k) => ctx0.params[k] === undefined);
        if (!alreadyRan || carriesNewArgs) chained.push(a);
      }
    }
    for (const a of chained.slice(0, 2)) {
      this.bus.agentState(a.to, 'thinking', 'chained by master');
      const ctx = this.ctxFor(a.to, clean, route, reports);
      const out = await this.call(a.to, { ...ctx, params: { ...ctx.params, ...a.params } });
      reports[a.to] = out;
      this.queue.step(task.id, a.to, 'done', `chain · ${out.headline}`);
      this.bus.emitEvent('agent.report', { report: out }, { agent: a.to });
    }

    // ── strip chart actions into a single ordered queue for the screens
    const chartActions = Object.values(reports)
      .flatMap((r) => (r.actions || []).filter((a) => a.type === 'chart'))
      .map((a) => ({ action: a.action, payload: a.payload }));
    if (this.mcp?.configured) {
      for (const a of chartActions.slice(0, 10)) await this.mcp.send(a.action, a.payload).catch(() => {});
    }

    // ── synthesize
    const synthesized = await synthesizeReply({
      command: clean,
      reports,
      session: this.session,
      extra: this.feed.health().simulated ? 'DATA NOTE: quotes are from the labelled SIM feed — tell the operator, do not present these as market data.' : '',
    }).catch((err) => { this.lastError = err.message; return null; });

    const speech = synthesized?.speech ?? this.composeSpeech(clean, reports, route);
    const reply = {
      ok: true,
      speech,
      card: synthesized?.card ?? this.pickCard(reports),
      agents: Object.keys(reports),
      reports,
      chartActions,
      at: new Date().toISOString(),
      ms: Date.now() - started,
      intents: route.intents,
      routedBy: route.via,
      symbol: route.symbol,
      pendingApproval: this.approvals.pending()[0] ?? null,
    };
    this.queue.close(task.id, { status: Object.values(reports).some((r) => r.status === 'error') ? 'partial' : 'done', summary: truncate(speech, 120) });
    this.journal.append({ kind: 'report', agent: 'friday', text: truncate(speech, 200), ms: reply.ms, status: 'ok', routed: route.agents.join(','), via: route.via });
    this.setState('speaking', route.agents.join('+'));
    this.bus.emitEvent('reply', { reply });
    return reply;
  }

  /** Template synthesis: the master's voice without any model in the loop. */
  composeSpeech(command, reports, route) {
    const bySeat = ([a], [b]) => (ORDER[a] ?? 99) - (ORDER[b] ?? 99);
    const rows = Object.entries(reports).sort(bySeat);
    const missing = rows.filter(([, r]) => r.status === 'no-data');
    const blocked = rows.find(([, r]) => r.status === 'blocked' || r.status === 'veto');
    const usable = rows.filter(([, r]) => r.status === 'ok');
    const parts = [];
    if (route.symbol) parts.push(`${route.symbol}.`);
    if (blocked) parts.push(`${this.seatFor(blocked[0])?.name}: ${blocked[1].speech}`);
    if (usable.length) parts.push(usable.map(([, r]) => r.speech).filter(Boolean).join(' '));
    if (missing.length) {
      const who = missing.map(([id]) => this.seatFor(id)?.name ?? id).join(' and ');
      parts.push(`${who} ${missing.length === 1 ? 'is' : 'are'} showing dashes${missing[0][1].reason ? ` — ${missing[0][1].reason}` : ''}. I am not filling that in for them.`);
    }
    if (!parts.join(' ').trim()) parts.push('Nothing came back I would repeat. Ask me for a briefing, or wire a data key.');
    return truncate(parts.join(' '), 900);
  }

  pickCard(reports) {
    const athena = reports.athena?.data;
    if (athena?.price) {
      return { label: `${athena.symbol} vs demand`, value: `$${round(athena.price, 2)}`, sub: athena.support ? `${round(((athena.price - athena.support.price) / athena.price) * 100, 2)}% to the shelf` : 'no level found' };
    }
    const atlas = reports.atlas?.data;
    if (atlas?.breadth !== undefined) return { label: 'breadth on the tape', value: `${atlas.ups}/${atlas.ups + atlas.downs}`, sub: atlas.regime };
    const oracle = reports.oracle?.data;
    if (oracle?.probUpPct !== undefined) return { label: 'P(higher) over model horizon', value: `${oracle.probUpPct}%`, sub: oracle.method };
    return null;
  }

  intro() {
    const feed = this.feed.health();
    const seats = ROSTER.length;
    return `Desk online. ${seats} specialists seated${feed.live ? ', live tape from Finnhub' : ' on a simulated tape — paste FINNHUB_KEY for real quotes'}. I route; they work; Sentinel decides whether money moves. Try: "pull up NVDA and mark the levels".`;
  }

  /** Periodic sweep so the log is alive between commands. */
  async heartbeat({ moveThresholdPct = 4.5 } = {}) {
    try {
      const rows = await this.feed.quotesFor(this.feed.watch);
      for (const r of rows.filter((x) => x.ok)) {
        if (Math.abs(r.changePct || 0) >= moveThresholdPct) {
          this.bus.alert(
            'atlas',
            `Tape watch: ${r.symbol} ${round(r.changePct, 2)}% at $${r.price}`,
            Math.abs(r.changePct) >= 8 ? 'danger' : 'warn',
            { dedupe: `pulse-${r.symbol}-${new Date().toISOString().slice(0, 16)}`, symbol: r.symbol }
          );
        }
      }
      const ev = this.nextEvent;
      if (ev?.imminent) {
        this.bus.alert('sentinel', `Standing rule: ${ev.label} in ${ev.daysAway}d — no new risk within 24h of the print unless sized for a gap`, 'warn', { dedupe: `gate-${ev.date}` });
      }
      if (!this.feed.health().live) {
        this.bus.alert('ledger', 'Feed check: quotes are SIMULATED (no FINNHUB_KEY). Panels are badged; nothing here is market data.', 'warn', { dedupe: 'sim-flag', dedupeMs: 600000 });
      }
    } catch (err) {
      this.lastError = err.message;
    }
  }
}
