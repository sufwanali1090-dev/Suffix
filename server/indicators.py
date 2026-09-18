"""Native vectorized technical-indicator engine.

Agent 5 (CHARTIST) and Agent 11 (QUANTUM) need indicators on every trial; a
pure NumPy/Pandas implementation keeps the quant loop dependency-free and fast
enough to run tens of thousands of Optuna trials on a laptop.

All functions accept and return :class:`pandas.Series` aligned to the input
index, so they compose cleanly with ``vectorbt`` (which consumes the same
boolean entry/exit signal series).
"""

from __future__ import annotations

from typing import Optional, Tuple

import numpy as np
import pandas as pd

__all__ = [
    "sma", "ema", "rma", "rsi", "atr", "adx", "macd", "bollinger",
    "donchian", "keltner", "realized_vol", "zscore", "crossover", "crossunder",
    "supertrend", "stoch_rsi", "volume_zscore", "add_indicators",
    "annualization_factor",
]


# --------------------------------------------------------------------------- #
#  Moving averages
# --------------------------------------------------------------------------- #
def sma(series: pd.Series, length: int) -> pd.Series:
    return series.rolling(int(max(1, length)), min_periods=int(max(1, length))).mean()


def ema(series: pd.Series, length: int) -> pd.Series:
    length = int(max(1, length))
    return series.ewm(span=length, adjust=False, min_periods=length).mean()


def rma(series: pd.Series, length: int) -> pd.Series:
    """Wilder's smoothing (the 'R' in RSI/ATR/ADX)."""
    length = int(max(1, length))
    return series.ewm(alpha=1.0 / length, adjust=False, min_periods=length).mean()


def wma(series: pd.Series, length: int) -> pd.Series:
    length = int(max(1, length))
    weights = np.arange(1, length + 1, dtype=float)
    return series.rolling(length).apply(
        lambda x: float(np.dot(x, weights) / weights.sum()), raw=True
    )


# --------------------------------------------------------------------------- #
#  Oscillators
# --------------------------------------------------------------------------- #
def rsi(close: pd.Series, length: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)
    avg_gain = rma(gain, length)
    avg_loss = rma(loss, length)
    rs = avg_gain / avg_loss.replace(0.0, np.nan)
    out = 100.0 - (100.0 / (1.0 + rs))
    # All-gain windows => RSI 100, all-loss windows => RSI 0.
    out = out.where(avg_loss != 0.0, 100.0)
    out = out.where(avg_gain != 0.0, out.fillna(0.0))
    return out.clip(0.0, 100.0)


def stoch_rsi(close: pd.Series, length: int = 14, smooth_k: int = 3) -> pd.Series:
    r = rsi(close, length)
    lo = r.rolling(length).min()
    hi = r.rolling(length).max()
    stoch = (r - lo) / (hi - lo).replace(0.0, np.nan)
    return (stoch * 100.0).rolling(smooth_k).mean()


# --------------------------------------------------------------------------- #
#  Volatility
# --------------------------------------------------------------------------- #
def true_range(high: pd.Series, low: pd.Series, close: pd.Series) -> pd.Series:
    prev_close = close.shift(1)
    ranges = pd.concat(
        [(high - low), (high - prev_close).abs(), (low - prev_close).abs()], axis=1
    )
    return ranges.max(axis=1)


def atr(high: pd.Series, low: pd.Series, close: pd.Series, length: int = 14) -> pd.Series:
    return rma(true_range(high, low, close), length)


def bollinger(close: pd.Series, length: int = 20, mult: float = 2.0) -> Tuple[pd.Series, pd.Series, pd.Series]:
    mid = sma(close, length)
    sd = close.rolling(length).std(ddof=0)
    return mid - mult * sd, mid, mid + mult * sd


def keltner(high: pd.Series, low: pd.Series, close: pd.Series,
            length: int = 20, mult: float = 2.0) -> Tuple[pd.Series, pd.Series, pd.Series]:
    mid = ema(close, length)
    band = atr(high, low, close, length) * mult
    return mid - band, mid, mid + band


def realized_vol(close: pd.Series, length: int = 20, periods_per_year: int = 8760) -> pd.Series:
    ret = np.log(close / close.shift(1))
    return ret.rolling(length).std(ddof=0) * np.sqrt(periods_per_year) * 100.0


def donchian(high: pd.Series, low: pd.Series, length: int = 20) -> Tuple[pd.Series, pd.Series]:
    length = int(max(1, length))
    upper = high.rolling(length).max()
    lower = low.rolling(length).min()
    return lower, upper


# --------------------------------------------------------------------------- #
#  Trend strength
# --------------------------------------------------------------------------- #
def adx(high: pd.Series, low: pd.Series, close: pd.Series, length: int = 14) -> pd.Series:
    up_move = high.diff()
    down_move = -low.diff()
    plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
    minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)
    plus_di = 100.0 * rma(pd.Series(plus_dm, index=high.index), length) / atr(high, low, close, length).replace(0.0, np.nan)
    minus_di = 100.0 * rma(pd.Series(minus_dm, index=high.index), length) / atr(high, low, close, length).replace(0.0, np.nan)
    dx = 100.0 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0.0, np.nan)
    return rma(dx.fillna(0.0), length).clip(0.0, 100.0)


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9
         ) -> Tuple[pd.Series, pd.Series, pd.Series]:
    line = ema(close, fast) - ema(close, slow)
    sig = ema(line.fillna(0.0), signal)
    return line, sig, line - sig


def supertrend(high: pd.Series, low: pd.Series, close: pd.Series,
               length: int = 10, mult: float = 3.0) -> Tuple[pd.Series, pd.Series]:
    """Returns (trend_direction[+1/-1], line)."""
    hl2 = (high + low) / 2.0
    a = atr(high, low, close, length)
    # .copy() is required: the iterative band-ratchet below mutates in place, and
    # pandas-derived arrays are read-only views.
    upper = (hl2 + mult * a).to_numpy(dtype=float).copy()
    lower = (hl2 - mult * a).to_numpy(dtype=float).copy()
    c = close.to_numpy(dtype=float)
    n = len(c)
    direction = np.ones(n)
    line = np.full(n, np.nan)
    for i in range(1, n):
        if np.isnan(upper[i]) or np.isnan(lower[i]):
            continue
        if c[i] > (upper[i - 1] if not np.isnan(upper[i - 1]) else upper[i]):
            direction[i] = 1
        elif c[i] < (lower[i - 1] if not np.isnan(lower[i - 1]) else lower[i]):
            direction[i] = -1
        else:
            direction[i] = direction[i - 1]
            if direction[i] > 0 and lower[i] < lower[i - 1]:
                lower[i] = lower[i - 1]
            if direction[i] < 0 and upper[i] > upper[i - 1]:
                upper[i] = upper[i - 1]
        line[i] = lower[i] if direction[i] > 0 else upper[i]
    idx = close.index
    return pd.Series(direction, index=idx), pd.Series(line, index=idx)


# --------------------------------------------------------------------------- #
#  Statistical helpers
# --------------------------------------------------------------------------- #
def zscore(series: pd.Series, length: int = 50) -> pd.Series:
    m = sma(series, length)
    s = series.rolling(int(length)).std(ddof=0).replace(0.0, np.nan)
    return (series - m) / s


def volume_zscore(volume: pd.Series, length: int = 50) -> pd.Series:
    return zscore(volume.astype(float), length)


def crossover(a: pd.Series, b: pd.Series) -> pd.Series:
    return (a > b) & (a.shift(1) <= b.shift(1))


def crossunder(a: pd.Series, b: pd.Series) -> pd.Series:
    return (a < b) & (a.shift(1) >= b.shift(1))


def annualization_factor(freq: str) -> float:
    """Bars per year for the timeframe strings used across the desk."""
    table = {
        "1m": 525600, "3m": 175200, "5m": 105120, "15m": 35040, "30m": 17520,
        "1h": 8760, "2h": 4380, "4h": 2190, "6h": 1460, "12h": 730,
        "1d": 365, "1w": 52,
    }
    return float(table.get(freq.lower(), 8760))


# --------------------------------------------------------------------------- #
#  Bulk enrichment used by QUANTUM + CHARTIST
# --------------------------------------------------------------------------- #
def add_indicators(df: pd.DataFrame, *, fast: int = 12, slow: int = 48,
                   rsi_len: int = 14, atr_len: int = 14, adx_len: int = 14,
                   donchian_len: int = 20) -> pd.DataFrame:
    """Attach the full default indicator panel to an OHLCV frame.

    ``df`` must contain: open, high, low, close, volume (index = DatetimeIndex).
    """
    out = df.copy()
    c = out["close"].astype(float)
    h = out["high"].astype(float)
    l = out["low"].astype(float)
    v = out["volume"].astype(float)
    out["ema_fast"] = ema(c, fast)
    out["ema_slow"] = ema(c, slow)
    out["sma_fast"] = sma(c, fast)
    out["rsi"] = rsi(c, rsi_len)
    out["atr"] = atr(h, l, c, atr_len)
    out["atr_pct"] = (out["atr"] / c) * 100.0
    out["adx"] = adx(h, l, c, adx_len)
    macd_line, macd_sig, macd_hist = macd(c)
    out["macd"] = macd_line
    out["macd_signal"] = macd_sig
    out["macd_hist"] = macd_hist
    bb_low, bb_mid, bb_up = bollinger(c)
    out["bb_lower"], out["bb_mid"], out["bb_upper"] = bb_low, bb_mid, bb_up
    dc_low, dc_up = donchian(h, l, donchian_len)
    out["dc_lower"], out["dc_upper"] = dc_low, dc_up
    out["vol_z"] = volume_zscore(v)
    out["rv"] = realized_vol(c)
    st_dir, st_line = supertrend(h, l, c)
    out["st_dir"] = st_dir
    out["st_line"] = st_line
    return out
