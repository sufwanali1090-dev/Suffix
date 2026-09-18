/**
 * Equity curve with the $80 Death Line drawn in.
 *
 * The y-domain is pinned to [death_line - 2, starting_capital + headroom] rather
 * than autoscaled to the data: a desk that drifts between $99.80 and $100.10 must
 * not look like it is in freefall, and the death line must always be on screen.
 */

import { useMemo } from 'react';

export interface EquityPoint {
  ts: number;
  equity: number;
}

export function EquityGraph({
  points,
  deathLine,
  startingCapital,
  height = 108,
}: {
  points: EquityPoint[];
  deathLine: number;
  startingCapital: number;
  height?: number;
}) {
  const W = 520;
  const H = height;

  const { path, area, lo, hi, last } = useMemo(() => {
    const series = points.length >= 2 ? points : [];
    const lo = Math.min(deathLine - 2, ...series.map((p) => p.equity), startingCapital - 8);
    const hi = Math.max(startingCapital + 1, ...series.map((p) => p.equity)) + 1;
    const span = Math.max(hi - lo, 1e-6);

    const toY = (v: number) => H - ((v - lo) / span) * H;
    const toX = (i: number) => (series.length <= 1 ? 0 : (i / (series.length - 1)) * W);

    const d = series
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(p.equity).toFixed(1)}`)
      .join(' ');
    const a = series.length
      ? `${d} L${W},${H} L0,${H} Z`
      : '';
    return { path: d, area: a, lo, hi, last: series.length ? series[series.length - 1].equity : startingCapital };
  }, [points, deathLine, startingCapital, H]);

  const yFor = (v: number) => H - ((v - lo) / Math.max(hi - lo, 1e-6)) * H;
  const positive = last >= startingCapital;

  return (
    <div className="panel overflow-hidden">
      <div className="panel-header">
        <span className="panel-title">Equity Curve</span>
        <span className="font-mono text-[9px] text-slate-600">
          {points.length} pts · death line ${deathLine.toFixed(2)}
        </span>
      </div>
      <div className="relative px-1.5 pb-1.5 pt-1">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-[108px] w-full" preserveAspectRatio="none">
          <defs>
            <linearGradient id="eq-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={positive ? '#22c55e' : '#ef4444'} stopOpacity="0.28" />
              <stop offset="100%" stopColor={positive ? '#22c55e' : '#ef4444'} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* starting-capital reference */}
          <line
            x1="0"
            x2={W}
            y1={yFor(startingCapital)}
            y2={yFor(startingCapital)}
            stroke="rgba(148,163,184,0.28)"
            strokeWidth="0.75"
            strokeDasharray="4 5"
          />
          {/* death line */}
          <line
            x1="0"
            x2={W}
            y1={yFor(deathLine)}
            y2={yFor(deathLine)}
            stroke="#ef4444"
            strokeWidth="1"
            strokeDasharray="6 4"
            opacity="0.85"
          />
          <text x="3" y={Math.max(yFor(deathLine) - 3, 9)} fill="#ef4444" fontSize="8" fontFamily="monospace" opacity="0.9">
            DEATH ${deathLine.toFixed(2)}
          </text>

          {area && <path d={area} fill="url(#eq-fill)" />}
          {path && (
            <path
              d={path}
              fill="none"
              stroke={positive ? '#22c55e' : '#ef4444'}
              strokeWidth="1.6"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {!path && (
            <text x={W / 2} y={H / 2} fill="#475569" fontSize="9" textAnchor="middle" fontFamily="monospace">
              accumulating equity snapshots…
            </text>
          )}
        </svg>
      </div>
    </div>
  );
}
