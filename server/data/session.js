/**
 * session.js — the real NYSE phase and countdown, computed from New York time.
 * No hardcoded offsets: DST is handled by Intl's tz database.
 */

// NYSE holidays. Edit/extend for the years you trade; the desk only uses this
// to decide "closed", so a missing date degrades to "open" rather than breaking.
export const NYSE_HOLIDAYS = [
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
];

const PHASES = {
  closed: { label: 'Closed', tone: 'muted' },
  pre: { label: 'Pre-market', tone: 'dim' },
  open: { label: 'Regular session', tone: 'live' },
  lunch: { label: 'Midday', tone: 'dim' },
  post: { label: 'After hours', tone: 'dim' },
};

const ET = 'America/New_York';

function partsInNy(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const iso = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    iso,
    weekday: parts.weekday,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    minuteOfDay: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

const isWeekend = (wd) => wd === 'Sat' || wd === 'Sun';
const minutes = (h, m) => h * 60 + m;
const BOUNDS = {
  preOpen: minutes(4, 0),
  open: minutes(9, 30),
  close: minutes(16, 0),
  postClose: minutes(20, 0),
};

/** Milliseconds until the next HH:MM in New York time on a given target date. */
function msUntilNy(now, isoDate, h, m) {
  const target = Date.parse(`${isoDate}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-05:00`);
  // Re-resolve the exact instant by walking NY wall-clock (DST-safe enough for a countdown).
  const nowNy = partsInNy(now);
  const sameDay = nowNy.iso === isoDate;
  const approx = target - now.getTime();
  if (sameDay) {
    const secsIntoDay = nowNy.minuteOfDay * 60 + nowNy.second;
    return Math.max(0, minutes(h, m) * 60 - secsIntoDay) * 1000;
  }
  return Math.max(0, approx);
}

function nextTradingDayDate(now) {
  const d = new Date(now.getTime());
  for (let i = 0; i < 10; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const p = partsInNy(d);
    if (!isWeekend(p.weekday) && !NYSE_HOLIDAYS.includes(p.iso)) return p;
  }
  return partsInNy(now);
}

export function describeSession(at = new Date()) {
  const ny = partsInNy(at);
  const holiday = NYSE_HOLIDAYS.includes(ny.iso);
  const closedDay = isWeekend(ny.weekday) || holiday;
  const m = ny.minuteOfDay;

  let phase = 'closed';
  let next = null;
  if (!closedDay) {
    if (m < BOUNDS.preOpen) phase = 'closed';
    else if (m < BOUNDS.open) phase = 'pre';
    else if (m < BOUNDS.close) phase = 'open';
    else if (m < BOUNDS.postClose) phase = 'post';
    else phase = 'closed';

    if (phase === 'closed' && m < BOUNDS.preOpen) next = { at: '04:00', label: 'pre-market', ms: msUntilNy(at, ny.iso, 4, 0) };
    else if (phase === 'pre') next = { at: '09:30', label: 'open', ms: msUntilNy(at, ny.iso, 9, 30) };
    else if (phase === 'open') next = { at: '16:00', label: 'close', ms: msUntilNy(at, ny.iso, 16, 0) };
    else if (phase === 'post') next = { at: '20:00', label: 'after hours ends', ms: msUntilNy(at, ny.iso, 20, 0) };
  }

  if (!next) {
    const nxt = closedDay ? ny : nextTradingDayDate(at);
    const target = closedDay ? nextTradingDayDate(at) : nxt;
    next = {
      at: '09:30',
      label: 'open',
      date: target.iso,
      ms: msUntilNy(at, target.iso, 9, 30) + (target.iso !== ny.iso ? 0 : 0),
    };
    if (target.iso !== ny.iso) {
      // Recompute across days from the NY date boundary at 04:00 pre-market.
      const days = Math.round(
        (Date.parse(`${target.iso}T12:00:00Z`) - Date.parse(`${ny.iso}T12:00:00Z`)) / 86400000
      );
      const secsTo4am = Math.max(0, BOUNDS.preOpen * 60 - m * 60 - ny.second);
      next.ms = (secsTo4am + (days - 1) * 86400 + minutes(9, 30) * 60 - BOUNDS.preOpen * 60) * 1000;
    }
  }

  return {
    phase,
    label: PHASES[phase].label,
    tone: PHASES[phase].tone,
    holiday,
    nyDate: ny.iso,
    nyClock: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(ny.minute).padStart(2, '0')}`,
    nySeconds: ny.second,
    weekday: ny.weekday,
    nextOpen: phase === 'closed' ? next.ms : null,
    countdownMs: Math.max(0, next.ms ?? 0),
    countingTo: next ? `${next.at} ET · ${next.label}${next.date && next.date !== ny.iso ? ` (${next.date})` : ''}` : null,
    tickerHint:
      phase === 'open'
        ? 'Regular session — spreads tight, volume real.'
        : phase === 'pre'
          ? 'Pre-market — thin book, wide spreads. Level touches mean less here.'
          : phase === 'post'
            ? 'After hours — earnings moves live here. Size down.'
            : holiday
              ? 'NYSE holiday — desk stays in research mode.'
              : 'Market closed. Research and journaling keep running.',
  };
}

export { ET };
