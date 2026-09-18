"""Strategy sandbox — Agent 11's containment cell for arbitrary genomes.

Every genome QUANTUM promotes is re-run here under *hard* limits before it is
allowed to influence a live proposal:

  * wall-clock budget per backtest
  * bar-count cap
  * the same $100 / $80 Do-or-Die risk model as the live desk
  * a deterministic seed so a promoted genome reproduces exactly

There is no ``eval``/``exec`` anywhere: a genome is data (a strategy kind plus
numeric hyperparameters), never code.  Strategy kind is validated against the
declared whitelist before any simulation runs.
"""

from __future__ import annotations

import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional

import pandas as pd

from server.config import settings
from server.quantum import Genome, STRATEGY_KINDS, backtest, build_signals

log = logging.getLogger("suffix.sandbox")


class StrategySandbox:
    def __init__(self, max_workers: int = 2) -> None:
        self.executor = ThreadPoolExecutor(max_workers=max_workers,
                                           thread_name_prefix="quantum-sbx")
        self.timeout_sec = 45.0
        self.max_bars = 20_000
        self.runs = 0
        self.failures = 0

    # -------------------------------------------------------------- validation
    @staticmethod
    def validate(genome: Dict[str, Any]) -> Optional[str]:
        """Return an error string when a genome is malformed."""
        if not isinstance(genome, dict):
            return "genome is not an object"
        kind = genome.get("kind")
        if kind not in STRATEGY_KINDS:
            return f"unknown strategy kind {kind!r}"
        params = genome.get("params")
        if not isinstance(params, dict):
            return "missing params object"
        for key in ("fast", "slow", "stop_atr_mult", "target_atr_mult", "leverage", "risk_pct"):
            if key not in params:
                return f"missing required parameter {key!r}"
        lev = int(params.get("leverage", 0))
        if lev not in settings.allowed_leverage:
            return f"leverage {lev}x outside the whitelist {settings.allowed_leverage}"
        risk = float(params.get("risk_pct", 0.0))
        if not (settings.suffix_risk_min_pct <= risk <= settings.suffix_risk_max_pct):
            return (f"risk {risk}% outside the {settings.suffix_risk_min_pct}–"
                    f"{settings.suffix_risk_max_pct}% directive")
        if float(params.get("stop_atr_mult", 0)) <= 0:
            return "stop_atr_mult must be positive"
        return None

    # ---------------------------------------------------------------- execution
    def _run_sync(self, symbol: str, genome_dict: Dict[str, Any],
                  df: pd.DataFrame) -> Dict[str, Any]:
        genome = Genome(kind=genome_dict["kind"], params=dict(genome_dict["params"]))
        t0 = time.time()
        result = backtest(df, genome, timeframe=settings.suffix_quantum_timeframe,
                          starting_capital=settings.suffix_starting_capital,
                          enforce_death_line=True)
        samples = sum(int(pd.Series(s).sum()) for s in
                      [result.equity > 0]) if result.equity is not None else 0
        return {
            "symbol": symbol,
            "strategy_uid": genome.uid(),
            "kind": genome.kind,
            "bars": len(df),
            "signals_sampled": samples,
            "metrics": result.metrics.model_dump(mode="json"),
            "trades": len(result.trades),
            "sample_trades": result.trades[:10],
            "equity_tail": [round(float(x), 4) for x in result.equity[-120:]],
            "elapsed_ms": int((time.time() - t0) * 1000),
            "gate": {
                "min_sharpe": settings.suffix_min_sharpe,
                "min_profit_factor": settings.suffix_min_profit_factor,
                "passed": (result.metrics.sharpe > settings.suffix_min_sharpe
                           and result.metrics.profit_factor > settings.suffix_min_profit_factor
                           and result.metrics.liquidation_events == 0),
            },
        }

    async def run(self, symbol: str, genome_dict: Dict[str, Any],
                  df: pd.DataFrame) -> Dict[str, Any]:
        """Validate + simulate a genome under a hard wall-clock budget."""
        err = self.validate(genome_dict)
        if err:
            self.failures += 1
            return {"status": "rejected", "error": err, "symbol": symbol}
        if df is None or len(df) < 80:
            self.failures += 1
            return {"status": "rejected", "error": "insufficient history", "symbol": symbol}
        if len(df) > self.max_bars:
            df = df.tail(self.max_bars)

        loop = asyncio.get_running_loop()
        try:
            out = await asyncio.wait_for(
                loop.run_in_executor(self.executor, self._run_sync, symbol, genome_dict, df),
                timeout=self.timeout_sec)
            self.runs += 1
            return {"status": "ok", **out}
        except asyncio.TimeoutError:
            self.failures += 1
            log.warning("Sandbox timeout for %s %s", symbol, genome_dict.get("kind"))
            return {"status": "timeout", "error": f"exceeded {self.timeout_sec}s budget",
                    "symbol": symbol}
        except Exception as exc:  # noqa: BLE001
            self.failures += 1
            log.exception("Sandbox failure for %s", symbol)
            return {"status": "error", "error": str(exc), "symbol": symbol}

    async def signal_preview(self, symbol: str, genome_dict: Dict[str, Any],
                             df: pd.DataFrame, bars: int = 120) -> Dict[str, Any]:
        """Return the most recent long/short signals for HUD visualisation."""
        err = self.validate(genome_dict)
        if err:
            return {"status": "rejected", "error": err}

        def _compute() -> Dict[str, Any]:
            genome = Genome(kind=genome_dict["kind"], params=dict(genome_dict["params"]))
            tail = df.tail(bars * 3)
            le, se = build_signals(tail, genome)
            recent = tail.tail(bars)
            return {
                "index": [str(i) for i in recent.index],
                "close": [round(float(v), 6) for v in recent["close"]],
                "long": [bool(x) for x in le.tail(bars)],
                "short": [bool(x) for x in se.tail(bars)],
            }

        loop = asyncio.get_running_loop()
        try:
            data = await asyncio.wait_for(loop.run_in_executor(self.executor, _compute),
                                          timeout=self.timeout_sec)
            return {"status": "ok", "strategy_uid":
                    Genome(kind=genome_dict["kind"], params=dict(genome_dict["params"])).uid(),
                    **data}
        except Exception as exc:  # noqa: BLE001
            return {"status": "error", "error": str(exc)}

    def shutdown(self) -> None:
        self.executor.shutdown(wait=False, cancel_futures=True)

    def stats(self) -> Dict[str, Any]:
        return {"runs": self.runs, "failures": self.failures,
                "timeout_sec": self.timeout_sec, "max_bars": self.max_bars}
