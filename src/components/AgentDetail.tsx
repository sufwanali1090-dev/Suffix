/**
 * Focused agent dossier.
 *
 * Selecting a telemetry node (click, or a camera swipe) opens that specialist's
 * full report: headline, bullets, metrics, provenance and data quality. This is
 * the HUD's "cycle agent telemetry views" surface.
 */

import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import { AGENT_META, type AgentId, type AgentReport, type AgentStatus } from '@/types/contract';

const QUALITY_STYLE: Record<string, string> = {
  live: 'border-bull/35 bg-bull/10 text-bull',
  cached: 'border-signal-400/30 bg-signal-400/10 text-signal-200',
  partial: 'border-caution/35 bg-caution/10 text-caution',
  simulated: 'border-plasma-500/35 bg-plasma-500/10 text-plasma-400',
};

const TONE_STYLE: Record<string, string> = {
  bull: 'text-bull',
  bear: 'text-bear',
  warn: 'text-caution',
  critical: 'text-critical',
  neutral: 'text-slate-300',
};

export function AgentDetail({
  agent,
  report,
  status,
  onClose,
}: {
  agent: AgentId;
  report: AgentReport | null;
  status: AgentStatus | null;
  onClose: () => void;
}) {
  const meta = AGENT_META[agent];
  const quality = report?.data_quality ?? 'simulated';

  return (
    <motion.div
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
      className="panel flex h-full flex-col overflow-hidden"
    >
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] tracking-[0.22em] text-signal-200">
            {meta.designation}
          </span>
          <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-slate-600">
            agent {meta.designationIndex}
          </span>
        </div>
        <button onClick={onClose} className="no-drag font-mono text-[11px] text-slate-500 hover:text-slate-200">
          ✕
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3.5">
        <div>
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate-600">
            {meta.role}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{meta.blurb}</p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className={clsx('chip', QUALITY_STYLE[quality])}>{quality} data</span>
          {status && (
            <span className="chip border-white/10 text-slate-500">
              {status.state} · load {(status.load * 100).toFixed(0)}%
            </span>
          )}
          {report && (
            <span
              className={clsx(
                'chip',
                report.bias === 'long' && 'border-bull/35 text-bull',
                report.bias === 'short' && 'border-bear/35 text-bear',
                (report.bias === 'flat' || report.bias === 'unclear') && 'border-white/10 text-slate-500',
              )}
            >
              {report.bias} · {(report.confidence * 100).toFixed(0)}%
            </span>
          )}
          {report && (
            <span className="chip border-white/10 text-slate-500">{report.latency_ms}ms</span>
          )}
        </div>

        {!report && (
          <div className="rounded-lg border border-white/5 bg-black/25 p-3 text-[11px] leading-relaxed text-slate-500">
            No report cached for {meta.designation}. Request one to pull a fresh read.
          </div>
        )}

        {report && (
          <>
            <Section title="Headline">
              <p className="text-[12px] leading-relaxed text-slate-200">{report.headline}</p>
            </Section>

            {report.bullets?.length > 0 && (
              <Section title="Findings">
                <ul className="space-y-1.5">
                  {report.bullets.map((b, i) => (
                    <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-slate-400">
                      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-signal-400/70" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {report.metrics?.length > 0 && (
              <Section title="Metrics">
                <div className="grid grid-cols-2 gap-1.5">
                  {report.metrics.map((m, i) => (
                    <div key={i} className="rounded border border-white/5 bg-black/25 px-2 py-1.5">
                      <div className="font-mono text-[8px] uppercase tracking-[0.14em] text-slate-600">
                        {m.label}
                      </div>
                      <div
                        className={clsx(
                          'readout mt-0.5 text-[12px]',
                          TONE_STYLE[m.tone ?? 'neutral'] ?? 'text-slate-300',
                        )}
                      >
                        {typeof m.value === 'number' ? m.value.toLocaleString() : m.value}
                        {m.unit ? <span className="text-slate-600">{m.unit}</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {report.sources?.length > 0 && (
              <Section title="Provenance">
                <div className="flex flex-wrap gap-1">
                  {report.sources.map((s) => (
                    <span key={s} className="chip border-white/10 text-slate-500">
                      {s}
                    </span>
                  ))}
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </motion.div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-slate-600">
        {title}
      </div>
      {children}
    </section>
  );
}
