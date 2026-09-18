/**
 * Radial telemetry ring — the 10 specialist agents orbiting SUFFIX.
 *
 * Each node renders:
 *   • a confidence arc (how sure that agent is)
 *   • an activity meter (its 0..1 value for the current read)
 *   • a 48-point sparkline history
 *   • a live state pip (idle / thinking / error)
 *
 * Position is `angle_deg` from the server (36° apart), so the ring layout is
 * driven by the orchestrator rather than hard-coded in the view.
 */

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { AGENT_META, type AgentId, type TelemetryFrame, type TelemetryNode } from '@/types/contract';
import { clsx } from 'clsx';

const RADIUS = 268;
const NODE = 82;

const BIAS_TONE: Record<string, string> = {
  long: '#22c55e',
  short: '#ef4444',
  flat: '#64748b',
  unclear: '#334155',
};

const STATE_PIP: Record<string, string> = {
  idle: 'bg-slate-600',
  thinking: 'bg-signal-400 animate-pulse',
  streaming: 'bg-bull animate-pulse',
  vetoing: 'bg-critical animate-pulse',
  error: 'bg-caution',
  offline: 'bg-slate-800',
};

export interface TelemetryRingProps {
  frame: TelemetryFrame | null;
  focused: AgentId | null;
  onFocus: (agent: AgentId | null) => void;
}

export function TelemetryRing({ frame, focused, onFocus }: TelemetryRingProps) {
  const nodes = useMemo<TelemetryNode[]>(() => {
    if (frame?.nodes?.length) return frame.nodes;
    // Pre-handshake placeholder so the ring has its full geometry immediately.
    return (Object.keys(AGENT_META) as AgentId[]).map((agent, i) => ({
      agent,
      designation: AGENT_META[agent].designation,
      angle_deg: i * 36,
      value: 0,
      confidence: 0,
      load: 0,
      state: 'offline',
      series: [],
      label: 'awaiting link',
      headline: '',
      bias: 'unclear' as const,
    }));
  }, [frame]);

  return (
    <div className="relative h-full w-full">
      {/* orbit guides */}
      <svg viewBox="-340 -340 680 680" className="absolute inset-0 h-full w-full">
        <circle r={RADIUS} fill="none" stroke="rgba(34,211,238,0.10)" strokeWidth="1" />
        <circle
          r={RADIUS - 46}
          fill="none"
          stroke="rgba(34,211,238,0.05)"
          strokeWidth="0.75"
          strokeDasharray="3 14"
        />
        {nodes.map((n) => {
          const rad = (n.angle_deg * Math.PI) / 180;
          const x = Math.cos(rad) * RADIUS;
          const y = Math.sin(rad) * RADIUS;
          const active = n.state !== 'idle' && n.state !== 'offline';
          return (
            <line
              key={`spoke-${n.agent}`}
              x1={0}
              y1={0}
              x2={x}
              y2={y}
              stroke={active ? 'rgba(34,211,238,0.22)' : 'rgba(148,163,184,0.07)'}
              strokeWidth={focused === n.agent ? 1.6 : 0.8}
            />
          );
        })}
        {/* connecting web between neighbours — shows the ring as one system */}
        {nodes.map((n, i) => {
          const a = (n.angle_deg * Math.PI) / 180;
          const next = nodes[(i + 1) % nodes.length];
          const b = (next.angle_deg * Math.PI) / 180;
          return (
            <line
              key={`web-${n.agent}`}
              x1={Math.cos(a) * RADIUS}
              y1={Math.sin(a) * RADIUS}
              x2={Math.cos(b) * RADIUS}
              y2={Math.sin(b) * RADIUS}
              stroke="rgba(34,211,238,0.06)"
              strokeWidth="0.5"
            />
          );
        })}
      </svg>

      {nodes.map((node, i) => {
        const rad = (node.angle_deg * Math.PI) / 180;
        const x = Math.cos(rad) * RADIUS;
        const y = Math.sin(rad) * RADIUS;
        return (
          <motion.div
            key={node.agent}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: i * 0.045, duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            className="absolute left-1/2 top-1/2"
            style={{ x: x - NODE / 2, y: y - NODE / 2, width: NODE, height: NODE }}
          >
            <TelemetryNodeView
              node={node}
              focused={focused === node.agent}
              onClick={() => onFocus(focused === node.agent ? null : node.agent)}
            />
          </motion.div>
        );
      })}
    </div>
  );
}

function TelemetryNodeView({
  node,
  focused,
  onClick,
}: {
  node: TelemetryNode;
  focused: boolean;
  onClick: () => void;
}) {
  const meta = AGENT_META[node.agent];
  const size = 76;
  const r = 32;
  const circumference = 2 * Math.PI * r;
  const confidence = Math.max(0, Math.min(1, node.confidence));
  const value = Math.max(0, Math.min(1, node.value));
  const biasTone = BIAS_TONE[node.bias] ?? BIAS_TONE.unclear;
  const offline = node.state === 'offline';

  const spark = useMemo(() => {
    const series = node.series?.length ? node.series : [0.06];
    if (series.length < 2) return '';
    const max = Math.max(...series, 0.08);
    const min = Math.min(...series, 0);
    const span = Math.max(max - min, 0.02);
    return series
      .map((v, i) => {
        const px = (i / (series.length - 1)) * 54;
        const py = 20 - ((v - min) / span) * 18;
        return `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`;
      })
      .join(' ');
  }, [node.series]);

  return (
    <button
      type="button"
      onClick={onClick}
      title={`${meta.designation} — ${meta.blurb}\n${node.headline || 'no report yet'}`}
      className={clsx(
        'group relative flex h-full w-full flex-col items-center justify-center rounded-full',
        'border transition-all duration-200',
        offline
          ? 'border-white/5 bg-void-800/40'
          : 'border-signal-400/25 bg-void-700/75 hover:border-signal-400/60',
        focused && 'ring-2 ring-signal-400/70 ring-offset-2 ring-offset-void-900 scale-110',
        node.bias === 'long' && !offline && 'border-bull/35',
        node.bias === 'short' && !offline && 'border-bear/35',
      )}
      style={{
        boxShadow: offline
          ? 'none'
          : `0 0 ${12 + value * 26}px -6px ${biasTone}55, inset 0 0 18px -10px ${biasTone}88`,
      }}
    >
      {/* SVG gauges */}
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute inset-0">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(148,163,184,0.14)" strokeWidth="2.5" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={biasTone}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${(confidence * circumference).toFixed(2)} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          opacity={offline ? 0.2 : 0.95}
        />
        {spark && (
          <path
            d={spark}
            transform={`translate(${size / 2 - 27}, ${size / 2 + 6})`}
            fill="none"
            stroke="rgba(165,243,252,0.5)"
            strokeWidth="1"
          />
        )}
      </svg>

      <span className="relative z-10 font-mono text-[9px] font-medium tracking-[0.14em] text-slate-100">
        {node.designation}
      </span>
      <span className="relative z-10 mt-0.5 font-mono text-[8px] uppercase tracking-[0.12em] text-slate-500">
        {node.label.slice(0, 11)}
      </span>

      {/* activity meter */}
      <span className="absolute -bottom-0.5 left-1/2 z-10 h-[2px] w-10 -translate-x-1/2 overflow-hidden rounded-full bg-white/10">
        <span
          className="block h-full rounded-full transition-all duration-500"
          style={{ width: `${value * 100}%`, background: biasTone, boxShadow: `0 0 8px ${biasTone}` }}
        />
      </span>

      {/* state pip */}
      <span
        className={clsx(
          'absolute right-1 top-1 h-1.5 w-1.5 rounded-full',
          STATE_PIP[node.state] ?? STATE_PIP.offline,
        )}
      />
    </button>
  );
}
