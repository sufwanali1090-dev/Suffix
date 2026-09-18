"""Wire contracts shared by the Python agents, the FastAPI bridge and the HUD.

Everything that crosses the Node <-> Python boundary is a Pydantic model defined
here, so the JSON-RPC surface is typed, validated and self-documenting.
``src/types/contract.ts`` mirrors these shapes for the renderer.
"""

from __future__ import annotations

import time
import uuid
from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


# --------------------------------------------------------------------------- #
#  Agent identity
# --------------------------------------------------------------------------- #
class AgentId(str, Enum):
    ATLAS = "atlas"          # 1  Macro
    SCOUT = "scout"          # 2  News / Sentiment
    CAPITOL = "capitol"      # 3  Smart money (13F / insider)
    ATHENA = "athena"        # 4  Fundamentals
    CHARTIST = "chartist"    # 5  Technician (TradingView MCP)
    ORACLE = "oracle"        # 6  Quant probabilities / EV
    SENTINEL = "sentinel"    # 7  Risk officer (VETO)
    PILOT = "pilot"          # 8  Execution
    LEDGER = "ledger"        # 9  The book (SQLite journal)
    SUFFIX = "suffix"        # 10 Master voice / orchestrator
    QUANTUM = "quantum"      # 11 Self-learning hedge fund


AgentRole = Literal["macro", "news", "flows", "fundamental", "technical",
                    "quant", "risk", "execution", "book", "orchestrator",
                    "research"]

DataQuality = Literal["live", "cached", "simulated", "partial"]


def _uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def now_ms() -> int:
    return int(time.time() * 1000)


# --------------------------------------------------------------------------- #
#  Agent reporting
# --------------------------------------------------------------------------- #
class AgentMetric(BaseModel):
    label: str
    value: float | str
    unit: str = ""
    delta: Optional[float] = None
    tone: Literal["neutral", "bull", "bear", "warn", "critical"] = "neutral"


class AgentReport(BaseModel):
    """A single agent's structured answer.  Never shown raw to the user —
    SUFFIX (agent 10) is the only voice; it collates these into an utterance."""

    model_config = ConfigDict(use_enum_values=True)

    report_id: str = Field(default_factory=lambda: _uid("rpt"))
    agent: AgentId
    headline: str
    bullets: List[str] = Field(default_factory=list)
    metrics: List[AgentMetric] = Field(default_factory=list)
    payload: Dict[str, Any] = Field(default_factory=dict)
    confidence: float = 0.5          # 0..1
    bias: Literal["long", "short", "flat", "unclear"] = "unclear"
    data_quality: DataQuality = "simulated"
    latency_ms: int = 0
    sources: List[str] = Field(default_factory=list)
    ts: int = Field(default_factory=now_ms)

    @field_validator("confidence")
    @classmethod
    def _clamp(cls, v: float) -> float:
        return max(0.0, min(1.0, float(v)))


class AgentStatus(BaseModel):
    agent: AgentId
    designation: str
    role: str
    state: Literal["idle", "thinking", "streaming", "vetoing", "error", "offline"] = "idle"
    load: float = 0.0                # 0..1 — drives radial node intensity
    confidence: float = 0.5
    last_report_ts: Optional[int] = None
    queue_depth: int = 0
    note: str = ""


# --------------------------------------------------------------------------- #
#  The single voice
# --------------------------------------------------------------------------- #
class Utterance(BaseModel):
    """SUFFIX speaking.  ``voice_text`` is what TTS renders; ``trace`` is the
    reasoning provenance surfaced in the HUD transcript."""

    utterance_id: str = Field(default_factory=lambda: _uid("say"))
    speaker: AgentId = AgentId.SUFFIX
    text: str
    voice_text: str = ""
    priority: Literal["ambient", "briefing", "alert", "critical"] = "briefing"
    intent: str = "status"
    trace: List[str] = Field(default_factory=list)
    reports: List[AgentReport] = Field(default_factory=list)
    audio_url: Optional[str] = None
    audio_b64: Optional[str] = None
    ts: int = Field(default_factory=now_ms)


# --------------------------------------------------------------------------- #
#  Risk / Sentinel
# --------------------------------------------------------------------------- #
class TradeSide(str, Enum):
    LONG = "long"
    SHORT = "short"


class StopType(str, Enum):
    PRICE = "price"
    ATR = "atr"
    PCT = "pct"
    TRAILING = "trailing"


class TradeProposal(BaseModel):
    """What an agent *wants* to do.  SENTINEL may VETO it; PILOT may not act
    on it until a signed approval token exists."""

    proposal_id: str = Field(default_factory=lambda: _uid("prp"))
    symbol: str
    side: TradeSide
    thesis: str = ""
    entry_price: float
    stop_price: float
    take_profit_price: Optional[float] = None
    risk_pct: float = 1.0                 # must live in [risk_min_pct, risk_max_pct]
    leverage: int = 3                     # must be in {3,5,10}
    quantity: Optional[float] = None      # filled by SENTINEL sizing
    timeframe: str = "1h"
    strategy_uid: Optional[str] = None    # provenance -> QUANTUM genome
    origin: AgentId = AgentId.ORACLE
    confidence: float = 0.5
    meta: Dict[str, Any] = Field(default_factory=dict)
    ts: int = Field(default_factory=now_ms)

    @property
    def stop_distance(self) -> float:
        return abs(self.entry_price - self.stop_price)

    @property
    def stop_distance_pct(self) -> float:
        if self.entry_price <= 0:
            return 0.0
        return self.stop_distance / self.entry_price * 100.0

    def risk_per_unit(self) -> float:
        return self.stop_distance


class RiskVerdict(str, Enum):
    APPROVE = "APPROVE"
    VETO = "VETO"
    RESIZE = "RESIZE"


class RiskCheck(BaseModel):
    code: str
    label: str
    passed: bool
    detail: str = ""
    severity: Literal["info", "warn", "critical"] = "info"


class Sizing(BaseModel):
    quantity: float
    notional: float
    required_leverage: float
    applied_leverage: int
    risk_usd: float
    risk_pct: float
    margin_usd: float
    liquidation_price: Optional[float] = None


class RiskVerdictRecord(BaseModel):
    model_config = ConfigDict(use_enum_values=True)

    verdict_id: str = Field(default_factory=lambda: _uid("vet"))
    proposal_id: str
    symbol: str
    side: TradeSide
    decision: RiskVerdict
    reasons: List[str] = Field(default_factory=list)
    checks: List[RiskCheck] = Field(default_factory=list)
    sizing: Optional[Sizing] = None
    adjusted: Optional[TradeProposal] = None
    approval_token: Optional[str] = None
    token_expires_ms: Optional[int] = None
    risk_state: str = "ARMED"
    equity: float = 0.0
    balance: float = 0.0
    drawdown_pct: float = 0.0
    ts: int = Field(default_factory=now_ms)


class SentinelState(BaseModel):
    state: Literal["ARMED", "CAUTION", "CRITICAL", "FROZEN", "DEAD"] = "ARMED"
    armed: bool = True
    balance: float
    equity: float
    peak_equity: float
    drawdown_pct: float
    death_line: float
    distance_to_death_usd: float
    risk_budget_remaining_usd: float
    daily_pnl: float
    consecutive_losses: int
    cooldown_until_ms: Optional[int] = None
    open_positions: int = 0
    vetoes_today: int = 0
    kills_today: int = 0
    last_verdict: Optional[RiskVerdictRecord] = None
    ts: int = Field(default_factory=now_ms)


# --------------------------------------------------------------------------- #
#  Execution / book
# --------------------------------------------------------------------------- #
class Fill(BaseModel):
    fill_id: str = Field(default_factory=lambda: _uid("fil"))
    price: float
    quantity: float
    fees: float
    slippage_usd: float
    ts: int = Field(default_factory=now_ms)


class Position(BaseModel):
    ticket: str = Field(default_factory=lambda: _uid("tkt"))
    symbol: str
    side: TradeSide
    quantity: float
    entry_price: float
    stop_price: float
    take_profit_price: Optional[float] = None
    leverage: int
    strategy_uid: Optional[str] = None
    risk_usd: float = 0.0
    unrealized_pnl: float = 0.0
    unrealized_pct: float = 0.0
    liquidation_price: Optional[float] = None
    opened_ms: int = Field(default_factory=now_ms)
    fills: List[Fill] = Field(default_factory=list)
    venue: str = "paper"
    meta: Dict[str, Any] = Field(default_factory=dict)


class ExecutionReport(BaseModel):
    order_id: str = Field(default_factory=lambda: _uid("ord"))
    proposal_id: str
    ticket: Optional[str] = None
    status: Literal["FILLED", "PARTIAL", "REJECTED", "CLOSED", "ERROR"] = "FILLED"
    venue: str = "paper"
    symbol: str
    side: TradeSide
    quantity: float = 0.0
    price: float = 0.0
    fees: float = 0.0
    slippage_usd: float = 0.0
    leverage: int = 3
    risk_usd: float = 0.0
    pnl: Optional[float] = None
    message: str = ""
    approval_token: Optional[str] = None
    ts: int = Field(default_factory=now_ms)


class AccountState(BaseModel):
    balance: float
    equity: float
    starting_capital: float
    peak_equity: float
    unrealized_pnl: float = 0.0
    realized_pnl: float = 0.0
    margin_used: float = 0.0
    free_margin: float = 0.0
    return_pct: float = 0.0
    drawdown_pct: float = 0.0
    death_line: float = 0.0
    open_positions: List[Position] = Field(default_factory=list)
    mode: str = "paper"
    ts: int = Field(default_factory=now_ms)


class TradeRecord(BaseModel):
    trade_id: str
    symbol: str
    side: TradeSide
    quantity: float
    entry_price: float
    exit_price: Optional[float] = None
    pnl: float = 0.0
    pnl_pct: float = 0.0
    fees: float = 0.0
    leverage: int = 3
    strategy_uid: Optional[str] = None
    opened_ms: int = 0
    closed_ms: Optional[int] = None
    status: Literal["OPEN", "CLOSED", "STOPPED", "TAKEPROFIT", "KILLED"] = "OPEN"
    thesis: str = ""


class ExtinctionRecord(BaseModel):
    """A strategy that the Do-or-Die protocol put in the ground."""

    strategy_uid: str
    symbol: str
    reason: Literal["DEATH_LINE", "PERFORMANCE_GATE", "MUTATED_OUT", "MANUAL", "GENERATION_TERMINATED"]
    detail: str = ""
    sharpe: float = 0.0
    profit_factor: float = 0.0
    generation: int = 0
    genome: Dict[str, Any] = Field(default_factory=dict)
    ts: int = Field(default_factory=now_ms)


# --------------------------------------------------------------------------- #
#  Quantum telemetry
# --------------------------------------------------------------------------- #
class BacktestMetrics(BaseModel):
    sharpe: float = 0.0
    sortino: float = 0.0
    profit_factor: float = 0.0
    total_return_pct: float = 0.0
    max_drawdown_pct: float = 0.0
    win_rate: float = 0.0
    trades: int = 0
    expectancy: float = 0.0
    exposure: float = 0.0
    cagr: float = 0.0
    liquidation_events: int = 0
    period_start: Optional[str] = None
    period_end: Optional[str] = None
    engine: str = "native"


class StrategyRecord(BaseModel):
    strategy_uid: str
    symbol: str
    timeframe: str
    kind: str
    generation: int
    genome: Dict[str, Any]
    in_sample: BacktestMetrics
    out_of_sample: BacktestMetrics
    status: Literal["CANDIDATE", "PROMOTED", "ACTIVE", "EXTINCT", "BLACKLISTED"] = "CANDIDATE"
    score: float = 0.0
    penalty: float = 1.0
    created_ms: int = Field(default_factory=now_ms)
    promoted_ms: Optional[int] = None
    lifetime_trades: int = 0
    lifetime_pnl: float = 0.0


class GenerationState(BaseModel):
    generation: int = 0
    status: Literal["IDLE", "HUNTING", "EVALUATING", "TERMINATED"] = "IDLE"
    trials_completed: int = 0
    trials_total: int = 0
    best_score: float = 0.0
    best_uid: Optional[str] = None
    active_strategies: int = 0
    extinct_total: int = 0
    blacklisted_total: int = 0
    loss_streak: int = 0
    loss_pressure: float = 0.0
    penalty_k: float = 0.0
    symbol: str = ""
    timeframe: str = "1h"
    engine: str = "native"
    last_action: str = ""
    ts: int = Field(default_factory=now_ms)


# --------------------------------------------------------------------------- #
#  Telemetry frames for the cinematic HUD
# --------------------------------------------------------------------------- #
class TelemetryNode(BaseModel):
    """One of the 10 radial telemetry nodes orbiting the SUFFIX orb."""

    agent: AgentId
    designation: str
    angle_deg: float = 0.0
    value: float = 0.0            # 0..1 primary meter
    confidence: float = 0.5
    load: float = 0.0
    state: str = "idle"
    series: List[float] = Field(default_factory=list)   # sparkline, last N points
    label: str = ""
    headline: str = ""
    bias: str = "unclear"


class TelemetryFrame(BaseModel):
    frame_id: int = 0
    ts: int = Field(default_factory=now_ms)
    nodes: List[TelemetryNode] = Field(default_factory=list)
    equity: float = 100.0
    balance: float = 100.0
    drawdown_pct: float = 0.0
    risk_state: str = "ARMED"
    daily_pnl: float = 0.0
    quantum: Optional[GenerationState] = None
    fps: float = 0.0
    voices: int = 0
    latency_ms: float = 0.0


class DeskEvent(BaseModel):
    event_id: str = Field(default_factory=lambda: _uid("evt"))
    channel: Literal["system", "agent", "risk", "order", "quantum", "ledger", "gesture", "voice"]
    level: Literal["debug", "info", "warn", "error", "critical"] = "info"
    title: str
    detail: str = ""
    payload: Dict[str, Any] = Field(default_factory=dict)
    ts: int = Field(default_factory=now_ms)


class RpcError(BaseModel):
    code: int
    message: str
    data: Dict[str, Any] = Field(default_factory=dict)


class RpcRequest(BaseModel):
    jsonrpc: Literal["2.0"] = "2.0"
    id: Optional[int | str] = None
    method: str
    params: Dict[str, Any] = Field(default_factory=dict)


class RpcResponse(BaseModel):
    jsonrpc: Literal["2.0"] = "2.0"
    id: Optional[int | str] = None
    result: Optional[Dict[str, Any] | List[Any] | str | float | int | bool | None] = None
    error: Optional[RpcError] = None


# Earliest request in the JSON-RPC surface — kept for parity with the TS client.
JSONRPC_VERSION = "2.0"
