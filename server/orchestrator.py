"""Agent 10 — SUFFIX (Master Voice / Orchestrator).

*"Nine agents, one voice."*  SUFFIX is the **only** agent that ever addresses the
user.  Everything else is a specialist that reports inward.

Responsibilities
----------------
1. **Fan-out**   — dispatch a request to the relevant specialists concurrently.
2. **Rubric**    — weight each report by role, confidence and freshness into one
                   directional score plus a consensus/divergence flag.
3. **Composition** — turn structured reports into a single spoken briefing.  The
                   composer is deterministic (no LLM in the hot path): the desk
                   must be able to justify every sentence it says.
4. **Proposal synthesis** — build a TradeProposal from ORACLE's brackets gated by
                   CHARTIST's regime and the macro/sentiment checks.
5. **Dispatch**  — hand the proposal to SENTINEL, and on APPROVE hand the signed
                   verdict to PILOT. Nothing bypasses this path.
6. **Telemetry** — assemble the frame the cinematic HUD renders at 60fps.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
from collections import deque
from typing import Any, Awaitable, Callable, Deque, Dict, List, Optional, Tuple

import numpy as np

from server.agents import (
    AtlasMacro, AthenaFundamentals, CapitolFlows, ChartistTechnician,
    DeskContext, OracleQuant, ScoutNews,
)
from server.agents_ops import LedgerBook, PilotExecution, QuantumResearch, SentinelRisk
from server.broker import PaperBroker, Pilot, Sentinel
from server.config import settings
from server.contracts import (
    AgentId, AgentReport, AgentStatus, DeskEvent, GenerationState, RiskVerdict,
    TelemetryFrame, TelemetryNode, TradeProposal, TradeSide, Utterance, now_ms,
)
from server.ledger import get_ledger
from server.mcp_tradingview import TradingViewMCP
from server.providers.backtester import StrategySandbox

log = logging.getLogger("suffix.orchestrator")

# Role weights per intent.  The orchestrator, not any single agent, decides how
# much each voice matters for a given question.
INTENT_WEIGHTS: Dict[str, Dict[AgentId, float]] = {
    "brief": {
        AgentId.ATLAS: 1.00, AgentId.SCOUT: 1.00, AgentId.CAPITOL: 0.85,
        AgentId.ATHENA: 0.85, AgentId.CHARTIST: 1.25, AgentId.ORACLE: 1.30,
        AgentId.SENTINEL: 1.60, AgentId.QUANTUM: 1.10, AgentId.LEDGER: 0.70,
        AgentId.PILOT: 0.80,
    },
    "trade": {
        AgentId.ORACLE: 1.60, AgentId.CHARTIST: 1.35, AgentId.SENTINEL: 2.20,
        AgentId.QUANTUM: 1.20, AgentId.ATLAS: 0.80, AgentId.SCOUT: 0.75,
        AgentId.LEDGER: 0.60,
    },
    "risk": {
        AgentId.SENTINEL: 2.60, AgentId.LEDGER: 1.10, AgentId.PILOT: 1.00,
        AgentId.ORACLE: 0.80, AgentId.QUANTUM: 0.70,
    },
    "macro": {
        AgentId.ATLAS: 1.70, AgentId.CAPITOL: 0.90, AgentId.SCOUT: 0.90,
        AgentId.ATHENA: 0.60,
    },
    "technical": {
        AgentId.CHARTIST: 2.10, AgentId.ORACLE: 1.20, AgentId.QUANTUM: 0.90,
    },
    "quantum": {
        AgentId.QUANTUM: 2.30, AgentId.ORACLE: 1.10, AgentId.LEDGER: 0.80,
    },
    "status": {
        AgentId.SENTINEL: 1.50, AgentId.PILOT: 1.20, AgentId.LEDGER: 1.10,
        AgentId.QUANTUM: 1.00,
    },
}

INTENT_AGENT_SETS: Dict[str, List[AgentId]] = {
    "brief": [AgentId.ATLAS, AgentId.SCOUT, AgentId.CAPITOL, AgentId.ATHENA,
              AgentId.CHARTIST, AgentId.ORACLE, AgentId.SENTINEL, AgentId.PILOT,
              AgentId.LEDGER, AgentId.QUANTUM],
    "trade": [AgentId.CHARTIST, AgentId.ORACLE, AgentId.SENTINEL, AgentId.QUANTUM,
              AgentId.LEDGER],
    "risk": [AgentId.SENTINEL, AgentId.PILOT, AgentId.LEDGER, AgentId.QUANTUM],
    "macro": [AgentId.ATLAS, AgentId.SCOUT, AgentId.CAPITOL, AgentId.SENTINEL],
    "technical": [AgentId.CHARTIST, AgentId.ORACLE, AgentId.QUANTUM, AgentId.SENTINEL],
    "quantum": [AgentId.QUANTUM, AgentId.ORACLE, AgentId.LEDGER],
    "status": [AgentId.SENTINEL, AgentId.PILOT, AgentId.LEDGER, AgentId.QUANTUM],
    "full": [AgentId.ATLAS, AgentId.SCOUT, AgentId.CAPITOL, AgentId.ATHENA,
             AgentId.CHARTIST, AgentId.ORACLE, AgentId.SENTINEL, AgentId.PILOT,
             AgentId.LEDGER, AgentId.QUANTUM],
}

BIAS_SIGN = {"long": 1.0, "short": -1.0, "flat": 0.0, "unclear": 0.0}

SYMBOL_RE = re.compile(r"\b([A-Z]{2,6}(?:-USD)?|BTC|ETH|SOL)\b")


def _agent_key(agent: Any) -> str:
    """Normalize an agent reference to its lowercase string key.

    ``AgentReport`` is declared with ``use_enum_values=True``, so a report's
    ``agent`` field arrives as a plain ``str`` while the orchestrator's internal
    maps are keyed by ``AgentId``. Because ``AgentId`` is a ``str``-mixin enum
    the two hash identically and dict lookups agree — but attribute access like
    ``agent.value`` does not. Always go through this helper.
    """
    if isinstance(agent, AgentId):
        return agent.value
    return str(agent).lower()


# =========================================================================== #
#  Orchestrator
# =========================================================================== #
class SuffixOrchestrator:
    """Owns the desk.  One instance per process, wired in ``server.main``."""

    def __init__(self) -> None:
        self.ledger = get_ledger()
        self.broker = PaperBroker()
        self.sentinel = Sentinel(self.broker)
        self.pilot = Pilot(self.broker, self.sentinel)
        self.mcp = TradingViewMCP()
        self.sandbox = StrategySandbox()

        from server.quantum import get_engine

        self.engine = get_engine()

        self.ctx = DeskContext(
            broker=self.broker, sentinel=self.sentinel, pilot=self.pilot,
            engine=self.engine, mcp=self.mcp, watchlist=settings.watchlist,
            symbol=settings.watchlist[0] if settings.watchlist else "BTC-USD",
            timeframe=settings.suffix_quantum_timeframe,
        )

        # Specialist roster
        self.agents: Dict[AgentId, Any] = {
            AgentId.ATLAS: AtlasMacro(),
            AgentId.SCOUT: ScoutNews(),
            AgentId.CAPITOL: CapitolFlows(),
            AgentId.ATHENA: AthenaFundamentals(),
            AgentId.CHARTIST: ChartistTechnician(),
            AgentId.ORACLE: OracleQuant(),
            AgentId.SENTINEL: SentinelRisk(),
            AgentId.PILOT: PilotExecution(),
            AgentId.LEDGER: LedgerBook(),
            AgentId.QUANTUM: QuantumResearch(),
        }

        # Runtime state
        self.last_reports: Dict[AgentId, AgentReport] = {}
        self.agent_state: Dict[AgentId, AgentStatus] = {
            a: AgentStatus(agent=a, designation=getattr(impl, "designation", a.value.upper()),
                           role=getattr(impl, "role", "analyst"))
            for a, impl in self.agents.items()
        }
        self.utterances: Deque[Utterance] = deque(maxlen=200)
        self.events: Deque[DeskEvent] = deque(maxlen=600)
        self.subscribers: List[Callable[[Dict[str, Any]], Awaitable[None]]] = []
        self.frame_id = 0
        self.paused = False
        self.listeners = 0
        self.tick_task: Optional[asyncio.Task] = None
        self._busy = asyncio.Lock()

        # Wire the death line to the evolutionary loop.
        self.broker.kill_hook = self._on_death_line
        self.engine.extinction_cb = lambda payload: self.emit_event(
            "quantum", "warn", "Strategy EXTINCT",
            f"{payload['strategy_uid']} [{payload['reason']}] {payload.get('detail', '')[:140]}",
            payload)

    # ------------------------------------------------------------------ events
    def emit_event(self, channel: str, level: str, title: str,
                   detail: str = "", payload: Optional[Dict[str, Any]] = None) -> DeskEvent:
        event = DeskEvent(channel=channel, level=level, title=title, detail=detail,
                          payload=payload or {})  # type: ignore[arg-type]
        self.events.append(event)
        try:
            self.ledger.record_event(event.model_dump(mode="json"))
        except Exception:  # noqa: BLE001
            pass

        message = {"type": "event", "event": event.model_dump(mode="json")}
        try:
            # Fast path: we are on the event loop already.
            asyncio.get_running_loop().create_task(self._broadcast(message))
        except RuntimeError:
            # Slow path: emitted from the QUANTUM worker thread (or another
            # non-async context), where there is no running loop. Hand the
            # coroutine to the loop captured at startup instead of dropping it.
            loop = getattr(self, "_loop", None)
            if loop is not None and loop.is_running():
                try:
                    asyncio.run_coroutine_threadsafe(self._broadcast(message), loop)
                except Exception:  # noqa: BLE001
                    pass
        return event

    async def _broadcast(self, message: Dict[str, Any]) -> None:
        if not self.subscribers:
            return
        dead: List[Callable] = []
        for cb in list(self.subscribers):
            try:
                await cb(message)
            except Exception:  # noqa: BLE001
                dead.append(cb)
        for cb in dead:
            if cb in self.subscribers:
                self.subscribers.remove(cb)

    def subscribe(self, cb: Callable[[Dict[str, Any]], Awaitable[None]]) -> None:
        self.subscribers.append(cb)

    def unsubscribe(self, cb: Callable[[Dict[str, Any]], Awaitable[None]]) -> None:
        if cb in self.subscribers:
            self.subscribers.remove(cb)

    # ---------------------------------------------------------------- lifecycle
    async def startup(self) -> None:
        # Captured so non-async producers (QUANTUM's worker thread, MCP callbacks)
        # can schedule broadcasts onto the loop that actually owns the sockets.
        self._loop: asyncio.AbstractEventLoop = asyncio.get_running_loop()
        log.info("SUFFIX %s coming online — mode=%s capital=$%.2f death_line=$%.2f",
                 settings.suffix_version, settings.suffix_execution_mode,
                 settings.suffix_starting_capital, settings.suffix_death_line)
        if settings.suffix_attach_mcp:
            result = await self.mcp.attach()
            self.emit_event("system", "info" if result.get("status") == "attached" else "warn",
                            "TradingView MCP", f"status: {result.get('status')}", result)
        if settings.suffix_quantum_enabled and settings.suffix_auto_launch_quantum_worker:
            await asyncio.to_thread(self.engine.load_blacklist_from_ledger)
            self.engine.start_background()
            self.emit_event("quantum", "info", "QUANTUM worker online",
                            f"engine {self.engine.generation.engine}")
        self.tick_task = asyncio.create_task(self._heartbeat())
        self.emit_event("system", "info", "Desk online",
                        f"{len(self.agents)} specialists reporting to SUFFIX; "
                        f"{settings.suffix_execution_mode} venue armed at ${settings.suffix_starting_capital:.2f}.")

    async def shutdown(self) -> None:
        if self.tick_task:
            self.tick_task.cancel()
            try:
                await self.tick_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        await self.engine.stop_background()
        await self.mcp.detach()
        self.sandbox.shutdown()
        log.info("SUFFIX offline")

    def _on_death_line(self, equity: float, cause: str) -> None:
        """Broker hook: -20% drawdown kills the generation and freezes the desk."""
        self.emit_event("risk", "critical", "DEATH LINE BREACHED",
                        f"Equity ${equity:.2f} <= ${settings.suffix_death_line:.2f}. "
                        f"{cause}. Active generation terminated.", {"equity": equity})
        result = self.engine.kill_generation("DEATH_LINE", cause)
        self.emit_event("quantum", "critical", "Generation terminated",
                        f"{result['count']} strategies killed and blacklisted.",
                        result)
        utterance = Utterance(
            text=(f"Death line. Equity is ${equity:,.2f}, below the ${settings.suffix_death_line:,.2f} floor. "
                  f"I have flattened every position and terminated the active generation — "
                  f"{result['count']} strategies killed and blacklisted. The desk is frozen pending operator reset."),
            priority="critical", intent="death_line",
            trace=["SENTINEL: drawdown > 20%", "PILOT: flatten_all()",
                   f"QUANTUM: kill_generation() purged {result['count']}"],
        )
        self.record_utterance(utterance)
        asyncio.create_task(self._broadcast({"type": "utterance",
                                             "utterance": utterance.model_dump(mode="json")}))

    # ---------------------------------------------------------------- heartbeat
    async def _heartbeat(self) -> None:
        """Mark-to-market, death-line watch, equity snapshots, telemetry push."""
        seconds = 0
        while True:
            try:
                await asyncio.sleep(2.0)
                if self.paused:
                    continue
                events = await asyncio.to_thread(self.broker.mark_to_market)
                for ev in events:
                    pnl = float(ev.get("pnl", 0.0))
                    self.emit_event(
                        "order", "warn" if pnl < 0 else "info",
                        f"{ev['status']} {ev['symbol']} {ev['side']}",
                        f"exit {ev['exit_price']:,.4f} → P&L ${pnl:+,.4f} ({ev['pnl_pct']:+.2f}%)",
                        {k: ev[k] for k in ("ticket", "symbol", "side", "pnl", "pnl_pct", "status")})
                    # Feed the evolutionary loop with live outcomes.
                    await asyncio.to_thread(self.engine.record_live_outcome,
                                            ev.get("strategy_uid"), pnl, ev["symbol"])
                    if pnl < 0:
                        self.emit_event(
                            "quantum", "warn", "Adaptive penalty mutation",
                            f"Realized loss ${pnl:.4f} → reward decay "
                            f"×{self.engine.pressure.decay:.4f} (k={self.engine.pressure.k:.3f}); "
                            f"lookbacks slashed, stops tightened.",
                            {"loss_streak": self.engine.pressure.loss_streak,
                             "k": self.engine.pressure.k,
                             "decay": round(self.engine.pressure.decay, 6)})

                seconds += 2
                if seconds % 10 == 0:
                    account = self.broker.account_snapshot()
                    self.ledger.record_equity(
                        balance=account["balance"], equity=account["equity"],
                        drawdown_pct=account["drawdown_pct"],
                        open_positions=len(self.broker.positions))
                if seconds % 15 == 0:
                    await self._broadcast({"type": "telemetry",
                                           "frame": self.telemetry().model_dump(mode="json")})
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - the heartbeat must never die
                log.exception("heartbeat error: %s", exc)

    # ---------------------------------------------------------------- fan-out
    async def gather(self, intent: str, symbol: str, ctx: Optional[DeskContext] = None) -> List[AgentReport]:
        """Dispatch to the intent's specialist set, concurrently."""
        ctx = ctx or self.ctx
        ctx.symbol = symbol
        ctx.watchlist = settings.watchlist
        wanted = INTENT_AGENT_SETS.get(intent, INTENT_AGENT_SETS["brief"])
        for agent_id in wanted:
            st = self.agent_state[agent_id]
            st.state = "thinking"
            st.queue_depth = len(wanted)

        async def run(agent_id: AgentId) -> Optional[AgentReport]:
            impl = self.agents[agent_id]
            t0 = time.time()
            try:
                report = await asyncio.wait_for(impl.analyze(symbol, ctx), timeout=45.0)
            except asyncio.TimeoutError:
                self.agent_state[agent_id].state = "error"
                self.agent_state[agent_id].note = "timeout"
                log.warning("%s timed out on %s", agent_id.value, symbol)
                return None
            except Exception as exc:  # noqa: BLE001 - one bad agent never blinds the desk
                self.agent_state[agent_id].state = "error"
                self.agent_state[agent_id].note = str(exc)[:120]
                log.exception("%s failed on %s: %s", agent_id.value, symbol, exc)
                return None
            st = self.agent_state[agent_id]
            st.state = "idle"
            st.load = min(1.0, (time.time() - t0) / 4.0)
            st.confidence = report.confidence
            st.last_report_ts = report.ts
            st.note = report.headline[:160]
            return report

        results = await asyncio.gather(*(run(a) for a in wanted))
        reports = [r for r in results if r is not None]
        for r in reports:
            self.last_reports[r.agent] = r
        return reports

    # ------------------------------------------------------------------ rubric
    def rubric(self, reports: List[AgentReport], intent: str) -> Dict[str, Any]:
        """Weighted consensus across the reporting agents."""
        weights = INTENT_WEIGHTS.get(intent, INTENT_WEIGHTS["brief"])
        num = den = 0.0
        votes = {"long": 0.0, "short": 0.0, "flat": 0.0, "unclear": 0.0}
        for r in reports:
            w = weights.get(r.agent, 1.0) * max(0.15, r.confidence)
            sign = BIAS_SIGN.get(r.bias, 0.0)
            num += w * sign
            den += w
            votes[r.bias] = votes.get(r.bias, 0.0) + w
        net = num / den if den else 0.0
        total = sum(votes.values()) or 1.0
        agreement = max(votes.values()) / total
        directional = votes["long"] + votes["short"]
        dispersion = (min(votes["long"], votes["short"]) / directional) if directional > 0.3 else 0.0
        return {
            "net": round(net, 4), "agreement": round(agreement, 4),
            "dispersion": round(dispersion, 4), "votes": {k: round(v, 3) for k, v in votes.items()},
            "stance": "long" if net > 0.18 else "short" if net < -0.18 else "flat",
            "divergent": agreement < 0.45 or dispersion > 0.55,
        }

    # -------------------------------------------------------------- composition
    def compose(self, symbol: str, reports: List[AgentReport], rubric: Dict[str, Any],
                intent: str) -> Utterance:
        """Deterministic natural-language composition.  SUFFIX's only voice."""
        by_agent = {r.agent: r for r in reports}
        sentinel = by_agent.get(AgentId.SENTINEL)
        oracle = by_agent.get(AgentId.ORACLE)
        chartist = by_agent.get(AgentId.CHARTIST)
        quantum = by_agent.get(AgentId.QUANTUM)
        ledger = by_agent.get(AgentId.LEDGER)
        atlas = by_agent.get(AgentId.ATLAS)
        scout = by_agent.get(AgentId.SCOUT)

        account = self.broker.account_snapshot()
        equity = account["equity"]
        dd = account["drawdown_pct"]
        degraded = [r for r in reports if r.data_quality == "simulated"]
        partial = [r for r in reports if r.data_quality == "partial"]

        trace: List[str] = []
        lines: List[str] = []

        if intent in ("brief", "full", "trade"):
            lines.append(
                f"Equity ${equity:,.2f}, {account['return_pct']:+.2f}% on the ${settings.suffix_starting_capital:.2f} "
                f"desk, {dd:.2f}% off peak, risk state {self.broker.risk_state}.")
            trace.append(f"SENTINEL → equity ${equity:.2f}, dd {dd:.2f}%, state {self.broker.risk_state}")

        if atlas:
            rates = atlas.payload.get("rates", {})
            vix = float(rates.get("VIX", {}).get("last", 0.0) or 0.0)
            ten = float(rates.get("US10Y", {}).get("last", 0.0) or 0.0)
            lines.append(
                f"ATLAS reads the macro tape at VIX {vix:.1f} with the US 10-year at {ten:.2f}%: "
                f"{atlas.headline.split(';')[-1].strip() or atlas.headline}")
            trace.append(f"ATLAS → {atlas.bias} (conf {atlas.confidence:.2f})")

        if scout:
            lines.append(f"SCOUT: {scout.headline}")
            trace.append(f"SCOUT → {scout.bias} (conf {scout.confidence:.2f})")

        if chartist:
            lines.append(f"CHARTIST: {chartist.headline}")
            trace.append(f"CHARTIST → {chartist.bias} (conf {chartist.confidence:.2f})")

        if oracle:
            bracket = oracle.payload.get("bracket", {})
            lines.append(
                f"ORACLE prices the setup at entry {float(bracket.get('entry', 0)):,.4f} with "
                f"stop {float(bracket.get('stop', 0)):,.4f} and target {float(bracket.get('target', 0)):,.4f}.")
            lines.append(oracle.headline)
            trace.append(f"ORACLE → EV {oracle.metrics[2].value if len(oracle.metrics) > 2 else 0}")

        if rubric["divergent"]:
            lines.append(
                f"The desk is SPLIT on {symbol}: weighted vote {rubric['net']:+.2f} with only "
                f"{rubric['agreement'] * 100:.0f}% agreement. I will not commit capital into disagreement.")
            trace.append(f"RUBRIC → divergent (agreement {rubric['agreement']:.2f})")
        else:
            trace.append(f"RUBRIC → {rubric['stance']} (net {rubric['net']:+.2f}, "
                         f"agreement {rubric['agreement']:.2f})")

        if sentinel:
            lines.append(f"SENTINEL: {sentinel.headline}")
            trace.append(f"SENTINEL → {sentinel.payload.get('state')} "
                         f"({settings.suffix_max_concurrent_positions - sentinel.payload.get('open_positions', 0)} slots free)")

        if quantum:
            lines.append(
                f"QUANTUM is on generation {quantum.payload.get('state', {}).get('generation', 0)} — "
                f"{quantum.headline}")
            trace.append(f"QUANTUM → {quantum.metrics[2].value} active, penalty "
                         f"×{quantum.payload.get('state', {}).get('loss_pressure', 1.0)}")

        if ledger and intent in ("brief", "full", "status", "risk"):
            lines.append(f"LEDGER: {ledger.headline}")
            trace.append("LEDGER → book reconciled")

        if degraded or partial:
            # `AgentReport` sets use_enum_values=True, so `r.agent` is a plain
            # string on the wire — normalize before reading `.value`.
            names = ", ".join(sorted({_agent_key(r.agent).upper() for r in degraded + partial}))
            lines.append(
                f"Data note: {names} "
                f"{'are' if len(degraded) + len(partial) > 1 else 'is'} running on "
                f"{'simulated' if degraded else 'partial'} inputs. Treat the numbers accordingly.")

        if self.broker.risk_state == "DEAD":
            lines.insert(0, "The desk is DEAD. No new risk until you reset and re-fund the simulation.")
        elif self.broker.risk_state == "FROZEN":
            lines.insert(0, "The desk is frozen by my risk gate. Say resume, or clear SENTINEL, to continue.")

        text = " ".join(lines).strip()
        priority = ("critical" if self.broker.risk_state in ("DEAD", "CRITICAL")
                    else "alert" if rubric["divergent"] or self.broker.risk_state == "FROZEN"
                    else "briefing")

        utterance = Utterance(
            text=text,
            voice_text=self._voice_text(text),
            priority=priority,  # type: ignore[arg-type]
            intent=intent,
            trace=trace,
            reports=reports,
        )
        return utterance

    @staticmethod
    def _voice_text(text: str) -> str:
        """Normalize prose for TTS: expand symbols and units the voice can read."""
        out = text
        replacements = [
            ("$", " dollars "), ("%", " percent "), ("+", " plus "),
            ("→", " to "), ("×", " times "), ("☠", ""),
            ("BTC-USD", "Bitcoin"), ("ETH-USD", "Ethereum"), ("SOL-USD", "Solana"),
            ("VIX", "V I X"), ("US10Y", "ten year"), ("2s10s", "two s ten s"),
            ("OOS", "out of sample"), ("EV", "expected value"), ("R:R", "risk reward"),
            ("P&L", "profit and loss"), ("q/q", "quarter over quarter"),
            ("ADX", "A D X"), ("ATR", "A T R"), ("RSI", "R S I"),
            ("s/r", "support and resistance"),
        ]
        for src, dst in replacements:
            out = out.replace(src, dst)
        out = re.sub(r"\s{2,}", " ", out)
        out = re.sub(r"\bdollars\s+([\d,\.]+)", r"\1 dollars", out)
        return out.strip()

    def record_utterance(self, utterance: Utterance) -> None:
        self.utterances.append(utterance)
        try:
            self.ledger.record_utterance(utterance.model_dump(mode="json"))
        except Exception:  # noqa: BLE001
            pass

    # ------------------------------------------------------------------ brief
    async def brief(self, symbol: Optional[str] = None, intent: str = "brief",
                    *, speak: bool = False, tts: Any = None) -> Utterance:
        """Full pipeline: fan-out → rubric → compose → (optionally) synthesize."""
        async with self._busy:
            symbol = (symbol or self.ctx.symbol).upper()
            self.ctx.symbol = symbol
            t0 = time.time()
            reports = await self.gather(intent, symbol)
            rubric = self.rubric(reports, intent)
            utterance = self.compose(symbol, reports, rubric, intent)
            utterance.text = f"{utterance.text}" if utterance.text else f"Standing by on {symbol}."
            self.record_utterance(utterance)

            if speak and tts is not None:
                audio = await tts.synthesize(utterance.voice_text, priority=utterance.priority)
                if audio:
                    import base64

                    utterance.audio_b64 = base64.b64encode(audio[0]).decode("ascii")
                    utterance.audio_url = f"/tts/{utterance.utterance_id}.mp3"

            log.info("SUFFIX brief[%s] %s in %dms (%d specialists, %d chars)",
                     intent, symbol, int((time.time() - t0) * 1000), len(reports), len(utterance.text))
            await self._broadcast({"type": "utterance",
                                   "utterance": utterance.model_dump(mode="json"),
                                   "rubric": rubric})
            return utterance

    # ------------------------------------------------------- proposals / trades
    async def propose(self, symbol: Optional[str] = None,
                      leverage: Optional[int] = None,
                      risk_pct: Optional[float] = None) -> Dict[str, Any]:
        """Derive a TradeProposal from the desk's own research, then adjudicate.

        Nothing here is discretionary: the bracket comes from ORACLE (which uses
        the incumbent QUANTUM genome when one exists), the direction must clear
        the rubric, and SENTINEL has final say.
        """
        symbol = (symbol or self.ctx.symbol).upper()
        reports = await self.gather("trade", symbol)
        by_agent = {r.agent: r for r in reports}
        rubric = self.rubric(reports, "trade")
        oracle = by_agent.get(AgentId.ORACLE)
        chartist = by_agent.get(AgentId.CHARTIST)

        if oracle is None:
            return {"status": "no_proposal", "reason": "ORACLE did not report"}

        bracket = oracle.payload.get("bracket", {})
        entry = float(bracket.get("entry", 0.0))
        stop_long = float(bracket.get("stop", 0.0))
        target_long = float(bracket.get("target", 0.0))
        if entry <= 0 or stop_long <= 0 or target_long <= 0:
            return {"status": "no_proposal", "reason": "invalid bracket from ORACLE"}

        side = TradeSide.LONG
        if rubric["stance"] == "short":
            side = TradeSide.SHORT
            stop = entry + (entry - stop_long)
            target = entry - (target_long - entry)
        else:
            stop, target = stop_long, target_long

        if rubric["divergent"]:
            return {"status": "no_proposal",
                    "reason": f"desk is split (agreement {rubric['agreement']:.2f}); "
                              f"SUFFIX will not commit capital into disagreement",
                    "rubric": rubric}
        if rubric["stance"] == "flat":
            return {"status": "no_proposal",
                    "reason": f"no directional edge (net {rubric['net']:+.2f})",
                    "rubric": rubric}

        strategy_uid = oracle.payload.get("strategy_uid")
        rng = np.random.default_rng(hash(symbol) % (2**31))
        risk = float(risk_pct if risk_pct is not None else
                     np.clip(settings.suffix_risk_max_pct, settings.suffix_risk_min_pct,
                             settings.suffix_risk_max_pct))
        lev = int(leverage) if int(leverage or 0) in settings.allowed_leverage else \
            int(min(settings.allowed_leverage))
        if strategy_uid:
            strat = next((s for s in self.engine.active_strategies(symbol)
                          if s["strategy_uid"] == strategy_uid), None)
            if strat:
                lev = int(strat["genome"]["params"].get("leverage", lev))
                risk = float(np.clip(strat["genome"]["params"].get("risk_pct", risk),
                                     settings.suffix_risk_min_pct, settings.suffix_risk_max_pct))

        proposal = TradeProposal(
            symbol=symbol, side=side,
            thesis=(f"{rubric['stance'].upper()} confluences: {chartist.headline if chartist else 'technical read active'} "
                    f"| {oracle.headline[:220]}"),
            entry_price=round(entry, 8),
            stop_price=round(stop, 8),
            take_profit_price=round(target, 8),
            risk_pct=risk, leverage=lev,
            timeframe=self.ctx.timeframe,
            strategy_uid=strategy_uid,
            origin=AgentId.QUANTUM if strategy_uid else AgentId.ORACLE,
            confidence=round(float(np.mean([r.confidence for r in reports])) if reports else 0.5, 4),
            meta={"rubric": rubric, "rng_seed": int(rng.integers(0, 10**6))},
        )

        verdict = self.sentinel.evaluate(proposal)
        result: Dict[str, Any] = {
            "status": verdict.decision,
            "proposal": proposal.model_dump(mode="json"),
            "verdict": verdict.model_dump(mode="json"),
            "rubric": rubric,
            "reports": [r.model_dump(mode="json") for r in reports],
        }

        if verdict.decision == RiskVerdict.VETO:
            self.emit_event("risk", "warn", f"SENTINEL VETO {symbol}",
                            verdict.reasons[0] if verdict.reasons else "risk check failed",
                            {"proposal_id": proposal.proposal_id,
                             "checks": [c.model_dump() for c in verdict.checks]})
            result["execution"] = None
            return result

        execution = self.pilot.execute(verdict)
        result["execution"] = execution.model_dump(mode="json")
        self.emit_event("order", "info" if execution.status == "FILLED" else "warn",
                        f"PILOT {execution.status} {symbol}",
                        execution.message,
                        execution.model_dump(mode="json"))
        if execution.status == "FILLED":
            utterance = Utterance(
                text=(f"Filled {'long' if side == TradeSide.LONG else 'short'} {symbol} at "
                      f"{execution.price:,.4f}, {execution.quantity:.8f} units, {execution.leverage} times leverage, "
                      f"risking ${execution.risk_usd:,.2f} of ${self.broker.equity():,.2f} equity. "
                      f"Stop is working at {proposal.stop_price:,.4f}, target {proposal.take_profit_price:,.4f}."),
                priority="alert", intent="fill",
                trace=[f"RUBRIC {rubric['stance']} ({rubric['net']:+.2f})",
                       f"SENTINEL {verdict.decision}",
                       f"PILOT {execution.message}"],
            )
            self.record_utterance(utterance)
            await self._broadcast({"type": "utterance", "utterance": utterance.model_dump(mode="json")})
        return result

    async def manual_order(self, symbol: str, side: str, leverage: int = 3,
                           risk_pct: float = 1.0,
                           stop: Optional[float] = None,
                           target: Optional[float] = None) -> Dict[str, Any]:
        """Operator-issued order.  Still fully adjudicated by SENTINEL."""
        from server.market_data import atr_based_bracket

        symbol = symbol.upper()
        s = TradeSide.SHORT if str(side).lower() in ("short", "sell") else TradeSide.LONG
        bracket = await asyncio.to_thread(
            atr_based_bracket, symbol, self.ctx.timeframe, 14, 1.5, 2.0, s.value)
        entry = bracket["entry"]
        stop_price = float(stop) if stop else bracket["stop"]
        target_price = float(target) if target else bracket["target"]

        proposal = TradeProposal(
            symbol=symbol, side=s, thesis="Operator directive via SUFFIX voice/UI",
            entry_price=entry, stop_price=stop_price, take_profit_price=target_price,
            risk_pct=float(np.clip(risk_pct, settings.suffix_risk_min_pct, settings.suffix_risk_max_pct)),
            leverage=int(leverage) if int(leverage) in settings.allowed_leverage else 3,
            timeframe=self.ctx.timeframe, origin=AgentId.SUFFIX, confidence=0.6,
            meta={"manual": True},
        )
        verdict = self.sentinel.evaluate(proposal)
        out: Dict[str, Any] = {"status": verdict.decision,
                               "proposal": proposal.model_dump(mode="json"),
                               "verdict": verdict.model_dump(mode="json"),
                               "execution": None}
        if verdict.decision == RiskVerdict.VETO:
            self.emit_event("risk", "warn", f"SENTINEL VETO {symbol} (operator order)",
                            verdict.reasons[0] if verdict.reasons else "risk check failed",
                            {"proposal_id": proposal.proposal_id, "manual": True})
            return out

        execution = self.pilot.execute(verdict)
        out["execution"] = execution.model_dump(mode="json")
        # An operator order is still a desk event: it must appear in the flight
        # recorder exactly like an agent-originated fill.
        self.emit_event("order", "info" if execution.status == "FILLED" else "warn",
                        f"PILOT {execution.status} {symbol} (operator)",
                        execution.message, execution.model_dump(mode="json"))
        return out

    def flatten(self, reason: str = "OPERATOR") -> Dict[str, Any]:
        closed = self.pilot.flatten(reason)
        self.emit_event("risk", "warn", "Desk flattened",
                        f"{len(closed)} position(s) closed by operator ({reason}).",
                        {"closed": len(closed)})
        return {"closed": len(closed), "trades": closed}

    async def kill_switch(self, reason: str = "VOICE_KILL_SWITCH") -> Dict[str, Any]:
        self.sentinel.freeze(reason)
        closed = self.pilot.flatten("VOICE_KILL_SWITCH")
        self.broker.armed = False
        self.emit_event("risk", "critical", "KILL SWITCH",
                        f"Desk frozen and flattened: {len(closed)} position(s) closed.", {"reason": reason})
        utterance = Utterance(
            text=(f"Kill switch engaged. I have frozen the desk and closed {len(closed)} position(s). "
                  f"Say resume to re-arm when you are ready."),
            priority="critical", intent="kill_switch",
            trace=["SENTINEL.freeze()", "PILOT.flatten_all()", "QUANTUM background continues research only"])
        self.record_utterance(utterance)
        await self._broadcast({"type": "utterance", "utterance": utterance.model_dump(mode="json")})
        return {"frozen": True, "closed": len(closed)}

    def resume(self) -> Dict[str, Any]:
        self.sentinel.unfreeze()
        self.broker.armed = True
        self.paused = False
        self.emit_event("risk", "info", "Desk re-armed",
                        f"Risk state {self.broker.risk_state}; operator cleared the freeze.")
        return {"risk_state": self.broker.risk_state, "armed": True}

    def reset_desk(self, reason: str = "operator reset") -> Dict[str, Any]:
        self.engine.registry.purge_all()
        out = self.broker.reset(reason)
        self.emit_event("risk", "warn", "Desk reset",
                        f"Balance restored to ${settings.suffix_starting_capital:.2f}; "
                        f"active generation purged.", out)
        return out

    # ------------------------------------------------------------- command parse
    async def handle_command(self, text: str, *, speak: bool = False,
                             tts: Any = None) -> Dict[str, Any]:
        """Deterministic intent router for voice/UI commands."""
        raw = (text or "").strip()
        low = raw.lower()
        if not low:
            return {"intent": "none", "utterance": None}

        symbol = None
        match = SYMBOL_RE.search(raw.upper())
        if match:
            candidate = match.group(1)
            if candidate in settings.watchlist or candidate.endswith("-USD"):
                symbol = candidate

        if any(k in low for k in ("kill switch", "kill-switch", "stop everything", "emergency stop",
                                  "flatten everything", "abort", "do or die")):
            out = await self.kill_switch("VOICE_KILL_SWITCH")
            return {"intent": "kill_switch", **out}

        if "reset" in low and any(k in low for k in ("desk", "account", "book", "sim")):
            out = self.reset_desk("voice reset")
            return {"intent": "reset", **out}

        if any(k in low for k in ("resume", "re-arm", "rearm", "unfreeze", "continue trading")):
            out = self.resume()
            return {"intent": "resume", **out}

        if any(k in low for k in ("pause", "hold", "stand down", "freeze")):
            self.paused = True
            self.emit_event("system", "warn", "Desk paused", "Telemetry held; monitoring continues.")
            return {"intent": "pause", "paused": True}

        if any(k in low for k in ("flatten", "close all", "close everything", "flat all")):
            return {"intent": "flatten", **self.flatten("VOICE")}

        if any(k in low for k in ("buy", "go long", "open long", "enter long", "take a long")):
            out = await self.manual_order(symbol or self.ctx.symbol, "long")
            return {"intent": "buy", **out}

        if any(k in low for k in ("sell", "go short", "open short", "enter short", "short it")):
            out = await self.manual_order(symbol or self.ctx.symbol, "short")
            return {"intent": "sell", **out}

        if any(k in low for k in ("trade this", "should i trade", "take the trade", "execute",
                                  "make a trade", "deploy", "size it")):
            out = await self.propose(symbol or self.ctx.symbol)
            return {"intent": "trade", **out}

        if any(k in low for k in ("risk", "exposure", "drawdown", "sentinel", "how much am i risking")):
            utt = await self.brief(symbol or self.ctx.symbol, "risk", speak=speak, tts=tts)
            return {"intent": "risk", "utterance": utt.model_dump(mode="json")}

        if any(k in low for k in ("macro", "rates", "inflation", "atlas", "instability")):
            utt = await self.brief(symbol or self.ctx.symbol, "macro", speak=speak, tts=tts)
            return {"intent": "macro", "utterance": utt.model_dump(mode="json")}

        if any(k in low for k in ("chart", "technical", "levels", "support", "resistance", "pattern")):
            utt = await self.brief(symbol or self.ctx.symbol, "technical", speak=speak, tts=tts)
            return {"intent": "technical", "utterance": utt.model_dump(mode="json")}

        if any(k in low for k in ("quantum", "strategy", "backtest", "optuna", "generation", "learn")):
            utt = await self.brief(symbol or self.ctx.symbol, "quantum", speak=speak, tts=tts)
            return {"intent": "quantum", "utterance": utt.model_dump(mode="json")}

        if any(k in low for k in ("status", "how are we", "pnl", "book", "journal", "ledger")):
            utt = await self.brief(symbol or self.ctx.symbol, "status", speak=speak, tts=tts)
            return {"intent": "status", "utterance": utt.model_dump(mode="json")}

        if any(k in low for k in ("scan", "everything", "all agents", "full", "deep dive", "brief me")):
            utt = await self.brief(symbol or self.ctx.symbol, "full", speak=speak, tts=tts)
            return {"intent": "full", "utterance": utt.model_dump(mode="json")}

        if any(k in low for k in ("analyze", "analysis", "look at", "what do you think",
                                  "brief", "report", "thoughts")):
            utt = await self.brief(symbol or self.ctx.symbol, "brief", speak=speak, tts=tts)
            return {"intent": "brief", "utterance": utt.model_dump(mode="json")}

        # Fallback: a full briefing is always a safe answer to an unknown command.
        utt = await self.brief(symbol or self.ctx.symbol, "brief", speak=speak, tts=tts)
        return {"intent": "brief", "fallback": True, "utterance": utt.model_dump(mode="json")}

    # ------------------------------------------------------------------ telemetry
    def telemetry(self) -> TelemetryFrame:
        """Assemble the frame the cinematic HUD renders."""
        self.frame_id += 1
        account = self.broker.account_snapshot()
        equity = account["equity"]
        death_distance = max(0.0, equity - settings.suffix_death_line)
        risk_norm = float(np.clip(death_distance / (settings.suffix_starting_capital - settings.suffix_death_line), 0.0, 1.0))

        nodes: List[TelemetryNode] = []
        report_map = self.last_reports
        order = [AgentId.ATLAS, AgentId.SCOUT, AgentId.CAPITOL, AgentId.ATHENA,
                 AgentId.CHARTIST, AgentId.ORACLE, AgentId.SENTINEL, AgentId.PILOT,
                 AgentId.LEDGER, AgentId.QUANTUM]
        series_sources = {
            AgentId.ATLAS: lambda r: float(r.payload.get("rates", {}).get("VIX", {}).get("last", 16) or 16),
            AgentId.SCOUT: lambda r: float(r.payload.get("velocity", 1.0)),
            AgentId.CAPITOL: lambda r: float(r.payload.get("net_insider_bias", 0.0)),
            AgentId.ATHENA: lambda r: float(r.payload.get("score", 0.0)),
            AgentId.CHARTIST: lambda r: float(r.payload.get("levels", {}).get("bb_position", 0.5)),
            AgentId.ORACLE: lambda r: float(r.payload.get("probability", {}).get("p_target_first", 0.5)),
            AgentId.SENTINEL: lambda r: risk_norm,
            AgentId.PILOT: lambda r: float(len(account["open_positions"])),
            AgentId.LEDGER: lambda r: float(r.payload.get("stats", {}).get("trades", {}).get("win_rate", 0.0)),
            AgentId.QUANTUM: lambda r: float(r.payload.get("state", {}).get("loss_pressure", 1.0)),
        }
        for i, agent_id in enumerate(order):
            impl = self.agents[agent_id]
            st = self.agent_state[agent_id]
            report = report_map.get(agent_id)
            raw = 0.5
            if report is not None:
                try:
                    raw = float(series_sources[agent_id](report))
                except Exception:  # noqa: BLE001
                    raw = 0.5
            value = float(np.clip(math.tanh(raw / 3.0) if abs(raw) > 1.5 else raw, 0.0, 1.0))
            if agent_id == AgentId.ORACLE and report is not None:
                try:
                    value = float(np.clip(report.payload["probability"]["p_target_first"], 0.0, 1.0))
                except Exception:  # noqa: BLE001
                    value = 0.5
            if agent_id == AgentId.SENTINEL:
                value = risk_norm
            series = self._node_history(agent_id, value)
            nodes.append(TelemetryNode(
                agent=agent_id,
                designation=getattr(impl, "designation", agent_id.value.upper()),
                angle_deg=round(i * 36.0, 2),
                value=round(value, 4),
                confidence=round(float(report.confidence if report else st.confidence), 4),
                load=round(float(st.load), 4),
                state=st.state,
                series=series,
                label=(report.metrics[0].label if report and report.metrics else st.role),
                headline=(report.headline[:200] if report else st.note),
                bias=(report.bias if report else "unclear"),
            ))

        frame = TelemetryFrame(
            frame_id=self.frame_id,
            nodes=nodes,
            equity=round(equity, 4),
            balance=round(account["balance"], 4),
            drawdown_pct=round(account["drawdown_pct"], 4),
            risk_state=self.broker.risk_state,
            daily_pnl=round(self.broker.daily_realized_pnl + self.broker.unrealized_pnl(), 4),
            quantum=self.engine.state(),
            voices=len([r for r in report_map.values()]),
            latency_ms=round(float(np.mean([r.latency_ms for r in report_map.values()])) if report_map else 0.0, 2),
        )
        return frame

    def _node_history(self, agent_id: AgentId, value: float, length: int = 48) -> List[float]:
        store = getattr(self, "_series", None)
        if store is None:
            self._series: Dict[AgentId, Deque[float]] = {  # type: ignore[attr-defined]
                a: deque(maxlen=length) for a in self.agents}
            store = self._series
        series = store[agent_id]
        series.append(round(float(value), 4))
        return list(series)

    # ------------------------------------------------------------------ status
    def status(self) -> Dict[str, Any]:
        account = self.broker.account_snapshot()
        return {
            "version": settings.suffix_version,
            "codename": settings.suffix_codename,
            "tagline": settings.suffix_tagline,
            "uptime_seconds": int(time.time() - getattr(self, "_boot", time.time())),
            "paused": self.paused,
            "execution_mode": settings.suffix_execution_mode,
            "account": {k: v for k, v in account.items() if k != "open_positions"},
            "positions": [p.model_dump(mode="json") for p in account["open_positions"]],
            "sentinel": self.sentinel.snapshot().model_dump(mode="json"),
            "agents": [st.model_dump(mode="json") for st in self.agent_state.values()],
            "quantum": self.engine.state().model_dump(mode="json"),
            "mcp": self.mcp.health(),
            "sandbox": self.sandbox.stats(),
            "subscribers": len(self.subscribers),
        }


_orchestrator: Optional[SuffixOrchestrator] = None


def get_orchestrator() -> SuffixOrchestrator:
    global _orchestrator
    if _orchestrator is None:
        _orchestrator = SuffixOrchestrator()
        _orchestrator._boot = time.time()  # type: ignore[attr-defined]
    return _orchestrator
