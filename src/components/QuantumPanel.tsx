/**
 * Agent 11 QUANTUM console — the evolutionary hedge-fund engine.
 *
 * Shows the live generation, the performance gate, the adaptive penalty state,
 * the promoted genomes, and the extinction graveyard (strategies the Do-or-Die
 * protocol has killed).
 */

import { clsx } from 'clsx';
import type { ExtinctionRecord, QuantumStateResponse } from '@/types/contract';

export function QuantumPanel({
  quantum,
  extinctions,
  onRun,
  busy,
}: {
  quantum: QuantumStateResponse | null;
  extinctions: ExtinctionRecord[];
  onRun: () => void;
  busy: string | null;
}) {
  const state = quantum?.state;
  const engine = quantum?.engine;
  const pressure = engine?.pressure;
  const active = quantum?.active ?? [];

  const lossTone =
    (pressure?.decay ?? 1) < 0.3 ? 'text-critical' : (pressure?.decay ?? 1) < 0.7 ? 'text-caution' : 'text-bull';

  return (
    <div className="panel flex h-full flex-col overflow-hidden">
      <div className="panel-header">
        <span className="panel-title">Quantum — Self-Learning Fund</span>
        <div className="flex items-center gap-2">
          <span
            className={clsx(
              'chip',
              state?.status === 'HUNTING'
                ? 'border-signal-400/40 bg-signal-400/10 text-signal-200'
                : state?.status === 'TERMINATED'
                  ? 'border-bear/40 bg-bear/10 text-bear'
                  : 'border-white/10 text-slate-500',
            )}
          >
            {state?.status ?? 'OFFLINE'}
          </span>
          <button className="btn no-drag px-2 py-1 text-[10px]" onClick={onRun} disabled={Boolean(busy)}>
            RUN GEN
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3.5">
        {/* generation vitals */}
        <div className="grid grid-cols-3 gap-2">
          <Cell label="Generation" value={`${state?.generation ?? 0}`} />
          <Cell label="Active" value={`${state?.active_strategies ?? 0}`} tone="bull" />
          <Cell label="Extinct" value={`${state?.extinct_total ?? 0}`} tone="warn" />
          <Cell label="Blacklisted" value={`${state?.blacklisted_total ?? 0}`} />
          <Cell label="Loss streak" value={`${state?.loss_streak ?? 0}`} tone={(state?.loss_streak ?? 0) > 0 ? 'warn' : undefined} />
          <Cell
            label="Penalty ×"
            value={(pressure?.decay ?? 1).toFixed(3)}
            tone={(pressure?.decay ?? 1) < 0.7 ? 'warn' : undefined}
          />
        </div>

        {/* The gate */}
        <div className="rounded-lg border border-signal-400/15 bg-black/30 p-2.5">
          <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-slate-600">
            Performance gate
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px]">
            <span className="text-slate-500">
              OOS SHARPE <span className="text-signal-200">&gt; {engine?.gates.min_sharpe ?? 1.8}</span>
            </span>
            <span className="text-slate-500">
              PROFIT FACTOR <span className="text-signal-200">&gt; {engine?.gates.min_profit_factor ?? 1.5}</span>
            </span>
            <span className="text-slate-500">
              MIN TRADES <span className="text-signal-200">≥ {engine?.gates.min_oos_trades ?? 12}</span>
            </span>
            <span className="text-slate-500">
              WINDOWS <span className="text-signal-200">{engine?.gates.walk_forward_windows ?? 3}</span>
            </span>
          </div>
          <div className="mt-1.5 font-mono text-[9px] text-slate-600">
            engine <span className="text-plasma-400">{state?.engine ?? '—'}</span> · sampler{' '}
            <span className="text-plasma-400">{engine?.sampler ?? '—'}</span> · vectorbt{' '}
            <span className={engine?.vectorbt.available ? 'text-bull' : 'text-caution'}>
              {engine?.vectorbt.available ? engine.vectorbt.version : 'native fallback'}
            </span>
          </div>
        </div>

        {/* Adaptive penalty */}
        <div className="rounded-lg border border-white/5 bg-black/25 p-2.5">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate-600">
              Adaptive penalty mutation
            </span>
            <span className={clsx('font-mono text-[10px]', lossTone)}>
              k = {(pressure?.k ?? 0).toFixed(3)}
            </span>
          </div>
          <div className="font-mono text-[9px] text-slate-600">
            reward × exp(−k · streak) ={' '}
            <span className={lossTone}>{(pressure?.decay ?? 1).toFixed(4)}</span>
            {' '}· {engine?.directive.generations ?? 50} generations per cycle
          </div>
          {pressure?.tightened && Object.keys(pressure.tightened).length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {Object.entries(pressure.tightened).map(([key, value]) => (
                <span key={key} className="chip border-caution/25 bg-caution/10 text-caution">
                  {key} ≤ {String(value)}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Promoted genomes */}
        <div>
          <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-slate-600">
            Promoted genomes ({active.length})
          </div>
          <div className="space-y-1.5">
            {active.length === 0 && (
              <div className="rounded border border-white/5 bg-black/20 px-2 py-2 text-[10px] text-slate-600">
                No genome has cleared the gate yet. Every candidate so far was deleted.
              </div>
            )}
            {active.slice(0, 5).map((s) => (
              <div key={s.strategy_uid} className="rounded border border-bull/15 bg-bull/[0.04] px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] text-bull/90">{s.strategy_uid.slice(0, 14)}</span>
                  <span className="font-mono text-[9px] text-slate-500">
                    {s.kind.replace(/_/g, ' ')}
                  </span>
                </div>
                <div className="mt-0.5 flex gap-3 font-mono text-[9px] text-slate-500">
                  <span>
                    SHARPE <span className="text-slate-300">{s.out_of_sample.sharpe.toFixed(2)}</span>
                  </span>
                  <span>
                    PF <span className="text-slate-300">{s.out_of_sample.profit_factor.toFixed(2)}</span>
                  </span>
                  <span>
                    TRADES <span className="text-slate-300">{s.out_of_sample.trades}</span>
                  </span>
                  <span>
                    DD <span className="text-slate-300">{s.out_of_sample.max_drawdown_pct.toFixed(1)}%</span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Graveyard */}
        <div>
          <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-slate-600">
            Extinction graveyard ({extinctions.length})
          </div>
          <div className="space-y-1">
            {extinctions.slice(0, 6).map((x) => (
              <div key={`${x.strategy_uid}-${x.ts}`} className="rounded border border-bear/15 bg-bear/[0.04] px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] text-bear/80">
                    ☠ {String(x.strategy_uid).slice(0, 14)}
                  </span>
                  <span className="chip border-bear/25 bg-bear/10 text-[8px] text-bear/80">
                    {x.reason}
                  </span>
                </div>
                <div className="mt-0.5 font-mono text-[9px] leading-snug text-slate-600">
                  gen {x.generation} · sharpe {Number(x.sharpe).toFixed(2)} · PF{' '}
                  {Number(x.profit_factor).toFixed(2)}
                </div>
                {x.detail && (
                  <div className="mt-0.5 line-clamp-2 text-[9px] leading-snug text-slate-600">
                    {x.detail}
                  </div>
                )}
              </div>
            ))}
            {extinctions.length === 0 && (
              <div className="rounded border border-white/5 bg-black/20 px-2 py-2 text-[10px] text-slate-600">
                Graveyard empty. No strategy has failed the gate yet.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Cell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'bull' | 'warn';
}) {
  return (
    <div className="rounded border border-white/5 bg-black/25 px-2 py-1.5">
      <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-slate-600">{label}</div>
      <div
        className={clsx(
          'readout mt-0.5 text-[13px]',
          tone === 'bull' && 'text-bull',
          tone === 'warn' && 'text-caution',
          !tone && 'text-slate-200',
        )}
      >
        {value}
      </div>
    </div>
  );
}
