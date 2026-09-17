/**
 * roster.js — the nine seats, in one place.
 *
 * The HUD, the docs, the voice layer and the router all read this table, so
 * adding a tenth agent means adding one file in server/agents/ and one entry
 * here. Nothing else in the codebase hardcodes a name or a seat.
 *
 * `remote: null` means "this agent runs in-process". Set it to a URL and the
 * exact same agent becomes a standalone service (see server/agent-service.js).
 */
export const MASTER = {
  id: 'friday',
  name: 'F.R.I.D.A.Y.',
  role: 'master',
  seat: 0,
  hue: 44, // gold
  glyph: '◈',
  voice: { voiceHint: 'Daniel', pitch: 0.92, rate: 1.02, lang: 'en-GB' },
  tagline: 'The orchestrator. Routes one command, answers out loud.',
  bio:
    'You give one command; it routes the work to the right agents, synthesizes what comes back, and answers out loud. Never does the specialist work itself — it runs the desk.',
};

export const ROSTER = [
  {
    id: 'atlas',
    name: 'ATLAS',
    title: 'MACRO',
    group: 'intelligence',
    seat: 1,
    hue: 198,
    glyph: '⌁',
    voice: { voiceHint: 'Google UK English Male', pitch: 0.78, rate: 0.94, lang: 'en-GB' },
    tagline: "Reads the Fed, rates, and the market's weather — the tide everything else floats on.",
    keywords: ['macro', 'fed', 'rates', 'yield', 'inflation', 'cpi', 'weather', 'tide', 'liquidity conditions'],
    remote: null,
  },
  {
    id: 'capitol',
    name: 'CAPITOL',
    title: 'SMART MONEY',
    group: 'intelligence',
    seat: 2,
    hue: 276,
    glyph: '⚖',
    voice: { voiceHint: 'Fred', pitch: 0.68, rate: 0.9, lang: 'en-US' },
    tagline: 'Tracks what Congress, insiders, and the big funds quietly buy — before the news does.',
    keywords: ['congress', 'insider', 'smart money', '13f', 'filings', 'politician', 'senator', 'house trades', 'institutional'],
    remote: null,
  },
  {
    id: 'scout',
    name: 'SCOUT',
    title: 'RECON',
    group: 'intelligence',
    seat: 3,
    hue: 96,
    glyph: '◎',
    voice: { voiceHint: 'Alex', pitch: 1.18, rate: 1.16, lang: 'en-US' },
    tagline: "Finds whatever stock is going viral today — an hour before your feed does.",
    keywords: ['viral', 'trending', 'movers', 'buzz', 'retail', 'what is moving', 'top gainers', 'gappers', 'recon'],
    remote: null,
  },
  {
    id: 'athena',
    name: 'ATHENA',
    title: 'ANALYST',
    group: 'analysis',
    seat: 4,
    hue: 24,
    glyph: '✦',
    voice: { voiceHint: 'Karen', pitch: 0.95, rate: 0.98, lang: 'en-AU' },
    tagline: 'Reads the filings and calls the structure — supply, demand, liquidity — to your face.',
    keywords: ['structure', 'support', 'resistance', 'supply', 'demand', 'fundamentals', 'earnings', 'valuation', 'levels', 'thesis'],
    remote: null,
  },
  {
    id: 'chartist',
    name: 'CHARTIST',
    title: 'TECHNICIAN',
    group: 'analysis',
    seat: 5,
    hue: 172,
    glyph: '▤',
    voice: { voiceHint: 'Rocko', pitch: 0.62, rate: 1.06, lang: 'en-US' },
    tagline: 'Owns the screens. Flips symbols, marks the lines — where to buy, and where to run.',
    keywords: ['chart', 'pull up', 'show me', 'flip', 'draw', 'mark', 'lines', 'indicator', 'timeframe', 'screenshot'],
    remote: null,
  },
  {
    id: 'oracle',
    name: 'ORACLE',
    title: 'QUANT',
    group: 'analysis',
    seat: 6,
    hue: 262,
    glyph: '∿',
    voice: { voiceHint: 'Whisper', pitch: 1.45, rate: 1.1, lang: 'en-US' },
    tagline: "Runs the forecasting models — TimesFM included — and answers in probabilities, never promises.",
    keywords: ['forecast', 'predict', 'model', 'timesfm', 'probability', 'odds', 'distribution', 'monte carlo', 'scenario'],
    remote: null,
  },
  {
    id: 'sentinel',
    name: 'SENTINEL',
    title: 'RISK OFFICER',
    group: 'execution',
    seat: 7,
    hue: 6,
    glyph: '⛨',
    voice: { voiceHint: 'Albert', pitch: 0.55, rate: 0.86, lang: 'en-US' },
    tagline: 'Sizes every position, sets every stop, holds veto power. Favourite word: no.',
    keywords: ['risk', 'size', 'position size', 'stop', 'veto', 'heat', 'exposure', 'how much can i buy', 'approval'],
    remote: null,
  },
  {
    id: 'pilot',
    name: 'PILOT',
    title: 'EXECUTION',
    group: 'execution',
    seat: 8,
    hue: 208,
    glyph: '➤',
    voice: { voiceHint: 'Rishi', pitch: 0.88, rate: 1.08, lang: 'en-IN' },
    tagline: 'Places the trade — but only once Sentinel signs off. No cowboy stuff.',
    keywords: ['buy', 'sell', 'execute', 'place', 'order', 'trade', 'fill', 'submit', 'send it'],
    remote: null,
  },
  {
    id: 'ledger',
    name: 'LEDGER',
    title: 'THE BOOK',
    group: 'execution',
    seat: 9,
    hue: 84,
    glyph: '≡',
    voice: { voiceHint: 'Grandpa', pitch: 0.6, rate: 0.84, lang: 'en-US' },
    tagline: 'Journals every call the desk makes — especially the bad ones — and watches system health.',
    keywords: ['journal', 'log', 'review', 'pnl', 'performance', 'what did we do', 'mistakes', 'health', 'stats', 'audit'],
    remote: null,
  },
];

export const GROUPS = [
  { id: 'intelligence', label: 'Intelligence — what’s happening', members: ['atlas', 'capitol', 'scout'] },
  { id: 'analysis', label: 'Analysis — what it’s worth', members: ['athena', 'chartist', 'oracle'] },
  { id: 'execution', label: 'Execution — where money moves', members: ['sentinel', 'pilot', 'ledger'] },
];

export const AGENTS = [MASTER, ...ROSTER];
export const byId = Object.fromEntries(AGENTS.map((a) => [a.id, a]));
export const ids = ROSTER.map((a) => a.id);
