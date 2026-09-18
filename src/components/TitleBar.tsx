/**
 * Frameless-window title bar + master controls.
 *
 * Owns the drag region, window buttons, and the three controls that matter at
 * 3am: the kill switch, the $100 desk reset, and the live equity readout.
 */

import { clsx } from 'clsx';
import { RISK_STATE_STYLE, type PublicConfig, type RiskStateName } from '@/types/contract';

export function TitleBar({
  config,
  version,
  equity,
  balance,
  dailyPnl,
  drawdown,
  riskState,
  paused,
  connected,
  isElectron,
  onKill,
  onReset,
  onPause,
  onResume,
  onMinimize,
  onMaximize,
  onClose,
}: {
  config: PublicConfig | null;
  version: string;
  equity: number;
  balance: number;
  dailyPnl: number;
  drawdown: number;
  riskState: RiskStateName;
  paused: boolean;
  connected: boolean;
  isElectron: boolean;
  onKill: () => void;
  onReset: () => void;
  onPause: () => void;
  onResume: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onClose: () => void;
}) {
  const tone = RISK_STATE_STYLE[riskState];
  const pnlPositive = dailyPnl >= 0;

  return (
    <header className="drag-region relative z-30 flex h-11 shrink-0 items-center justify-between
                       border-b border-signal-400/12 bg-void-800/80 px-3 backdrop-blur">
      {/* left: identity */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span
              className={clsx(
                'absolute inline-flex h-full w-full rounded-full opacity-60',
                connected ? 'animate-ping bg-bull' : 'bg-bear',
              )}
            />
            <span
              className={clsx(
                'relative inline-flex h-2 w-2 rounded-full',
                connected ? 'bg-bull' : 'bg-bear',
              )}
            />
          </span>
          <span className="font-mono text-[12px] font-medium tracking-[0.32em] text-signal-200 text-glow">
            SUFFIX
          </span>
          <span className="hidden font-mono text-[9px] uppercase tracking-[0.24em] text-slate-600 lg:inline">
            trading desk
          </span>
        </div>

        <span className="hidden font-mono text-[9px] text-slate-600 xl:inline">
          v{version} · {config?.execution_mode ?? '—'} · {config?.tagline ?? ''}
        </span>
      </div>

      {/* centre: equity telemetry */}
      <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-4">
        <Readout label="EQUITY" value={`$${equity.toFixed(2)}`} />
        <Divider />
        <Readout label="BALANCE" value={`$${balance.toFixed(2)}`} />
        <Divider />
        <Readout
          label="DAY P&L"
          value={`${pnlPositive ? '+' : ''}$${dailyPnl.toFixed(2)}`}
          tone={pnlPositive ? 'bull' : 'bear'}
        />
        <Divider />
        <Readout label="DD" value={`${drawdown.toFixed(2)}%`} tone={drawdown > 12 ? 'bear' : undefined} />
        <Divider />
        <span className={clsx('chip ring-1', tone.text, tone.ring)}>{tone.label}</span>
      </div>

      {/* right: controls */}
      <div className="no-drag flex items-center gap-1.5">
        <button
          className={clsx('btn px-2 py-1 text-[9px]', paused && 'btn-warn')}
          onClick={paused ? onResume : onPause}
          title={paused ? 'Resume telemetry' : 'Pause telemetry'}
        >
          {paused ? 'RESUME' : 'PAUSE'}
        </button>
        <button
          className="btn btn-ghost px-2 py-1 text-[9px]"
          onClick={onReset}
          title="Reset the desk to $100.00 and purge the active generation"
        >
          RESET
        </button>
        <button
          className="btn btn-danger px-2.5 py-1 text-[9px]"
          onClick={onKill}
          title="Freeze the desk and flatten every position (Ctrl/Cmd+Shift+X)"
        >
          KILL
        </button>

        {isElectron && (
          <>
            <span className="mx-1 h-4 w-px bg-white/10" />
            <WindowButton onClick={onMinimize} label="—" />
            <WindowButton onClick={onMaximize} label="▢" />
            <WindowButton onClick={onClose} label="✕" danger />
          </>
        )}
      </div>
    </header>
  );
}

function Readout({ label, value, tone }: { label: string; value: string; tone?: 'bull' | 'bear' }) {
  return (
    <div className="text-center">
      <div className="font-mono text-[8px] uppercase tracking-[0.2em] text-slate-600">{label}</div>
      <div
        className={clsx(
          'readout text-[12px] leading-tight',
          tone === 'bull' && 'text-bull',
          tone === 'bear' && 'text-bear',
          !tone && 'text-slate-200',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Divider() {
  return <span className="h-4 w-px bg-white/8" />;
}

function WindowButton({
  onClick,
  label,
  danger,
}: {
  onClick: () => void;
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex h-6 w-7 items-center justify-center rounded font-mono text-[10px] transition',
        danger ? 'text-slate-500 hover:bg-bear/80 hover:text-white' : 'text-slate-500 hover:bg-white/10 hover:text-slate-100',
      )}
    >
      {label}
    </button>
  );
}
