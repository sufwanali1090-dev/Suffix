"""Agents 7, 8, 9 and 11 as reporting surfaces.

SENTINEL/PILOT/LEDGER/QUANTUM already exist as live machinery
(``server.broker``, ``server.quantum``, ``server.ledger``).  This module wraps
them in the common ``AgentReport`` interface so the HUD can render all eleven
agents uniformly through one telemetry contract.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Dict, List

from server.config import settings
from server.contracts import AgentId, AgentMetric, AgentReport
from server.ledger import get_ledger


class SentinelRisk:
    agent = AgentId.SENTINEL
    designation = "SENTINEL"
    role = "risk"

    async def analyze(self, symbol: str, ctx: Any) -> AgentReport:
        t0 = time.time()
        state = ctx.sentinel.snapshot()
        account = ctx.broker.account_snapshot()
        equity = account["equity"]
        headroom = state.distance_to_death_usd
        band = settings.risk_max_usd

        tone = ("critical" if state.state in ("DEAD", "CRITICAL")
                else "warn" if state.state in ("CAUTION", "FROZEN") else "neutral")
        headline = (
            f"Risk state {state.state} | equity ${equity:,.2f} | "
            f"${headroom:,.2f} above the ${settings.suffix_death_line:,.2f} death line | "
            f"max risk ${band:.2f}/trade at {settings.allowed_leverage}x cap."
        )
        bullets = [
            f"Drawdown {state.drawdown_pct:.2f}% from peak equity ${state.peak_equity:,.2f}.",
            f"Per-trade risk band {settings.suffix_risk_min_pct:.1f}%–{settings.suffix_risk_max_pct:.1f}% "
            f"(${settings.risk_min_usd:.2f}–${settings.risk_max_usd:.2f}); leverage whitelist "
            f"{'/'.join(str(x) for x in settings.allowed_leverage)}x only.",
            f"Open positions {state.open_positions}/{settings.suffix_max_concurrent_positions}; "
            f"VETOs today {state.vetoes_today}; generation kills today {state.kills_today}.",
            f"Daily P&L ${state.daily_pnl:+,.2f} against the "
            f"-${settings.daily_loss_limit_usd:.2f} ({settings.suffix_daily_loss_limit_pct:.0f}%) limit.",
            f"Loss streak {state.consecutive_losses}"
            + (f"; cooldown until "
               f"{time.strftime('%H:%M:%SZ', time.gmtime((state.cooldown_until_ms or 0) / 1000))}"
               if state.cooldown_until_ms else "; no cooldown active."),
        ]
        if state.last_verdict:
            lv = state.last_verdict
            bullets.append(
                f"Last verdict: {lv.decision} on {lv.symbol} — "
                f"{(lv.reasons[0] if lv.reasons else 'all checks passed')[:160]}")

        return AgentReport(
            agent=self.agent, headline=headline, bullets=bullets,
            metrics=[
                AgentMetric(label="Equity", value=round(equity, 2), unit="$",
                            tone="bear" if equity < settings.suffix_death_line + 5 else "neutral"),
                AgentMetric(label="Drawdown", value=round(state.drawdown_pct, 2), unit="%",
                            tone=tone),  # type: ignore[arg-type]
                AgentMetric(label="Death buffer", value=round(headroom, 2), unit="$",
                            tone="critical" if headroom < 5 else "warn" if headroom < 12 else "neutral"),
                AgentMetric(label="Risk/trade", value=round(band, 2), unit="$"),
                AgentMetric(label="VETOs", value=state.vetoes_today),
                AgentMetric(label="Risk state", value=state.state),
            ],
            payload=state.model_dump(mode="json"),
            confidence=0.95,
            bias="flat",
            data_quality="live",
            latency_ms=int((time.time() - t0) * 1000),
            sources=["sentinel-risk-gate"],
        )


class PilotExecution:
    agent = AgentId.PILOT
    designation = "PILOT"
    role = "execution"

    async def analyze(self, symbol: str, ctx: Any) -> AgentReport:
        t0 = time.time()
        account = ctx.broker.account_snapshot()
        positions = account["open_positions"]
        venue_health = await asyncio.to_thread(ctx.pilot.testnet.health)
        book = await asyncio.to_thread(ctx.broker.mark_price, symbol)

        bullets: List[str] = []
        for p in positions:
            bullets.append(
                f"{p.symbol} {p.side.value.upper()} {p.quantity:.8f} @ {p.entry_price:,.4f} "
                f"({p.leverage}x) — uPnL ${p.unrealized_pnl:+,.4f} ({p.unrealized_pct:+.2f}%), "
                f"stop {p.stop_price:,.4f}"
                + (f", liq {p.liquidation_price:,.4f}" if p.liquidation_price else ""))
        if not bullets:
            bullets.append("Flat. No working orders.")
        bullets.append(f"Venue: {ctx.pilot.venue} | testnet "
                       f"{'reachable' if venue_health.get('reachable') else 'disabled/unreachable'}.")
        bullets.append(f"Free margin ${account['free_margin']:,.2f} of equity ${account['equity']:,.2f} "
                       f"(margin used ${account['margin_used']:,.2f}).")

        return AgentReport(
            agent=self.agent, headline=(
                f"PILOT on {ctx.pilot.venue}: {len(positions)} open position(s), "
                f"free margin ${account['free_margin']:,.2f}, mark {symbol} {book:,.4f}."),
            bullets=bullets,
            metrics=[
                AgentMetric(label="Venue", value=ctx.pilot.venue),
                AgentMetric(label="Open", value=len(positions)),
                AgentMetric(label="Margin used", value=round(account["margin_used"], 2), unit="$"),
                AgentMetric(label="Free margin", value=round(account["free_margin"], 2), unit="$"),
                AgentMetric(label="Fees/slippage", value=f"{settings.paper_fee_bps:.0f}/{settings.paper_slippage_bps:.0f}",
                            unit="bps"),
            ],
            payload={"positions": [p.model_dump(mode="json") for p in positions],
                     "venue_health": venue_health},
            confidence=0.9, bias="flat", data_quality="live",
            latency_ms=int((time.time() - t0) * 1000),
            sources=["paper-broker", "binance-testnet"],
        )


class LedgerBook:
    agent = AgentId.LEDGER
    designation = "LEDGER"
    role = "book"

    async def analyze(self, symbol: str, ctx: Any) -> AgentReport:
        t0 = time.time()
        ledger = get_ledger()
        stats = await asyncio.to_thread(ledger.stats)
        trades = await asyncio.to_thread(ledger.recent_trades, 8)
        extinct = await asyncio.to_thread(ledger.extinctions, 5)
        t = stats["trades"]

        pf = t["profit_factor"]
        pf_str = "∞" if pf == float("inf") else f"{pf:.2f}"
        bullets = [
            f"{t['trades']} closed trades: {t['wins']}W / {t['losses']}L "
            f"({t['win_rate']:.1f}% hit rate), profit factor {pf_str}.",
            f"Gross profit ${t['gross_profit']:,.2f} vs gross loss ${t['gross_loss']:,.2f} "
            f"→ net ${t['net_pnl']:+,.2f}.",
            f"Average win ${t['avg_win']:+,.4f} / average loss ${t['avg_loss']:+,.4f}; "
            f"expectancy ${t['expectancy']:+,.4f} per trade.",
            f"Graveyard: {stats['extinctions']} extinct strategies, "
            f"{stats['blacklisted']} blacklisted genomes purged from active memory.",
        ]
        for x in extinct[:3]:
            bullets.append(f"☠ {x['strategy_uid']} [{x['reason']}] sharpe {x['sharpe']:.2f}, "
                           f"PF {x['profit_factor']:.2f} — {x['detail'][:110]}")
        for tr in trades[:3]:
            bullets.append(f"{tr['symbol']} {tr['side']} {tr['status']} "
                           f"P&L ${tr['pnl']:+,.4f} ({tr['pnl_pct']:+.2f}%)")

        return AgentReport(
            agent=self.agent, headline=(
                f"The Book: {t['trades']} trades, {t['win_rate']:.1f}% hit rate, "
                f"PF {pf_str}, net ${t['net_pnl']:+,.2f}; {stats['extinctions']} strategies buried."),
            bullets=bullets,
            metrics=[
                AgentMetric(label="Trades", value=t["trades"]),
                AgentMetric(label="Win rate", value=round(t["win_rate"], 2), unit="%",
                            tone="bull" if t["win_rate"] > 50 else "bear" if t["trades"] else "neutral"),
                AgentMetric(label="Profit factor", value=pf_str),
                AgentMetric(label="Net P&L", value=round(t["net_pnl"], 2), unit="$",
                            tone="bull" if t["net_pnl"] >= 0 else "bear"),
                AgentMetric(label="Extinctions", value=stats["extinctions"], tone="warn" if stats["extinctions"] else "neutral"),
                AgentMetric(label="Blacklisted", value=stats["blacklisted"]),
            ],
            payload={"stats": stats, "recent_trades": trades, "extinctions": extinct,
                     "db_path": stats["db_path"]},
            confidence=1.0, bias="flat", data_quality="live",
            latency_ms=int((time.time() - t0) * 1000),
            sources=["sqlite-ledger"],
        )


class QuantumResearch:
    agent = AgentId.QUANTUM
    designation = "QUANTUM"
    role = "research"

    async def analyze(self, symbol: str, ctx: Any) -> AgentReport:
        t0 = time.time()
        engine = ctx.engine
        state = engine.state()
        info = engine.engine_info()
        active = engine.active_strategies(symbol)
        best = engine.best_for(symbol)

        bullets = [
            f"Generation {state.generation} — {state.status}, "
            f"{state.trials_completed}/{state.trials_total} trials scored on "
            f"{state.symbol or symbol} {state.timeframe}.",
            f"Performance Gate: OOS Sharpe > {settings.suffix_min_sharpe} AND "
            f"Profit Factor > {settings.suffix_min_profit_factor} AND "
            f"≥ {settings.suffix_min_oos_trades} trades AND zero liquidation events.",
            f"Engine: {info['sampler']} + {info['vectorbt']['version'] if info['vectorbt']['available'] else 'native'} "
            f"cross-check (optuna {info['optuna']['version']}).",
            f"Adaptive penalty: loss streak {state.loss_streak}, k = {state.penalty_k:.3f}, "
            f"reward decay ×{state.loss_pressure:.4f}.",
            f"Active memory: {state.active_strategies} strategies; "
            f"{state.extinct_total} extinctions; {state.blacklisted_total} blacklisted genomes.",
        ]
        if best:
            bullets.append(
                f"Incumbent {best.strategy_uid[:12]} [{best.kind}]: OOS Sharpe "
                f"{best.out_of_sample.sharpe:.3f}, PF {best.out_of_sample.profit_factor:.3f}, "
                f"return {best.out_of_sample.total_return_pct:+.2f}%, max DD "
                f"{best.out_of_sample.max_drawdown_pct:.2f}%.")
        else:
            bullets.append("No promoted incumbent for this symbol yet — the gate remains closed.")

        return AgentReport(
            agent=self.agent, headline=(
                f"QUANTUM gen {state.generation} ({state.status}): "
                f"{state.active_strategies} live strategies, {state.extinct_total} killed by the "
                f"performance gate, penalty decay ×{state.loss_pressure:.3f}."),
            bullets=bullets,
            metrics=[
                AgentMetric(label="Generation", value=state.generation),
                AgentMetric(label="Status", value=state.status),
                AgentMetric(label="Active", value=state.active_strategies),
                AgentMetric(label="Extinct", value=state.extinct_total, tone="warn"),
                AgentMetric(label="Best score", value=round(state.best_score, 4) if state.best_score != float("-inf") else 0.0),
                AgentMetric(label="Penalty ×", value=round(state.loss_pressure, 4),
                            tone="warn" if state.loss_pressure < 0.8 else "neutral"),
            ],
            payload={"state": state.model_dump(mode="json"), "engine": info,
                     "active_strategies": active[:10], "history": engine.history[-10:]},
            confidence=0.8, bias="flat", data_quality="live",
            latency_ms=int((time.time() - t0) * 1000),
            sources=["optuna", "vectorbt", "suffix-native-backtester"],
        )
