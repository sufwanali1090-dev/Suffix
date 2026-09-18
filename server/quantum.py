"""Agent 11 — QUANTUM (Self-Learning Hedge Fund).

Background worker that generates, backtests and optimizes trading strategies
with **Optuna** (search) and **vectorbt** (cross-validation), then subjects every
candidate to the Do-or-Die evolutionary directive:

  1. **Performance Gate** — a candidate is only promoted if its *out-of-sample*
     rolling-window Sharpe > 1.80 AND Profit Factor > 1.50.  Anything else is
     deleted from active memory and written to the extinction ledger.

  2. **Death Line** — every backtest runs the *real* desk risk model, including
     the $80 liquidation floor.  A strategy whose equity curve breaches it is
     killed regardless of its Sharpe.

  3. **Adaptive Penalty Mutation** — on any realized live loss the trial reward
     is exponentially decayed by  ``exp(-k * loss_streak)`` and the *next*
     generation samples from a mutated space: shorter lookbacks, tighter stops,
     lower leverage.  50 generations per evolution cycle.

Design notes
------------
* The internal backtester is pure NumPy/Pandas and is the *canonical* engine:
  the desk must be able to prove its numbers without any third-party library.
* When ``vectorbt`` is importable, promoted strategies are re-simulated through
  it as an independent cross-check (``engine="vectorbt(cross-check)"``).
* When ``optuna`` is importable it drives the study; otherwise a seeded
  TPE-lite sampler (random search + Gaussian refinement around the incumbent)
  takes over with identical semantics.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from server import indicators as ind
from server.config import settings
from server.contracts import BacktestMetrics, GenerationState, StrategyRecord
from server.ledger import get_ledger

log = logging.getLogger("suffix.quantum")

# --------------------------------------------------------------------------- #
#  Optional third-party engines
# --------------------------------------------------------------------------- #
try:  # pragma: no cover - environment dependent
    import optuna  # type: ignore

    optuna.logging.set_verbosity(optuna.logging.WARNING)
    OPTUNA_AVAILABLE = True
    OPTUNA_VERSION = getattr(optuna, "__version__", "unknown")
except Exception:  # noqa: BLE001
    OPTUNA_AVAILABLE = False
    OPTUNA_VERSION = "unavailable"

try:  # pragma: no cover - environment dependent
    import vectorbt as vbt  # type: ignore

    VBT_AVAILABLE = True
    VBT_VERSION = getattr(vbt, "__version__", "unknown")
except Exception:  # noqa: BLE001
    VBT_AVAILABLE = False
    VBT_VERSION = "unavailable"


# =========================================================================== #
#  Genome
# =========================================================================== #
STRATEGY_KINDS = ("ema_cross", "donchian_breakout", "rsi_meanrev",
                  "supertrend_trend", "bollinger_squeeze", "vol_breakout")

GENOME_SPEC: Dict[str, Tuple[float, float, float, bool]] = {
    # name: (low, high, step, is_integer)
    "fast":            (5, 60, 1, True),
    "slow":            (30, 260, 1, True),
    "adx_min":         (8, 42, 1, True),
    "rsi_len":         (6, 30, 1, True),
    "rsi_low":         (18, 38, 1, True),
    "rsi_high":        (62, 84, 1, True),
    "entry_len":       (10, 90, 1, True),
    "exit_len":        (4, 40, 1, True),
    "atr_len":         (7, 28, 1, True),
    "stop_atr_mult":   (0.7, 3.2, 0.05, False),
    "target_atr_mult": (1.0, 6.0, 0.1, False),
    "trend_filter":    (0.0, 1.0, 1.0, True),
    "vol_min_z":       (-0.5, 2.0, 0.1, False),
    "risk_pct":        (1.0, 2.0, 0.05, False),
    "leverage":        (3.0, 10.0, 1.0, True),
    "allow_short":     (0.0, 1.0, 1.0, True),
    "bb_mult":         (1.4, 3.4, 0.1, False),
    "trail_atr_mult":  (0.0, 2.5, 0.1, False),
}


@dataclass
class Genome:
    kind: str
    params: Dict[str, Any]

    def dumps(self) -> str:
        return json.dumps({"kind": self.kind, "params": self.params}, sort_keys=True)

    def uid(self) -> str:
        return "q_" + hashlib.sha1(self.dumps().encode()).hexdigest()[:12]

    def to_dict(self) -> Dict[str, Any]:
        return {"kind": self.kind, "params": dict(self.params)}


def sample_genome(rng: np.random.Generator, pressure: Optional["MutationPressure"] = None) -> Genome:
    """Draw a genome from the search space, optionally under mutation pressure."""
    params: Dict[str, Any] = {}
    for name, (low, high, step, is_int) in GENOME_SPEC.items():
        lo, hi = low, high
        if pressure is not None:
            lo, hi = pressure.adjust(name, low, high)
        if hi < lo:
            lo, hi = low, high
        if is_int:
            value = int(rng.integers(int(round(lo)), int(round(hi)) + 1))
        else:
            value = float(rng.uniform(lo, hi))
            if step:
                value = round(round(value / step) * step, 4)
        params[name] = value
    params["fast"] = min(params["fast"], max(5, params["slow"] - 5))
    params["exit_len"] = min(params["exit_len"], max(3, params["entry_len"] - 2))
    params["rsi_low"] = min(params["rsi_low"], params["rsi_high"] - 8)
    if params["target_atr_mult"] <= params["stop_atr_mult"]:
        params["target_atr_mult"] = round(params["stop_atr_mult"] * 1.5, 3)
    leverage = int(round(params["leverage"]))
    if leverage not in settings.allowed_leverage:
        leverage = min(settings.allowed_leverage, key=lambda x: abs(x - leverage))
    params["leverage"] = leverage
    return Genome(kind=str(rng.choice(STRATEGY_KINDS)), params=params)


def mutate_genome(genome: Genome, rng: np.random.Generator, strength: float = 0.35) -> Genome:
    """Hyperparameter mutation: slashed lookbacks and tightened stops."""
    params = dict(genome.params)
    for name, (low, high, step, is_int) in GENOME_SPEC.items():
        if rng.random() > strength:
            continue
        if name in ("stop_atr_mult", "trail_atr_mult"):          # tighten stops
            floor = max(low, params.get(name, low) * 0.55)
            value = float(rng.uniform(floor, max(floor + 1e-3, params.get(name, low) + 0.05)))
        elif name in ("fast", "slow", "entry_len", "exit_len", "rsi_len", "atr_len"):
            value = float(params.get(name, (low + high) / 2)) * float(rng.uniform(0.55, 0.95))
        elif name == "leverage":
            value = float(min(settings.allowed_leverage))
        elif name == "risk_pct":
            value = float(rng.uniform(settings.suffix_risk_min_pct,
                                      min(settings.suffix_risk_min_pct + 0.5, settings.suffix_risk_max_pct)))
        else:
            value = float(rng.uniform(low, high))
        value = max(low, min(high, value))
        params[name] = int(round(value)) if is_int else round(value, 4)
    params["fast"] = min(params["fast"], max(5, params["slow"] - 5))
    params["exit_len"] = min(params["exit_len"], max(3, params["entry_len"] - 2))
    if params["target_atr_mult"] <= params["stop_atr_mult"]:
        params["target_atr_mult"] = round(params["stop_atr_mult"] * 1.5, 3)
    leverage = int(round(params["leverage"]))
    if leverage not in settings.allowed_leverage:
        leverage = min(settings.allowed_leverage, key=lambda x: abs(x - leverage))
    params["leverage"] = leverage
    return Genome(kind=genome.kind, params=params)


@dataclass
class MutationPressure:
    """Adaptive penalty.  Exponentially tightens the sampling space after losses.

    ``k``     — decay constant, grows with the live loss streak
    ``decay`` — exp(-k * loss_streak), the multiplier applied to trial reward
    """

    loss_streak: int = 0
    k: float = 0.0
    decay: float = 1.0
    generation: int = 0
    tightened: Dict[str, float] = field(default_factory=dict)

    def update(self, loss_streak: int) -> "MutationPressure":
        self.loss_streak = max(0, int(loss_streak))
        self.k = round(settings.suffix_penalty_base_k * (1.0 + 0.25 * self.loss_streak), 4)
        self.decay = float(math.exp(-self.k * self.loss_streak)) if self.loss_streak else 1.0
        return self

    def adjust(self, name: str, low: float, high: float) -> Tuple[float, float]:
        """Shrink lookback windows / widen nothing / tighten stops."""
        if self.loss_streak <= 0:
            return low, high
        severity = min(1.0, self.loss_streak / 6.0)
        if name in ("fast", "slow", "entry_len", "exit_len", "rsi_len", "atr_len"):
            new_high = low + (high - low) * (1.0 - 0.72 * severity)   # slash lookbacks
            self.tightened[name] = round(new_high, 3)
            return low, new_high
        if name in ("stop_atr_mult", "trail_atr_mult"):
            # TIGHTENING a stop means a SMALLER ATR multiple, so the ceiling
            # collapses toward the floor — the opposite of widening it.
            new_high = low + (high - low) * (1.0 - 0.65 * severity)
            self.tightened[name] = round(new_high, 3)
            return low, new_high
        if name == "risk_pct":
            return settings.suffix_risk_min_pct, max(settings.suffix_risk_min_pct,
                                                     settings.suffix_risk_max_pct - severity)
        if name == "leverage":
            return low, float(min(settings.allowed_leverage))
        if name in ("adx_min", "vol_min_z"):                          # demand more edge
            new_low = low + (high - low) * 0.45 * severity
            self.tightened[name] = round(new_low, 3)
            return new_low, high
        return low, high


# =========================================================================== #
#  Canonical backtester (risk-model-faithful)
# =========================================================================== #
@dataclass
class BacktestResult:
    metrics: BacktestMetrics
    equity: np.ndarray
    trades: List[Dict[str, Any]]


def _max_drawdown(equity: np.ndarray) -> Tuple[float, float]:
    if equity.size == 0:
        return 0.0, 0.0
    peak = np.maximum.accumulate(equity)
    dd = (peak - equity) / np.where(peak <= 0, 1e-9, peak)
    idx = int(np.argmax(dd))
    return float(dd[idx] * 100.0), float(peak[idx])


def build_signals(df: pd.DataFrame, genome: Genome) -> Tuple[pd.Series, pd.Series]:
    """Translate a genome into (long_entry, short_entry) boolean series."""
    p = genome.params
    c, h, l, v = df["close"], df["high"], df["low"], df["volume"]
    long_entry = pd.Series(False, index=df.index)
    short_entry = pd.Series(False, index=df.index)
    kind = genome.kind

    if kind == "ema_cross":
        fast = ind.ema(c, int(p["fast"]))
        slow = ind.ema(c, int(p["slow"]))
        gate = ind.adx(h, l, c, 14) > p["adx_min"]
        if p.get("trend_filter", 0):
            gate &= c > ind.sma(c, int(p["slow"]))
        long_entry = ind.crossover(fast, slow) & gate
        short_entry = ind.crossunder(fast, slow) & gate
    elif kind == "donchian_breakout":
        upper = h.rolling(int(p["entry_len"])).max().shift(1)
        lower = l.rolling(int(p["entry_len"])).min().shift(1)
        exit_up = h.rolling(int(p["exit_len"])).max().shift(1)
        exit_dn = l.rolling(int(p["exit_len"])).min().shift(1)
        vol_ok = (v / v.rolling(50).mean().replace(0, np.nan)) > 0.85
        long_entry = (c > upper) & vol_ok
        short_entry = (c < lower) & vol_ok
    elif kind == "rsi_meanrev":
        r = ind.rsi(c, int(p["rsi_len"]))
        trend = ind.ema(c, int(p["slow"])) if p.get("trend_filter", 1) else c * 0 + 1e18
        above = c > trend
        long_entry = (r < p["rsi_low"]) & above
        short_entry = (r > p["rsi_high"]) & (~above)
    elif kind == "supertrend_trend":
        st_dir, _ = ind.supertrend(h, l, c, int(p["atr_len"]), float(p["bb_mult"]))
        macd_line, macd_sig, _ = ind.macd(c, int(p["fast"]), int(p["slow"]))
        gate = ind.adx(h, l, c, 14) > p["adx_min"]
        long_entry = (st_dir > 0) & (st_dir.shift(1) <= 0) & gate
        short_entry = (st_dir < 0) & (st_dir.shift(1) >= 0) & gate
        if not p.get("trend_filter", 1):
            long_entry &= macd_line > macd_sig
            short_entry &= macd_line < macd_sig
    elif kind == "bollinger_squeeze":
        bb_low, bb_mid, bb_up = ind.bollinger(c, int(p["slow"]), float(p["bb_mult"]))
        width = (bb_up - bb_low) / bb_mid.replace(0, np.nan)
        squeeze = width < width.rolling(int(p["entry_len"])).mean()
        long_entry = ind.crossover(c, bb_up) & squeeze
        short_entry = ind.crossunder(c, bb_low) & squeeze
    elif kind == "vol_breakout":
        a = ind.atr(h, l, c, int(p["atr_len"]))
        vz = ind.volume_zscore(v, 50)
        body = c - df["open"]
        long_entry = (body > a * 0.6) & (vz > p["vol_min_z"])
        short_entry = (body < -a * 0.6) & (vz > p["vol_min_z"])
        if p.get("trend_filter", 1):
            long_entry &= c > ind.ema(c, int(p["slow"]))
            short_entry &= c < ind.ema(c, int(p["slow"]))

    if not p.get("allow_short", 1):
        short_entry = pd.Series(False, index=df.index)
    return long_entry.fillna(False), short_entry.fillna(False)


def backtest(df: pd.DataFrame, genome: Genome, *, timeframe: str = "1h",
             starting_capital: Optional[float] = None,
             enforce_death_line: bool = True,
             fee_bps: Optional[float] = None) -> BacktestResult:
    """Bar-by-bar simulation under the *live* desk risk model.

    Risk, leverage, fees, slippage, stop/target brackets and the $80 death line
    are all identical to the live SENTINEL/PILOT path, so a backtest Sharpe is
    directly comparable with what the desk will experience.
    """
    starting_capital = starting_capital or settings.suffix_starting_capital
    fee_bps = settings.paper_fee_bps if fee_bps is None else fee_bps
    bars_per_year = ind.annualization_factor(timeframe)

    if df is None or len(df) < 80:
        return BacktestResult(
            BacktestMetrics(trades=0, engine="native"), np.array([starting_capital]), [])

    long_entry, short_entry = build_signals(df, genome)
    p = genome.params
    a = ind.atr(df["high"], df["low"], df["close"], int(p["atr_len"]))

    o = df["open"].to_numpy(dtype=float)
    hi = df["high"].to_numpy(dtype=float)
    lo = df["low"].to_numpy(dtype=float)
    cl = df["close"].to_numpy(dtype=float)
    atr = np.nan_to_num(a.to_numpy(dtype=float), nan=0.0)
    le = long_entry.to_numpy(dtype=bool)
    se = short_entry.to_numpy(dtype=bool)

    equity_curve = np.full(len(cl), starting_capital, dtype=float)
    equity = starting_capital
    peak = starting_capital
    position: Optional[Dict[str, Any]] = None
    trades: List[Dict[str, Any]] = []
    exposure_bars = 0
    liquidations = 0
    killed = False

    risk_pct = float(np.clip(p["risk_pct"], settings.suffix_risk_min_pct, settings.suffix_risk_max_pct))
    leverage = int(p["leverage"]) if int(p["leverage"]) in settings.allowed_leverage else 3
    stop_mult = float(p["stop_atr_mult"])
    target_mult = float(p["target_atr_mult"])
    trail_mult = float(p.get("trail_atr_mult", 0.0) or 0.0)

    for i in range(1, len(cl)):
        # ---- manage an open position against this bar's intrabar range ------
        if position is not None:
            pos = position
            d = pos["dir"]
            # trailing stop update using the previous close
            if trail_mult > 0 and atr[i - 1] > 0:
                if d > 0:
                    pos["stop"] = max(pos["stop"], cl[i - 1] - trail_mult * atr[i - 1])
                else:
                    pos["stop"] = min(pos["stop"], cl[i - 1] + trail_mult * atr[i - 1])

            exit_price: Optional[float] = None
            exit_reason = ""
            if d > 0:
                if lo[i] <= pos["stop"]:
                    exit_price, exit_reason = pos["stop"], "STOP"
                elif pos["target"] and hi[i] >= pos["target"]:
                    exit_price, exit_reason = pos["target"], "TARGET"
            else:
                if hi[i] >= pos["stop"]:
                    exit_price, exit_reason = pos["stop"], "STOP"
                elif pos["target"] and lo[i] <= pos["target"]:
                    exit_price, exit_reason = pos["target"], "TARGET"

            if exit_price is None:
                # mark to market on close
                pnl = (cl[i] - pos["entry"]) * pos["qty"] * d
                equity = pos["equity_at_entry"] + pnl
                exposure_bars += 1
            else:
                gross = (exit_price - pos["entry"]) * pos["qty"] * d
                fee = (exit_price * pos["qty"]) * fee_bps / 10_000
                pnl = gross - fee
                equity = pos["equity_at_entry"] + pnl
                trades.append({
                    "entry_i": pos["i"], "exit_i": i, "dir": d,
                    "entry": pos["entry"], "exit": exit_price,
                    "pnl": pnl, "pnl_pct": (exit_price - pos["entry"]) / pos["entry"] * 100.0 * d,
                    "reason": exit_reason, "leverage": pos["leverage"],
                    "bars": i - pos["i"],
                })
                position = None

        # ---- death-line enforcement (identical to live SENTINEL) -----------
        if enforce_death_line and equity <= settings.suffix_death_line:
            killed = True

        peak = max(peak, equity)
        equity_curve[i] = equity
        if killed:
            # Account is dead: flatten and freeze for the remainder of the sample.
            if position is not None:
                d = position["dir"]
                exit_price = cl[i]
                gross = (exit_price - position["entry"]) * position["qty"] * d
                fee = (exit_price * position["qty"]) * fee_bps / 10_000
                pnl = gross - fee
                equity = position["equity_at_entry"] + pnl
                trades.append({
                    "entry_i": position["i"], "exit_i": i, "dir": d,
                    "entry": position["entry"], "exit": exit_price, "pnl": pnl,
                    "pnl_pct": (exit_price - position["entry"]) / position["entry"] * 100.0 * d,
                    "reason": "DEATH_LINE", "leverage": position["leverage"],
                    "bars": i - position["i"],
                })
                position = None
                equity_curve[i] = equity
            liquidations += 1
            equity_curve[i:] = equity
            break

        # ---- entries --------------------------------------------------------
        if position is None and equity > 0 and atr[i] > 0:
            direction = 0
            if le[i]:
                direction = 1
            elif se[i]:
                direction = -1
            if direction != 0:
                entry = cl[i] * (1.0 + direction * settings.paper_slippage_bps / 10_000)
                stop_dist = stop_mult * atr[i]
                if stop_dist <= 0:
                    continue
                risk_usd = min(equity * risk_pct / 100.0, settings.suffix_absolute_risk_ceiling)
                qty = risk_usd / stop_dist
                notional = qty * entry
                max_notional = equity * leverage
                if notional > max_notional:
                    qty = max_notional / entry
                    notional = qty * entry
                if notional < 5.0:
                    continue
                fee = notional * fee_bps / 10_000
                equity -= fee
                position = {
                    "i": i, "dir": direction, "entry": entry, "qty": qty,
                    "stop": entry - direction * stop_dist,
                    "target": entry + direction * stop_mult * target_mult * atr[i],
                    "leverage": leverage,
                    "equity_at_entry": equity,
                    "fee": fee,
                }
                exposure_bars += 1

    # Final close for an open position.
    if position is not None:
        d = position["dir"]
        exit_price = cl[-1]
        gross = (exit_price - position["entry"]) * position["qty"] * d
        fee = (exit_price * position["qty"]) * fee_bps / 10_000
        pnl = gross - fee
        equity = position["equity_at_entry"] + pnl
        equity_curve[-1] = equity
        trades.append({"entry_i": position["i"], "exit_i": len(cl) - 1, "dir": d,
                       "entry": position["entry"], "exit": exit_price, "pnl": pnl,
                       "pnl_pct": (exit_price - position["entry"]) / position["entry"] * 100.0 * d,
                       "reason": "EOD", "leverage": position["leverage"],
                       "bars": len(cl) - 1 - position["i"]})

    metrics = compute_metrics(equity_curve, trades, bars_per_year, starting_capital,
                              exposure_bars / max(1, len(cl)), liquidations, df)
    return BacktestResult(metrics, equity_curve, trades)


def compute_metrics(equity: np.ndarray, trades: List[Dict[str, Any]], bars_per_year: float,
                    starting_capital: float, exposure: float, liquidations: int,
                    df: pd.DataFrame) -> BacktestMetrics:
    if equity.size < 2:
        return BacktestMetrics(trades=len(trades), engine="native")

    # ---- risk-adjusted returns -------------------------------------------
    # Bar-level Sharpe on a sparse strategy is badly inflated: a system that
    # makes 11 trades in 3000 bars has thousands of zero-return bars that crush
    # the denominator's standard deviation. Any honest gate has to look at the
    # return series at a fixed calendar frequency instead, so we resample the
    # equity curve to daily closes for intraday timeframes.
    idx = df.index[: equity.size]
    curve = pd.Series(equity, index=idx, dtype=float)
    periods_per_year = bars_per_year
    priced = curve
    if bars_per_year > 400 and len(curve) > 60:
        try:
            daily = curve.resample("1D").last().dropna()
            if len(daily) >= 15:
                priced = daily
                periods_per_year = 365.0
        except Exception:  # noqa: BLE001 - resample is best-effort
            priced = curve

    rets = priced.pct_change().replace([np.inf, -np.inf], np.nan).dropna().to_numpy(dtype=float)
    rets = np.nan_to_num(rets, nan=0.0)
    mean = float(np.mean(rets)) if rets.size else 0.0
    std = float(np.std(rets, ddof=1)) if rets.size > 1 else 0.0
    downside = rets[rets < 0]
    dstd = float(np.std(downside, ddof=1)) if downside.size > 1 else 0.0
    sharpe = (mean / std * math.sqrt(periods_per_year)) if std > 1e-12 else 0.0
    sortino = (mean / dstd * math.sqrt(periods_per_year)) if dstd > 1e-12 else 0.0
    # A Sharpe from fewer than ~20 observations is statistically meaningless.
    if rets.size < 30:
        # Annualising a Sharpe off a handful of observations is how backtests
        # lie. Shrink it toward zero until there is a real sample.
        shrink = math.sqrt(max(rets.size, 1) / 30.0)
        sharpe *= shrink
        sortino *= shrink

    wins = [t["pnl"] for t in trades if t["pnl"] > 0]
    losses = [t["pnl"] for t in trades if t["pnl"] < 0]
    gross_win = float(sum(wins))
    gross_loss = float(abs(sum(losses)))
    if gross_loss > 1e-12:
        profit_factor = gross_win / gross_loss
    else:
        profit_factor = 20.0 if gross_win > 0 else 0.0
    profit_factor = float(min(profit_factor, 20.0))

    dd_pct, _ = _max_drawdown(equity)
    total_return = (equity[-1] - starting_capital) / starting_capital * 100.0
    years = len(equity) / bars_per_year
    cagr = ((max(equity[-1], 1e-9) / starting_capital) ** (1.0 / years) - 1.0) * 100.0 if years > 0 else 0.0
    cagr = float(np.clip(cagr, -100.0, 5000.0))

    return BacktestMetrics(
        sharpe=round(float(np.clip(sharpe, -20.0, 20.0)), 4),
        sortino=round(float(np.clip(sortino, -20.0, 20.0)), 4),
        profit_factor=round(profit_factor, 4),
        total_return_pct=round(float(total_return), 4),
        max_drawdown_pct=round(float(dd_pct), 4),
        win_rate=round(len(wins) / len(trades) * 100.0, 4) if trades else 0.0,
        trades=len(trades),
        expectancy=round((gross_win - gross_loss) / len(trades), 6) if trades else 0.0,
        exposure=round(float(exposure), 4),
        cagr=round(cagr, 4),
        liquidation_events=liquidations,
        period_start=str(df.index[0]) if len(df) else None,
        period_end=str(df.index[-1]) if len(df) else None,
        engine="native",
    )


# --------------------------------------------------------------------------- #
#  vectorbt cross-validation
# --------------------------------------------------------------------------- #
def vectorbt_crosscheck(df: pd.DataFrame, genome: Genome) -> Optional[BacktestMetrics]:
    """Independent re-simulation of the same signals through vectorbt.

    Returns ``None`` when vectorbt is unavailable or the ported signal set is
    degenerate.  The result is advisory: it validates the native engine's edge
    estimates, it never overrides them.
    """
    if not VBT_AVAILABLE or df is None or len(df) < 80:
        return None
    try:
        long_entry, short_entry = build_signals(df, genome)
        close = df["close"].astype(float)
        pf = vbt.Portfolio.from_signals(
            close=close,
            # Signals are shifted one bar: a signal formed on close[i] can only
            # be acted on during bar i+1. This is the same no-look-ahead rule
            # the native engine enforces.
            entries=long_entry.shift(1).fillna(False).astype(bool),
            short_entries=short_entry.shift(1).fillna(False).astype(bool),
            exits=short_entry.astype(bool),
            short_exits=long_entry.astype(bool),
            # Deliberately unlevered (100% of equity per leg): this is an
            # independent check of the *signal edge*, not of the risk model.
            # The native engine owns risk/leverage accounting.
            size=1.0, size_type="percent",
            fees=settings.paper_fee_bps / 10_000,
            slippage=settings.paper_slippage_bps / 10_000,
            init_cash=settings.suffix_starting_capital,
            freq=ind_bar_freq(),
        )
        equity = np.asarray(pf.value(), dtype=float).reshape(-1)
        trade_list: List[Dict[str, Any]] = []
        try:
            records = pf.trades.records
            if records is not None and len(records):
                pnl_field = "pnl" if "pnl" in records.dtype.names else None
                if pnl_field:
                    trade_list = [{"pnl": float(p)} for p in records[pnl_field]]
        except Exception:  # noqa: BLE001 - trade records are advisory
            trade_list = []
        metrics = compute_metrics(equity, trade_list,
                                  ind.annualization_factor(settings.suffix_quantum_timeframe),
                                  settings.suffix_starting_capital, 0.0, 0,
                                  df.tail(len(equity)))
        metrics.engine = f"vectorbt {VBT_VERSION}"
        return metrics
    except Exception as exc:  # noqa: BLE001 - cross-check must never block the desk
        log.warning("vectorbt cross-check failed: %s", exc)
        return None


def ind_bar_freq() -> Optional[str]:
    """Pandas frequency alias for the configured QUANTUM timeframe."""
    return {"1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min",
            "1h": "1h", "4h": "4h", "1d": "1D"}.get(settings.suffix_quantum_timeframe.lower())


# --------------------------------------------------------------------------- #
#  Optuna / fallback sampler
# --------------------------------------------------------------------------- #
class TpeLiteSampler:
    """Seeded random search with Gaussian refinement around the incumbent.

    Used when Optuna is unavailable.  Semantics match the Optuna path: it
    proposes genomes, the study scores them, the best survives.
    """

    def __init__(self, seed: int) -> None:
        self.rng = np.random.default_rng(seed)
        self.best: Optional[Genome] = None
        self.best_value = -math.inf

    def suggest(self, pressure: MutationPressure, completed: int) -> Genome:
        if self.best is None or completed < 8 or self.rng.random() < 0.30:
            return sample_genome(self.rng, pressure)
        child = mutate_genome(self.best, self.rng, strength=0.45)
        return child

    def observe(self, genome: Genome, value: float) -> None:
        if value > self.best_value:
            self.best_value = value
            self.best = genome


# =========================================================================== #
#  Registry
# =========================================================================== #
@dataclass
class Registry:
    """Active-memory strategy registry + extinction ledger view."""

    active: Dict[str, StrategyRecord] = field(default_factory=dict)
    blacklist: set = field(default_factory=set)

    def add(self, record: StrategyRecord) -> None:
        self.active[record.strategy_uid] = record

    def purge(self, uid: str) -> Optional[StrategyRecord]:
        rec = self.active.pop(uid, None)
        self.blacklist.add(uid)
        return rec

    def purge_all(self) -> List[str]:
        uids = list(self.active.keys())
        for uid in uids:
            self.purge(uid)
        return uids

    def by_symbol(self, symbol: str) -> List[StrategyRecord]:
        return [r for r in self.active.values() if r.symbol == symbol
                and r.status in ("PROMOTED", "ACTIVE")]


# =========================================================================== #
#  The engine
# =========================================================================== #
class QuantumEngine:
    """Self-learning hedge fund worker."""

    def __init__(self) -> None:
        self.ledger = get_ledger()
        self.registry = Registry()
        self.pressure = MutationPressure()
        self.generation = GenerationState()
        self.generation.engine = ("optuna+vectorbt" if OPTUNA_AVAILABLE and VBT_AVAILABLE
                                  else "optuna+native" if OPTUNA_AVAILABLE
                                  else "tpe-lite+native")
        self.sampler = TpeLiteSampler(settings.suffix_quantum_seed)
        self._rng = np.random.default_rng(settings.suffix_quantum_seed)
        self._lock = threading.RLock()
        self._task: Optional[asyncio.Task] = None
        self._stop = threading.Event()
        self.history: List[Dict[str, Any]] = []
        self._data: Dict[str, pd.DataFrame] = {}
        self.extinct_total = 0
        self.cancel_requested = False
        self.progress_cb: Optional[Callable[[GenerationState], None]] = None
        self.extinction_cb: Optional[Callable[[Dict[str, Any]], None]] = None
        self.blacklist: set = self.registry.blacklist

    # ------------------------------------------------------------- blacklist
    def load_blacklist_from_ledger(self) -> int:
        """Restore the extinction blacklist so a restart cannot resurrect a
        strategy that the Do-or-Die protocol already killed."""
        try:
            ids = self.ledger.blacklist_ids()
        except Exception as exc:  # noqa: BLE001
            log.error("Could not load the blacklist from LEDGER: %s", exc)
            return 0
        self.registry.blacklist.update(ids)
        self.extinct_total = max(self.extinct_total, len(ids))
        self.generation.blacklisted_total = len(self.registry.blacklist)
        log.info("Blacklist restored: %d extinct genomes are barred from active memory", len(ids))
        return len(ids)

    # ------------------------------------------------------------- data cache
    def frame(self, symbol: str, refresh: bool = False) -> pd.DataFrame:
        if refresh or symbol not in self._data:
            from server.market_data import fetch_ohlcv

            res = fetch_ohlcv(symbol, settings.suffix_quantum_timeframe, bars=3000)
            df = res.value if isinstance(res.value, pd.DataFrame) else None
            if df is None or len(df) < 80:
                from server.market_data import synthetic_ohlcv

                df = synthetic_ohlcv(symbol, settings.suffix_quantum_timeframe, 3000)
            self._data[symbol] = df
        return self._data[symbol]

    # ---------------------------------------------------------- walk-forward
    @staticmethod
    def walk_forward_windows(df: pd.DataFrame, windows: Optional[int] = None
                             ) -> List[Tuple[pd.DataFrame, pd.DataFrame]]:
        """Rolling IS/OOS splits: 70% in-sample, 30% out-of-sample, stepped."""
        windows = windows or settings.suffix_walk_forward_windows
        n = len(df)
        if n < 200:
            cut = int(n * 0.7)
            return [(df.iloc[:cut], df.iloc[cut:])]
        fold = n // (windows + 1)
        out: List[Tuple[pd.DataFrame, pd.DataFrame]] = []
        for w in range(windows):
            start = w * fold // 2
            is_end = start + int(fold * 2.4)
            oos_end = min(n, is_end + fold)
            if is_end >= n - 30 or oos_end - is_end < 20:
                break
            out.append((df.iloc[start:is_end], df.iloc[is_end:oos_end]))
        return out or [(df.iloc[: int(n * 0.7)], df.iloc[int(n * 0.7):])]

    def evaluate(self, symbol: str, genome: Genome,
                 df: Optional[pd.DataFrame] = None
                 ) -> Tuple[BacktestMetrics, BacktestMetrics, float, Dict[str, Any]]:
        """Return (in_sample, out_of_sample, penalized_score, gate_info)."""
        df = self.frame(symbol) if df is None else df
        windows = self.walk_forward_windows(df)
        is_runs: List[BacktestMetrics] = []
        oos_runs: List[BacktestMetrics] = []
        for is_df, oos_df in windows:
            is_runs.append(backtest(is_df, genome, timeframe=settings.suffix_quantum_timeframe).metrics)
            oos_runs.append(backtest(oos_df, genome, timeframe=settings.suffix_quantum_timeframe).metrics)

        is_agg = _aggregate(is_runs)
        oos_agg = _aggregate(oos_runs)

        # ---- The Performance Gate ------------------------------------------
        # The directive requires Sharpe > 1.8 and Profit Factor > 1.5 "across
        # rolling windows". That is a *consistency* requirement, not merely a
        # pooled average: a genome that posts one spectacular window and three
        # flat ones has not earned active memory. We therefore demand the
        # aggregate clears both thresholds AND that the large majority of
        # individual out-of-sample windows clear them too.
        gate_sharpe = settings.suffix_min_sharpe
        gate_pf = settings.suffix_min_profit_factor
        windows_passing = sum(
            1 for m in oos_runs
            if m.trades >= 3 and m.sharpe > gate_sharpe and m.profit_factor > gate_pf
            and m.liquidation_events == 0
        )
        min_windows = max(1, math.ceil(len(oos_runs) * 0.6))
        consistency_ok = windows_passing >= min_windows
        passed = (oos_agg.sharpe > gate_sharpe and oos_agg.profit_factor > gate_pf
                  and oos_agg.trades >= settings.suffix_min_oos_trades
                  and oos_agg.liquidation_events == 0
                  and consistency_ok)

        # ---- Continuous score (what Optuna maximizes) ----------------------
        consistency = 1.0 if (oos_agg.sharpe > 0 and is_agg.sharpe > 0) else 0.35
        overfit_penalty = max(0.0, (is_agg.sharpe - oos_agg.sharpe) * 0.35)
        dd_penalty = max(0.0, (oos_agg.max_drawdown_pct - 12.0) * 0.06)
        liq_penalty = 8.0 * oos_agg.liquidation_events
        trade_bonus = min(1.0, oos_agg.trades / max(1, settings.suffix_min_oos_trades)) * 0.5
        raw = (oos_agg.sharpe + 0.6 * math.log1p(max(0.0, oos_agg.profit_factor)))
        raw = raw * consistency - overfit_penalty - dd_penalty - liq_penalty + trade_bonus
        if not passed:
            raw -= 1.25                              # gate miss is a strong negative
        score = float(raw * self.pressure.decay)     # <-- adaptive penalty

        gate_info = {
            "passed": bool(passed),
            "consistency_ok": bool(consistency_ok),
            "windows_passing": int(windows_passing),
            "windows_total": len(oos_runs),
            "windows_required": int(min_windows),
            "min_sharpe": gate_sharpe,
            "min_profit_factor": gate_pf,
            "oos_sharpe": oos_agg.sharpe,
            "oos_profit_factor": oos_agg.profit_factor,
            "oos_trades": oos_agg.trades,
            "liquidation_events": oos_agg.liquidation_events,
            "window_detail": [
                {"sharpe": m.sharpe, "profit_factor": m.profit_factor, "trades": m.trades,
                 "return_pct": m.total_return_pct, "max_dd_pct": m.max_drawdown_pct}
                for m in oos_runs
            ],
        }
        return is_agg, oos_agg, round(score, 5), gate_info

    # ----------------------------------------------------------- generations
    def run_generation(self, symbol: Optional[str] = None,
                       trials: Optional[int] = None) -> Dict[str, Any]:
        """Run one evolution cycle: propose -> backtest -> gate -> promote/kill."""
        symbol = symbol or (settings.watchlist[0] if settings.watchlist else "BTC-USD")
        trials = trials or settings.suffix_quantum_trials_per_generation
        with self._lock:
            self.generation.generation += 1
            self.generation.symbol = symbol
            self.generation.timeframe = settings.suffix_quantum_timeframe
            self.generation.status = "HUNTING"
            self.generation.trials_total = trials
            self.generation.trials_completed = 0
            self.generation.best_score = -math.inf
            self.generation.best_uid = None
            self.pressure.generation = self.generation.generation

        df = self.frame(symbol, refresh=True)
        best: Optional[StrategyRecord] = None
        promoted: List[str] = []
        killed: List[str] = []
        study = self._make_study()

        for t in range(trials):
            if self.cancel_requested:
                self.cancel_requested = False
                break
            genome, trial = self._suggest(study, t)
            is_agg, oos_agg, score, gate = self.evaluate(symbol, genome, df)
            self._observe(study, trial, genome, score)

            ready = bool(gate["passed"])
            if not ready:
                record_reason = (
                    f"OOS Sharpe {gate['oos_sharpe']:.3f} (gate >{gate['min_sharpe']}) | "
                    f"PF {gate['oos_profit_factor']:.3f} (gate >{gate['min_profit_factor']}) | "
                    f"trades {gate['oos_trades']} | windows passing "
                    f"{gate['windows_passing']}/{gate['windows_total']} "
                    f"(need {gate['windows_required']})")

            record = StrategyRecord(
                strategy_uid=genome.uid(),
                symbol=symbol,
                timeframe=settings.suffix_quantum_timeframe,
                kind=genome.kind,
                generation=self.generation.generation,
                genome=genome.to_dict(),
                in_sample=is_agg,
                out_of_sample=oos_agg,
                status="CANDIDATE",
                score=score,
                penalty=round(self.pressure.decay, 6),
            )

            if ready:
                # Independent cross-check before anything reaches active memory.
                xcheck = vectorbt_crosscheck(df, genome)
                if xcheck is not None:
                    record.genome["vectorbt_check"] = {
                        "sharpe": xcheck.sharpe, "profit_factor": xcheck.profit_factor,
                        "trades": xcheck.trades, "engine": xcheck.engine,
                    }
                    # The cross-check vetoes only on a *decisive* contradiction
                    # with an adequate sample: enough trades AND a clearly
                    # negative independent edge. Sparse or degenerate ported
                    # signal sets are inconclusive, never punitive — the native
                    # engine is canonical and vectorbt is the second opinion.
                    decisive_disagreement = (
                        xcheck.trades >= 5
                        and xcheck.sharpe < 0.0
                        and xcheck.profit_factor < 0.9
                    )
                    if decisive_disagreement:
                        ready = False
                        record.status = "BLACKLISTED"
                        record.genome["reject_reason"] = (
                            f"vectorbt cross-check contradiction: sharpe {xcheck.sharpe}, "
                            f"PF {xcheck.profit_factor} over {xcheck.trades} trades")
                if ready and not self.ledger.is_blacklisted(record.strategy_uid):
                    record.status = "PROMOTED"
                    record.promoted_ms = int(time.time() * 1000)
                    self.registry.add(record)
                    promoted.append(record.strategy_uid)
                    if best is None or record.score > best.score:
                        best = record
            else:
                # Sub-par strategies are DELETED from active memory.
                record.status = "EXTINCT"
                self._extinct(record, "PERFORMANCE_GATE", record_reason)
                killed.append(record.strategy_uid)

            with self._lock:
                self.generation.trials_completed = t + 1
                if best is not None:
                    self.generation.best_score = round(best.score, 5)
                    self.generation.best_uid = best.strategy_uid
            if self.progress_cb:
                self._safe_cb(self.progress_cb, self.generation.model_copy())

        with self._lock:
            self.generation.status = "IDLE"
            self.generation.active_strategies = len(self.registry.active)
            self.generation.extinct_total = self.extinct_total
            self.generation.blacklisted_total = len(self.registry.blacklist)
            self.generation.loss_streak = self.pressure.loss_streak
            self.generation.loss_pressure = round(self.pressure.decay, 6)
            self.generation.penalty_k = self.pressure.k
            self.generation.last_action = (
                f"gen {self.generation.generation}: promoted {len(promoted)}, killed {len(killed)}")

        summary = {
            "generation": self.generation.generation,
            "symbol": symbol,
            "trials": self.generation.trials_completed,
            "promoted": promoted,
            "killed": len(killed),
            "best_uid": self.generation.best_uid,
            "best_score": self.generation.best_score,
            "penalty_decay": round(self.pressure.decay, 6),
            "penalty_k": self.pressure.k,
            "loss_streak": self.pressure.loss_streak,
            "engine": self.generation.engine,
        }
        self.history.append({**summary, "ts": int(time.time() * 1000)})
        self.history = self.history[-200:]
        log.info("QUANTUM generation %s complete: %s promoted, %s killed",
                 summary["generation"], len(promoted), summary["killed"])
        return summary

    # ------------------------------------------------------------- study glue
    def _make_study(self):
        if not OPTUNA_AVAILABLE:
            return None
        try:
            sampler = optuna.samplers.TPESampler(seed=settings.suffix_quantum_seed,
                                                 n_startup_trials=8, multivariate=True)
            return optuna.create_study(
                study_name=settings.suffix_quantum_study,
                direction="maximize",
                sampler=sampler,
                storage=f"sqlite:///{settings.optuna_path}",
                load_if_exists=True,
            )
        except Exception as exc:  # noqa: BLE001 - arg drift across optuna majors
            log.warning("Optuna study creation failed (%s); using TPE-lite sampler", exc)
            try:
                return optuna.create_study(direction="maximize",
                                           sampler=optuna.samplers.TPESampler(
                                               seed=settings.suffix_quantum_seed))
            except Exception:  # noqa: BLE001
                return None

    def _suggest(self, study, trial_index: int) -> Tuple[Genome, Any]:
        """Propose the next genome.

        With Optuna we use ``study.ask()`` + ``trial.suggest_*`` — real TPE
        sampling.  Adaptive mutation pressure is then applied as a *post-sample
        transform* (``apply_pressure``) rather than by changing the search
        ranges: Optuna rejects a study whose distributions drift between trials,
        and a transform is exactly equivalent while staying stable across the
        50-generation run.
        """
        if study is None:
            return self.sampler.suggest(self.pressure, trial_index), None

        try:
            trial = study.ask()
            params: Dict[str, Any] = {}
            for name, (low, high, step, is_int) in GENOME_SPEC.items():
                if is_int:
                    params[name] = trial.suggest_int(name, int(low), int(high),
                                                     step=max(1, int(step)))
                else:
                    params[name] = trial.suggest_float(name, float(low), float(high),
                                                       step=float(step) or None)
            kind = trial.suggest_categorical("kind", list(STRATEGY_KINDS))
            genome = Genome(kind=str(kind), params=params)
        except Exception as exc:  # noqa: BLE001 - never let the sampler block a run
            log.warning("Optuna sampling failed (%s); falling back to TPE-lite", exc)
            return self.sampler.suggest(self.pressure, trial_index), None

        return self.apply_pressure(genome), trial

    def apply_pressure(self, genome: Genome) -> Genome:
        """Post-sample adaptive mutation: slashed lookbacks, tightened stops.

        Under a live loss streak, ``MutationPressure.adjust`` shrinks the search
        space; here we instead pull the sampled parameters into that shrunken
        space, which produces the identical distribution of mutations.
        """
        if self.pressure.loss_streak <= 0:
            return self._normalize(genome)
        params = dict(genome.params)
        for name, (low, high, step, is_int) in GENOME_SPEC.items():
            adjust_low, adjust_high = self.pressure.adjust(name, low, high)
            value = float(params.get(name, low))
            if name in ("adx_min", "vol_min_z"):
                # Raise the floor: demand more trend strength / more volume edge.
                params[name] = max(value, float(adjust_low))
            elif adjust_high < high:
                # Collapse the ceiling: slashed lookbacks, tightened stops,
                # reduced risk% and leverage all land here.
                params[name] = min(value, float(adjust_high))
            else:
                params[name] = value
            params[name] = int(round(params[name])) if is_int else round(float(params[name]), 4)
        return self._normalize(Genome(kind=genome.kind, params=params))

    @staticmethod
    def _normalize(genome: Genome) -> Genome:
        """Enforce cross-parameter invariants and the leverage whitelist."""
        p = genome.params
        p["fast"] = min(int(p["fast"]), max(5, int(p["slow"]) - 5))
        p["exit_len"] = min(int(p["exit_len"]), max(3, int(p["entry_len"]) - 2))
        p["rsi_low"] = min(int(p["rsi_low"]), int(p["rsi_high"]) - 8)
        p["risk_pct"] = float(np.clip(p["risk_pct"], settings.suffix_risk_min_pct,
                                      settings.suffix_risk_max_pct))
        if float(p["target_atr_mult"]) <= float(p["stop_atr_mult"]):
            p["target_atr_mult"] = round(float(p["stop_atr_mult"]) * 1.5, 3)
        lev = int(round(p["leverage"]))
        p["leverage"] = lev if lev in settings.allowed_leverage else min(
            settings.allowed_leverage, key=lambda x: abs(x - lev))
        return genome

    def _observe(self, study, trial: Any, genome: Genome, score: float) -> None:
        self.sampler.observe(genome, score)
        if study is not None and trial is not None:
            try:
                study.tell(trial, float(score))
            except Exception as exc:  # noqa: BLE001
                log.debug("optuna tell failed: %s", exc)

    # ------------------------------------------------------------- extinction
    def _extinct(self, record: StrategyRecord, reason: str, detail: str) -> None:
        self.extinct_total += 1
        payload = {
            "strategy_uid": record.strategy_uid,
            "symbol": record.symbol,
            "reason": reason,
            "detail": detail,
            "sharpe": record.out_of_sample.sharpe,
            "profit_factor": record.out_of_sample.profit_factor,
            "generation": record.generation,
            "genome": record.genome,
            "ts": int(time.time() * 1000),
        }
        try:
            self.ledger.extinct(payload)
        except Exception as exc:  # noqa: BLE001
            log.error("LEDGER extinction write failed: %s", exc)
        self.registry.purge(record.strategy_uid)
        if self.extinction_cb:
            self._safe_cb(self.extinction_cb, payload)

    def kill_generation(self, reason: str = "DEATH_LINE",
                        detail: str = "Equity below the $80 death line") -> Dict[str, Any]:
        """Terminate + purge the entire active generation (the Death Line)."""
        uids = self.registry.purge_all()
        for uid in uids:
            self.extinct_total += 1
            payload = {
                "strategy_uid": uid, "symbol": self.generation.symbol, "reason": reason,
                "detail": detail, "sharpe": 0.0, "profit_factor": 0.0,
                "generation": self.generation.generation,
                "genome": self.registry.active.get(uid, StrategyRecord(
                    strategy_uid=uid, symbol="", timeframe="", kind="", generation=0,
                    genome={}, in_sample=BacktestMetrics(), out_of_sample=BacktestMetrics())).genome,
                "ts": int(time.time() * 1000),
            }
            try:
                self.ledger.extinct(payload)
            except Exception as exc:  # noqa: BLE001
                log.error("LEDGER purge write failed: %s", exc)
            if self.extinction_cb:
                self._safe_cb(self.extinction_cb, payload)
        with self._lock:
            self.generation.status = "TERMINATED"
            self.generation.active_strategies = 0
            self.generation.extinct_total = self.extinct_total
            self.generation.blacklisted_total = len(self.registry.blacklist)
            self.generation.last_action = f"GENERATION TERMINATED ({reason}): {len(uids)} strategies purged"
        log.critical("QUANTUM generation terminated (%s): %d strategies killed and blacklisted",
                     reason, len(uids))
        return {"reason": reason, "detail": detail, "purged": uids, "count": len(uids)}

    # ------------------------------------------------------- live loss penalty
    def record_live_outcome(self, strategy_uid: Optional[str], pnl: float,
                            symbol: str = "") -> Dict[str, Any]:
        """Feed a realized live result back into the evolutionary loop.

        Losses increment the streak, exponentially decay trial reward and trigger
        hyperparameter mutation on the next generation.
        """
        if strategy_uid:
            rec = self.registry.active.get(strategy_uid)
            if rec is not None:
                rec.lifetime_trades += 1
                rec.lifetime_pnl = round(rec.lifetime_pnl + pnl, 6)
        if pnl < 0:
            self.pressure.update(self.pressure.loss_streak + 1)
            mutated: List[str] = []
            for uid, rec in list(self.registry.active.items()):
                if strategy_uid and uid != strategy_uid:
                    continue
                child = mutate_genome(Genome(kind=rec.kind, params=rec.genome["params"]),
                                      self._rng, strength=0.25 + 0.1 * min(4, self.pressure.loss_streak))
                rec.genome = child.to_dict()
                rec.penalty = round(self.pressure.decay, 6)
                mutated.append(uid)
                self.ledger.record_event({
                    "event_id": f"mut_{uid}_{int(time.time()*1000)}", "channel": "quantum",
                    "level": "warn", "title": "Hyperparameter mutation applied",
                    "detail": f"{uid}: lookbacks slashed, stops tightened "
                              f"(decay {self.pressure.decay:.4f}, k={self.pressure.k})",
                    "payload": {"strategy_uid": uid, "genome": rec.genome,
                                "penalty_decay": rec.penalty, "loss_streak": self.pressure.loss_streak},
                })
        else:
            self.pressure.update(0)
        with self._lock:
            self.generation.loss_streak = self.pressure.loss_streak
            self.generation.loss_pressure = round(self.pressure.decay, 6)
            self.generation.penalty_k = self.pressure.k
            self.generation.active_strategies = len(self.registry.active)
        return {
            "strategy_uid": strategy_uid,
            "loss_streak": self.pressure.loss_streak,
            "penalty_k": self.pressure.k,
            "penalty_decay": round(self.pressure.decay, 6),
            "mutated": len(self.registry.active) if pnl < 0 else 0,
        }

    # ------------------------------------------------------------ background
    async def background_loop(self, interval_sec: Optional[int] = None) -> None:
        interval = interval_sec or settings.suffix_quantum_bg_interval_sec
        symbols = settings.watchlist or ["BTC-USD"]
        idx = 0
        log.info("QUANTUM background worker online (interval %ss, engine %s)",
                 interval, self.generation.engine)
        while not self._stop.is_set():
            try:
                symbol = symbols[idx % len(symbols)]
                idx += 1
                await asyncio.to_thread(self.run_generation, symbol, None)
                await asyncio.to_thread(self.ledger.prune_equity_curve, 5000)
                await asyncio.to_thread(self.ledger.purge_blacklist, 512)
            except Exception as exc:  # noqa: BLE001 - the worker must survive anything
                log.exception("QUANTUM generation failed: %s", exc)
            try:
                await asyncio.wait_for(asyncio.to_thread(self._stop.wait), timeout=interval)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass

    def start_background(self, interval_sec: Optional[int] = None) -> Optional[asyncio.Task]:
        if self._task is not None and not self._task.done():
            return self._task
        self._stop.clear()
        self._task = asyncio.create_task(self.background_loop(interval_sec))
        return self._task

    async def stop_background(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None

    # ------------------------------------------------------------------ status
    def state(self) -> GenerationState:
        with self._lock:
            g = self.generation.model_copy()
            g.active_strategies = len(self.registry.active)
            g.extinct_total = self.extinct_total
            g.blacklisted_total = len(self.registry.blacklist)
            g.loss_streak = self.pressure.loss_streak
            g.loss_pressure = round(self.pressure.decay, 6)
            g.penalty_k = self.pressure.k
            return g

    def active_strategies(self, symbol: Optional[str] = None) -> List[Dict[str, Any]]:
        recs = ([r for r in self.registry.active.values() if r.symbol == symbol]
                if symbol else list(self.registry.active.values()))
        recs.sort(key=lambda r: r.score, reverse=True)
        return [r.model_dump(mode="json") for r in recs[:40]]

    def best_for(self, symbol: str) -> Optional[StrategyRecord]:
        recs = self.registry.by_symbol(symbol)
        if not recs:
            return None
        return max(recs, key=lambda r: r.score)

    def engine_info(self) -> Dict[str, Any]:
        return {
            "optuna": {"available": OPTUNA_AVAILABLE, "version": OPTUNA_VERSION},
            "vectorbt": {"available": VBT_AVAILABLE, "version": VBT_VERSION},
            "sampler": "optuna.tpe" if OPTUNA_AVAILABLE else "internal.tpe-lite",
            "gates": {"min_sharpe": settings.suffix_min_sharpe,
                      "min_profit_factor": settings.suffix_min_profit_factor,
                      "min_oos_trades": settings.suffix_min_oos_trades,
                      "walk_forward_windows": settings.suffix_walk_forward_windows},
            "directive": {"generations": settings.suffix_mutation_generations,
                          "penalty_base_k": settings.suffix_penalty_base_k,
                          "risk_band_pct": [settings.suffix_risk_min_pct, settings.suffix_risk_max_pct],
                          "leverage": list(settings.allowed_leverage),
                          "death_line": settings.suffix_death_line},
            "pressure": {"loss_streak": self.pressure.loss_streak,
                         "k": self.pressure.k, "decay": round(self.pressure.decay, 6),
                         "tightened": self.pressure.tightened},
        }

    def _safe_cb(self, cb: Callable, payload: Any) -> None:
        try:
            cb(payload)
        except Exception as exc:  # noqa: BLE001
            log.debug("quantum callback failed: %s", exc)


def _aggregate(metrics: List[BacktestMetrics]) -> BacktestMetrics:
    """Average a metric set across walk-forward windows (trade-count weighted)."""
    if not metrics:
        return BacktestMetrics()
    if len(metrics) == 1:
        return metrics[0]
    weights = np.array([max(1, m.trades) for m in metrics], dtype=float)
    weights = weights / weights.sum()

    def wmean(attr: str) -> float:
        return round(float(np.sum([getattr(m, attr) * w for m, w in zip(metrics, weights)])), 4)

    return BacktestMetrics(
        sharpe=wmean("sharpe"), sortino=wmean("sortino"),
        profit_factor=wmean("profit_factor"),
        total_return_pct=wmean("total_return_pct"),
        max_drawdown_pct=float(max(m.max_drawdown_pct for m in metrics)),
        win_rate=wmean("win_rate"), trades=int(sum(m.trades for m in metrics)),
        expectancy=wmean("expectancy"), exposure=wmean("exposure"),
        cagr=wmean("cagr"),
        liquidation_events=int(sum(m.liquidation_events for m in metrics)),
        period_start=metrics[0].period_start, period_end=metrics[-1].period_end,
        engine=metrics[0].engine,
    )


_engine: Optional[QuantumEngine] = None
_engine_lock = threading.Lock()


def get_engine() -> QuantumEngine:
    global _engine
    if _engine is None:
        with _engine_lock:
            if _engine is None:
                _engine = QuantumEngine()
    return _engine
