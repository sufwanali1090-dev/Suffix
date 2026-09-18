/**
 * Desk event stream — the flight recorder.
 *
 * Every risk verdict, fill, extinction, gesture and system transition lands
 * here. Level drives the colour; critical rows get a pulse so a kill event is
 * impossible to miss while the operator is looking elsewhere.
 */

import { clsx } from 'clsx';
import type { DeskEvent } from '@/types/contract';

const LEVEL_STYLE: Record<DeskEvent['level'], string> = {
  debug: 'text-slate-600',
  info: 'text-slate-400',
  warn: 'text-caution',
  error: 'text-critical',
  critical: 'text-critical font-medium',
};

const CHANNEL_STYLE: Record<DeskEvent['channel'], string> = {
  system: 'border-white/10 text-slate-500',
  agent: 'border-signal-400/25 text-signal-200',
  risk: 'border-caution/30 text-caution',
  order: 'border-bull/30 text-bull',
  quantum: 'border-plasma-500/30 text-plasma-400',
  ledger: 'border-white/10 text-slate-500',
  gesture: 'border-signal-400/20 text-signal-200/80',
  voice: 'border-signal-400/25 text-signal-200',
};

export function EventLog({ events }: { events: DeskEvent[] }) {
  return (
    <div className="panel flex h-full flex-col overflow-hidden">
      <div className="panel-header">
        <span className="panel-title">Flight Recorder</span>
        <span className="font-mono text-[9px] text-slate-600">{events.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {events.length === 0 && (
          <div className="p-3 text-[10px] text-slate-600">No events yet.</div>
        )}
        <ul className="divide-y divide-white/[0.04]">
          {events.map((e) => (
            <li
              key={e.event_id}
              className={clsx(
                'px-3 py-1.5 transition-colors hover:bg-white/[0.02]',
                e.level === 'critical' && 'bg-critical/[0.06]',
              )}
            >
              <div className="flex items-start gap-2">
                <time className="mt-0.5 shrink-0 font-mono text-[9px] tabular text-slate-600">
                  {new Date(e.ts).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </time>
                <span className={clsx('chip mt-0.5 shrink-0', CHANNEL_STYLE[e.channel])}>
                  {e.channel}
                </span>
                <div className="min-w-0 flex-1">
                  <div className={clsx('font-mono text-[10px] leading-snug', LEVEL_STYLE[e.level])}>
                    {e.title}
                  </div>
                  {e.detail && (
                    <div className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-slate-600">
                      {e.detail}
                    </div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
