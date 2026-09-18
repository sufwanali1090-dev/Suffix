"""The analytical agents — ATLAS, SCOUT, CAPITOL, ATHENA, CHARTIST, ORACLE.

Every agent implements the same interface::

    async def analyze(self, symbol: str, ctx: "DeskContext") -> AgentReport

``DeskContext`` carries the broker, sentinel, ledger, QUANTUM engine and the
TradingView MCP client, so agents pull live state instead of re-deriving it.

Each agent degrades explicitly: ``data_quality`` is one of
``live | cached | partial | simulated`` and SUFFIX (agent 10) always announces
degradation to the user rather than silently dressing up simulated numbers.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from server import indicators as ind
from server.config import settings
from server.contracts import AgentId, AgentMetric, AgentReport, DataQuality
from server.ledger import get_ledger
from server.market_data import (
    atr_based_bracket, fetch_fundamentals, fetch_institutional_flows,
    fetch_news, fetch_ohlcv, macro_snapshot, micro_snapshot, synthetic_ohlcv,
)

log = logging.getLogger("suffix.agents")


@dataclass
class DeskContext:
    """Everything an agent may need, injected by SUFFIX."""

    broker: Any
    sentinel: Any
    pilot: Any
    engine: Any                      # QuantumEngine
    mcp: Any                         # TradingViewMCP | None
    watchlist: List[str]
    symbol: str = "BTC-USD"
    timeframe: str = "1h"
    last_prices: Dict[str, float] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.last_prices is None:
            self.last_prices = {}


# --------------------------------------------------------------------------- #
#  helpers
# --------------------------------------------------------------------------- #
def _clamp(v: float, lo: float = -1.0, hi: float = 1.0) -> float:
    return float(max(lo, min(hi, v)))


def _squash(x: float, scale: float = 1.0) -> float:
    """Map any real number into (-1, 1) smoothly."""
    return _clamp(math.tanh(x / max(scale, 1e-9)))


def _frame(symbol: str, timeframe: str = "1h", bars: int = 400) -> tuple[pd.DataFrame, str]:
    res = fetch_ohlcv(symbol, timeframe, bars)
    df = res.value if isinstance(res.value, pd.DataFrame) else None
    if df is None or len(df) < 60:
        df = synthetic_ohlcv(symbol, timeframe, max(bars, 200))
        return df, "simulated"
    return df, res.quality


def _bias_from(score: float, long_th: float = 0.18, short_th: float = -0.18) -> str:
    if score > long_th:
        return "long"
    if score < short_th:
        return "short"
    return "flat"


# =========================================================================== #
#  1. ATLAS — Macro
# =========================================================================== #
class AtlasMacro:
    agent = AgentId.ATLAS
    designation = "ATLAS"
    role = "macro"

    async def analyze(self, symbol: str, ctx: DeskContext) -> AgentReport:
        t0 = time.time()
        res = await asyncio.to_thread(macro_snapshot)
        macro = res.value or {}
        rates = macro.get("rates", {})
        cii = macro.get("instability") or []
        inflation = macro.get("inflation", {})

        vix = float(rates.get("VIX", {}).get("last", 16.0))
        dxy_chg = float(rates.get("DXY", {}).get("chg_1m", 0.0))
        ten_y = float(rates.get("US10Y", {}).get("last", 4.1))
        ten_chg = float(rates.get("US10Y", {}).get("chg_1m", 0.0))
        curve = ten_y - float(rates.get("US02Y", {}).get("last", ten_y))
        gold_chg = float(rates.get("GOLD", {}).get("chg_1m", 0.0))
        cpi = float(inflation.get("us_cpi_yoy", 2.6))
        top_cii = cii[:5] if isinstance(cii, list) else []
        cii_peak = float(top_cii[0]["cii"]) if top_cii and isinstance(top_cii[0], dict) else 25.0
        is_crypto = symbol.upper().endswith("-USD")

        # Macro risk appetite composite.
        score = 0.0
        score -= _squash(vix - 17.0, 7.0) * 0.40            # fear is bearish
        score -= _squash(dxy_chg, 1.4) * 0.22               # strong dollar is bearish risk
        score -= _squash(ten_chg, 0.25) * 0.18              # rising yields tighten
        score -= _squash(cpi - 2.5, 0.6) * 0.16             # hot inflation is bearish
        score -= _squash(cii_peak - 40.0, 25.0) * 0.20      # instability is bearish
        score += _squash(gold_chg, 40.0) * 0.06
        if is_crypto:
            score -= _squash(dxy_chg, 1.4) * 0.10           # crypto is long-dollar-sensitive
        score = _clamp(score)

        curve_state = "inverted" if curve < 0 else "steepening" if curve > 1.0 else "normalizing"
        bullets = [
            f"US 10Y at {ten_y:.2f}% ({ten_chg:+.2f}% 1M); 2s10s curve {curve:+.2f}pp — {curve_state}.",
            f"VIX {vix:.2f} → risk appetite {'compressed' if vix < 15 else 'stable' if vix < 22 else 'impaired'}.",
            f"DXY 1M {dxy_chg:+.2f}%, gold 1M {gold_chg:+.2f}%; dollar {'headwind' if dxy_chg > 0 else 'tailwind'} for risk.",
            f"Top Country Instability: {top_cii[0]['country']} {top_cii[0]['cii']:.1f}"
            if top_cii else "CII snapshot unavailable.",
            f"US CPI YoY {cpi:.2f}% — next print in {inflation.get('next_print_days', '?')} days.",
        ]
        headline = (
            f"Macro regime {'SUPPORTIVE' if score > 0.15 else 'HOSTILE' if score < -0.15 else 'NEUTRAL'}; "
            f"rates {ten_y:.2f}%, VIX {vix:.1f}, instability peak {cii_peak:.0f}."
        )

        return AgentReport(
            agent=self.agent, headline=headline, bullets=bullets,
            metrics=[
                AgentMetric(label="US10Y", value=round(ten_y, 3), unit="%", delta=round(ten_chg, 3)),
                AgentMetric(label="VIX", value=round(vix, 2),
                            tone="warn" if vix > 22 else "neutral"),
                AgentMetric(label="2s10s", value=round(curve, 3), unit="pp",
                            tone="bear" if curve < 0 else "neutral"),
                AgentMetric(label="DXY 1M", value=round(dxy_chg, 3), unit="%"),
                AgentMetric(label="CII peak", value=round(cii_peak, 1),
                            tone="warn" if cii_peak > 55 else "neutral"),
                AgentMetric(label="US CPI", value=round(cpi, 2), unit="%"),
            ],
            payload={"rates": rates, "instability": top_cii, "inflation": inflation,
                     "curve_pp": round(curve, 4)},
            confidence=0.62 + 0.2 * (1.0 - abs(score)),
            bias=_bias_from(score), data_quality=res.quality,  # type: ignore[arg-type]
            latency_ms=int((time.time() - t0) * 1000),
            sources=["worldmonitor", res.source],
        )


# =========================================================================== #
#  2. SCOUT — News / sentiment
# =========================================================================== #
class ScoutNews:
    agent = AgentId.SCOUT
    designation = "SCOUT"
    role = "news"

    async def analyze(self, symbol: str, ctx: DeskContext) -> AgentReport:
        t0 = time.time()
        res = await asyncio.to_thread(fetch_news, [symbol] + ctx.watchlist[:3], 24)
        items: List[Dict[str, Any]] = res.value or []
        now = time.time()

        relevant = [i for i in items if str(i.get("symbol", "")).upper() == symbol.upper()] or items
        sentiments = [float(i.get("sentiment", 0.0)) for i in relevant]
        avg_sent = float(np.mean(sentiments)) if sentiments else 0.0

        # Headline velocity: headlines per hour over the last 6h vs the 24h mean.
        recent = [i for i in relevant if now - float(i.get("datetime", 0)) <= 6 * 3600]
        older = [i for i in relevant if 6 * 3600 < now - float(i.get("datetime", 0)) <= 24 * 3600]
        vel_now = len(recent) / 6.0
        vel_base = max(len(older) / 18.0, 0.15)
        velocity = vel_now / vel_base
        surprise = _clamp((velocity - 1.0) * 0.5) * (1.0 if avg_sent >= 0 else -1.0)

        score = _clamp(avg_sent * 0.72 + surprise * 0.35)
        divergent = len(recent) >= 4 and abs(avg_sent) < 0.2
        headline = (
            f"Headline velocity {velocity:.2f}x baseline; net sentiment {avg_sent:+.2f} "
            f"across {len(relevant)} stories"
            + (" — narrative CONFLICT, stand aside." if divergent else ".")
        )
        bullets = [
            f"{i.get('headline', '')[:150]} — {i.get('source', 'wire')} "
            f"({int((now - float(i.get('datetime', now))) / 60)}m ago, {i.get('sentiment', 0):+.2f})"
            for i in relevant[:5]
        ] or ["No fresh headlines in the ingest window."]
        if divergent:
            bullets.append("Conflicting coverage detected: sentiment variance high, signal suppressed.")

        return AgentReport(
            agent=self.agent, headline=headline, bullets=bullets,
            metrics=[
                AgentMetric(label="Net sentiment", value=round(avg_sent, 3),
                            tone="bull" if avg_sent > 0.15 else "bear" if avg_sent < -0.15 else "neutral"),
                AgentMetric(label="Headlines 6h", value=len(recent)),
                AgentMetric(label="Velocity", value=round(velocity, 3), unit="x",
                            tone="warn" if velocity > 2.0 else "neutral"),
                AgentMetric(label="Std dev", value=round(float(np.std(sentiments)), 3) if sentiments else 0.0),
            ],
            payload={"items": relevant[:12], "velocity": round(velocity, 4),
                     "conflict": divergent},
            confidence=max(0.25, min(0.9, 0.45 + 0.1 * len(recent))) if not divergent else 0.35,
            bias=_bias_from(score), data_quality=res.quality,  # type: ignore[arg-type]
            latency_ms=int((time.time() - t0) * 1000),
            sources=["finnhub", res.source] if settings.finnhub_api_key else [res.source],
        )


# =========================================================================== #
#  3. CAPITOL — Smart money
# =========================================================================== #
class CapitolFlows:
    agent = AgentId.CAPITOL
    designation = "CAPITOL"
    role = "flows"

    async def analyze(self, symbol: str, ctx: DeskContext) -> AgentReport:
        t0 = time.time()
        res = await asyncio.to_thread(fetch_institutional_flows, symbol)
        data = res.value or {}
        institutions = data.get("institutions", []) or []
        insiders = data.get("insiders", []) or []
        net_bias = float(data.get("net_insider_bias", 0.0))

        changes = [float(i.get("change_pct") or 0.0) for i in institutions]
        added = sum(1 for c in changes if c > 0.5)
        trimmed = sum(1 for c in changes if c < -0.5)
        net_pct = float(np.mean(changes)) if changes else 0.0
        concentration = float(np.sum([float(i.get("pct_held") or 0.0) for i in institutions]))

        score = _clamp(_squash(net_pct, 6.0) * 0.55 + net_bias * 0.30
                       + _squash(added - trimmed, 3.0) * 0.25)
        headline = (
            f"13F cohort {'accumulating' if net_pct > 1 else 'distributing' if net_pct < -1 else 'flat'}"
            f" ({(net_pct):+.2f}% avg position change, {added} adds / {trimmed} trims); "
            f"insider bias {net_bias:+.2f}."
        )
        bullets = []
        for inst in institutions[:4]:
            chg = float(inst.get("change_pct") or 0.0)
            bullets.append(
                f"{inst.get('holder', 'Institution')}: {float(inst.get('pct_held') or 0) * 100:.2f}% held, "
                f"{chg:+.2f}% q/q")
        for tx in insiders[:3]:
            bullets.append(f"Insider {tx.get('transaction', 'tx')} "
                           f"{float(tx.get('shares') or 0):,.0f} shares "
                           f"~${float(tx.get('value') or 0):,.0f} on {tx.get('date', 'n/a')}")
        if not bullets:
            bullets = ["No 13F or insider disclosure in the window."]

        return AgentReport(
            agent=self.agent, headline=headline, bullets=bullets,
            metrics=[
                AgentMetric(label="Avg 13F chg", value=round(net_pct, 3), unit="%",
                            tone="bull" if net_pct > 0 else "bear" if net_pct < 0 else "neutral"),
                AgentMetric(label="Adds / Trims", value=f"{added}/{trimmed}"),
                AgentMetric(label="Institutional conc.", value=round(concentration * 100, 2), unit="%"),
                AgentMetric(label="Insider bias", value=round(net_bias, 3),
                            tone="bull" if net_bias > 0.2 else "bear" if net_bias < -0.2 else "neutral"),
            ],
            payload={"institutions": institutions[:10], "insiders": insiders[:10],
                     "net_insider_bias": net_bias},
            confidence=0.55 if institutions else 0.3,
            bias=_bias_from(score), data_quality=res.quality,  # type: ignore[arg-type]
            latency_ms=int((time.time() - t0) * 1000),
            sources=["sec-13f", res.source],
        )


# =========================================================================== #
#  4. ATHENA — Fundamentals
# =========================================================================== #
class AthenaFundamentals:
    agent = AgentId.ATHENA
    designation = "ATHENA"
    role = "fundamental"

    async def analyze(self, symbol: str, ctx: DeskContext) -> AgentReport:
        t0 = time.time()
        res = await asyncio.to_thread(fetch_fundamentals, symbol)
        f = res.value or {}
        is_crypto = symbol.upper().endswith("-USD")

        def num(key: str, default: Optional[float] = None) -> Optional[float]:
            v = f.get(key)
            try:
                return float(v) if v is not None else default
            except (TypeError, ValueError):
                return default

        pe = num("pe_ttm")
        pe_fwd = num("pe_fwd")
        pb = num("pb")
        growth = num("revenue_growth", 0.0) or 0.0
        margin = num("profit_margin", 0.0) or 0.0
        roe = num("roe", 0.0) or 0.0
        d2e = num("debt_to_equity", 0.0) or 0.0
        fcf = num("free_cashflow", 0.0) or 0.0
        beta = num("beta", 1.0) or 1.0

        scores: List[Dict[str, Any]] = []
        if is_crypto:
            # Crypto has no earnings: score network/structure proxies instead.
            score = _clamp(_squash(growth, 0.35) * 0.5 - abs(_squash(beta - 1.0, 0.8)) * 0.2)
            bullets = [
                "Digital asset: balance-sheet multiples do not apply; structural proxies used.",
                f"Simulated 12M growth proxy {growth * 100:+.1f}%, beta proxy {beta:.2f}.",
                "Agent ATHENA defers valuation weight to ORACLE (probabilistic) for this asset class.",
            ]
        else:
            val_score = 0.0
            if pe and pe > 0:
                val_score -= _squash(pe - 22.0, 14.0) * 0.35
                scores.append({"metric": "PE(TTM)", "value": pe, "verdict": "cheap" if pe < 18 else "rich" if pe > 30 else "fair"})
            if pe_fwd and pe and pe_fwd < pe:
                val_score += 0.15      # forward earnings expansion
            if pb and pb > 0:
                val_score -= _squash(pb - 4.0, 5.0) * 0.15
            qual = _clamp(_squash(margin, 0.18) * 0.35 + _squash(roe, 0.18) * 0.35
                          - _squash(d2e - 80.0, 90.0) * 0.20 + _squash(fcf, 5e9) * 0.15)
            growth_s = _clamp(_squash(growth, 0.22))
            score = _clamp(val_score * 0.45 + qual * 0.35 + growth_s * 0.20)
            bullets = [
                f"Valuation: P/E {pe:.1f}x" if pe else "Valuation: P/E unavailable",
                f"Quality: net margin {margin * 100:.1f}%, ROE {roe * 100:.1f}%, D/E {d2e:.0f}%.",
                f"Growth: revenue {growth * 100:+.1f}% y/y, free cash flow ${fcf / 1e9:,.2f}B.",
                f"Beta {beta:.2f} — {'high' if beta > 1.4 else 'low' if beta < 0.8 else 'market'} volatility exposure.",
            ]

        headline = (
            f"{symbol} fundamentals "
            + ("NOT APPLICABLE (digital asset)" if is_crypto else
               f"{'CHEAP' if score > 0.2 else 'RICH' if score < -0.2 else 'FAIR'}: "
               f"quality {qual:+.2f}, valuation {val_score:+.2f}, growth {growth_s:+.2f}")
        )
        return AgentReport(
            agent=self.agent, headline=headline, bullets=bullets,
            metrics=[
                AgentMetric(label="P/E", value=round(pe, 2) if pe else "n/a"),
                AgentMetric(label="Net margin", value=round(margin * 100, 2), unit="%"),
                AgentMetric(label="Rev growth", value=round(growth * 100, 2), unit="%",
                            tone="bull" if growth > 0.1 else "bear" if growth < 0 else "neutral"),
                AgentMetric(label="ROE", value=round(roe * 100, 2), unit="%"),
                AgentMetric(label="Beta", value=round(beta, 2)),
            ],
            payload={**f, "score": round(score, 4), "valuation_flags": scores},
            confidence=0.35 if is_crypto else (0.72 if pe else 0.45),
            bias="flat" if is_crypto else _bias_from(score),
            data_quality=res.quality,  # type: ignore[arg-type]
            latency_ms=int((time.time() - t0) * 1000),
            sources=["yfinance-balance-sheet", res.source],
        )


# =========================================================================== #
#  5. CHARTIST — Technician (+ TradingView MCP)
# =========================================================================== #
class ChartistTechnician:
    agent = AgentId.CHARTIST
    designation = "CHARTIST"
    role = "technical"

    PATTERNS = ("bull_flag", "bear_flag", "double_top", "double_bottom",
                "ascending_triangle", "descending_triangle", "head_shoulders")

    def __init__(self) -> None:
        self.last_drawing: Optional[Dict[str, Any]] = None

    def _detect_pattern(self, df: pd.DataFrame) -> tuple[str, float]:
        """Lightweight structural pattern detector over the last 60 bars."""
        tail = df.tail(60)
        if len(tail) < 40:
            return "insufficient_history", 0.0
        hi, lo, cl = tail["high"].to_numpy(), tail["low"].to_numpy(), tail["close"].to_numpy()
        recent_hi, prior_hi = hi[-15:].max(), hi[-35:-15].max()
        recent_lo, prior_lo = lo[-15:].min(), lo[-35:-15].min()
        slope = np.polyfit(np.arange(20), cl[-20:], 1)[0] / max(cl[-1], 1e-9)
        range_pct = (hi[-20:].max() - lo[-20:].min()) / max(cl[-1], 1e-9)

        if abs(recent_hi - prior_hi) / max(prior_hi, 1e-9) < 0.01 and slope < 0:
            return "double_top", 0.72
        if abs(recent_lo - prior_lo) / max(prior_lo, 1e-9) < 0.01 and slope > 0:
            return "double_bottom", 0.72
        if range_pct < 0.03 and slope > 0.001:
            return "ascending_triangle", 0.6
        if range_pct < 0.03 and slope < -0.001:
            return "descending_triangle", 0.6
        if slope > 0.002:
            return "bull_flag", 0.5
        if slope < -0.002:
            return "bear_flag", 0.5
        return "range", 0.3

    async def analyze(self, symbol: str, ctx: DeskContext) -> AgentReport:
        t0 = time.time()
        df, quality = await asyncio.to_thread(_frame, symbol, ctx.timeframe, 400)
        df = ind.add_indicators(df)

        c = float(df["close"].iloc[-1])
        ema_f = float(df["ema_fast"].iloc[-1])
        ema_s = float(df["ema_slow"].iloc[-1])
        rsi_v = float(df["rsi"].iloc[-1])
        adx_v = float(df["adx"].iloc[-1])
        atr_v = float(df["atr"].iloc[-1])
        atr_pct = float(df["atr_pct"].iloc[-1])
        macd_h = float(df["macd_hist"].iloc[-1])
        macd_h_prev = float(df["macd_hist"].iloc[-2])
        st_dir = float(df["st_dir"].iloc[-1])
        vol_z = float(df["vol_z"].iloc[-1])
        bb_pos = (c - float(df["bb_lower"].iloc[-1])) / max(
            float(df["bb_upper"].iloc[-1]) - float(df["bb_lower"].iloc[-1]), 1e-9)
        dc_hi = float(df["dc_upper"].iloc[-1])
        dc_lo = float(df["dc_lower"].iloc[-1])
        pattern, pattern_conf = self._detect_pattern(df)

        trend = _squash(c - ema_s, max(atr_v * 2.0, 1e-9))
        momentum = _squash(macd_h - macd_h_prev, max(atr_v * 0.15, 1e-9))
        strength = _clamp((adx_v - 20.0) / 25.0, 0.0, 1.0)
        mean_rev = _clamp((50.0 - rsi_v) / 50.0)
        score = _clamp(trend * 0.42 + momentum * 0.26 + st_dir * 0.18
                       + mean_rev * 0.10 * (1.0 - strength) + strength * 0.04)

        structure = ("above" if c > ema_s else "below")
        bullets = [
            f"Structure: price {structure} EMA{int(df['ema_slow'].notna().sum() and 48)} "
            f"({ema_s:,.4f}); EMA fast {ema_f:,.4f}.",
            f"Momentum: RSI {rsi_v:.1f} ({'overbought' if rsi_v > 70 else 'oversold' if rsi_v < 30 else 'neutral'}), "
            f"MACD histogram {'expanding' if abs(macd_h) > abs(macd_h_prev) else 'contracting'}.",
            f"Trend strength: ADX {adx_v:.1f} — "
            f"{'strong' if adx_v > 25 else 'developing' if adx_v > 18 else 'absent'} directional conviction.",
            f"Volatility: ATR {atr_v:,.4f} ({atr_pct:.2f}% of price); volume z-score {vol_z:+.2f}.",
            f"Range: Donchian [{dc_lo:,.4f} → {dc_hi:,.4f}], Bollinger position {bb_pos * 100:.1f}%.",
            f"Pattern scan: {pattern.replace('_', ' ')} ({pattern_conf * 100:.0f}% structural confidence).",
        ]

        # Push the setup to TradingView Desktop via the MCP server when available.
        mcp_note = "MCP offline"
        if ctx.mcp is not None:
            drawing = {
                "symbol": symbol,
                "timeframe": ctx.timeframe,
                "pattern": pattern,
                "levels": {"support": round(dc_lo, 6), "resistance": round(dc_hi, 6),
                           "stop_ref": round(c - 1.5 * atr_v, 6)},
            }
            ack = await ctx.mcp.draw_setup(drawing)
            self.last_drawing = drawing
            mcp_note = ack.get("status", "failed")
            bullets.append(f"TradingView MCP: {mcp_note} — levels pushed to the desktop chart.")

        return AgentReport(
            agent=self.agent, headline=(
                f"{symbol} {ctx.timeframe}: {'BULLISH' if score > 0.2 else 'BEARISH' if score < -0.2 else 'NEUTRAL'} "
                f"structure, ADX {adx_v:.1f}, ATR {atr_pct:.2f}%, pattern {pattern.replace('_', ' ')}."),
            bullets=bullets,
            metrics=[
                AgentMetric(label="RSI", value=round(rsi_v, 2),
                            tone="bear" if rsi_v > 72 else "bull" if rsi_v < 28 else "neutral"),
                AgentMetric(label="ADX", value=round(adx_v, 2),
                            tone="bull" if adx_v > 25 else "neutral"),
                AgentMetric(label="ATR%", value=round(atr_pct, 3), unit="%"),
                AgentMetric(label="MACD hist", value=round(macd_h, 6),
                            tone="bull" if macd_h > 0 else "bear"),
                AgentMetric(label="Vol z", value=round(vol_z, 2)),
                AgentMetric(label="Pattern", value=pattern, unit=f"{pattern_conf:.0%}"),
            ],
            payload={"levels": {"price": round(c, 6), "ema_fast": round(ema_f, 6),
                                "ema_slow": round(ema_s, 6), "atr": round(atr_v, 6),
                                "donchian_high": round(dc_hi, 6), "donchian_low": round(dc_lo, 6),
                                "bb_position": round(bb_pos, 4)},
                     "pattern": pattern, "mcp": mcp_note},
            confidence=float(np.clip(0.45 + strength * 0.35 + pattern_conf * 0.12, 0.2, 0.9)),
            bias=_bias_from(score), data_quality=quality,  # type: ignore[arg-type]
            latency_ms=int((time.time() - t0) * 1000),
            sources=["suffix-indicators", "tradingview-mcp" if ctx.mcp else "mcp-disabled"],
        )


# =========================================================================== #
#  6. ORACLE — Quant probability / expected value
# =========================================================================== #
class OracleQuant:
    agent = AgentId.ORACLE
    designation = "ORACLE"
    role = "quant"

    SIMULATIONS = 4000

    async def analyze(self, symbol: str, ctx: DeskContext) -> AgentReport:
        t0 = time.time()
        df, quality = await asyncio.to_thread(_frame, symbol, ctx.timeframe, 500)
        bracket = await asyncio.to_thread(atr_based_bracket, symbol, ctx.timeframe, 14, 1.5, 2.0, "long")

        # Better brackets when a promoted QUANTUM strategy exists for this symbol.
        strat = ctx.engine.best_for(symbol) if ctx.engine else None
        if strat is not None:
            params = strat.genome.get("params", {})
            atr_len = int(params.get("atr_len", 14))
            stop_mult = float(params.get("stop_atr_mult", 1.5))
            tgt_mult = float(params.get("target_atr_mult", 2.0))
            bracket = await asyncio.to_thread(
                atr_based_bracket, symbol, ctx.timeframe, atr_len, stop_mult, tgt_mult, "long")

        entry = bracket["entry"]
        stop = bracket["stop"]
        target = bracket["target"]

        prob = await asyncio.to_thread(self._monte_carlo, df, entry, stop, target)
        p_win = prob["p_target_first"]
        stop_dist = abs(entry - stop)
        tgt_dist = abs(target - entry)
        rr = tgt_dist / max(stop_dist, 1e-12)
        risk_usd = settings.risk_min_usd
        ev = p_win * tgt_dist - (1.0 - p_win) * stop_dist
        ev_per_dollar = ev / max(stop_dist, 1e-12)
        kelly = (p_win * rr - (1.0 - p_win)) / max(rr, 1e-9)
        kelly = float(np.clip(kelly, -1.0, 1.0))

        edge = _clamp(ev_per_dollar)
        headline = (
            f"{symbol}: P(target first) = {p_win * 100:.1f}% over {self.SIMULATIONS:,} bootstrap paths; "
            f"R:R {rr:.2f}:1, EV {'+' if ev >= 0 else ''}{ev_per_dollar:.3f}R per unit risk"
            + (f" | {strat.kind} genome {strat.strategy_uid[:10]}" if strat else " | no promoted genome")
        )
        bullets = [
            f"Bracket: entry {entry:,.4f}, stop {stop:,.4f} ({stop_dist / entry * 100:.2f}%), "
            f"target {target:,.4f} ({tgt_dist / entry * 100:.2f}%).",
            f"Dollar risk at 1.0% of $100 = ${risk_usd:.2f}; expected value "
            f"{'+' if ev >= 0 else ''}${ev / max(stop_dist, 1e-12) * risk_usd:.4f} per trade.",
            f"Half-Kelly allocation suggests {max(0.0, kelly * 50):.2f}% of equity at full conviction.",
            f"Path statistics: P95 max adverse excursion {prob['p95_mae_pct']:.2f}%, "
            f"P95 max favourable excursion {prob['p95_mfe_pct']:.2f}%.",
            f"Realised vol (annualised) {prob['ann_vol_pct']:.1f}%, drift estimate {prob['drift_ann_pct']:+.1f}%.",
        ]

        return AgentReport(
            agent=self.agent, headline=headline, bullets=bullets,
            metrics=[
                AgentMetric(label="P(target)", value=round(p_win * 100, 2), unit="%",
                            tone="bull" if p_win > 0.5 else "bear"),
                AgentMetric(label="R:R", value=round(rr, 3), unit=":1"),
                AgentMetric(label="EV", value=round(ev_per_dollar, 4), unit="R",
                            tone="bull" if ev > 0 else "bear"),
                AgentMetric(label="Kelly", value=round(kelly * 100, 2), unit="%"),
                AgentMetric(label="Ann vol", value=round(prob["ann_vol_pct"], 2), unit="%"),
                AgentMetric(label="Drift", value=round(prob["drift_ann_pct"], 2), unit="%"),
            ],
            payload={"bracket": bracket, "probability": prob,
                     "strategy_uid": strat.strategy_uid if strat else None,
                     "strategy_kind": strat.kind if strat else None},
            confidence=float(np.clip(0.4 + abs(edge) * 0.4, 0.25, 0.9)),
            bias=_bias_from(edge if ev > 0 else edge, 0.05, -0.05),
            data_quality=quality,  # type: ignore[arg-type]
            latency_ms=int((time.time() - t0) * 1000),
            sources=["suffix-monte-carlo", "suffix-atr-brackets"],
        )

    # ------------------------------------------------------------------ model
    def _monte_carlo(self, df: pd.DataFrame, entry: float, stop: float,
                     target: float) -> Dict[str, float]:
        """Block-bootstrap path simulation for first-touch probabilities.

        Blocks of 5 bars preserve short-horizon autocorrelation and volatility
        clustering far better than i.i.d. resampling of returns.
        """
        closes = df["close"].to_numpy(dtype=float)
        highs = df["high"].to_numpy(dtype=float)
        lows = df["low"].to_numpy(dtype=float)
        rets = np.diff(np.log(np.maximum(closes, 1e-12)))
        rets = rets[np.isfinite(rets)]
        if rets.size < 50:
            return {"p_target_first": 0.5, "p_stop_first": 0.5, "p95_mae_pct": 0.0,
                    "p95_mfe_pct": 0.0, "ann_vol_pct": 0.0, "drift_ann_pct": 0.0,
                    "paths": self.SIMULATIONS, "horizon_bars": 60}

        horizon = 60
        block = 5
        n_blocks = int(np.ceil(horizon / block))
        rng = np.random.default_rng(abs(hash(f"{entry:.6f}{stop:.6f}{target:.6f}")) % (2**31))
        starts = rng.integers(0, max(1, rets.size - block), size=(self.SIMULATIONS, n_blocks))
        sampled = np.stack([rets[s:s + block] for s in starts.ravel()]).reshape(
            self.SIMULATIONS, n_blocks, block)
        paths = np.exp(np.cumsum(sampled.reshape(self.SIMULATIONS, -1)[:, :horizon], axis=1)) * entry

        # First-touch test using the path extremes (conservative: assumes the
        # adverse level is reached before the favourable one in the same bar).
        hit_target = paths >= target
        hit_stop = paths <= stop
        idx_t = np.where(hit_target.any(axis=1), hit_target.argmax(axis=1), horizon + 1)
        idx_s = np.where(hit_stop.any(axis=1), hit_stop.argmax(axis=1), horizon + 1)
        p_target_first = float(np.mean(idx_t < idx_s))
        p_stop_first = float(np.mean(idx_s <= idx_t))
        both_never = float(np.mean((idx_t > horizon) & (idx_s > horizon)))
        # Split the unresolved paths by which barrier is closer.
        if both_never > 0:
            closer_up = abs(target - entry) < abs(entry - stop)
            p_target_first += both_never * (1.0 if closer_up else 0.0)
            p_stop_first += both_never * (0.0 if closer_up else 1.0)

        mae = np.min(paths, axis=1) / entry - 1.0
        mfe = np.max(paths, axis=1) / entry - 1.0
        bar_vol = float(np.std(rets, ddof=1))
        bars_year = ind.annualization_factor(settings.suffix_quantum_timeframe)
        return {
            "p_target_first": round(p_target_first, 4),
            "p_stop_first": round(p_stop_first, 4),
            "p95_mae_pct": round(float(np.percentile(mae, 5) * 100.0), 4),
            "p95_mfe_pct": round(float(np.percentile(mfe, 95) * 100.0), 4),
            "ann_vol_pct": round(bar_vol * math.sqrt(bars_year) * 100.0, 3),
            "drift_ann_pct": round(float(np.mean(rets)) * bars_year * 100.0, 3),
            "paths": self.SIMULATIONS,
            "horizon_bars": horizon,
        }
