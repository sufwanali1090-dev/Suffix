/**
 * SUFFIX orb — the desk's face.
 *
 * A pure-SVG audio visualizer: 96 radial bars arranged on a circle, each bar's
 * length driven by a frequency-band magnitude, with three concentric rings for
 * the risk state, a rotating outer tick ring, and a live waveform trace. It
 * reacts to SUFFIX's own voice when it is speaking and idles on a slow
 * synthesized breathing signal otherwise.
 *
 * Performance: the whole thing is one `requestAnimationFrame` that mutates
 * `transform`/`y` attributes directly through refs — React re-renders only when
 * the *state* (risk level, speaking, label) changes, never per frame.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { RiskStateName } from '@/types/contract';

const BAR_COUNT = 96;
const BASE_RADIUS = 108;
const MAX_BAR = 46;

const RING_TONE: Record<RiskStateName, { core: string; halo: string; accent: string }> = {
  ARMED: { core: '#22d3ee', halo: 'rgba(34,211,238,0.35)', accent: '#22c55e' },
  CAUTION: { core: '#f59e0b', halo: 'rgba(245,158,11,0.35)', accent: '#f59e0b' },
  CRITICAL: { core: '#f43f5e', halo: 'rgba(244,63,94,0.4)', accent: '#f43f5e' },
  FROZEN: { core: '#8b5cf6', halo: 'rgba(139,92,246,0.4)', accent: '#8b5cf6' },
  DEAD: { core: '#ef4444', halo: 'rgba(239,68,68,0.45)', accent: '#ef4444' },
};

export interface SuffixOrbProps {
  speaking: boolean;
  listening: boolean;
  /** 0..1 — drives the idle breathing amplitude (agent load / panel activity). */
  intensity?: number;
  riskState: RiskStateName;
  label: string;
  sublabel: string;
  confidence?: number;
  /** Injected audio analyser; when absent a synthetic spectrum is used. */
  analyser?: AnalyserNode | null;
}

export function SuffixOrb({
  speaking,
  listening,
  intensity = 0.4,
  riskState,
  label,
  sublabel,
  confidence = 0.5,
  analyser = null,
}: SuffixOrbProps) {
  const barsRef = useRef<SVGGElement | null>(null);
  const waveRef = useRef<SVGPathElement | null>(null);
  const coreRef = useRef<SVGCircleElement | null>(null);
  const haloRef = useRef<SVGCircleElement | null>(null);
  const freqRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const phaseRef = useRef(0);
  const smoothRef = useRef<number[]>(new Array(BAR_COUNT).fill(0.06));

  const tone = RING_TONE[riskState];
  const bars = useMemo(() => Array.from({ length: BAR_COUNT }, (_, i) => i), []);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(64, now - last) / 1000;
      last = now;
      phaseRef.current += dt;

      // ---------------------------------------------------------------- data
      let spectrum: number[] | null = null;
      if (analyser && speaking) {
        const bins = analyser.frequencyBinCount;
        if (!freqRef.current || freqRef.current.length !== bins) {
          freqRef.current = new Uint8Array(new ArrayBuffer(bins));
        }
        analyser.getByteFrequencyData(freqRef.current);
        const data = freqRef.current;
        // Sample the useful lower 2/3 of the spectrum logarithmically.
        spectrum = new Array(BAR_COUNT);
        for (let i = 0; i < BAR_COUNT; i += 1) {
          const t = i / BAR_COUNT;
          const idx = Math.floor(Math.pow(t, 1.6) * (bins * 0.66));
          spectrum[i] = (data[idx] ?? 0) / 255;
        }
      }

      const speed = speaking ? 3.1 : listening ? 2.2 : 1.0;
      const amp = speaking ? 1.0 : listening ? 0.62 : 0.28 + intensity * 0.3;

      // ------------------------------------------------------------- visuals
      const group = barsRef.current;
      if (group) {
        const children = group.children;
        for (let i = 0; i < children.length; i += 1) {
          const el = children[i] as SVGLineElement | SVGRectElement;
          const t = i / BAR_COUNT;

          let target: number;
          if (spectrum) {
            target = Math.pow(spectrum[i], 0.78) * amp;
          } else {
            // Synthetic voice: a few detuned harmonics so the ring breathes
            // rather than pulsing uniformly.
            const a = Math.sin(phaseRef.current * speed + t * Math.PI * 6);
            const b = Math.sin(phaseRef.current * speed * 1.7 + t * Math.PI * 11) * 0.5;
            const c = Math.sin(phaseRef.current * speed * 0.6 + t * Math.PI * 2) * 0.35;
            target = (0.5 + 0.5 * (a * 0.5 + b * 0.28 + c * 0.22)) * amp;
          }

          // Asymmetric attack/decay gives the meter a physical feel.
          const prev = smoothRef.current[i];
          const alpha = target > prev ? 0.45 : 0.12;
          const value = prev + (target - prev) * alpha;
          smoothRef.current[i] = value;

          const len = 4 + value * MAX_BAR;
          const angle = t * Math.PI * 2 - Math.PI / 2;
          const x1 = 200 + Math.cos(angle) * BASE_RADIUS;
          const y1 = 200 + Math.sin(angle) * BASE_RADIUS;
          const x2 = 200 + Math.cos(angle) * (BASE_RADIUS + len);
          const y2 = 200 + Math.sin(angle) * (BASE_RADIUS + len);
          el.setAttribute('x1', x1.toFixed(2));
          el.setAttribute('y1', y1.toFixed(2));
          el.setAttribute('x2', x2.toFixed(2));
          el.setAttribute('y2', y2.toFixed(2));
          el.setAttribute('stroke', tick_color(value, t, riskState));
          el.setAttribute('stroke-width', (1.2 + value * 1.9).toFixed(2));
          el.setAttribute('opacity', (0.35 + value * 0.65).toFixed(3));
        }
      }

      // ------------------------------------------------------- waveform trace
      if (waveRef.current) {
        const points: string[] = [];
        const N = 64;
        for (let i = 0; i <= N; i += 1) {
          const x = (i / N) * 400;
          const local = i / N;
          const env = Math.sin(local * Math.PI);
          const a = Math.sin(local * Math.PI * 8 + phaseRef.current * (speaking ? 7 : 1.6));
          const b = Math.sin(local * Math.PI * 21 - phaseRef.current * 3.4) * 0.4;
          const y = 200 + (a + b) * env * (speaking ? 26 : listening ? 15 : 6) * amp;
          points.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
        }
        waveRef.current.setAttribute('d', points.join(' '));
        waveRef.current.setAttribute('opacity', speaking ? '0.95' : '0.32');
      }

      // ----------------------------------------------------------- core pulse
      const pulse = 1 + Math.sin(phaseRef.current * (speaking ? 6 : 1.8)) * (speaking ? 0.05 : 0.02);
      coreRef.current?.setAttribute('r', (52 * pulse).toFixed(2));
      haloRef.current?.setAttribute('r', (74 * pulse).toFixed(2));
      haloRef.current?.setAttribute('opacity', (0.35 + Math.sin(phaseRef.current * 2) * 0.12).toFixed(3));

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [analyser, speaking, listening, intensity, riskState]);

  return (
    <div className="relative flex items-center justify-center">
      <svg
        viewBox="0 0 400 400"
        className="h-[min(46vh,380px)] w-[min(46vh,380px)]"
        role="img"
        aria-label={`SUFFIX orb — ${riskState}, ${speaking ? 'speaking' : 'idle'}`}
      >
        <defs>
          <radialGradient id="orb-core" cx="50%" cy="42%" r="62%">
            <stop offset="0%" stopColor={tone.core} stopOpacity="0.95" />
            <stop offset="45%" stopColor={tone.core} stopOpacity="0.32" />
            <stop offset="100%" stopColor="#03040a" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="orb-halo" cx="50%" cy="50%" r="50%">
            <stop offset="60%" stopColor={tone.halo} stopOpacity="0.5" />
            <stop offset="100%" stopColor={tone.halo} stopOpacity="0" />
          </radialGradient>
          <filter id="orb-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* outer static rings */}
        <circle cx="200" cy="200" r="168" fill="none" stroke={tone.core} strokeOpacity="0.10" strokeWidth="1" />
        <circle
          cx="200"
          cy="200"
          r="176"
          fill="none"
          stroke={tone.core}
          strokeOpacity="0.22"
          strokeWidth="0.75"
          strokeDasharray="2 9"
          className="origin-center animate-spin-slower"
        />
        <circle
          cx="200"
          cy="200"
          r="186"
          fill="none"
          stroke={tone.accent}
          strokeOpacity="0.14"
          strokeWidth="0.5"
          strokeDasharray="1 22"
          className="origin-center animate-spin-slow"
        />

        {/* rotating tick ring — one tick per 5 degrees, cyan on the cardinal */}
        <g className="origin-center animate-spin-slow">
          {Array.from({ length: 72 }, (_, i) => {
            const angle = (i / 72) * Math.PI * 2;
            const long = i % 9 === 0;
            const r1 = 150;
            const r2 = long ? 142 : 146;
            return (
              <line
                key={i}
                x1={200 + Math.cos(angle) * r1}
                y1={200 + Math.sin(angle) * r1}
                x2={200 + Math.cos(angle) * r2}
                y2={200 + Math.sin(angle) * r2}
                stroke={tone.core}
                strokeOpacity={long ? 0.5 : 0.2}
                strokeWidth={long ? 1.4 : 0.8}
              />
            );
          })}
        </g>

        {/* the reactive bar ring */}
        <g ref={barsRef} filter="url(#orb-glow)">
          {bars.map((i) => (
            <line key={i} x1="200" y1={200 - BASE_RADIUS} x2="200" y2={200 - BASE_RADIUS - 6} strokeLinecap="round" />
          ))}
        </g>

        {/* waveform trace */}
        <path ref={waveRef} fill="none" stroke={tone.core} strokeWidth="1.1" strokeLinejoin="round" />

        {/* halo + core */}
        <circle ref={haloRef} cx="200" cy="200" r="74" fill="url(#orb-halo)" />
        <circle cx="200" cy="200" r="92" fill="url(#orb-core)" />
        <circle ref={coreRef} cx="200" cy="200" r="52" fill="none" stroke={tone.core} strokeOpacity="0.5" strokeWidth="1" />
        <circle
          cx="200"
          cy="200"
          r="60"
          fill="none"
          stroke={tone.core}
          strokeOpacity="0.3"
          strokeWidth="0.7"
          className="origin-center animate-pulse-ring"
        />

        {/* confidence arc — how sure SUFFIX is of its current read */}
        <circle
          cx="200"
          cy="200"
          r="128"
          fill="none"
          stroke={tone.accent}
          strokeOpacity="0.75"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${(confidence * 2 * Math.PI * 128).toFixed(1)} ${2 * Math.PI * 128}`}
          transform="rotate(-90 200 200)"
        />
      </svg>

      {/* centre label */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        <div
          className="font-mono text-[26px] font-light leading-none tracking-[0.34em] text-glow"
          style={{ color: tone.core }}
        >
          SUFFIX
        </div>
        <div className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.3em] text-slate-400">
          {label}
        </div>
        <div className="mt-2 max-w-[190px] text-[10px] leading-snug text-slate-500">{sublabel}</div>
        <div className="mt-2.5 flex items-center gap-1.5">
          {speaking && (
            <span className="chip border-signal-400/40 bg-signal-400/10 text-signal-200">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal-400" />
              SPEAKING
            </span>
          )}
          {listening && !speaking && (
            <span className="chip border-plasma-500/40 bg-plasma-500/10 text-plasma-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-plasma-400" />
              LISTENING
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Bar colour ramp: cool at rest, hot as the bar grows and near the top of the dial. */
function tick_color(value: number, t: number, risk: RiskStateName): string {
  if (risk === 'DEAD' || risk === 'CRITICAL') {
    return value > 0.6 ? '#f43f5e' : value > 0.3 ? '#fb7185' : '#7f1d1d';
  }
  if (risk === 'FROZEN') {
    return value > 0.6 ? '#c4b5fd' : value > 0.3 ? '#8b5cf6' : '#4c1d95';
  }
  if (value > 0.72) return '#a5f3fc';
  if (value > 0.42) return '#22d3ee';
  if (value > 0.18) return '#0891b2';
  return '#164e63';
}
