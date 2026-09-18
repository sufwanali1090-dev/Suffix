"""Market data + fundamentals + news provider layer.

Priority chain
--------------
1. **live**      — yfinance (OHLCV / balance sheets) and Finnhub (news, quotes).
2. **cached**    — last good frame persisted under ``runtime/cache``.
3. **simulated** — a deterministic geometric-Brownian-motion generator seeded by
   the symbol, so every agent, backtest and HUD animation stays fully functional
   with no network and no API keys.  Simulated data is always tagged
   ``data_quality="simulated"`` and is never presented to the user as real.

All network calls are bound to a hard timeout and wrapped in try/except: a
provider outage must degrade the desk, never crash it.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from server.config import settings

log = logging.getLogger("suffix.market")

HTTP_TIMEOUT = 12.0
CACHE_TTL_SEC = 300

_FINNHUB_NEWS_CACHE: Dict[str, Any] = {}


# --------------------------------------------------------------------------- #
#  Result envelope
# --------------------------------------------------------------------------- #
@dataclass
class DataResult:
    value: Any
    quality: str            # live | cached | simulated | partial
    source: str
    detail: str = ""

    @property
    def is_simulated(self) -> bool:
        return self.quality == "simulated"


# --------------------------------------------------------------------------- #
#  Cache helpers
# --------------------------------------------------------------------------- #
def _cache_file(key: str, ext: str = "json") -> Path:
    digest = hashlib.sha1(key.encode()).hexdigest()[:16]
    return settings.cache_dir / f"{digest}.{ext}"


def _cache_write(key: str, payload: Any, ext: str = "json") -> None:
    try:
        path = _cache_file(key, ext)
        if ext == "json":
            path.write_text(json.dumps(payload, default=str), encoding="utf-8")
        elif ext == "csv" and isinstance(payload, pd.DataFrame):
            payload.to_csv(path)
        (settings.cache_dir / f"{path.stem}.meta").write_text(
            json.dumps({"ts": time.time(), "key": key}), encoding="utf-8")
    except OSError as exc:  # pragma: no cover - disk issues only
        log.debug("cache write failed for %s: %s", key, exc)


def _cache_read(key: str, ext: str = "json", max_age: float = CACHE_TTL_SEC) -> Optional[Any]:
    try:
        path = _cache_file(key, ext)
        if not path.exists():
            return None
        meta_path = settings.cache_dir / f"{path.stem}.meta"
        if meta_path.exists():
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            if time.time() - float(meta.get("ts", 0)) > max_age:
                return None
        if ext == "json":
            return json.loads(path.read_text(encoding="utf-8"))
        if ext == "csv":
            df = pd.read_csv(path, index_col=0, parse_dates=True)
            return df
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        log.debug("cache read failed for %s: %s", key, exc)
    return None


# --------------------------------------------------------------------------- #
#  Synthetic generator (the always-available provider)
# --------------------------------------------------------------------------- #
_SYMBOL_PROFILE: Dict[str, Dict[str, float]] = {
    "BTC-USD": {"px": 63_500.0, "vol": 0.62, "drift": 0.28},
    "ETH-USD": {"px": 3_120.0, "vol": 0.72, "drift": 0.22},
    "SOL-USD": {"px": 148.0, "vol": 0.95, "drift": 0.30},
    "BNB-USD": {"px": 585.0, "vol": 0.68, "drift": 0.18},
    "XRP-USD": {"px": 0.62, "vol": 0.85, "drift": 0.05},
    "SPY": {"px": 545.0, "vol": 0.17, "drift": 0.09},
    "QQQ": {"px": 468.0, "vol": 0.22, "drift": 0.13},
    "NVDA": {"px": 124.0, "vol": 0.52, "drift": 0.35},
    "AAPL": {"px": 228.0, "vol": 0.24, "drift": 0.11},
    "TSLA": {"px": 248.0, "vol": 0.58, "drift": 0.14},
    "MSFT": {"px": 432.0, "vol": 0.23, "drift": 0.12},
    "GLD": {"px": 245.0, "vol": 0.14, "drift": 0.07},
    "TLT": {"px": 98.0, "vol": 0.15, "drift": 0.02},
    "DXY": {"px": 101.5, "vol": 0.08, "drift": 0.01},
}


def _seed_for(symbol: str) -> int:
    return int(hashlib.sha1(f"{symbol}:{settings.suffix_quantum_seed}".encode()).hexdigest()[:8], 16)


def _bars_per_year(timeframe: str) -> float:
    return {"1m": 525600, "5m": 105120, "15m": 35040, "30m": 17520,
            "1h": 8760, "4h": 2190, "1d": 365}.get(timeframe.lower(), 8760)


def _bar_delta(timeframe: str) -> timedelta:
    return {"1m": timedelta(minutes=1), "5m": timedelta(minutes=5),
            "15m": timedelta(minutes=15), "30m": timedelta(minutes=30),
            "1h": timedelta(hours=1), "4h": timedelta(hours=4),
            "1d": timedelta(days=1)}.get(timeframe.lower(), timedelta(hours=1))


def synthetic_ohlcv(symbol: str, timeframe: str = "1h", bars: int = 720,
                    end: Optional[datetime] = None) -> pd.DataFrame:
    """Deterministic OHLCV series with regime shifts, vol clustering and
    liquidity gaps.  Seeded per symbol so backtests are reproducible."""
    profile = _SYMBOL_PROFILE.get(symbol.upper(), {"px": 100.0, "vol": 0.45, "drift": 0.10})
    rng = np.random.default_rng(_seed_for(symbol))
    dt = _bar_delta(timeframe)
    bpy = _bars_per_year(timeframe)
    sigma_bar = profile["vol"] / math.sqrt(bpy)
    mu_bar = profile["drift"] / bpy

    # Regime-switching drift so charts have structure (not flat noise).
    #
    # The regime coefficient is deliberately SMALL (0.025). Drift must be a
    # modest fraction of per-bar noise: a tape where drift dominates noise is
    # trivially predictable and every trend-follower backtests as a holy grail.
    # 0.09 produced a 56% win rate at 2R (PF 2.5, unearned); 0.025 yields a
    # 43% win rate and PF ~1.5 — real edge is small, which is the point.
    n_regimes = max(3, bars // 180)
    regimes = rng.choice([-2.6, -1.0, 0.0, 1.0, 2.6], size=n_regimes,
                         p=[0.12, 0.2, 0.24, 0.28, 0.16])
    regime_len = int(np.ceil(bars / n_regimes))
    regime_series = np.repeat(regimes, regime_len)[:bars]

    # GARCH-flavoured volatility clustering (bounded, realistic persistence).
    vol_mult = np.ones(bars)
    for i in range(1, bars):
        shock = abs(rng.normal(0, 1)) - 1.0
        vol_mult[i] = max(0.5, min(2.2, 0.94 * vol_mult[i - 1] + 0.06 * (1 + 0.7 * shock)))

    log_ret = (mu_bar + sigma_bar * regime_series * vol_mult * 0.025
               + rng.normal(0, sigma_bar * vol_mult, bars))
    close = profile["px"] * np.exp(np.cumsum(log_ret))

    # Intrabar range: excursion beyond the close-to-close move, scaled to a
    # realistic ATR/price ratio (~0.4–0.8% per hourly bar on crypto).
    bar_vol = np.abs(log_ret) + sigma_bar * (0.25 + 0.35 * vol_mult)
    high = close * np.exp(bar_vol * rng.uniform(0.15, 0.45, bars))
    low = close * np.exp(-bar_vol * rng.uniform(0.15, 0.45, bars))
    open_ = np.concatenate([[close[0]], close[:-1]]) * np.exp(rng.normal(0, sigma_bar * 0.4, bars))
    high = np.maximum.reduce([high, open_, close])
    low = np.minimum.reduce([low, open_, close])

    base_vol = 250_000 if symbol.upper().endswith("-USD") else 1_400_000
    volume = (base_vol * (1 + 3.0 * np.abs(log_ret) / (sigma_bar + 1e-12) * 0.25)
              * rng.lognormal(0, 0.45, bars))

    end_ts = end or datetime.now(timezone.utc)
    index = pd.date_range(end=end_ts.replace(minute=0, second=0, microsecond=0),
                          periods=bars, freq=dt, tz="UTC")
    return pd.DataFrame(
        {"open": open_, "high": high, "low": low, "close": close, "volume": volume},
        index=index,
    ).round(6)


# --------------------------------------------------------------------------- #
#  OHLCV
# --------------------------------------------------------------------------- #
def fetch_ohlcv(symbol: str, timeframe: str = "1h", bars: int = 720,
                allow_synthetic: Optional[bool] = None) -> DataResult:
    """Return an OHLCV frame for ``symbol``, degrading gracefully."""
    allow_synthetic = settings.suffix_enable_synthetic_fallback if allow_synthetic is None else allow_synthetic
    cache_key = f"ohlcv:{symbol}:{timeframe}:{bars}"

    # 1. live via yfinance
    try:
        import yfinance as yf  # imported lazily: keeps boot time low

        yf_interval = {"1h": "1h", "4h": "1h", "1d": "1d", "30m": "30m",
                       "15m": "15m", "5m": "5m"}.get(timeframe, "1h")
        yf_period = {  # yfinance caps intraday history; ask for the max it allows
            "1m": "7d", "5m": "60d", "15m": "60d", "30m": "60d",
            "1h": "730d", "4h": "730d", "1d": "5y",
        }.get(timeframe, "180d")
        raw = yf.download(symbol, period=yf_period, interval=yf_interval,
                          auto_adjust=False, progress=False, threads=False, timeout=HTTP_TIMEOUT)
        if raw is not None and len(raw) > 30:
            if isinstance(raw.columns, pd.MultiIndex):
                raw.columns = [c[0].lower() for c in raw.columns]
            else:
                raw.columns = [str(c).lower() for c in raw.columns]
            df = raw[["open", "high", "low", "close", "volume"]].dropna()
            df.index = pd.to_datetime(df.index, utc=True)
            if timeframe == "4h":
                df = df.resample("4h").agg(
                    {"open": "first", "high": "max", "low": "min",
                     "close": "last", "volume": "sum"}).dropna()
            df = df.tail(bars).astype(float)
            _cache_write(cache_key, df, "csv")
            return DataResult(df, "live", "yfinance", f"{len(df)} bars of {symbol} {timeframe}")
    except Exception as exc:  # noqa: BLE001 - provider isolation is intentional
        log.debug("yfinance failed for %s: %s", symbol, exc)

    # 2. cache
    cached = _cache_read(cache_key, "csv", max_age=60 * 60 * 6)
    if isinstance(cached, pd.DataFrame) and len(cached) > 30:
        return DataResult(cached.tail(bars), "cached", "yfinance-cache",
                          f"{len(cached)} cached bars of {symbol} {timeframe}")

    # 3. synthetic
    if allow_synthetic:
        df = synthetic_ohlcv(symbol, timeframe, bars)
        return DataResult(df, "simulated", "suffix-sim",
                          f"deterministic simulated tape for {symbol} {timeframe}")
    return DataResult(None, "simulated", "none", f"no data available for {symbol}")


def last_price(symbol: str, timeframe: str = "1h") -> DataResult:
    res = fetch_ohlcv(symbol, timeframe, bars=120)
    if isinstance(res.value, pd.DataFrame) and len(res.value):
        px = float(res.value["close"].iloc[-1])
        return DataResult(px, res.quality, res.source, res.detail)
    profile = _SYMBOL_PROFILE.get(symbol.upper(), {"px": 100.0})
    return DataResult(float(profile["px"]), "simulated", "suffix-sim", "profile price")


def atr_based_bracket(symbol: str, timeframe: str = "1h", atr_len: int = 14,
                      stop_mult: float = 1.5, rr: float = 2.0,
                      side: str = "long") -> Dict[str, float]:
    """Deterministic entry/stop/target used when an agent has no better level."""
    res = fetch_ohlcv(symbol, timeframe, bars=200)
    df = res.value
    if not isinstance(df, pd.DataFrame) or len(df) < atr_len + 2:
        df = synthetic_ohlcv(symbol, timeframe, 200)
    from server.indicators import atr as _atr

    entry = float(df["close"].iloc[-1])
    a = float(_atr(df["high"], df["low"], df["close"], atr_len).iloc[-1])
    a = a if a and not math.isnan(a) else entry * 0.01
    if side == "long":
        stop = entry - stop_mult * a
        target = entry + stop_mult * a * rr
    else:
        stop = entry + stop_mult * a
        target = entry - stop_mult * a * rr
    return {"entry": round(entry, 6), "stop": round(max(stop, 1e-9), 6),
            "target": round(max(target, 1e-9), 6), "atr": round(a, 6)}


# --------------------------------------------------------------------------- #
#  News (Finnhub) — Agent 2 SCOUT
# --------------------------------------------------------------------------- #
_FALLBACK_HEADLINES = [
    ("Fed officials signal patience as core PCE cools to 2.4%", "Reuters", "macro"),
    ("Treasury yields slip after soft jobs revision; 10Y back below 4.1%", "Bloomberg", "macro"),
    ("Spot BTC ETFs log third straight week of net inflows", "CoinDesk", "crypto"),
    ("Semiconductor index hits record on AI capex guidance upgrades", "CNBC", "equities"),
    ("ECB minutes show split on timing of next cut", "FT", "macro"),
    ("Options market prices elevated vol into Friday's CPI print", "Barron's", "volatility"),
    ("On-chain data shows exchange reserves at multi-year lows", "Glassnode", "crypto"),
    ("Country instability index ticks up across two EM regions", "WorldMonitor", "geopolitics"),
    ("13F filings reveal hedge funds added energy exposure in Q2", "Institutional Investor", "flows"),
    ("Crypto funding rates flip positive as basis trade reopens", "The Block", "crypto"),
    ("Mega-cap breadth narrows: five names drive 60% of index gains", "WSJ", "equities"),
    ("Insider buying cluster detected in regional banks", "SmartInsider", "flows"),
]


def fetch_news(symbols: Optional[List[str]] = None, limit: int = 20) -> DataResult:
    """Company/general news via Finnhub, falling back to a labelled synthetic feed."""
    symbols = symbols or settings.watchlist
    cache_key = f"news:{','.join(sorted(symbols))}:{limit}"
    cached_blob = _FINNHUB_NEWS_CACHE.get(cache_key)
    if cached_blob and time.time() - cached_blob["ts"] < 120:
        return DataResult(cached_blob["items"], cached_blob["quality"], "finnhub-cache")

    if settings.finnhub_api_key:
        try:
            import httpx

            items: List[Dict[str, Any]] = []
            with httpx.Client(timeout=HTTP_TIMEOUT) as client:
                for sym in symbols[:4]:
                    resp = client.get(
                        f"{settings.finnhub_base}/company-news",
                        params={"symbol": sym.split("-")[0], "from": (datetime.now() - timedelta(days=5)).date().isoformat(),
                                "to": datetime.now().date().isoformat(),
                                "token": settings.finnhub_api_key},
                    )
                    if resp.status_code != 200:
                        continue
                    for art in resp.json()[: max(2, limit // len(symbols) + 2)]:
                        items.append({
                            "symbol": sym,
                            "headline": art.get("headline", ""),
                            "summary": (art.get("summary") or "")[:400],
                            "source": art.get("source", "finnhub"),
                            "url": art.get("url", ""),
                            "datetime": int(art.get("datetime", time.time())),
                            "sentiment": _lexicon_sentiment(f"{art.get('headline','')} {art.get('summary','')}"),
                            "category": "company",
                        })
            if items:
                items.sort(key=lambda x: x["datetime"], reverse=True)
                out = items[:limit]
                _FINNHUB_NEWS_CACHE[cache_key] = {"ts": time.time(), "items": out, "quality": "live"}
                return DataResult(out, "live", "finnhub", f"{len(out)} headlines")
        except Exception as exc:  # noqa: BLE001
            log.debug("finnhub news failed: %s", exc)

    cached = _cache_read(cache_key, "json", max_age=1800)
    if cached:
        return DataResult(cached, "cached", "finnhub-cache", f"{len(cached)} cached headlines")

    rng = np.random.default_rng(int(time.time() // 900))
    now = int(time.time())
    items = []
    for i, (headline, source, category) in enumerate(_FALLBACK_HEADLINES[:limit]):
        offset = int(rng.integers(300, 5400))
        items.append({
            "symbol": symbols[i % len(symbols)] if symbols else "MACRO",
            "headline": headline,
            "summary": "SIMULATED FEED — configure FINNHUB_API_KEY for live headlines.",
            "source": source,
            "url": "",
            "datetime": now - i * offset,
            "sentiment": _lexicon_sentiment(headline),
            "category": category,
        })
    return DataResult(items, "simulated", "suffix-news-sim", "deterministic headline set")


_POSITIVE_WORDS = {"beat", "beats", "record", "surge", "surges", "rally", "rallies", "upgrade",
                   "upgrades", "inflow", "inflows", "cool", "cools", "cuts", "growth", "strong",
                   "bullish", "outperform", "raise", "raised", "boost", "optimism", "recovery",
                   "lows", "supportive", "expands"}
_NEGATIVE_WORDS = {"miss", "misses", "plunge", "plunges", "selloff", "downgrade", "downgrades",
                   "outflow", "outflows", "hot", "hawkish", "weak", "bearish", "underperform",
                   "cut", "risk", "warns", "warning", "probe", "lawsuit", "default", "contagion",
                   "stress", "instability", "tensions", "slump", "halts"}


def _lexicon_sentiment(text: str) -> float:
    """Cheap, deterministic headline polarity in [-1, 1]."""
    tokens = [t.strip(".,:;()[]'\"!?").lower() for t in (text or "").split()]
    if not tokens:
        return 0.0
    pos = sum(1 for t in tokens if t in _POSITIVE_WORDS)
    neg = sum(1 for t in tokens if t in _NEGATIVE_WORDS)
    total = pos + neg
    if total == 0:
        return 0.0
    return round((pos - neg) / total, 4)


# --------------------------------------------------------------------------- #
#  Fundamentals — Agent 4 ATHENA
# --------------------------------------------------------------------------- #
def fetch_fundamentals(symbol: str) -> DataResult:
    cache_key = f"fundamentals:{symbol}"
    try:
        import yfinance as yf

        tk = yf.Ticker(symbol)
        info = tk.info or {}
        if info and info.get("marketCap"):
            payload = {
                "symbol": symbol,
                "name": info.get("longName") or info.get("shortName") or symbol,
                "sector": info.get("sector", "n/a"),
                "market_cap": info.get("marketCap"),
                "pe_ttm": info.get("trailingPE"),
                "pe_fwd": info.get("forwardPE"),
                "pb": info.get("priceToBook"),
                "ps": info.get("priceToSalesTrailing12Months"),
                "ev_ebitda": info.get("enterpriseToEbitda"),
                "gross_margin": info.get("grossMargins"),
                "operating_margin": info.get("operatingMargins"),
                "profit_margin": info.get("profitMargins"),
                "revenue_growth": info.get("revenueGrowth"),
                "earnings_growth": info.get("earningsGrowth"),
                "roe": info.get("returnOnEquity"),
                "debt_to_equity": info.get("debtToEquity"),
                "current_ratio": info.get("currentRatio"),
                "free_cashflow": info.get("freeCashflow"),
                "beta": info.get("beta"),
                "dividend_yield": info.get("dividendYield"),
                "target_mean": info.get("targetMeanPrice"),
                "recommendation": info.get("recommendationKey"),
                "shares_outstanding": info.get("sharesOutstanding"),
            }
            _cache_write(cache_key, payload)
            return DataResult(payload, "live", "yfinance", f"fundamentals for {symbol}")
    except Exception as exc:  # noqa: BLE001
        log.debug("yfinance fundamentals failed for %s: %s", symbol, exc)

    cached = _cache_read(cache_key, "json", max_age=60 * 60 * 12)
    if cached:
        return DataResult(cached, "cached", "yfinance-cache", f"cached fundamentals for {symbol}")

    rng = np.random.default_rng(_seed_for(f"fund:{symbol}"))
    is_crypto = symbol.upper().endswith("-USD")
    payload = {
        "symbol": symbol,
        "name": symbol,
        "sector": "Digital Assets" if is_crypto else "Simulated Equity",
        "market_cap": float(rng.uniform(2e9, 9e11)),
        "pe_ttm": None if is_crypto else round(float(rng.uniform(9, 42)), 2),
        "pe_fwd": None if is_crypto else round(float(rng.uniform(8, 34)), 2),
        "pb": None if is_crypto else round(float(rng.uniform(0.8, 12)), 2),
        "ps": None if is_crypto else round(float(rng.uniform(0.6, 14)), 2),
        "ev_ebitda": None if is_crypto else round(float(rng.uniform(5, 26)), 2),
        "gross_margin": None if is_crypto else round(float(rng.uniform(0.18, 0.72)), 4),
        "operating_margin": round(float(rng.uniform(-0.05, 0.38)), 4),
        "profit_margin": round(float(rng.uniform(-0.08, 0.31)), 4),
        "revenue_growth": round(float(rng.uniform(-0.12, 0.55)), 4),
        "earnings_growth": round(float(rng.uniform(-0.25, 0.65)), 4),
        "roe": round(float(rng.uniform(-0.1, 0.42)), 4),
        "debt_to_equity": round(float(rng.uniform(5, 180)), 2),
        "current_ratio": round(float(rng.uniform(0.7, 3.4)), 2),
        "free_cashflow": float(rng.uniform(-1e9, 4e10)),
        "beta": round(float(rng.uniform(0.4, 2.1)), 2),
        "dividend_yield": round(float(rng.uniform(0.0, 0.045)), 4),
        "target_mean": None,
        "recommendation": "n/a",
        "shares_outstanding": float(rng.uniform(1e8, 8e9)),
        "simulated": True,
    }
    return DataResult(payload, "simulated", "suffix-sim", f"simulated fundamentals for {symbol}")


# --------------------------------------------------------------------------- #
#  Institutional flows — Agent 3 CAPITOL
# --------------------------------------------------------------------------- #
def fetch_institutional_flows(symbol: str) -> DataResult:
    """13F + insider activity.

    yfinance exposes ``institutional_holders`` and ``insider_transactions``; the
    public 13F XML endpoints (SEC EDGAR) are rate-limited and gated, so we use
    the aggregator and label simulated data explicitly when unavailable.
    """
    cache_key = f"flows:{symbol}"
    try:
        import yfinance as yf

        tk = yf.Ticker(symbol)
        holders = tk.institutional_holders
        insiders = tk.insider_transactions
        rows: List[Dict[str, Any]] = []
        insider_rows: List[Dict[str, Any]] = []
        if holders is not None and hasattr(holders, "to_dict"):
            for rec in holders.head(10).to_dict(orient="records"):
                rows.append({k: (None if pd.isna(v) else v) for k, v in rec.items()})
        if insiders is not None and hasattr(insiders, "to_dict"):
            for rec in insiders.head(10).to_dict(orient="records"):
                insider_rows.append({k: (None if pd.isna(v) else v) for k, v in rec.items()})
        if rows or insider_rows:
            payload = {
                "symbol": symbol,
                "institutions": rows,
                "insiders": insider_rows,
                "net_insider_bias": _insider_bias(insider_rows),
            }
            _cache_write(cache_key, payload)
            return DataResult(payload, "live" if rows else "partial", "yfinance-13f", "holder + insider data")
    except Exception as exc:  # noqa: BLE001
        log.debug("13F/insider pull failed for %s: %s", symbol, exc)

    cached = _cache_read(cache_key, "json", max_age=60 * 60 * 24)
    if cached:
        return DataResult(cached, "cached", "yfinance-13f", "cached holder data")

    rng = np.random.default_rng(_seed_for(f"flows:{symbol}"))
    funds = ["BlackRock", "Vanguard", "State Street", "Citadel", "Two Sigma",
             "Bridgewater", "Point72", "Millennium", "Renaissance", "DE Shaw"]
    institutions = []
    for i, fund in enumerate(rng.permutation(funds)):
        institutions.append({
            "@type": "13F-HR",
            "holder": f"{fund} Institutional",
            "pct_held": round(float(rng.uniform(0.01, 0.085)), 4),
            "shares": float(rng.integers(2_000_000, 90_000_000)),
            "value": float(rng.uniform(2e8, 2.2e10)),
            "change_pct": round(float(rng.normal(2.5, 9.0)), 2),
        })
    insiders = []
    for _ in range(6):
        tx = str(rng.choice(["Buy", "Sale", "Sale+OE", "Grant"]))
        insiders.append({
            "insider": "Officer / Director",
            "transaction": tx,
            "shares": float(rng.integers(500, 90_000)),
            "value": float(rng.uniform(2e4, 9e6)),
            "date": (datetime.now(timezone.utc) - timedelta(days=int(rng.integers(1, 60)))).date().isoformat(),
        })
    payload = {"symbol": symbol, "institutions": institutions, "insiders": insiders,
               "net_insider_bias": _insider_bias(insiders), "simulated": True}
    return DataResult(payload, "simulated", "suffix-sim", "simulated 13F + insider set")


def _insider_bias(insiders: List[Dict[str, Any]]) -> float:
    score = 0.0
    for tx in insiders:
        label = str(tx.get("transaction") or tx.get("Text") or "").lower()
        if "buy" in label or "purchase" in label:
            score += 1.0
        elif "sale" in label or "sell" in label:
            score -= 1.0
    if not insiders:
        return 0.0
    return round(max(-1.0, min(1.0, score / max(1.0, len(insiders)))), 4)


# --------------------------------------------------------------------------- #
#  Country Instability Index — Agent 1 ATLAS (worldmonitor-style)
# --------------------------------------------------------------------------- #
_CII_BASELINE = {
    "US": 18.0, "CN": 34.0, "RU": 71.0, "UA": 82.0, "IL": 74.0, "IR": 78.0,
    "TW": 46.0, "DE": 15.0, "JP": 13.0, "GB": 17.0, "IN": 29.0, "BR": 33.0,
    "TR": 55.0, "SA": 31.0, "ZA": 44.0, "AR": 58.0, "VE": 84.0, "KR": 22.0,
}


def fetch_instability_index() -> DataResult:
    try:
        import httpx

        # worldmonitor (modules/worldmonitor) exposes a public JSON snapshot.
        resp = httpx.get("https://www.worldmonitor.app/api/cii", timeout=HTTP_TIMEOUT)
        if resp.status_code == 200:
            data = resp.json()
            if isinstance(data, (list, dict)) and data:
                return DataResult(data, "live", "worldmonitor", "live country instability index")
    except Exception as exc:  # noqa: BLE001
        log.debug("worldmonitor CII unavailable: %s", exc)

    cached = _cache_read("cii:snapshot", "json", max_age=60 * 60 * 6)
    if cached:
        return DataResult(cached, "cached", "worldmonitor-cache", "cached CII snapshot")

    rng = np.random.default_rng(int(time.time() // 3600))
    rows = []
    for country, base in _CII_BASELINE.items():
        value = float(np.clip(base + rng.normal(0, 4.5), 0, 100))
        rows.append({
            "country": country,
            "cii": round(value, 2),
            "delta_24h": round(float(rng.normal(0, 1.6)), 2),
            "drivers": ["energy", "rates", "geopolitics"][int(rng.integers(0, 3))],
        })
    rows.sort(key=lambda x: x["cii"], reverse=True)
    return DataResult(rows, "simulated", "suffix-sim", "simulated instability snapshot")


def macro_snapshot() -> DataResult:
    """Rates, inflation prints and the CII in one payload for Agent 1 ATLAS."""
    cii = fetch_instability_index()
    try:
        import yfinance as yf

        symbols = {"US10Y": "^TNX", "US02Y": "^IRX", "DXY": "DX-Y.NYB",
                   "GOLD": "GC=F", "OIL": "CL=F", "VIX": "^VIX", "SPX": "^GSPC"}
        frames = yf.download(list(symbols.values()), period="1mo", interval="1d",
                             progress=False, threads=False, timeout=HTTP_TIMEOUT)
        rates: Dict[str, Any] = {}
        if frames is not None and len(frames):
            close = frames["Close"] if isinstance(frames.columns, pd.MultiIndex) else frames
            for label, tick in symbols.items():
                try:
                    series = close[tick].dropna()
                    if len(series) > 2:
                        rates[label] = {
                            "last": round(float(series.iloc[-1]), 4),
                            "chg_1d": round(float(series.iloc[-1] - series.iloc[-2]), 4),
                            "chg_1m": round(float(series.iloc[-1] - series.iloc[0]), 4),
                        }
                except (KeyError, IndexError):
                    continue
        if rates:
            return DataResult({"rates": rates, "instability": cii.value}, "live",
                              "yfinance", "macro tape live")
        raise RuntimeError("empty macro frame")
    except Exception as exc:  # noqa: BLE001
        log.debug("macro yfinance pull failed: %s", exc)

    rng = np.random.default_rng(int(time.time() // 1800))
    rates = {
        "US10Y": {"last": round(float(4.05 + rng.normal(0, 0.12)), 3), "chg_1d": round(float(rng.normal(0, 0.05)), 3), "chg_1m": round(float(rng.normal(-0.1, 0.22)), 3)},
        "US02Y": {"last": round(float(4.31 + rng.normal(0, 0.1)), 3), "chg_1d": round(float(rng.normal(0, 0.04)), 3), "chg_1m": round(float(rng.normal(-0.2, 0.2)), 3)},
        "DXY": {"last": round(float(101.4 + rng.normal(0, 0.7)), 3), "chg_1d": round(float(rng.normal(0, 0.3)), 3), "chg_1m": round(float(rng.normal(0, 1.4)), 3)},
        "GOLD": {"last": round(float(2420 + rng.normal(0, 35)), 2), "chg_1d": round(float(rng.normal(0, 14)), 2), "chg_1m": round(float(rng.normal(0, 60)), 2)},
        "OIL": {"last": round(float(77.5 + rng.normal(0, 2.2)), 2), "chg_1d": round(float(rng.normal(0, 1.1)), 2), "chg_1m": round(float(rng.normal(0, 4)), 2)},
        "VIX": {"last": round(float(15.4 + abs(rng.normal(0, 2.1))), 2), "chg_1d": round(float(rng.normal(0, 1.0)), 2), "chg_1m": round(float(rng.normal(0, 3.4)), 2)},
        "SPX": {"last": round(float(5620 + rng.normal(0, 55)), 2), "chg_1d": round(float(rng.normal(0, 22)), 2), "chg_1m": round(float(rng.normal(0, 90)), 2)},
    }
    cpi = round(float(2.6 + rng.normal(0, 0.18)), 2)
    return DataResult(
        {"rates": rates, "instability": cii.value,
         "inflation": {"us_cpi_yoy": cpi, "core_cpi_yoy": round(cpi - 0.2, 2),
                       "next_print_days": int(rng.integers(1, 28))},
         "simulated": True},
        "simulated", "suffix-sim", "simulated macro tape")


# --------------------------------------------------------------------------- #
#  Order-book micro snapshot (used by ORACLE / PILOT paper fills)
# --------------------------------------------------------------------------- #
def micro_snapshot(symbol: str) -> DataResult:
    res = last_price(symbol)
    px = float(res.value)
    rng = np.random.default_rng(int(time.time() // 15) ^ _seed_for(symbol))
    spread_bps = settings.paper_spread_bps * float(rng.uniform(0.6, 1.8))
    half = px * spread_bps / 2 / 10_000
    depth = [
        {"side": "bid", "price": round(px - half * (i + 1), 6),
         "size": round(float(rng.lognormal(9.0, 0.6)), 4)} for i in range(5)
    ] + [
        {"side": "ask", "price": round(px + half * (i + 1), 6),
         "size": round(float(rng.lognormal(9.0, 0.6)), 4)} for i in range(5)
    ]
    return DataResult(
        {"symbol": symbol, "mid": round(px, 6), "spread_bps": round(spread_bps, 3),
         "bid": round(px - half, 6), "ask": round(px + half, 6), "depth": depth},
        res.quality, res.source, "synthetic L2 ladder",
    )


def data_health() -> Dict[str, Any]:
    return {
        "finnhub_configured": bool(settings.finnhub_api_key),
        "execution_mode": settings.suffix_execution_mode,
        "synthetic_fallback": settings.suffix_enable_synthetic_fallback,
        "cache_dir": str(settings.cache_dir),
        "cached_artifacts": len(list(settings.cache_dir.glob("*"))) // 2,
    }
