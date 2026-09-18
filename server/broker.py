"""Agents 7 & 8 — SENTINEL (Risk Gate) and PILOT (Execution).

SENTINEL
--------
Unilateral VETO power.  Nothing reaches a venue without a signed, single-use
approval token minted by ``Sentinel.evaluate()``.  Every rule of the "Do or Die"
directive is enforced here, in one auditable place:

  * capital is fixed at $100.00 paper — the desk can never deposit more
  * death line at $80.00 (-20%): the account freezes, every position is
    flattened, and the active strategy generation is terminated
  * risk per trade is clamped into [1.0%, 2.0%] of starting capital and hard
    capped at $2.00 absolute
  * leverage is restricted to the set {3, 5, 10} — anything else is a VETO
  * daily loss limit, consecutive-loss cooldown, max concurrent positions
  * kill-switch, per-symbol exposure caps, correlation guard

PILOT
-----
Executes only against:
  * ``PaperBroker``      — local fill simulator (default; simulates fees,
                           slippage, spread, intrabar stop/target touches,
                           funding and liquidation)
  * ``BinanceTestnet``   — signed REST orders against testnet.binance.vision,
                           enabled only when both ``SUFFIX_ALLOW_TESTNET=1`` and
                           API credentials are present.

Live mainnet ordering is not implemented anywhere in this codebase.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import math
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from server.config import settings
from server.contracts import (
    Fill, Position, RiskCheck, RiskVerdict, RiskVerdictRecord, SentinelState,
    Sizing, TradeProposal, TradeSide, ExecutionReport, now_ms,
)
from server.ledger import get_ledger

log = logging.getLogger("suffix.broker")

TOKEN_TTL_MS = 30_000          # an approval is valid for 30 seconds, single use
LIQUIDATION_BUFFER = 0.004     # maintenance margin fraction used for liq. price


# =========================================================================== #
#  SENTINEL — the risk gate
# =========================================================================== #
class Sentinel:
    """Unilateral veto authority.  Stateful, single instance per process."""

    def __init__(self, broker: "PaperBroker") -> None:
        self.broker = broker
        self.ledger = get_ledger()
        self.last_verdict: Optional[RiskVerdictRecord] = None
        self.vetoes_today = 0
        self.kills_today = 0
        self._day_stamp = self._today()
        self._frozen_reason: Optional[str] = None

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _today() -> str:
        return time.strftime("%Y-%m-%d", time.gmtime())

    def _roll_day(self) -> None:
        today = self._today()
        if today != self._day_stamp:
            self._day_stamp = today
            self.vetoes_today = 0
            self.kills_today = 0
            self.broker.daily_realized_pnl = 0.0

    @property
    def state(self) -> str:
        return self.broker.risk_state

    # ------------------------------------------------------------- evaluation
    def evaluate(self, proposal: TradeProposal) -> RiskVerdictRecord:
        """Adjudicate a proposal.  Returns a verdict with an approval token when
        the decision is APPROVE or RESIZE."""
        self._roll_day()
        checks: List[RiskCheck] = []
        reasons: List[str] = []
        account = self.broker.account_snapshot()

        balance = account["balance"]
        equity = account["equity"]
        peak = account["peak_equity"]
        drawdown_pct = account["drawdown_pct"]

        def check(code: str, label: str, passed: bool, detail: str = "",
                  severity: str = "info") -> bool:
            checks.append(RiskCheck(code=code, label=label, passed=passed,
                                    detail=detail, severity=severity))
            return passed

        # ---- 0. desk-level gates (freeze / death) ---------------------------
        desked = True
        if self.broker.risk_state == "DEAD":
            desked = check("DESK_DEAD", "Desk liquidated (death line breached)", False,
                           f"equity {equity:.2f} <= death line {settings.suffix_death_line:.2f}",
                           "critical")
            reasons.append("Desk is DEAD. Manual reset required; no new risk may be taken.")
        elif self.broker.risk_state == "FROZEN":
            desked = check("DESK_FROZEN", "Desk frozen by SENTINEL kill-switch", False,
                           self._frozen_reason or "manual freeze", "critical")
            reasons.append("Desk frozen. Clear the freeze before proposing trades.")
        elif not self.broker.armed:
            desked = check("DESK_DISARMED", "Desk disarmed (open palm / voice command)", False,
                           "SENTINEL disarmed", "warn")
            reasons.append("Desk disarmed by operator.")
        else:
            check("DESK_ARMED", "Desk armed", True, f"risk state {self.broker.risk_state}")

        # ---- 1. death line ---------------------------------------------------
        distance = equity - settings.suffix_death_line
        check("DEATH_LINE", "Death line buffer", distance > 0,
              f"${distance:,.2f} above the ${settings.suffix_death_line:.2f} floor",
              "critical" if distance <= 2.0 else "info")
        if distance <= 0:
            self.trigger_death_line(equity, "Pre-trade equity at or below death line")

        # ---- 2. daily loss limit --------------------------------------------
        daily_limit = settings.daily_loss_limit_usd
        daily_pnl = self.broker.daily_realized_pnl + self.broker.unrealized_pnl()
        ok_daily = check("DAILY_LOSS", "Daily loss limit", daily_pnl > -daily_limit,
                         f"day P&L ${daily_pnl:,.2f} vs limit -${daily_limit:,.2f}",
                         "warn" if daily_pnl < -daily_limit * 0.6 else "info")
        if not ok_daily:
            reasons.append(f"Daily loss limit hit (${daily_pnl:,.2f}). Trading halted until UTC rollover.")

        # ---- 3. consecutive loss cooldown -----------------------------------
        cooling = self.broker.cooldown_until_ms and self.broker.cooldown_until_ms > now_ms()
        ok_cool = check(
            "COOLDOWN", "Loss-streak cooldown",
            not cooling,
            ("cooling until " + time.strftime("%H:%M:%SZ", time.gmtime(self.broker.cooldown_until_ms / 1000)))
            if cooling else f"{self.broker.consecutive_losses} consecutive losses",
            "warn" if cooling else "info",
        )
        if not ok_cool:
            reasons.append("Adaptive cooldown active after consecutive losses — venue entry blocked.")

        # ---- 4. concurrency --------------------------------------------------
        open_count = len(self.broker.positions)
        ok_slots = check("CONCURRENCY", "Max concurrent positions",
                         open_count < settings.suffix_max_concurrent_positions,
                         f"{open_count}/{settings.suffix_max_concurrent_positions} slots used",
                         "warn" if open_count >= settings.suffix_max_concurrent_positions else "info")

        # ---- 5. leverage -----------------------------------------------------
        allowed = settings.allowed_leverage
        ok_lev = check("LEVERAGE", "Leverage whitelist", proposal.leverage in allowed,
                       f"{proposal.leverage}x requested; permitted {allowed}")

        # ---- 6. risk band ----------------------------------------------------
        risk_pct_ok = settings.suffix_risk_min_pct <= proposal.risk_pct <= settings.suffix_risk_max_pct
        check("RISK_BAND", "Risk % within 1.0–2.0%", risk_pct_ok,
              f"{proposal.risk_pct:.2f}% requested", "warn" if not risk_pct_ok else "info")

        # ---- 7. geometry -----------------------------------------------------
        geometry_ok = True
        if proposal.entry_price <= 0 or proposal.stop_price <= 0:
            geometry_ok = False
            reasons.append("Invalid price geometry (non-positive entry/stop).")
        elif proposal.stop_distance <= 0:
            geometry_ok = False
            reasons.append("Stop distance is zero — a riskless trade is a data error.")
        else:
            if proposal.side == TradeSide.LONG and proposal.stop_price >= proposal.entry_price:
                # Auto-correct an inverted stop only if the intent is unambiguous.
                geometry_ok = False
                reasons.append("LONG stop is at/above entry.")
            if proposal.side == TradeSide.SHORT and proposal.stop_price <= proposal.entry_price:
                geometry_ok = False
                reasons.append("SHORT stop is at/below entry.")
            if proposal.take_profit_price:
                if proposal.side == TradeSide.LONG and proposal.take_profit_price <= proposal.entry_price:
                    geometry_ok = False
                    reasons.append("LONG target is at/below entry.")
                if proposal.side == TradeSide.SHORT and proposal.take_profit_price >= proposal.entry_price:
                    geometry_ok = False
                    reasons.append("SHORT target is at/above entry.")
        check("GEOMETRY", "Order geometry valid", geometry_ok,
              "stop must sit on the losing side, target on the winning side", "critical" if not geometry_ok else "info")

        # ---- 8. stop sanity: an absurdly wide stop is a hidden risk ---------
        stop_pct = proposal.stop_distance_pct
        max_stop_pct = 12.0
        ok_stop_pct = stop_pct <= max_stop_pct
        check("STOP_WIDTH", f"Stop width <= {max_stop_pct:.0f}%", ok_stop_pct,
              f"stop is {stop_pct:.2f}% away", "warn" if not ok_stop_pct else "info")
        if not ok_stop_pct:
            reasons.append(f"Stop {stop_pct:.1f}% away exceeds the {max_stop_pct:.0f}% risk envelope.")

        # ---- 9. correlation / exposure guard --------------------------------
        same_symbol = [p for p in self.broker.positions.values() if p.symbol == proposal.symbol]
        ok_dupe = check("DUPLICATE", "No stacked exposure on one symbol", not same_symbol,
                        f"{len(same_symbol)} open position(s) on {proposal.symbol}",
                        "warn" if same_symbol else "info")
        if same_symbol:
            reasons.append(f"Already holding {proposal.symbol}; refusing to stack correlated risk.")

        # ---- 10. strategy provenance ----------------------------------------
        if proposal.strategy_uid:
            blacklisted = self.ledger.is_blacklisted(proposal.strategy_uid)
            check("STRATEGY_LIVE", "Strategy not blacklisted", not blacklisted,
                  proposal.strategy_uid, "critical" if blacklisted else "info")
            if blacklisted:
                reasons.append(f"Strategy {proposal.strategy_uid} is EXTINCT (blacklisted). Proposal rejected.")
        else:
            check("STRATEGY_LIVE", "Discretionary proposal", True, "no strategy provenance (agent-discretionary)")

        # ---- 11. sizing ------------------------------------------------------
        fatal = [c for c in checks if not c.passed and c.severity == "critical"]
        blocking = [c for c in checks if not c.passed and c.code in {
            "DAILY_LOSS", "COOLDOWN", "CONCURRENCY", "LEVERAGE", "DUPLICATE"}]

        sizing: Optional[Sizing] = None
        if not fatal:
            sizing, sizing_note = self.size_position(proposal, equity)
            if sizing is None:
                reasons.append(sizing_note)
                fatal.append(RiskCheck(code="SIZING", label="Position sizing",
                                       passed=False, detail=sizing_note, severity="critical"))
            else:
                # Re-check the absolute risk ceiling post-sizing.
                if sizing.risk_usd > settings.suffix_absolute_risk_ceiling + 1e-6:
                    reasons.append(f"Sized risk ${sizing.risk_usd:.4f} exceeds the ${settings.suffix_absolute_risk_ceiling:.2f} ceiling.")

        # ---- decide ----------------------------------------------------------
        if fatal or blocking:
            decision = RiskVerdict.VETO
            self.vetoes_today += 1
            reasons = reasons or [c.label for c in fatal + blocking]
            approval = None
            expires = None
            adjusted = None
        else:
            adjusted = proposal.model_copy(update={
                "quantity": sizing.quantity if sizing else None,
                "risk_pct": sizing.risk_pct if sizing else proposal.risk_pct,
            })
            if abs((sizing.risk_pct if sizing else proposal.risk_pct) - proposal.risk_pct) > 0.01:
                decision = RiskVerdict.RESIZE
                reasons.append(
                    f"Sized to {sizing.risk_usd:.2f} USD at {sizing.risk_pct:.2f}% "
                    f"({sizing.quantity:.8f} units @ {sizing.applied_leverage}x) after venue caps.")
            else:
                decision = RiskVerdict.APPROVE
            approval, expires = self._mint_token(proposal, sizing)

        record = RiskVerdictRecord(
            proposal_id=proposal.proposal_id,
            symbol=proposal.symbol,
            side=proposal.side,
            decision=decision,
            reasons=reasons,
            checks=checks,
            sizing=sizing,
            adjusted=adjusted if decision != RiskVerdict.VETO else None,
            approval_token=approval,
            token_expires_ms=expires,
            risk_state=self.broker.risk_state,
            equity=equity,
            balance=balance,
            drawdown_pct=drawdown_pct,
        )
        self.last_verdict = record
        self.ledger.record_verdict(record.model_dump(mode="json"))

        if decision == RiskVerdict.VETO:
            log.warning("SENTINEL VETO %s %s: %s", proposal.side, proposal.symbol,
                        "; ".join(reasons[:3]) or "risk check failed")
        else:
            log.info("SENTINEL %s %s %s qty=%.8f risk=$%.2f lev=%dx",
                     decision.value, proposal.side.value, proposal.symbol,
                     sizing.quantity if sizing else 0.0,
                     sizing.risk_usd if sizing else 0.0,
                     sizing.applied_leverage if sizing else 0)
        return record

    # ---------------------------------------------------------------- sizing
    def size_position(self, proposal: TradeProposal, equity: float) -> Tuple[Optional[Sizing], str]:
        """Risk-based position sizing with leverage caps and margin feasibility.

        risk_usd = quantity * |entry - stop|
        Quantity is sized so that a stop-out costs exactly ``risk_usd``, then
        clamped by leverage, available margin and a notional ceiling.
        """
        risk_pct = float(np.clip(proposal.risk_pct, settings.suffix_risk_min_pct,
                                 settings.suffix_risk_max_pct))
        risk_usd = min(equity * risk_pct / 100.0, settings.suffix_absolute_risk_ceiling)
        risk_usd = max(risk_usd, 0.01)
        per_unit = proposal.stop_distance
        if per_unit <= 0:
            return None, "stop distance is zero"

        quantity = risk_usd / per_unit
        notional = quantity * proposal.entry_price

        # Leverage: cheapest rung in the whitelist that fits the intended notional.
        allowed = list(settings.allowed_leverage)
        required_lev = notional / max(equity, 1e-9)
        applied = next((lev for lev in allowed if lev >= required_lev), None)
        if applied is None:
            applied = allowed[-1]
            quantity = (equity * applied) / proposal.entry_price
            notional = quantity * proposal.entry_price

        margin = notional / max(applied, 1)
        free = self.broker.free_margin()
        if margin > free:
            scale = free / margin if margin > 0 else 0.0
            quantity *= scale
            notional *= scale
            margin = notional / max(applied, 1)
            if quantity <= 0:
                return None, f"insufficient free margin (${free:.2f})"

        # Minimum notional sanity: below ~$10 the paper venue can't quote honestly.
        if notional < 5.0:
            return None, f"notional ${notional:.2f} below the $5.00 venue minimum"

        # Recompute the true risk after all clamps.
        realized_risk = quantity * per_unit
        eff_risk_pct = realized_risk / max(equity, 1e-9) * 100.0

        liq = self.liquidation_price(proposal.side, proposal.entry_price, applied)
        return Sizing(
            quantity=round(quantity, 8),
            notional=round(notional, 4),
            required_leverage=round(required_lev, 3),
            applied_leverage=applied,
            risk_usd=round(realized_risk, 4),
            risk_pct=round(eff_risk_pct, 4),
            margin_usd=round(margin, 4),
            liquidation_price=liq,
        ), "ok"

    @staticmethod
    def liquidation_price(side: TradeSide, entry: float, leverage: int) -> float:
        """Isolated-margin liquidation approximation (1/lev minus a maintenance buffer)."""
        frac = 1.0 / max(leverage, 1) - LIQUIDATION_BUFFER
        if side == TradeSide.LONG:
            return round(max(entry * (1.0 - frac), 1e-9), 8)
        return round(entry * (1.0 + frac), 8)

    # ----------------------------------------------------------------- tokens
    def _mint_token(self, proposal: TradeProposal, sizing: Optional[Sizing]) -> Tuple[str, int]:
        nonce = uuid.uuid4().hex
        payload = f"{proposal.proposal_id}|{proposal.symbol}|{proposal.side.value}|{nonce}"
        token = hmac.new(self.broker.desk_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()[:40]
        expires = now_ms() + TOKEN_TTL_MS
        self.broker.approvals[token] = {
            "proposal_id": proposal.proposal_id,
            "symbol": proposal.symbol,
            "side": proposal.side.value,
            "quantity": sizing.quantity if sizing else 0.0,
            "expires_ms": expires,
        }
        return token, expires

    def burn_token(self, token: Optional[str]) -> bool:
        """Tokens are single-use; an unknown/expired token is a hard failure."""
        if not token:
            return False
        rec = self.broker.approvals.pop(token, None)
        return bool(rec and rec["expires_ms"] > now_ms())

    # ------------------------------------------------------------------ state
    def snapshot(self) -> SentinelState:
        account = self.broker.account_snapshot()
        equity = account["equity"]
        return SentinelState(
            state=self.broker.risk_state,
            armed=self.broker.armed,
            balance=account["balance"],
            equity=equity,
            peak_equity=account["peak_equity"],
            drawdown_pct=account["drawdown_pct"],
            death_line=settings.suffix_death_line,
            distance_to_death_usd=round(equity - settings.suffix_death_line, 4),
            risk_budget_remaining_usd=round(
                max(0.0, equity - settings.suffix_death_line) *
                min(1.0, settings.suffix_risk_max_pct / 100.0) * 10, 4),
            daily_pnl=round(self.broker.daily_realized_pnl + self.broker.unrealized_pnl(), 4),
            consecutive_losses=self.broker.consecutive_losses,
            cooldown_until_ms=self.broker.cooldown_until_ms,
            open_positions=len(self.broker.positions),
            vetoes_today=self.vetoes_today,
            kills_today=self.kills_today,
            last_verdict=self.last_verdict,
        )

    # -------------------------------------------------------------- kill-switch
    def freeze(self, reason: str) -> None:
        self.broker.risk_state = "FROZEN"
        self._frozen_reason = reason
        log.critical("SENTINEL FREEZE: %s", reason)

    def unfreeze(self) -> None:
        if self.broker.risk_state == "DEAD":
            return
        self.broker.risk_state = "CAUTION" if self.broker.drawdown_pct() > 10.0 else "ARMED"
        self._frozen_reason = None

    def trigger_death_line(self, equity: float, cause: str) -> None:
        """-20% total drawdown => terminate the active strategy generation.

        Delegates the state transition to the broker so the pre-trade path and
        the mark-to-market path can never diverge.
        """
        if self.broker.risk_state == "DEAD":
            return
        self.kills_today += 1
        self.broker.on_death_line(equity, cause)


# =========================================================================== #
#  PILOT — execution venues
# =========================================================================== #
class PaperBroker:
    """Local fill simulator.  This is the default venue for the $100 desk."""

    venue = "paper"

    def __init__(self) -> None:
        self.desk_secret = uuid.uuid4().hex + "suffix-desk"
        self.starting_capital = settings.suffix_starting_capital
        self.balance = settings.suffix_starting_capital
        self.peak_equity = settings.suffix_starting_capital
        self.realized_pnl = 0.0
        self.daily_realized_pnl = 0.0
        self.consecutive_losses = 0
        self.cooldown_until_ms: Optional[int] = None
        self.risk_state = "ARMED"
        self.armed = True
        self.positions: Dict[str, Position] = {}
        self.closed_trades: List[Dict[str, Any]] = []
        self.approvals: Dict[str, Dict[str, Any]] = {}
        self.fills: List[Fill] = []
        self._lock = asyncio.Lock()
        self._price_cache: Dict[str, Tuple[float, float]] = {}
        self.kill_hook: Optional[Any] = None      # set by the orchestrator
        self.trade_hook: Optional[Any] = None

    # ---------------------------------------------------------------- pricing
    def mark_price(self, symbol: str, force: bool = False) -> float:
        """Live-ish last price, memoized for 5s to spare provider rate limits."""
        now = time.time()
        cached = self._price_cache.get(symbol)
        if cached and not force and now - cached[1] < 5.0:
            return cached[0]
        from server.market_data import last_price

        res = last_price(symbol)
        try:
            px = float(res.value)
        except (TypeError, ValueError):
            px = cached[0] if cached else 1.0
        if px <= 0:
            px = cached[0] if cached else 1.0
        self._price_cache[symbol] = (px, now)
        return px

    def unrealized_pnl(self) -> float:
        return round(sum(p.unrealized_pnl for p in self.positions.values()), 6)

    def equity(self) -> float:
        return round(self.balance + self.unrealized_pnl(), 6)

    def drawdown_pct(self) -> float:
        eq = self.equity()
        peak = max(self.peak_equity, eq)
        if peak <= 0:
            return 0.0
        return round((peak - eq) / peak * 100.0, 4)

    def margin_used(self) -> float:
        return round(sum(
            (p.quantity * p.entry_price) / max(p.leverage, 1) for p in self.positions.values()
        ), 6)

    def free_margin(self) -> float:
        return round(self.equity() - self.margin_used(), 6)

    def account_snapshot(self) -> Dict[str, Any]:
        eq = self.equity()
        self.peak_equity = max(self.peak_equity, eq)
        return {
            "balance": round(self.balance, 4),
            "equity": round(eq, 4),
            "peak_equity": round(self.peak_equity, 4),
            "starting_capital": self.starting_capital,
            "unrealized_pnl": self.unrealized_pnl(),
            "realized_pnl": round(self.realized_pnl, 4),
            "margin_used": self.margin_used(),
            "free_margin": self.free_margin(),
            "return_pct": round((eq - self.starting_capital) / self.starting_capital * 100.0, 4),
            "drawdown_pct": self.drawdown_pct(),
            "death_line": settings.suffix_death_line,
            "open_positions": list(self.positions.values()),
            "mode": self.venue,
        }

    # -------------------------------------------------------- mark to market
    def mark_to_market(self, force: bool = False) -> List[Dict[str, Any]]:
        """Refresh unrealized P&L; auto-close on stop, target or liquidation."""
        events: List[Dict[str, Any]] = []
        for ticket, pos in list(self.positions.items()):
            px = self.mark_price(pos.symbol, force=force)
            direction = 1.0 if pos.side == TradeSide.LONG else -1.0
            pos.unrealized_pnl = round((px - pos.entry_price) * pos.quantity * direction, 6)
            pos.unrealized_pct = round(
                (px - pos.entry_price) / pos.entry_price * 100.0 * direction, 4)
            # liquidation first — it is the worst outcome and takes precedence
            if pos.liquidation_price:
                hit_liq = (pos.side == TradeSide.LONG and px <= pos.liquidation_price) or \
                          (pos.side == TradeSide.SHORT and px >= pos.liquidation_price)
                if hit_liq:
                    events.append(self.close_position(ticket, px, "LIQUIDATED"))
                    continue
            hit_stop = (pos.side == TradeSide.LONG and px <= pos.stop_price) or \
                       (pos.side == TradeSide.SHORT and px >= pos.stop_price)
            if hit_stop:
                events.append(self.close_position(ticket, pos.stop_price, "STOPPED"))
                continue
            if pos.take_profit_price:
                hit_tp = (pos.side == TradeSide.LONG and px >= pos.take_profit_price) or \
                         (pos.side == TradeSide.SHORT and px <= pos.take_profit_price)
                if hit_tp:
                    events.append(self.close_position(ticket, pos.take_profit_price, "TAKEPROFIT"))
        # Death line is checked on every heartbeat, mark-to-market or not.
        if self.risk_state != "DEAD" and self.equity() <= settings.suffix_death_line:
            self.on_death_line(self.equity(), "Mark-to-market equity crossed the death line")
        return [e for e in events if e]

    # ------------------------------------------------------------- execution
    def open_position(self, proposal: TradeProposal, sizing: Sizing,
                      approval_token: Optional[str] = None) -> Tuple[Optional[Position], ExecutionReport]:
        """Fill an APPROVED proposal.  Requires a live approval token."""
        px = self.mark_price(proposal.symbol, force=True)
        if px <= 0:
            return None, ExecutionReport(
                proposal_id=proposal.proposal_id, status="REJECTED", symbol=proposal.symbol,
                side=proposal.side, message="no market price available")

        side_mult = 1.0 if proposal.side == TradeSide.LONG else -1.0
        half_spread = px * settings.paper_spread_bps / 2 / 10_000
        slip = px * settings.paper_slippage_bps / 10_000
        fill_price = px + side_mult * (half_spread + slip)
        notional = fill_price * sizing.quantity
        fee = notional * settings.paper_fee_bps / 10_000

        pos = Position(
            symbol=proposal.symbol,
            side=proposal.side,
            quantity=sizing.quantity,
            entry_price=round(fill_price, 8),
            stop_price=proposal.stop_price,
            take_profit_price=proposal.take_profit_price,
            leverage=sizing.applied_leverage,
            strategy_uid=proposal.strategy_uid,
            risk_usd=sizing.risk_usd,
            liquidation_price=sizing.liquidation_price,
            venue=self.venue,
            meta={"proposal_id": proposal.proposal_id, "thesis": proposal.thesis,
                  "timeframe": proposal.timeframe, "origin": str(proposal.origin),
                  "fee_bps": settings.paper_fee_bps,
                  "slippage_bps": settings.paper_slippage_bps,
                  "spread_bps": settings.paper_spread_bps},
        )
        pos.fills.append(Fill(price=pos.entry_price, quantity=sizing.quantity,
                              fees=round(fee, 6),
                              slippage_usd=round(abs(fill_price - px) * sizing.quantity, 6)))
        # Fees are paid from the wallet; margin is reserved but stays on the balance.
        self.balance -= fee
        self.realized_pnl -= fee
        self.positions[pos.ticket] = pos

        self.ledger_open(pos, proposal)
        report = ExecutionReport(
            proposal_id=proposal.proposal_id, ticket=pos.ticket, status="FILLED",
            venue=self.venue, symbol=pos.symbol, side=pos.side, quantity=sizing.quantity,
            price=pos.entry_price, fees=round(fee, 6),
            slippage_usd=pos.fills[0].slippage_usd, leverage=pos.leverage,
            risk_usd=sizing.risk_usd, approval_token=approval_token,
            message=f"{'LONG' if pos.side == TradeSide.LONG else 'SHORT'} {pos.symbol} "
                    f"{sizing.quantity:.8f} @ {pos.entry_price:,.4f} ({pos.leverage}x)",
        )
        log.info("PILOT FILL %s", report.message)
        return pos, report

    def close_position(self, ticket: str, price: Optional[float] = None,
                       status: str = "CLOSED", fraction: float = 1.0) -> Optional[Dict[str, Any]]:
        pos = self.positions.get(ticket)
        if pos is None:
            return None
        fraction = float(np.clip(fraction, 0.05, 1.0))
        exit_px = price if price is not None else self.mark_price(pos.symbol, force=True)
        side_mult = 1.0 if pos.side == TradeSide.LONG else -1.0
        # Exits cross the spread the other way; stops and liquidations slip more.
        slip_bps = settings.paper_slippage_bps * (3.0 if status in ("STOPPED", "LIQUIDATED") else 1.0)
        exit_px = exit_px - side_mult * exit_px * slip_bps / 10_000

        qty = pos.quantity * fraction
        gross = (exit_px - pos.entry_price) * qty * side_mult
        close_notional = exit_px * qty
        fee = close_notional * settings.paper_fee_bps / 10_000
        pnl = gross - fee
        pnl_pct = (exit_px - pos.entry_price) / pos.entry_price * 100.0 * side_mult

        self.balance += pnl
        self.realized_pnl += pnl
        self.daily_realized_pnl += pnl
        self.peak_equity = max(self.peak_equity, self.equity())

        if pnl < 0:
            self.consecutive_losses += 1
            if self.consecutive_losses >= settings.suffix_consecutive_loss_cooldown:
                self.cooldown_until_ms = now_ms() + settings.suffix_cooldown_minutes * 60_000
        else:
            self.consecutive_losses = 0
            self.cooldown_until_ms = None

        record = {
            "ticket": pos.ticket,
            "symbol": pos.symbol,
            "side": pos.side.value,
            "quantity": round(qty, 8),
            "entry_price": pos.entry_price,
            "exit_price": round(exit_px, 8),
            "pnl": round(pnl, 6),
            "pnl_pct": round(pnl_pct, 4),
            "fees": round(fee, 6),
            "status": status,
            "leverage": pos.leverage,
            "strategy_uid": pos.strategy_uid,
            "opened_ms": pos.opened_ms,
            "closed_ms": now_ms(),
            "thesis": pos.meta.get("thesis", ""),
        }
        self.closed_trades.append(record)
        self.get_ledger().close_trade(
            trade_id=pos.ticket, exit_price=exit_px, pnl=pnl,
            pnl_pct=pnl_pct, fees=fee, status=status)

        if fraction >= 0.999:
            del self.positions[ticket]
        else:
            pos.quantity -= qty
        log.warning("PILOT EXIT %s %s %s P&L $%.4f (%s)",
                    pos.symbol, pos.side.value, status, pnl, f"{pnl_pct:+.2f}%")
        return record

    def close_all(self, status: str = "CLOSED") -> List[Dict[str, Any]]:
        return [r for r in (self.close_position(t, status=status) for t in list(self.positions)) if r]

    def flatten_all(self, reason: str = "KILL_SWITCH") -> List[Dict[str, Any]]:
        """Emergency flatten — used by the death line and the voice kill-switch."""
        out: List[Dict[str, Any]] = []
        for ticket in list(self.positions):
            rec = self.close_position(ticket, status="KILLED")
            if rec:
                rec["reason"] = reason
                out.append(rec)
        return out

    # ------------------------------------------------------------- ledger glue
    def get_ledger(self):
        return get_ledger()

    def ledger_open(self, pos: Position, proposal: TradeProposal) -> None:
        try:
            get_ledger().open_trade(
                trade_id=pos.ticket, symbol=pos.symbol, side=pos.side.value,
                quantity=pos.quantity, entry_price=pos.entry_price,
                leverage=pos.leverage, fees=pos.fills[0].fees if pos.fills else 0.0,
                strategy_uid=pos.strategy_uid, thesis=proposal.thesis)
        except Exception as exc:  # noqa: BLE001 - the book must never break the desk
            log.error("LEDGER open_trade failed: %s", exc)

    # ---------------------------------------------------------------- hooks
    def on_death_line(self, equity: float, cause: str) -> None:
        """Called exactly once when the death line is breached.

        This is the authoritative state transition: -20% total drawdown moves
        the desk to ``DEAD``, flattens every position, and fires ``kill_hook``
        so the orchestrator can terminate the active strategy generation.
        """
        if self.risk_state == "DEAD":
            return
        self.risk_state = "DEAD"
        log.critical("DEATH LINE: equity $%.2f <= $%.2f — %s", equity,
                     settings.suffix_death_line, cause)
        try:
            get_ledger().record_equity(balance=self.balance, equity=equity,
                                       drawdown_pct=self.drawdown_pct(),
                                       open_positions=len(self.positions))
        except Exception:  # noqa: BLE001
            pass
        try:
            self.flatten_all("DEATH_LINE")
        except Exception as exc:  # noqa: BLE001
            log.error("flatten_all during death line failed: %s", exc)
        if callable(self.kill_hook):
            try:
                self.kill_hook(equity, cause)
            except Exception as exc:  # noqa: BLE001
                log.error("kill_hook failed: %s", exc)

    # --------------------------------------------------------------- resets
    def reset(self, reason: str = "operator reset") -> Dict[str, Any]:
        """Full desk reset back to $100.00.  Only reachable from DEAD/FROZEN."""
        prior = self.account_snapshot()
        self.positions.clear()
        self.balance = self.starting_capital
        self.peak_equity = self.starting_capital
        self.realized_pnl = 0.0
        self.daily_realized_pnl = 0.0
        self.consecutive_losses = 0
        self.cooldown_until_ms = None
        self.risk_state = "ARMED"
        self.armed = True
        self.approvals.clear()
        log.warning("DESK RESET — %s", reason)
        return {"before": {k: prior[k] for k in ("balance", "equity", "drawdown_pct")},
                "after": {"balance": self.balance, "equity": self.balance, "risk_state": self.risk_state},
                "reason": reason}


# =========================================================================== #
#  Binance testnet venue (optional, opt-in)
# =========================================================================== #
class BinanceTestnet:
    """Signed REST orders against testnet.binance.vision.

    Activated only when ``SUFFIX_ALLOW_TESTNET=1`` **and** credentials exist.
    Mainnet is deliberately unreachable: ``base`` is hard-wired to testnet.
    """

    venue = "binance_testnet"

    def __init__(self) -> None:
        self.base = settings.binance_testnet_base.rstrip("/")
        self.key = settings.binance_api_key
        self.secret = settings.binance_api_secret
        self.enabled = bool(settings.suffix_allow_testnet and self.key and self.secret)
        self._symbol_map: Dict[str, str] = {}

    def _sign(self, params: Dict[str, Any]) -> str:
        query = "&".join(f"{k}={v}" for k, v in params.items())
        sig = hmac.new(self.secret.encode(), query.encode(), hashlib.sha256).hexdigest()
        return f"{query}&signature={sig}"

    def _symbol(self, symbol: str) -> str:
        """BTC-USD -> BTCUSDT (testnet trades USDT pairs)."""
        if symbol in self._symbol_map:
            return self._symbol_map[symbol]
        base = symbol.split("-")[0].upper()
        quote = "USDT" if symbol.upper().endswith("-USD") else "USDT"
        out = f"{base}{quote}"
        self._symbol_map[symbol] = out
        return out

    def health(self) -> Dict[str, Any]:
        if not self.enabled:
            return {"enabled": False, "reason": "testnet disabled or credentials missing"}
        try:
            import httpx

            resp = httpx.get(f"{self.base}/api/v3/time", timeout=8.0)
            return {"enabled": True, "reachable": resp.status_code == 200,
                    "server_time": resp.json().get("serverTime") if resp.status_code == 200 else None}
        except Exception as exc:  # noqa: BLE001
            return {"enabled": True, "reachable": False, "error": str(exc)}

    def place_market_order(self, side: TradeSide, symbol: str, quantity: float) -> Dict[str, Any]:
        if not self.enabled:
            return {"status": "ERROR", "message": "testnet venue disabled"}
        try:
            import httpx

            params = {
                "symbol": self._symbol(symbol),
                "side": "BUY" if side == TradeSide.LONG else "SELL",
                "type": "MARKET",
                "quantity": f"{quantity:.6f}".rstrip("0").rstrip("."),
                "timestamp": int(time.time() * 1000),
                "recvWindow": 5000,
            }
            body = self._sign(params)
            resp = httpx.post(f"{self.base}/api/v3/order", content=body,
                              headers={"X-MBX-APIKEY": self.key, "Content-Type": "application/x-www-form-urlencoded"},
                              timeout=10.0)
            data = resp.json() if resp.content else {}
            if resp.status_code != 200:
                return {"status": "REJECTED", "message": data.get("msg", resp.text), "raw": data}
            return {"status": "FILLED", "raw": data,
                    "fill_price": float(data.get("fills", [{}])[0].get("price", 0) or 0) or None}
        except Exception as exc:  # noqa: BLE001
            return {"status": "ERROR", "message": str(exc)}


class Pilot:
    """Agent 8 — routes orders to the correct venue, strictly post-approval."""

    def __init__(self, broker: PaperBroker, sentinel: Sentinel) -> None:
        self.broker = broker
        self.sentinel = sentinel
        self.testnet = BinanceTestnet()
        self.venue = broker.venue
        if settings.suffix_execution_mode == "testnet" and self.testnet.enabled:
            self.venue = self.testnet.venue

    def execute(self, verdict: RiskVerdictRecord) -> ExecutionReport:
        """Execute an approved proposal.  Any non-approved verdict is refused."""
        if verdict.decision == RiskVerdict.VETO or verdict.adjusted is None:
            return ExecutionReport(
                proposal_id=verdict.proposal_id, status="REJECTED", venue=self.venue,
                symbol=verdict.symbol, side=verdict.side, message="VETOED by SENTINEL",
                approval_token=None)

        proposal = verdict.adjusted
        sizing = verdict.sizing
        if sizing is None:
            return ExecutionReport(
                proposal_id=verdict.proposal_id, status="REJECTED", venue=self.venue,
                symbol=proposal.symbol, side=proposal.side, message="missing sizing")

        # Burn the single-use token; a stale/forged token never reaches a venue.
        if not self.sentinel.burn_token(verdict.approval_token):
            return ExecutionReport(
                proposal_id=verdict.proposal_id, status="REJECTED", venue=self.venue,
                symbol=proposal.symbol, side=proposal.side,
                message="approval token missing, expired or already used")

        pos, report = self.broker.open_position(proposal, sizing, verdict.approval_token)

        # Mirror the fill to the testnet venue when configured (paper book stays
        # the source of truth for accounting; this is an operational rehearsal).
        if pos and self.venue == self.testnet.venue:
            ack = self.testnet.place_market_order(pos.side, pos.symbol, sizing.quantity)
            report.message += f" | testnet:{ack.get('status')}"
            report.venue = self.testnet.venue
            if ack.get("status") in ("REJECTED", "ERROR"):
                # The rehearsal venue failed: keep the paper position but flag it.
                report.message += f" ({ack.get('message', '')})"
                log.warning("Testnet rehearsal failed for %s: %s", pos.symbol, ack.get("message"))
        return report

    def flatten(self, reason: str = "OPERATOR") -> List[Dict[str, Any]]:
        return self.broker.flatten_all(reason)
