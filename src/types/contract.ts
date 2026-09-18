/**
 * TypeScript mirror of `server/contracts.py`.
 *
 * These interfaces are the HUD's half of the wire contract. When a Python model
 * changes, change it here too — the JSON-RPC layer is deliberately untyped at
 * runtime, so this file is the only thing standing between a schema drift and a
 * silently blank telemetry node.
 */

export const AGENT_IDS = [
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
] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export type AgentStateName =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'vetoing'
  | 'error'
  | 'offline';

export type Bias = 'long' | 'short' | 'flat' | 'unclear';
export type DataQuality = 'live' | 'cached' | 'simulated' | 'partial';
export type RiskStateName = 'ARMED' | 'CAUTION' | 'CRITICAL' | 'FROZEN' | 'DEAD';
export type TradeSide = 'long' | 'short';
export type RiskDecision = 'APPROVE' | 'VETO' | 'RESIZE';
export type Priority = 'ambient' | 'briefing' | 'alert' | 'critical';

export interface AgentMetric {
  label: string;
  value: number | string;
  unit?: string;
  delta?: number | null;
  tone?: 'neutral' | 'bull' | 'bear' | 'warn' | 'critical';
}

export interface AgentReport {
  report_id: string;
  agent: AgentId;
  headline: string;
  bullets: string[];
  metrics: AgentMetric[];
  payload: Record<string, any>;
  confidence: number;
  bias: Bias;
  data_quality: DataQuality;
  latency_ms: number;
  sources: string[];
  ts: number;
}

export interface AgentStatus {
  agent: AgentId;
  designation: string;
  role: string;
  state: AgentStateName;
  load: number;
  confidence: number;
  last_report_ts: number | null;
  queue_depth: number;
  note: string;
}

export interface Utterance {
  utterance_id: string;
  speaker: AgentId;
  text: string;
  voice_text: string;
  priority: Priority;
  intent: string;
  trace: string[];
  reports: AgentReport[];
  audio_url?: string | null;
  audio_b64?: string | null;
  ts: number;
}

export interface RiskCheck {
  code: string;
  label: string;
  passed: boolean;
  detail: string;
  severity: 'info' | 'warn' | 'critical';
}

export interface Sizing {
  quantity: number;
  notional: number;
  required_leverage: number;
  applied_leverage: number;
  risk_usd: number;
  risk_pct: number;
  margin_usd: number;
  liquidation_price: number | null;
}

export interface TradeProposal {
  proposal_id: string;
  symbol: string;
  side: TradeSide;
  thesis: string;
  entry_price: number;
  stop_price: number;
  take_profit_price: number | null;
  risk_pct: number;
  leverage: number;
  quantity: number | null;
  timeframe: string;
  strategy_uid: string | null;
  origin: AgentId;
  confidence: number;
  meta: Record<string, any>;
  ts: number;
}

export interface RiskVerdictRecord {
  verdict_id: string;
  proposal_id: string;
  symbol: string;
  side: TradeSide;
  decision: RiskDecision;
  reasons: string[];
  checks: RiskCheck[];
  sizing: Sizing | null;
  adjusted: TradeProposal | null;
  approval_token: string | null;
  token_expires_ms: number | null;
  risk_state: RiskStateName;
  equity: number;
  balance: number;
  drawdown_pct: number;
  ts: number;
}

export interface Position {
  ticket: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  entry_price: number;
  stop_price: number;
  take_profit_price: number | null;
  leverage: number;
  strategy_uid: string | null;
  risk_usd: number;
  unrealized_pnl: number;
  unrealized_pct: number;
  liquidation_price: number | null;
  opened_ms: number;
  venue: string;
  meta: Record<string, any>;
}

export interface ExecutionReport {
  order_id: string;
  proposal_id: string;
  ticket: string | null;
  status: 'FILLED' | 'PARTIAL' | 'REJECTED' | 'CLOSED' | 'ERROR';
  venue: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  price: number;
  fees: number;
  slippage_usd: number;
  leverage: number;
  risk_usd: number;
  pnl: number | null;
  message: string;
  approval_token: string | null;
  ts: number;
}

export interface SentinelState {
  state: RiskStateName;
  armed: boolean;
  balance: number;
  equity: number;
  peak_equity: number;
  drawdown_pct: number;
  death_line: number;
  distance_to_death_usd: number;
  risk_budget_remaining_usd: number;
  daily_pnl: number;
  consecutive_losses: number;
  cooldown_until_ms: number | null;
  open_positions: number;
  vetoes_today: number;
  kills_today: number;
  last_verdict: RiskVerdictRecord | null;
  ts: number;
}

export interface BacktestMetrics {
  sharpe: number;
  sortino: number;
  profit_factor: number;
  total_return_pct: number;
  max_drawdown_pct: number;
  win_rate: number;
  trades: number;
  expectancy: number;
  exposure: number;
  cagr: number;
  liquidation_events: number;
  period_start: string | null;
  period_end: string | null;
  engine: string;
}

export interface StrategyRecord {
  strategy_uid: string;
  symbol: string;
  timeframe: string;
  kind: string;
  generation: number;
  genome: Record<string, any>;
  in_sample: BacktestMetrics;
  out_of_sample: BacktestMetrics;
  status: 'CANDIDATE' | 'PROMOTED' | 'ACTIVE' | 'EXTINCT' | 'BLACKLISTED';
  score: number;
  penalty: number;
  created_ms: number;
  promoted_ms: number | null;
  lifetime_trades: number;
  lifetime_pnl: number;
}

export interface GenerationState {
  generation: number;
  status: 'IDLE' | 'HUNTING' | 'EVALUATING' | 'TERMINATED';
  trials_completed: number;
  trials_total: number;
  best_score: number;
  best_uid: string | null;
  active_strategies: number;
  extinct_total: number;
  blacklisted_total: number;
  loss_streak: number;
  loss_pressure: number;
  penalty_k: number;
  symbol: string;
  timeframe: string;
  engine: string;
  last_action: string;
  ts: number;
}

export interface TelemetryNode {
  agent: AgentId;
  designation: string;
  angle_deg: number;
  value: number;
  confidence: number;
  load: number;
  state: string;
  series: number[];
  label: string;
  headline: string;
  bias: Bias;
}

export interface TelemetryFrame {
  frame_id: number;
  ts: number;
  nodes: TelemetryNode[];
  equity: number;
  balance: number;
  drawdown_pct: number;
  risk_state: RiskStateName;
  daily_pnl: number;
  quantum: GenerationState | null;
  fps: number;
  voices: number;
  latency_ms: number;
}

export interface DeskEvent {
  event_id: string;
  channel:
    | 'system'
    | 'agent'
    | 'risk'
    | 'order'
    | 'quantum'
    | 'ledger'
    | 'gesture'
    | 'voice';
  level: 'debug' | 'info' | 'warn' | 'error' | 'critical';
  title: string;
  detail: string;
  payload: Record<string, any>;
  ts: number;
}

export interface ExtinctionRecord {
  strategy_uid: string;
  symbol: string;
  reason:
    | 'DEATH_LINE'
    | 'PERFORMANCE_GATE'
    | 'MUTATED_OUT'
    | 'MANUAL'
    | 'GENERATION_TERMINATED';
  detail: string;
  sharpe: number;
  profit_factor: number;
  generation: number;
  genome: Record<string, any>;
  ts: number;
}

export interface TradeRecord {
  trade_id: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  entry_price: number;
  exit_price: number | null;
  pnl: number;
  pnl_pct: number;
  fees: number;
  leverage: number;
  strategy_uid: string | null;
  opened_ms: number;
  closed_ms: number | null;
  status: 'OPEN' | 'CLOSED' | 'STOPPED' | 'TAKEPROFIT' | 'KILLED';
  thesis: string;
}

export interface PublicConfig {
  version: string;
  codename: string;
  tagline: string;
  execution_mode: string;
  starting_capital: number;
  death_line: number;
  risk_min_pct: number;
  risk_max_pct: number;
  risk_min_usd: number;
  risk_max_usd: number;
  absolute_risk_ceiling: number;
  allowed_leverage: number[];
  max_concurrent_positions: number;
  daily_loss_limit_usd: number;
  daily_loss_limit_pct: number;
  consecutive_loss_cooldown: number;
  min_sharpe: number;
  min_profit_factor: number;
  mutation_generations: number;
  paper_fee_bps: number;
  paper_slippage_bps: number;
  watchlist: string[];
  quantum: {
    enabled: boolean;
    timeframe: string;
    study: string;
    trials_per_generation: number;
    background_interval_sec: number;
  };
  sidecars: {
    stt: string;
    tts: string;
    finnhub_configured: boolean;
    binance_testnet_configured: boolean;
    tradingview_mcp: boolean;
  };
}

export interface DeskStatus {
  version: string;
  codename: string;
  tagline: string;
  uptime_seconds: number;
  paused: boolean;
  execution_mode: string;
  account: {
    balance: number;
    equity: number;
    starting_capital: number;
    peak_equity: number;
    unrealized_pnl: number;
    realized_pnl: number;
    margin_used: number;
    free_margin: number;
    return_pct: number;
    drawdown_pct: number;
    death_line: number;
    mode: string;
  };
  positions: Position[];
  sentinel: SentinelState;
  agents: AgentStatus[];
  quantum: GenerationState;
  mcp: { enabled: boolean; status: string; tools: number; last_error: string | null };
  sandbox: { runs: number; failures: number; timeout_sec: number; max_bars: number };
  subscribers: number;
}

export interface QuantumStateResponse {
  state: GenerationState;
  engine: {
    optuna: { available: boolean; version: string };
    vectorbt: { available: boolean; version: string };
    sampler: string;
    gates: {
      min_sharpe: number;
      min_profit_factor: number;
      min_oos_trades: number;
      walk_forward_windows: number;
    };
    directive: {
      generations: number;
      penalty_base_k: number;
      risk_band_pct: [number, number];
      leverage: number[];
      death_line: number;
    };
    pressure: {
      loss_streak: number;
      k: number;
      decay: number;
      tightened: Record<string, number>;
    };
  };
  active: StrategyRecord[];
  history: Array<Record<string, any>>;
  registry_size: number;
  blacklist: string[];
}

/** A gesture the desk acted on, for the overlay's action log. */
export interface GestureFlash {
  gesture: GestureName;
  action: string;
  ts: number;
}

/** Hand gestures emitted by the MediaPipe engine. */
export type GestureName =
  | 'open_palm'
  | 'closed_fist'
  | 'swipe_left'
  | 'swipe_right'
  | 'pinch'
  | 'thumbs_up'
  | 'thumbs_down'
  | 'victory'
  | 'none';

/** Server-side JSON-RPC envelope. */
export interface RpcResponse<T = any> {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: T;
  error?: { code: number; message: string; data?: Record<string, any> };
}

/** WebSocket push frames. */
export type SocketMessage =
  | {
      type: 'handshake';
      version: string;
      directive: PublicConfig;
      methods: string[];
      telemetry: TelemetryFrame;
    }
  | { type: 'telemetry'; frame: TelemetryFrame }
  | { type: 'utterance'; utterance: Utterance; rubric?: Record<string, any> }
  | { type: 'event'; event: DeskEvent }
  | { type: 'ack'; received: string };

export const AGENT_META: Record<
  AgentId,
  { designation: string; role: string; designationIndex: number; blurb: string }
> = {
  atlas: {
    designation: 'ATLAS',
    role: 'MACRO',
    designationIndex: 1,
    blurb: 'Global rates, inflation prints and Country Instability Index.',
  },
  scout: {
    designation: 'SCOUT',
    role: 'NEWS / SENTIMENT',
    designationIndex: 2,
    blurb: 'Finnhub headline ingest and velocity scoring.',
  },
  capitol: {
    designation: 'CAPITOL',
    role: 'SMART MONEY',
    designationIndex: 3,
    blurb: '13F institutional disclosures and insider transactions.',
  },
  athena: {
    designation: 'ATHENA',
    role: 'FUNDAMENTALS',
    designationIndex: 4,
    blurb: 'Balance sheets, valuation multiples and quality scores.',
  },
  chartist: {
    designation: 'CHARTIST',
    role: 'TECHNICIAN',
    designationIndex: 5,
    blurb: 'TradingView Desktop control via the local MCP server.',
  },
  oracle: {
    designation: 'ORACLE',
    role: 'QUANT',
    designationIndex: 6,
    blurb: 'Bootstrap probability distributions and expected value.',
  },
  sentinel: {
    designation: 'SENTINEL',
    role: 'RISK OFFICER',
    designationIndex: 7,
    blurb: 'Unilateral VETO. Enforces the $100 limit and stops.',
  },
  pilot: {
    designation: 'PILOT',
    role: 'EXECUTION',
    designationIndex: 8,
    blurb: 'Routes approved orders to Binance paper / testnet.',
  },
  ledger: {
    designation: 'LEDGER',
    role: 'THE BOOK',
    designationIndex: 9,
    blurb: 'SQLite journal of wins, losses and strategy extinctions.',
  },
  quantum: {
    designation: 'QUANTUM',
    role: 'SELF-LEARNING',
    designationIndex: 11,
    blurb: 'Optuna + vectorbt strategy evolution across 50 generations.',
  },
};

export const RISK_STATE_STYLE: Record<
  RiskStateName,
  { text: string; ring: string; glow: string; label: string }
> = {
  ARMED: {
    text: 'text-bull',
    ring: 'ring-bull/40',
    glow: 'shadow-[0_0_40px_-10px_rgba(34,197,94,0.7)]',
    label: 'ARMED',
  },
  CAUTION: {
    text: 'text-caution',
    ring: 'ring-caution/40',
    glow: 'shadow-[0_0_40px_-10px_rgba(245,158,11,0.7)]',
    label: 'CAUTION',
  },
  CRITICAL: {
    text: 'text-critical',
    ring: 'ring-critical/50',
    glow: 'shadow-[0_0_50px_-8px_rgba(244,63,94,0.8)]',
    label: 'CRITICAL',
  },
  FROZEN: {
    text: 'text-plasma-400',
    ring: 'ring-plasma-500/50',
    glow: 'shadow-[0_0_50px_-8px_rgba(139,92,246,0.8)]',
    label: 'FROZEN',
  },
  DEAD: {
    text: 'text-bear',
    ring: 'ring-bear/60',
    glow: 'shadow-[0_0_60px_-6px_rgba(239,68,68,0.9)]',
    label: 'DEAD',
  },
};
