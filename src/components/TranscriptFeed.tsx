/**
 * The single voice.
 *
 * Only SUFFIX ever speaks to the user; the specialist reports are folded into
 * the `trace` lines underneath each utterance, which is where the HUD exposes
 * *why* the desk said what it said.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { clsx } from 'clsx';
import type { Utterance } from '@/types/contract';

const PRIORITY_STYLE: Record<Utterance['priority'], { chip: string; border: string }> = {
  ambient: { chip: 'border-white/10 text-slate-500', border: 'border-white/5' },
  briefing: { chip: 'border-signal-400/30 bg-signal-400/10 text-signal-200', border: 'border-signal-400/15' },
  alert: { chip: 'border-caution/40 bg-caution/10 text-caution', border: 'border-caution/20' },
  critical: { chip: 'border-critical/50 bg-critical/15 text-critical', border: 'border-critical/30' },
};

export function TranscriptFeed({
  transcript,
  onSpeak,
  speaking,
}: {
  transcript: Utterance[];
  onSpeak: (text: string) => void;
  speaking: boolean;
}) {
  return (
    <div className="panel flex h-full flex-col overflow-hidden">
      <div className="panel-header">
        <span className="panel-title">Su. — Master Voice</span>
        <span className="font-mono text-[9px] text-slate-600">{transcript.length} transmissions</span>
      </div>

      <div className="flex-1 space-y-2.5 overflow-y-auto p-3.5">
        <AnimatePresence initial={false}>
          {transcript.length === 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="rounded-lg border border-white/5 bg-black/20 p-3 text-[11px] leading-relaxed text-slate-500"
            >
              SUFFIX is online and holding. Say <span className="text-signal-200">“brief me”</span>,
              press <span className="text-signal-200">BRIEF</span>, or open your palm at the camera to
              cycle telemetry. Nothing is spoken to the user except through this channel.
            </motion.div>
          )}

          {transcript.map((u) => {
            const style = PRIORITY_STYLE[u.priority] ?? PRIORITY_STYLE.briefing;
            return (
              <motion.article
                key={u.utterance_id}
                initial={{ opacity: 0, y: -8, filter: 'blur(4px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                className={clsx('rounded-lg border bg-black/25 p-2.5', style.border)}
              >
                <header className="mb-1.5 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] tracking-[0.2em] text-signal-400">
                      SUFFIX
                    </span>
                    <span className={clsx('chip', style.chip)}>{u.priority}</span>
                    <span className="font-mono text-[9px] text-slate-600">{u.intent}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <time className="font-mono text-[9px] text-slate-600">
                      {new Date(u.ts).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </time>
                    <button
                      type="button"
                      onClick={() => onSpeak(u.voice_text || u.text)}
                      disabled={speaking}
                      title="Speak this transmission"
                      className="no-drag font-mono text-[9px] text-slate-500 transition hover:text-signal-200 disabled:opacity-30"
                    >
                      ▶
                    </button>
                  </div>
                </header>

                <p className="text-[12px] leading-relaxed text-slate-300">{u.text}</p>

                {u.trace?.length > 0 && (
                  <details className="group mt-2">
                    <summary className="cursor-pointer font-mono text-[9px] uppercase tracking-[0.18em] text-slate-600 transition hover:text-signal-200/80">
                      reasoning trace ({u.trace.length})
                    </summary>
                    <ul className="mt-1 space-y-0.5 border-l border-signal-400/20 pl-2.5">
                      {u.trace.map((line, i) => (
                        <li key={i} className="font-mono text-[9px] leading-relaxed text-slate-500">
                          {line}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                {u.reports?.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {u.reports.map((r) => (
                      <span
                        key={r.report_id}
                        className={clsx(
                          'chip',
                          r.bias === 'long' && 'border-bull/30 text-bull',
                          r.bias === 'short' && 'border-bear/30 text-bear',
                          (r.bias === 'flat' || r.bias === 'unclear') && 'border-white/10 text-slate-500',
                        )}
                        title={r.headline}
                      >
                        {r.agent} {(r.confidence * 100).toFixed(0)}%
                      </span>
                    ))}
                  </div>
                )}
              </motion.article>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
