/**
 * Desk store — the HUD's single source of truth.
 *
 * The store owns the socket subscription, folds every inbound frame into one
 * coherent snapshot, and exposes intent methods (brief / propose / kill switch)
 * that talk to the Python orchestrator. Components stay dumb and derived.
 */

import { create } from 'zustand';
import { bridge, type BridgeStatus } from '@/lib/bridge';
import type {
  AgentId,
  AgentReport,
  AgentStatus,
  DeskEvent,
  DeskStatus,
  ExtinctionRecord,
  GestureFlash,
  GestureName,
  Position,
  PublicConfig,
  QuantumStateResponse,
  RiskVerdictRecord,
  TelemetryFrame,
  Utterance,
} from '@/types/contract';

const MAX_EVENTS = 220;
const MAX_TRANSCRIPT = 60;

interface DeskStore {
  // -------------------------------------------------------------- connection
  status: BridgeStatus;
  booted: boolean;
  backendOk: boolean;
  backendDetail: string | null;
  config: PublicConfig | null;
  version: string;
  isElectron: boolean;
  fps: number;

  // ---------------------------------------------------------------- telemetry
  frame: TelemetryFrame | null;
  status_: DeskStatus | null;
  agents: AgentStatus[];
  reports: Partial<Record<AgentId, AgentReport>>;
  positions: Position[];

  // ------------------------------------------------------------- narrative
  transcript: Utterance[];
  events: DeskEvent[];

  // --------------------------------------------------------------- trading
  lastVerdict: RiskVerdictRecord | null;
  lastExecution: Record<string, any> | null;

  // --------------------------------------------------------------- quantum
  quantum: QuantumStateResponse | null;
  extinctions: ExtinctionRecord[];

  // ---------------------------------------------------------------- gesture
  gestureEnabled: boolean;
  gestureName: GestureName;
  gestureAction: string | null;
  gestureScore: number;
  gestureFlashes: GestureFlash[];

  // ---------------------------------------------------------------- voice
  listening: boolean;
  speaking: boolean;
  speakingId: string | null;

  // -------------------------------------------------------------- view state
  focusedAgent: AgentId | null;
  busy: string | null;
  toast: { text: string; tone: 'info' | 'warn' | 'error' | 'ok' } | null;

  // ---------------------------------------------------------------- actions
  boot: (origin: string, isElectron: boolean) => Promise<void>;
  teardown: () => void;
  refreshStatus: () => Promise<void>;
  refreshLedger: () => Promise<void>;
  refreshQuantum: () => Promise<void>;
  focusAgent: (agent: AgentId | null) => void;
  cycleAgent: (direction: 1 | -1) => void;

  brief: (intent?: string, symbol?: string, speak?: boolean) => Promise<void>;
  propose: (symbol?: string) => Promise<void>;
  manualOrder: (side: 'long' | 'short', symbol?: string) => Promise<void>;
  command: (text: string) => Promise<void>;
  flatten: () => Promise<void>;
  killSwitch: () => Promise<void>;
  resume: () => Promise<void>;
  resetDesk: () => Promise<void>;
  runGeneration: (trials?: number) => Promise<void>;

  setGesture: (gesture: GestureName, score: number, action?: string | null) => void;
  setGestureEnabled: (on: boolean) => void;
  setListening: (on: boolean, speaking?: boolean, id?: string | null) => void;
  pushToast: (text: string, tone?: 'info' | 'warn' | 'error' | 'ok') => void;
  clearToast: () => void;
}

const AGENT_ORDER: AgentId[] = [
  'atlas',
  'scout',
  'capitol',
  'athena',
  'chartist',
  'oracle',
  'sentinel',
  'pilot',
  'ledger',
  'quantum',
];

let unsubscribeSocket: (() => void) | null = null;
let unsubscribeStatus: (() => void) | null = null;
let frameTimes: number[] = [];

export const useDesk = create<DeskStore>((set, get) => ({
  status: { state: 'idle' },
  booted: false,
  backendOk: false,
  backendDetail: null,
  config: null,
  version: '—',
  isElectron: false,
  fps: 0,

  frame: null,
  status_: null,
  agents: [],
  reports: {},
  positions: [],

  transcript: [],
  events: [],

  lastVerdict: null,
  lastExecution: null,

  quantum: null,
  extinctions: [],

  gestureEnabled: false,
  gestureName: 'none',
  gestureAction: null,
  gestureScore: 0,
  gestureFlashes: [],

  listening: false,
  speaking: false,
  speakingId: null,

  focusedAgent: null,
  busy: null,
  toast: null,

  // ---------------------------------------------------------------- lifecycle
  async boot(origin, isElectron) {
    if (get().booted) return;
    bridge.setOrigin(origin);
    set({ booted: true, isElectron });

    unsubscribeStatus = bridge.onStatus((status) => {
      set({ status });
      if (status.state === 'closed' || status.state === 'error') {
        set({ backendOk: false });
      }
    });

    unsubscribeSocket = bridge.onMessage((message) => {
      switch (message?.type) {
        case 'handshake': {
          const hsFrame = message.telemetry as TelemetryFrame;
          set({
            config: message.directive as PublicConfig,
            version: message.version as string,
            frame: hsFrame,
            positions: hsFrame?.positions ?? [],
            backendOk: true,
          });
          break;
        }
        case 'telemetry': {
          const now = performance.now();
          frameTimes.push(now);
          frameTimes = frameTimes.filter((t) => now - t < 1500);
          const next = message.frame as TelemetryFrame;
          set({
            frame: next,
            // Positions ride the telemetry frame so the panel tracks
            // mark-to-market instead of going stale between polls.
            positions: next?.positions ?? [],
            fps: Math.round((frameTimes.length / 1.5) * 10) / 10,
          });
          break;
        }
        case 'utterance': {
          const utterance = message.utterance as Utterance;
          set((state) => ({
            transcript: [utterance, ...state.transcript].slice(0, MAX_TRANSCRIPT),
          }));
          void speak(utterance, set);
          break;
        }
        case 'event': {
          const event = message.event as DeskEvent;
          const isExtinction =
            event.channel === 'quantum' && /extinct|terminated/i.test(event.title);
          set((state) => ({
            events: [event, ...state.events].slice(0, MAX_EVENTS),
            extinctions: isExtinction
              ? ([
                  {
                    strategy_uid: String(event.payload?.strategy_uid ?? '—'),
                    symbol: String(event.payload?.symbol ?? ''),
                    reason: String(event.payload?.reason ?? 'PERFORMANCE_GATE'),
                    detail: event.detail,
                    sharpe: Number(event.payload?.sharpe ?? 0),
                    profit_factor: Number(event.payload?.profit_factor ?? 0),
                    generation: Number(event.payload?.generation ?? 0),
                    genome: (event.payload?.genome ?? {}) as Record<string, any>,
                    ts: event.ts,
                  } as ExtinctionRecord,
                  ...state.extinctions,
                ].slice(0, 80))
              : state.extinctions,
          }));
          break;
        }
        default:
          break;
      }
    });

    bridge.connect();

    // Poll health so a dead Python process is visible even if the socket is up.
    const health = await bridge.health();
    set({
      backendOk: Boolean(health),
      backendDetail: health ? null : 'no response from /health',
    });

    await Promise.all([get().refreshStatus(), get().refreshQuantum()]);
    await get().refreshLedger();
  },

  teardown() {
    unsubscribeSocket?.();
    unsubscribeStatus?.();
    bridge.disconnect();
    set({ booted: false });
  },

  // ------------------------------------------------------------------ refresh
  async refreshStatus() {
    const status_ = await bridge.callSafe<DeskStatus>('system.status');
    if (status_) {
      const reports: Partial<Record<AgentId, AgentReport>> = { ...get().reports };
      set({
        status_,
        agents: status_.agents ?? [],
        backendOk: true,
      });
    }
  },

  async refreshLedger() {
    const ledger = await bridge.callSafe<{ extinctions: ExtinctionRecord[] }>(
      'ledger.extinctions',
      { limit: 60 },
    );
    if (ledger?.extinctions) set({ extinctions: ledger.extinctions });
  },

  async refreshQuantum() {
    const quantum = await bridge.callSafe<QuantumStateResponse>('quantum.state');
    if (quantum) set({ quantum });
  },

  // -------------------------------------------------------------- view control
  focusAgent(agent) {
    set({ focusedAgent: agent });
    if (agent) {
      void bridge.callSafe('agents.report', { agent });
    }
  },

  cycleAgent(direction) {
    const current = get().focusedAgent;
    const idx = current ? AGENT_ORDER.indexOf(current) : -1;
    const nextIdx = (idx + direction + AGENT_ORDER.length) % AGENT_ORDER.length;
    get().focusAgent(AGENT_ORDER[nextIdx]);
  },

  // ------------------------------------------------------------------- actions
  async brief(intent = 'brief', symbol, speak = false) {
    set({ busy: `SUFFIX is collating (${intent})…` });
    try {
      const utterance = await bridge.call<Utterance>('desk.brief', { intent, symbol, speak });
      set((state) => ({
        transcript: [utterance, ...state.transcript].slice(0, MAX_TRANSCRIPT),
        busy: null,
      }));
      if (utterance.audio_b64) playBase64(utterance.audio_b64, set, utterance.utterance_id);
    } catch (err) {
      set({ busy: null });
      get().pushToast(`Brief failed: ${(err as Error).message}`, 'error');
    }
  },

  async propose(symbol) {
    set({ busy: 'SENTINEL is adjudicating…' });
    try {
      const result = await bridge.call<Record<string, any>>('desk.propose', { symbol });
      set({
        busy: null,
        lastVerdict: (result.verdict ?? null) as RiskVerdictRecord | null,
        lastExecution: (result.execution ?? null) as Record<string, any> | null,
      });
      const decision = result.verdict?.decision ?? result.status;
      if (decision === 'VETO') {
        const reason = result.verdict?.reasons?.[0] ?? 'risk check failed';
        get().pushToast(`SENTINEL VETO — ${reason}`, 'warn');
      } else if (result.execution?.status === 'FILLED') {
        get().pushToast(result.execution.message, 'ok');
      } else if (result.reason) {
        get().pushToast(result.reason, 'info');
      }
      await get().refreshStatus();
    } catch (err) {
      set({ busy: null });
      get().pushToast(`Proposal failed: ${(err as Error).message}`, 'error');
    }
  },

  async manualOrder(side, symbol) {
    set({ busy: `Routing ${side.toUpperCase()} through SENTINEL…` });
    try {
      const result = await bridge.call<Record<string, any>>('desk.manual_order', {
        symbol: symbol ?? get().frame?.nodes?.[0] ? get().config?.watchlist?.[0] : 'BTC-USD',
        side,
        leverage: get().config?.allowed_leverage?.[0] ?? 3,
        risk_pct: get().config?.risk_min_pct ?? 1.0,
      });
      set({
        busy: null,
        lastVerdict: (result.verdict ?? null) as RiskVerdictRecord | null,
        lastExecution: (result.execution ?? null) as Record<string, any> | null,
      });
      const verdict = result.verdict as RiskVerdictRecord | undefined;
      if (verdict?.decision === 'VETO') {
        get().pushToast(`VETO — ${verdict.reasons?.[0] ?? 'rejected'}`, 'warn');
      } else {
        get().pushToast(result.execution?.message ?? 'Order submitted', 'ok');
      }
      await get().refreshStatus();
    } catch (err) {
      set({ busy: null });
      get().pushToast(`Order failed: ${(err as Error).message}`, 'error');
    }
  },

  async command(text) {
    if (!text.trim()) return;
    set({ busy: 'SUFFIX is listening…' });
    try {
      const result = await bridge.call<Record<string, any>>('desk.command', {
        text,
        speak: false,
      });
      set({ busy: null });
      if (result.utterance) {
        const utterance = result.utterance as Utterance;
        set((state) => ({
          transcript: [utterance, ...state.transcript].slice(0, MAX_TRANSCRIPT),
        }));
      }
      if (result.intent) get().pushToast(`SUFFIX → ${String(result.intent).toUpperCase()}`, 'info');
      await get().refreshStatus();
    } catch (err) {
      set({ busy: null });
      get().pushToast(`Command failed: ${(err as Error).message}`, 'error');
    }
  },

  async flatten() {
    set({ busy: 'Flattening…' });
    try {
      const result = await bridge.call<{ closed: number }>('desk.flatten', { reason: 'UI' });
      get().pushToast(`Closed ${result.closed} position(s)`, 'warn');
      await get().refreshStatus();
    } finally {
      set({ busy: null });
    }
  },

  async killSwitch() {
    set({ busy: 'KILL SWITCH…' });
    try {
      const result = await bridge.call<{ closed: number }>('desk.kill_switch', {
        reason: 'UI_KILL_SWITCH',
      });
      get().pushToast(`Kill switch engaged — ${result.closed} closed`, 'error');
      await get().refreshStatus();
    } finally {
      set({ busy: null });
    }
  },

  async resume() {
    await bridge.callSafe('desk.resume');
    get().pushToast('Desk re-armed', 'ok');
    await get().refreshStatus();
  },

  async resetDesk() {
    set({ busy: 'Resetting to $100.00…' });
    try {
      await bridge.callSafe('desk.reset', { reason: 'UI reset' });
      get().pushToast('Desk reset to $100.00', 'warn');
      await get().refreshStatus();
    } finally {
      set({ busy: null });
    }
  },

  async runGeneration(trials) {
    set({ busy: 'QUANTUM is hunting strategies…' });
    try {
      const result = await bridge.call<Record<string, any>>(
        'quantum.run_generation',
        { trials: trials ?? null },
        { timeoutMs: 600_000 },
      );
      get().pushToast(
        `Generation ${result.generation}: ${result.promoted?.length ?? 0} promoted, ` +
          `${result.killed ?? 0} killed`,
        'info',
      );
      await get().refreshQuantum();
    } catch (err) {
      get().pushToast(`Generation failed: ${(err as Error).message}`, 'error');
    } finally {
      set({ busy: null });
    }
  },

  // -------------------------------------------------------------------- gesture
  setGesture(gesture, score, action = null) {
    set((state) => ({
      gestureName: gesture,
      gestureScore: score,
      gestureAction: action,
      gestureFlashes:
        action && gesture !== 'none'
          ? [{ gesture, action, ts: Date.now() }, ...state.gestureFlashes].slice(0, 12)
          : state.gestureFlashes,
    }));
  },

  setGestureEnabled(on) {
    set({ gestureEnabled: on });
    if (!on) set({ gestureName: 'none', gestureScore: 0 });
  },

  setListening(on, speaking = false, id = null) {
    set({ listening: on, speaking, speakingId: id });
  },

  pushToast(text, tone = 'info') {
    set({ toast: { text, tone } });
  },

  clearToast() {
    set({ toast: null });
  },
}));

// --------------------------------------------------------------------------- //
//  Audio helpers (outside the store so they never trigger a re-render)
// --------------------------------------------------------------------------- //
let currentAudio: HTMLAudioElement | null = null;

function playBase64(
  base64: string,
  set: (partial: Partial<DeskStore>) => void,
  id: string,
): void {
  try {
    currentAudio?.pause();
    const audio = new Audio(`data:audio/mpeg;base64,${base64}`);
    currentAudio = audio;
    set({ speaking: true, speakingId: id });
    audio.onended = () => set({ speaking: false, speakingId: null });
    audio.onerror = () => set({ speaking: false, speakingId: null });
    void audio.play().catch(() => set({ speaking: false, speakingId: null }));
  } catch {
    set({ speaking: false, speakingId: null });
  }
}

/**
 * Speak an utterance.
 *
 * Server-side Kokoro/ElevenLabs audio is preferred. When the sidecar is absent
 * we fall back to the browser SpeechSynthesis API so SUFFIX is never mute —
 * but we only auto-speak `alert` and `critical` priorities to avoid a wall of
 * chatter during normal briefings.
 */
async function speak(
  utterance: Utterance,
  set: (partial: Partial<DeskStore>) => void,
): Promise<void> {
  if (utterance.audio_b64) {
    playBase64(utterance.audio_b64, set, utterance.utterance_id);
    return;
  }
  const shouldAutoSpeak =
    utterance.priority === 'critical' || utterance.priority === 'alert';
  if (!shouldAutoSpeak) return;
  if (!('speechSynthesis' in window)) return;
  try {
    const text = (utterance.voice_text || utterance.text).slice(0, 900);
    const synth = window.speechSynthesis;
    synth.cancel();
    const line = new SpeechSynthesisUtterance(text);
    line.rate = 1.04;
    line.pitch = 0.92;
    line.onstart = () => set({ speaking: true, speakingId: utterance.utterance_id });
    line.onend = () => set({ speaking: false, speakingId: null });
    line.onerror = () => set({ speaking: false, speakingId: null });
    synth.speak(line);
  } catch {
    set({ speaking: false, speakingId: null });
  }
}

/** Synthesize arbitrary text through the server-side TTS chain. */
export async function speakText(
  text: string,
  set: (partial: Partial<DeskStore>) => void,
): Promise<void> {
  const result = await bridge.callSafe<{ ok: boolean; audio_b64?: string }>('voice.speak', {
    text,
  });
  if (result?.ok && result.audio_b64) {
    playBase64(result.audio_b64, set, 'manual');
    return;
  }
  if ('speechSynthesis' in window) {
    const line = new SpeechSynthesisUtterance(text.slice(0, 900));
    line.rate = 1.04;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(line);
  }
}

export { AGENT_ORDER, speakText as _speakText };
