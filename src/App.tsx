/**
 * SUFFIX TRADING DESK — cinematic HUD root.
 *
 * Layout
 * ------
 *   ┌──────────────── TitleBar (window chrome + equity readouts) ─────────────┐
 *   │ LEFT            │           CENTRE                 │        RIGHT        │
 *   │ RiskGauge       │   TelemetryRing + SuffixOrb      │ QuantumPanel        │
 *   │ GestureOverlay  │   (10 radial nodes orbiting)     │ AgentDetail (focus) │
 *   │ PositionsPanel  │                                  │                     │
 *   ├───────────────── TranscriptFeed ───── EquityGraph ─ EventLog ─────────┤
 *   └────────────────────────── CommandBar ───────────────────────────────────┘
 *
 * Boot sequence: ask the Electron preload (if present) for the API origin, then
 * `useDesk.boot()` — which opens the WebSocket, performs the JSON-RPC handshake
 * and pulls the directive. Everything rendered here is server-derived; the HUD
 * holds no risk constants of its own.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { clsx } from 'clsx';

import { CommandBar } from '@/components/CommandBar';
import { AgentDetail } from '@/components/AgentDetail';
import { EquityGraph, type EquityPoint } from '@/components/EquityGraph';
import { EventLog } from '@/components/EventLog';
import { GestureOverlay } from '@/components/GestureOverlay';
import { PositionsPanel } from '@/components/PositionsPanel';
import { QuantumPanel } from '@/components/QuantumPanel';
import { RiskGauge } from '@/components/RiskGauge';
import { SuffixOrb } from '@/components/SuffixOrb';
import { TelemetryRing } from '@/components/TelemetryRing';
import { TitleBar } from '@/components/TitleBar';
import { TranscriptFeed } from '@/components/TranscriptFeed';
import { useHandGestures } from '@/hooks/useHandGestures';
import { bridge } from '@/lib/bridge';
import { speakText, useDesk } from '@/store/desk';
import type { GestureName } from '@/types/contract';

type ElectronBridge = {
  appInfo: () => Promise<{ apiOrigin: string; wsUrl: string; isDev: boolean }>;
  backend: {
    health: () => Promise<{ ok: boolean; detail: string; latencyMs: number }>;
    restart: () => Promise<{ restarted: boolean }>;
  };
  window: {
    minimize: () => Promise<void>;
    maximize: () => Promise<boolean>;
    close: () => Promise<void>;
    toggleFullscreen: () => Promise<boolean>;
  };
  shortcuts: {
    onPushToTalk: (cb: () => void) => () => void;
    onKillSwitch: (cb: () => void) => () => void;
  };
  system: { openExternal: (url: string) => Promise<{ opened: boolean }> };
};

declare global {
  interface Window {
    suffix?: ElectronBridge;
  }
}

export default function App() {
  const desk = useDesk();
  const [videoReady, setVideoReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const equityRef = useRef<EquityPoint[]>([]);
  const [equityPoints, setEquityPoints] = useState<EquityPoint[]>([]);
  const lastEquityRef = useRef<number>(0);

  // ------------------------------------------------------------------ boot
  useEffect(() => {
    const electron = typeof window !== 'undefined' ? window.suffix : undefined;
    if (electron) {
      void electron.appInfo().then((info) => {
        bridge.setOrigin(info.apiOrigin);
        bridge.setWsUrl(info.wsUrl);
        void desk.boot(info.apiOrigin, true);
      });
      const offTalk = electron.shortcuts.onPushToTalk(() => toggleVoice());
      const offKill = electron.shortcuts.onKillSwitch(() => void desk.killSwitch());
      return () => {
        offTalk();
        offKill();
      };
    }
    // Browser / preview: relative URLs through the dev-server proxy.
    void desk.boot('', false);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // MediaPipe can only attach once the <video> element exists.
  useEffect(() => {
    if (videoRef.current && canvasRef.current) setVideoReady(true);
  }, []);

  // ------------------------------------------------------- gesture handling
  const handleGesture = useCallback(
    async (gesture: GestureName, score: number) => {
      // The server owns the gesture→action mapping so behaviour is identical
      // across camera, voice and API inputs. Fire-and-forget: never block the
      // render loop on a network round-trip.
      const payload: Record<string, unknown> = {
        gesture,
        payload: { symbol: desk.config?.watchlist?.[0] ?? 'BTC-USD', agent: desk.focusedAgent },
      };
      switch (gesture) {
        case 'swipe_left':
          desk.cycleAgent(-1);
          break;
        case 'swipe_right':
          desk.cycleAgent(1);
          break;
        case 'pinch':
          void desk.brief('brief', undefined, true);
          break;
        case 'thumbs_up':
          void desk.propose();
          break;
        case 'thumbs_down':
          void desk.flatten();
          break;
        default:
          break;
      }
      const result = await bridge.callSafe<{ action?: string }>('gesture.event', payload);
      desk.setGesture(gesture, score, result?.action ?? null);
    },
    [desk],
  );

  const gestures = useHandGestures({
    enabled: desk.gestureEnabled,
    videoRef,
    canvasRef,
    onGesture: (g, s) => void handleGesture(g, s),
  });

  // ------------------------------------------------------- equity history
  const equity = desk.frame?.equity ?? desk.status_?.account.equity ?? desk.config?.starting_capital ?? 100;
  useEffect(() => {
    if (Math.abs(equity - lastEquityRef.current) < 0.0005) return;
    lastEquityRef.current = equity;
    equityRef.current = [...equityRef.current, { ts: Date.now(), equity }].slice(-500);
    setEquityPoints(equityRef.current);
  }, [equity]);

  // Seed history from the LEDGER once the socket is up.
  useEffect(() => {
    if (!desk.booted) return;
    void bridge
      .callSafe<{ equity_curve: Array<{ ts: number; equity: number }> }>('ledger.equity', {
        limit: 400,
      })
      .then((res) => {
        if (res?.equity_curve?.length) {
          equityRef.current = res.equity_curve.map((p) => ({ ts: p.ts, equity: p.equity }));
          setEquityPoints(equityRef.current);
        }
      });
  }, [desk.booted]);

  // -------------------------------------------------------------- voice I/O
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const toggleVoice = useCallback(async () => {
    if (desk.listening) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: pickAudioMime() });
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        desk.setListening(false);
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        if (blob.size < 1200) return; // too short to be speech
        const buffer = await blob.arrayBuffer();
        const base64 = arrayBufferToBase64(buffer);
        const result = await bridge.callSafe<{ ok: boolean; text?: string; error?: string }>(
          'voice.transcribe',
          { audio_b64: base64, content_type: recorder.mimeType },
          );
        if (result?.ok && result.text) {
          desk.pushToast(`heard: “${result.text.slice(0, 90)}”`, 'info');
          void desk.command(result.text);
        } else {
          desk.pushToast(
            result?.error === 'stt_unavailable'
              ? 'whisper.cpp sidecar offline — type the command instead'
              : 'could not transcribe that',
            'warn',
          );
        }
      };
      recorder.start();
      desk.setListening(true);
    } catch {
      desk.pushToast('microphone unavailable', 'error');
      desk.setListening(false);
    }
  }, [desk]);

  // Global shortcut wiring inside the browser preview (Electron handles its own).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'Space') {
        e.preventDefault();
        void toggleVoice();
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'x') {
        e.preventDefault();
        void desk.killSwitch();
      }
      if (e.key === 'Escape') desk.focusAgent(null);
      if (e.key === 'ArrowRight' && e.altKey) desk.cycleAgent(1);
      if (e.key === 'ArrowLeft' && e.altKey) desk.cycleAgent(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [desk, toggleVoice]);

  // --------------------------------------------------------------- derived
  const riskState = useMemo(
    () => desk.frame?.risk_state ?? desk.status_?.sentinel.state ?? 'ARMED',
    [desk.frame?.risk_state, desk.status_?.sentinel.state],
  );
  const sentinel = desk.status_?.sentinel ?? null;
  const positions = desk.status_?.positions ?? [];
  const focusedReport = desk.focusedAgent ? desk.reports[desk.focusedAgent] ?? null : null;
  const focusedStatus = desk.focusedAgent
    ? desk.agents.find((a) => a.agent === desk.focusedAgent) ?? null
    : null;
  const primarySymbol = desk.config?.watchlist?.[0] ?? 'BTC-USD';
  const orbIntensity =
    (desk.frame?.nodes ?? []).reduce((sum, n) => sum + (n.value ?? 0), 0) /
    Math.max(1, desk.frame?.nodes?.length ?? 1);

  const connected = desk.status.state === 'open';

  const windows = typeof window !== 'undefined' ? window.suffix : undefined;

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-void-900 grain">
      <TitleBar
        config={desk.config}
        version={desk.version}
        equity={equity}
        balance={desk.frame?.balance ?? desk.config?.starting_capital ?? 100}
        dailyPnl={desk.frame?.daily_pnl ?? 0}
        drawdown={desk.frame?.drawdown_pct ?? 0}
        riskState={riskState}
        paused={Boolean(desk.status_?.paused)}
        connected={connected}
        isElectron={desk.isElectron}
        onKill={() => void desk.killSwitch()}
        onReset={() => void desk.resetDesk()}
        onPause={() => void bridge.callSafe('desk.pause', { paused: true })}
        onResume={() => void desk.resume()}
        onMinimize={() => void windows?.window.minimize()}
        onMaximize={() => void windows?.window.maximize()}
        onClose={() => void windows?.window.close()}
      />

      {!connected && (
        <div className="flex items-center justify-between border-b border-caution/25 bg-caution/10 px-3 py-1">
          <span className="font-mono text-[10px] text-caution">
            {desk.status.state === 'connecting'
              ? 'linking to the Python bridge…'
              : 'bridge offline — retrying. Start it with: python3 -m uvicorn server.main:app --port 8000'}
          </span>
          {windows && (
            <button
              className="btn btn-warn px-2 py-0.5 text-[9px]"
              onClick={() => void windows.backend.restart()}
            >
              RESTART BACKEND
            </button>
          )}
        </div>
      )}

      <main className="flex min-h-0 flex-1 gap-2.5 p-2.5">
        {/* ------------------------------------------------------ LEFT RAIL */}
        <aside className="flex w-[290px] shrink-0 flex-col gap-2.5 overflow-y-auto">
          <RiskGauge sentinel={sentinel} config={desk.config} />
          <PositionsPanel
            positions={positions}
            primaryPrice={null}
            execution={(desk.lastExecution as any) ?? null}
          />
          <GestureOverlay
            videoRef={videoRef}
            canvasRef={canvasRef}
            gesture={gestures.gesture}
            score={gestures.score}
            handsVisible={gestures.handsVisible}
            fps={gestures.fps}
            ready={videoReady && gestures.ready}
            loading={gestures.loading}
            error={gestures.error}
            enabled={desk.gestureEnabled}
            onToggle={() => desk.setGestureEnabled(!desk.gestureEnabled)}
            onRetry={() => {
              gestures.stop();
              setTimeout(() => void gestures.start(), 260);
            }}
            flashes={desk.gestureFlashes}
          />
        </aside>

        {/* ---------------------------------------------------- CENTRE STAGE */}
        <section className="relative flex min-w-0 flex-1 flex-col items-center justify-center">
          {/* ambient backdrop */}
          <div
            className="pointer-events-none absolute inset-0 opacity-60"
            style={{
              backgroundImage:
                'linear-gradient(rgba(34,211,238,0.055) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,0.055) 1px, transparent 1px)',
              backgroundSize: '46px 46px',
              maskImage: 'radial-gradient(circle at center, black 22%, transparent 72%)',
              WebkitMaskImage: 'radial-gradient(circle at center, black 22%, transparent 72%)',
            }}
          />

          {/* the 10 radial telemetry nodes */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="pointer-events-auto h-[640px] w-[640px] max-h-full max-w-full">
              <TelemetryRing
                frame={desk.frame}
                focused={desk.focusedAgent}
                onFocus={(agent) => desk.focusAgent(agent)}
              />
            </div>
          </div>

          {/* the orb */}
          <div className="relative z-10">
            <SuffixOrb
              speaking={desk.speaking}
              listening={desk.listening}
              intensity={orbIntensity}
              riskState={riskState}
              label={
                desk.busy
                  ? 'WORKING'
                  : desk.status_?.paused
                    ? 'HELD'
                    : riskState === 'DEAD'
                      ? 'TERMINATED'
                      : 'LISTENING'
              }
              sublabel={
                desk.busy ??
                desk.frame?.nodes?.find((n) => n.agent === 'sentinel')?.headline?.slice(0, 92) ??
                `${desk.config?.tagline ?? 'Nine agents, one voice.'}`
              }
              confidence={sentinel ? Math.max(0, 1 - (sentinel.drawdown_pct ?? 0) / 20) : 0.75}
            />
          </div>

          {/* quick actions under the orb */}
          <div className="relative z-10 mt-3 flex flex-wrap items-center justify-center gap-1.5">
            <button className="btn no-drag" onClick={() => void desk.brief('brief', undefined, false)}>
              BRIEF
            </button>
            <button className="btn no-drag" onClick={() => void desk.brief('full', undefined, true)}>
              FULL SCAN
            </button>
            <button className="btn no-drag" onClick={() => void desk.propose()}>
              PROPOSE
            </button>
            <button
              className="btn no-drag"
              onClick={() => void desk.manualOrder('long', primarySymbol)}
            >
              LONG {primarySymbol.replace('-USD', '')}
            </button>
            <button
              className="btn no-drag"
              onClick={() => void desk.manualOrder('short', primarySymbol)}
            >
              SHORT {primarySymbol.replace('-USD', '')}
            </button>
            <button className="btn btn-ghost no-drag" onClick={() => void desk.flatten()}>
              FLATTEN
            </button>
          </div>

          {/* status strip */}
          <div className="relative z-10 mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 font-mono text-[9px] text-slate-600">
            <span>
              transport <span className={connected ? 'text-bull' : 'text-bear'}>{desk.status.state}</span>
            </span>
            <span>fps <span className="text-slate-400">{desk.fps.toFixed(1)}</span></span>
            <span>latency <span className="text-slate-400">{(desk.frame?.latency_ms ?? 0).toFixed(0)}ms</span></span>
            <span>voices <span className="text-slate-400">{desk.frame?.voices ?? 0}</span></span>
            <span>
              agents <span className="text-slate-400">
                {desk.agents.filter((a) => a.last_report_ts).length}/{desk.agents.length || 10}
              </span>
            </span>
            <span>
              sidecars
              <span className={desk.config?.sidecars.tts !== 'disabled' ? ' text-slate-400' : ' text-slate-700'}>
                {' '}tts:{desk.config?.sidecars.tts ?? '—'}
              </span>
              <span className={desk.config?.sidecars.stt !== 'disabled' ? ' text-slate-400' : ' text-slate-700'}>
                {' '}stt:{desk.config?.sidecars.stt ?? '—'}
              </span>
              <span className={desk.config?.sidecars.finnhub_configured ? ' text-bull' : ' text-caution'}>
                {' '}finnhub:{desk.config?.sidecars.finnhub_configured ? 'live' : 'sim'}
              </span>
            </span>
          </div>
        </section>

        {/* ----------------------------------------------------- RIGHT RAIL */}
        <aside className="flex w-[320px] shrink-0 flex-col gap-2.5 overflow-y-auto">
          <AnimatePresence mode="wait">
            {desk.focusedAgent ? (
              <AgentDetail
                key={desk.focusedAgent}
                agent={desk.focusedAgent}
                report={focusedReport}
                status={focusedStatus}
                onClose={() => desk.focusAgent(null)}
              />
            ) : (
              <QuantumPanel
                key="quantum"
                quantum={desk.quantum}
                extinctions={desk.extinctions}
                onRun={() => void desk.runGeneration()}
                busy={desk.busy}
              />
            )}
          </AnimatePresence>
        </aside>
      </main>

      {/* -------------------------------------------------------- LOWER DECK */}
      <div className="grid min-h-0 shrink-0 grid-cols-12 gap-2.5 px-2.5" style={{ height: 238 }}>
        <div className="col-span-5 min-h-0">
          <TranscriptFeed
            transcript={desk.transcript}
            speaking={desk.speaking}
            onSpeak={(text) => void speakText(text, desk as any)}
          />
        </div>
        <div className="col-span-4 flex min-h-0 flex-col gap-2.5">
          <EquityGraph
            points={equityPoints}
            deathLine={desk.config?.death_line ?? 80}
            startingCapital={desk.config?.starting_capital ?? 100}
          />
        </div>
        <div className="col-span-3 min-h-0">
          <EventLog events={desk.events} />
        </div>
      </div>

      <div className="shrink-0 px-2.5 pb-2.5 pt-2.5">
        <CommandBar
          onSubmit={(text) => void desk.command(text)}
          onVoice={() => void toggleVoice()}
          busy={desk.busy}
          listening={desk.listening}
          voiceAvailable={desk.config?.sidecars.stt !== 'disabled'}
        />
      </div>

      {/* ------------------------------------------------------------ TOAST */}
      <AnimatePresence>
        {desk.toast && <Toast text={desk.toast.text} tone={desk.toast.tone} onDone={desk.clearToast} />}
      </AnimatePresence>
    </div>
  );
}

function Toast({
  text,
  tone,
  onDone,
}: {
  text: string;
  tone: 'info' | 'warn' | 'error' | 'ok';
  onDone: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDone, tone === 'error' ? 8000 : 5200);
    return () => clearTimeout(t);
  }, [text, tone, onDone]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12 }}
      transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
      onClick={onDone}
      className={clsx(
        'fixed bottom-20 left-1/2 z-50 max-w-[560px] -translate-x-1/2 cursor-pointer rounded-lg border px-3.5 py-2',
        'bg-void-800/95 font-mono text-[11px] backdrop-blur',
        tone === 'error' && 'border-critical/45 text-critical',
        tone === 'warn' && 'border-caution/45 text-caution',
        tone === 'ok' && 'border-bull/45 text-bull',
        tone === 'info' && 'border-signal-400/35 text-signal-200',
      )}
    >
      {text}
    </motion.div>
  );
}

// --------------------------------------------------------------------------- //
//  helpers
// --------------------------------------------------------------------------- //
function pickAudioMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  }
  return 'audio/webm';
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
