/**
 * SENTINEL risk gauge.
 *
 * The single most important readout on the desk: how far equity sits above the
 * $80.00 Death Line, and how much is left before the whole generation is killed.
 */

import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import { RISK_STATE_STYLE, type SentinelState } from '@/types/contract';

export function RiskGauge({
  sentinel,
  config,
}: {
  sentinel: SentinelState | null;
  config: { starting_capital: number; death_line: number; risk_min_usd: number; risk_max_usd: number; allowed_leverage: number[] } | null;
}) {
  const start = config?.starting_capital ?? 100;
  const death = config?.death_line ?? 80;
  const equity = sentinel?.equity ?? start;
  const tone = RISK_STATE_STYLE[sentinel?.state ?? 'ARMED'];

  // 0% at the death line, 100% at starting capital and above.
  const span = Math.max(start - death, 1e-6);
  const headroom = Math.max(0, Math.min(1, (equity - death) / span));
  const pct = Math.round(headroom * 100);

  const danger = equity <= death + 3;
  const warn = equity <= death + 10;

  return (
    <div className="panel scanlines relative overflow-hidden">
      <div className="panel-header">
        <span className="panel-title">Sentinel — Risk Gate</span>
        <span className={clsx('chip', tone.text, tone.ring, 'ring-1')}>{tone.label}</span>
      </div>

      <div className="space-y-3 p-3.5">
        {/* Death-line bar */}
        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">
              Death-line buffer
            </span>
            <span
              className={clsx(
                'readout text-sm',
                danger ? 'text-bear' : warn ? 'text-caution' : 'text-bull',
              )}
            >
              ${(sentinel?.distance_to_death_usd ?? start - death).toFixed(2)}
            </span>
          </div>
          <div className="relative h-2.5 overflow-hidden rounded-full bg-void-600/80 ring-1 ring-inset ring-white/5">
            <motion.div
              className={clsx(
                'absolute inset-y-0 left-0 rounded-full',
                danger
                  ? 'bg-gradient-to-r from-bear/70 to-bear'
                  : warn
                    ? 'bg-gradient-to-r from-caution/70 to-caution'
                    : 'bg-gradient-to-r from-bull/60 to-signal-400',
              )}
              initial={{ width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={{ type: 'spring', stiffness: 60, damping: 18 }}
            />
            {/* death-line marker */}
            <div className="absolute inset-y-0 left-0 w-[2px] bg-bear shadow-[0_0_10px_2px_rgba(239,68,68,0.8)]" />
          </div>
          <div className="mt-1 flex justify-between font-mono text-[9px] text-slate-600">
            <span className="text-bear/80">DEATH ${death.toFixed(2)}</span>
            <span>{pct}% buffer</span>
            <span>${start.toFixed(2)} START</span>
          </div>
        </div>

        {/* Readout grid */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          <Stat label="Equity" value={`$${(sentinel?.equity ?? start).toFixed(2)}`} />
          <Stat
            label="Drawdown"
            value={`${(sentinel?.drawdown_pct ?? 0).toFixed(2)}%`}
            tone={danger ? 'bear' : warn ? 'warn' : undefined}
          />
          <Stat
            label="Day P&L"
            value={`${(sentinel?.daily_pnl ?? 0) >= 0 ? '+' : ''}$${(sentinel?.daily_pnl ?? 0).toFixed(2)}`}
            tone={(sentinel?.daily_pnl ?? 0) < 0 ? 'bear' : 'bull'}
          />
          <Stat label="Open" value={`${sentinel?.open_positions ?? 0}`} />
          <Stat label="VETOs today" value={`${sentinel?.vetoes_today ?? 0}`} tone={sentinel?.vetoes_today ? 'warn' : undefined} />
          <Stat label="Kills today" value={`${sentinel?.kills_today ?? 0}`} tone={sentinel?.kills_today ? 'bear' : undefined} />
        </div>

        {/* Directive constants — read from the server, never hard-coded here */}
        <div className="rounded-lg border border-white/5 bg-black/25 p-2.5">
          <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-slate-600">
            Do-or-Die directive
          </div>
          <div className="grid grid-cols-3 gap-2 font-mono text-[10px]">
            <div>
              <div className="text-slate-600">RISK/TRADE</div>
              <div className="text-signal-200">
                ${config?.risk_min_usd?.toFixed(2) ?? '1.00'}–${config?.risk_max_usd?.toFixed(2) ?? '2.00'}
              </div>
            </div>
            <div>
              <div className="text-slate-600">LEVERAGE</div>
              <div className="text-signal-200">{(config?.allowed_leverage ?? [3, 5, 10]).join('/')}x</div>
            </div>
            <div>
              <div className="text-slate-600">DEATH LINE</div>
              <div className="text-bear/90">-20%</div>
            </div>
          </div>
        </div>

        {sentinel?.cooldown_until_ms && sentinel.cooldown_until_ms > Date.now() && (
          <div className="rounded-lg border border-caution/30 bg-caution/10 px-2.5 py-1.5 font-mono text-[10px] text-caution">
            COOLDOWN ACTIVE — {sentinel.consecutive_losses} consecutive losses
          </div>
        )}

        {sentinel?.last_verdict && (
          <div className="rounded-lg border border-white/5 bg-black/25 p-2.5">
            <div className="mb-1 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.2em] text-slate-600">
              <span>Last verdict</span>
              <span
                className={clsx(
                  sentinel.last_verdict.decision === 'VETO' ? 'text-critical' : 'text-bull',
                )}
              >
                {sentinel.last_verdict.decision}
              </span>
            </div>
            <div className="font-mono text-[10px] text-slate-400">
              {sentinel.last_verdict.symbol} · {sentinel.last_verdict.side}
              {sentinel.last_verdict.sizing && (
                <>
                  {' '}· {sentinel.last_verdict.sizing.applied_leverage}x · risk $
                  {sentinel.last_verdict.sizing.risk_usd.toFixed(2)}
                </>
              )}
            </div>
            {sentinel.last_verdict.reasons?.[0] && (
              <div className="mt-1 text-[10px] leading-snug text-slate-500">
                {sentinel.last_verdict.reasons[0]}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'bear' | 'bull' | 'warn';
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-slate-600">{label}</span>
      <span
        className={clsx(
          'readout text-[12px]',
          tone === 'bear' && 'text-bear',
          tone === 'bull' && 'text-bull',
          tone === 'warn' && 'text-caution',
          !tone && 'text-slate-200',
        )}
      >
        {value}
      </span>
    </div>
  );
}
