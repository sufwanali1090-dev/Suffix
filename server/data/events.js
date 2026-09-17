/**
 * events.js — the calendar panel's data. Edit this file; the HUD reads it via
 * /api/state. Nothing here is fetched or invented at runtime.
 *
 * FOMC 2026 dates are from the Federal Reserve's published schedule
 * (Jan 27–28, Mar 17–18, Apr 28–29, Jun 16–17, Jul 28–29, Sep 15–16,
 * Oct 27–28, Dec 8–9 — March/June/September/December carry the dot plot).
 * Monthly options expiry is computed: the third Friday, every month.
 */

const FOMC_2026 = [
  { start: '2026-01-27', end: '2026-01-28', sep: false },
  { start: '2026-03-17', end: '2026-03-18', sep: true },
  { start: '2026-04-28', end: '2026-04-29', sep: false },
  { start: '2026-06-16', end: '2026-06-17', sep: true },
  { start: '2026-07-28', end: '2026-07-29', sep: false },
  { start: '2026-09-15', end: '2026-09-16', sep: true },
  { start: '2026-10-27', end: '2026-10-28', sep: false },
  { start: '2026-12-08', end: '2026-12-09', sep: true },
];

/** Third Friday of the month, in YYYY-MM-DD form. */
export function opexDate(year, monthIndex) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const offset = (5 - first.getUTCDay() + 7) % 7; // days until first Friday
  return new Date(Date.UTC(year, monthIndex, 1 + offset + 14)).toISOString().slice(0, 10);
}

export function buildCalendar(month = new Date()) {
  const y = month.getFullYear();
  const m = month.getMonth();
  const first = new Date(Date.UTC(y, m, 1));
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // Monday-first grid
  const opex = opexDate(y, m);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const dayNum = i - lead + 1;
    if (dayNum < 1 || dayNum > daysInMonth) {
      cells.push({ blank: true, key: `blank${i}` });
      continue;
    }
    const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
    const dow = new Date(Date.UTC(y, m, dayNum)).getUTCDay();
    const fomc = FOMC_2026.find((f) => iso >= f.start && iso <= f.end);
    const events = [];
    if (fomc) events.push({ kind: 'fomc', label: fomc.sep ? 'FOMC + dots' : 'FOMC' });
    if (iso === opex) events.push({ kind: 'opex', label: 'Options expiry' });
    if (iso === '2026-09-18') events.push({ kind: 'russell', label: 'Russell rebalance' });
    cells.push({
      blank: false,
      iso,
      day: dayNum,
      weekday: dow,
      weekend: dow === 0 || dow === 6,
      events,
      key: iso,
    });
  }
  return {
    year: y,
    month: m,
    label: new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }),
    cells,
    opex,
  };
}

/** Next event the risk officer cares about, and how far away it is. */
export function nextEventRisk(at = new Date()) {
  const today = at.toISOString().slice(0, 10);
  const upcoming = [
    ...FOMC_2026.map((f) => ({ date: f.end, kind: 'fomc', label: f.sep ? 'FOMC decision + SEP' : 'FOMC decision' })),
    ...Array.from({ length: 14 }, (_, i) => {
      const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + i, 1));
      return { date: opexDate(d.getUTCFullYear(), d.getUTCMonth()), kind: 'opex', label: 'Monthly options expiry' };
    }),
  ]
    .filter((e) => e.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  const next = upcoming[0];
  if (!next) return null;
  const days = Math.round((Date.parse(`${next.date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000);
  return { ...next, daysAway: days, imminent: days <= 2 };
}

export const fomcSchedule = FOMC_2026;
