/**
 * Working positions and the last execution report.
 *
 * Shows the exact numbers that matter for a $100 desk: units, leverage, the
 * dollar risk riding on the stop, distance to liquidation, and live P&L.
 */

import { clsx } from 'clsx';
import type { ExecutionReport, Position } from '@/types/contract';

export function PositionsPanel({
  positions,
  primaryPrice,
  execution,
}: {
  positions: Position[];
  primaryPrice: number | null;
  execution: ExecutionReport | null;
}) {
  const totalUpnl = positions.reduce((sum, p) => sum + (p.unrealized_pnl ?? 0), 0);

  return (
    <div className="panel flex h-full flex-col overflow-hidden">
      <div className="panel-header">
        <span className="panel-title">Pilot — Working Positions</span>
        <span
          className={clsx(
            'readout text-[11px]',
            totalUpnl >= 0 ? 'text-bull' : 'text-bear',
          )}
        >
          {totalUpnl >= 0 ? '+' : ''}${totalUpnl.toFixed(2)}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {positions.length === 0 ? (
          <div className="p-3 text-[10px] leading-relaxed text-slate-600">
            Flat. No working orders.
            {primaryPrice !== null && (
              <>
                {' '}Reference mark{' '}
                <span className="text-slate-400">{primaryPrice.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>.
              </>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-white/[0.04]">
            {positions.map((p) => {
              const long = p.side === 'long';
              const riskPctOfStop = p.risk_usd;
              return (
                <li key={p.ticket} className="px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className={clsx('chip', long ? 'border-bull/40 text-bull' : 'border-bear/40 text-bear')}>
                        {long ? 'LONG' : 'SHORT'}
                      </span>
                      <span className="font-mono text-[11px] text-slate-200">{p.symbol}</span>
                      <span className="chip border-white/10 text-slate-500">{p.leverage}x</span>
                    </div>
                    <span
                      className={clsx(
                        'readout text-[12px]',
                        p.unrealized_pnl >= 0 ? 'text-bull' : 'text-bear',
                      )}
                    >
                      {p.unrealized_pnl >= 0 ? '+' : ''}${p.unrealized_pnl.toFixed(2)}
                      <span className="ml-1 text-[9px] text-slate-500">
                        ({p.unrealized_pct >= 0 ? '+' : ''}
                        {p.unrealized_pct.toFixed(2)}%)
                      </span>
                    </span>
                  </div>

                  <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-[9px]">
                    <Field label="ENTRY" value={p.entry_price.toLocaleString(undefined, { maximumFractionDigits: 4 })} />
                    <Field label="STOP" value={p.stop_price.toLocaleString(undefined, { maximumFractionDigits: 4 })} />
                    <Field
                      label="TARGET"
                      value={
                        p.take_profit_price
                          ? p.take_profit_price.toLocaleString(undefined, { maximumFractionDigits: 4 })
                          : '—'
                      }
                    />
                    <Field label="UNITS" value={p.quantity.toFixed(8)} />
                    <Field label="RISK" value={`$${riskPctOfStop.toFixed(2)}`} />
                    <Field
                      label="LIQ."
                      value={
                        p.liquidation_price
                          ? p.liquidation_price.toLocaleString(undefined, { maximumFractionDigits: 2 })
                          : '—'
                      }
                      danger
                    />
                  </div>

                  {p.strategy_uid && (
                    <div className="mt-1 font-mono text-[9px] text-plasma-400/70">
                      genome {String(p.strategy_uid).slice(0, 16)}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {execution && (
          <div className="border-t border-white/5 px-3 py-2">
            <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.18em] text-slate-600">
              Last execution
            </div>
            <div
              className={clsx(
                'font-mono text-[10px]',
                execution.status === 'FILLED' ? 'text-bull' : 'text-caution',
              )}
            >
              {execution.status} · {execution.message || `${execution.symbol} ${execution.side}`}
            </div>
            {execution.status === 'FILLED' && (
              <div className="mt-0.5 font-mono text-[9px] text-slate-600">
                fees ${execution.fees.toFixed(4)} · slippage ${execution.slippage_usd.toFixed(4)} ·{' '}
                {execution.venue}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div>
      <div className="text-[8px] uppercase tracking-[0.14em] text-slate-600">{label}</div>
      <div className={clsx('tabular', danger ? 'text-bear/70' : 'text-slate-400')}>{value}</div>
    </div>
  );
}
