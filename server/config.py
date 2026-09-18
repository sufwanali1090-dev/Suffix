"""SUFFIX TRADING DESK — runtime configuration.

This module is the SINGLE SOURCE OF TRUTH for every hard constraint in the desk.
The Electron/React HUD never hard-codes risk numbers: it calls ``system.config``
over JSON-RPC and renders whatever this file says.  If the two ever disagree,
Python wins.

The "Do or Die" evolutionary directive
--------------------------------------
*  starting capital ........ 100.00 USD   (paper)
*  death line ..............  80.00 USD   (-20% total drawdown => KILL)
*  risk per trade ..........   1.0% .. 2.0% of equity, hard-capped at 2.00 USD
*  leverage ................   only 3x, 5x or 10x — never anything else
*  performance gate ........  OOS Sharpe > 1.8 and Profit Factor > 1.5
*  adaptive penalty ........  exp(-k * loss_streak) reward decay + hyperparameter
                              mutation (slashed lookbacks, tightened stops)
                              across 50 generations
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import List, Literal, Tuple

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT_DIR / ".env"

ExecutionMode = Literal["paper", "testnet", "live"]


class Settings(BaseSettings):
    """Environment-driven settings.

    Every value is optional; the desk boots fully in simulated ``paper`` mode
    with zero API keys so that the HUD, agents and QUANTUM engine are always
    demonstrable offline.
    """

    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ------------------------------------------------------------------ identity
    suffix_version: str = "1.0.0"
    suffix_codename: str = "SUFFIX TRADING DESK"
    suffix_tagline: str = "Nine agents, one voice."

    # ------------------------------------------------------- account / directive
    suffix_starting_capital: float = 100.00
    suffix_death_line: float = 80.00
    suffix_risk_min_pct: float = 1.0
    suffix_risk_max_pct: float = 2.0
    suffix_absolute_risk_ceiling: float = 2.00
    suffix_allowed_leverage: str = "3,5,10"
    suffix_max_concurrent_positions: int = 2
    suffix_daily_loss_limit_pct: float = 5.0
    suffix_consecutive_loss_cooldown: int = 3
    suffix_cooldown_minutes: int = 45

    # ---------------------------------------------------- Agent 11 performance
    suffix_min_sharpe: float = 1.8
    suffix_min_profit_factor: float = 1.5
    suffix_min_oos_trades: int = 12
    suffix_walk_forward_windows: int = 3
    suffix_mutation_generations: int = 50
    suffix_penalty_base_k: float = 0.55
    suffix_max_blacklist_purge_batch: int = 256

    # --------------------------------------------------------------- execution
    suffix_execution_mode: ExecutionMode = "paper"
    suffix_allow_testnet: bool = False
    suffix_paper_fee_bps: float = 6.0
    suffix_paper_slippage_bps: float = 4.0
    suffix_paper_spread_bps: float = 1.5

    # ------------------------------------------------------------- market data
    finnhub_api_key: str = ""
    finnhub_base: str = "https://finnhub.io/api/v1"

    # ------------------------------------------------------------ AI sidecars
    suffix_stt_backend: Literal["whisper_cpp", "disabled"] = "whisper_cpp"
    whisper_cpp_url: str = "http://127.0.0.1:8082/inference"
    whisper_cpp_bin: str = "modules/whisper.cpp/build/bin/whisper-cli"
    whisper_cpp_model: str = "modules/whisper.cpp/models/ggml-base.en.bin"

    suffix_tts_backend: Literal["kokoro", "elevenlabs", "disabled"] = "kokoro"
    kokoro_url: str = "http://127.0.0.1:8880/v1/audio/speech"
    kokoro_voice: str = "am_michael"
    kokoro_speed: float = 1.0
    elevenlabs_api_key: str = ""
    elevenlabs_voice_id: str = "onwK4e9ZLuTAKqWW03F9"
    elevenlabs_model: str = "eleven_turbo_v2_5"

    # ------------------------------------------------------- Binance testnet
    binance_testnet_base: str = "https://testnet.binance.vision"
    binance_api_key: str = ""
    binance_api_secret: str = ""

    # ------------------------------------------------------------- TradingView MCP
    suffix_mcp_tradingview: bool = True
    tradingview_mcp_command: str = "npx"
    tradingview_mcp_args: str = "-y,@modelcontextprotocol/server-tradingview"
    tradingview_desktop_cdp: str = "http://127.0.0.1:9222"

    # ------------------------------------------------------- Agent 11 QUANTUM
    suffix_quantum_enabled: bool = True
    suffix_quantum_symbols: str = "BTC-USD,ETH-USD,SOL-USD,SPY,QQQ"
    suffix_quantum_timeframe: str = "4h"
    suffix_quantum_study: str = "quantum_v1"
    suffix_quantum_trials_per_generation: int = 40
    suffix_quantum_bg_interval_sec: int = 900
    suffix_quantum_seed: int = 1337
    suffix_history_days: int = 180

    # ------------------------------------------------------------- telemetry
    # How often the desk pushes a telemetry frame to connected HUDs. The frame
    # carries 10 nodes with 48-point sparkline series, so ~2s keeps the ring and
    # equity readouts live without flooding the socket.
    suffix_telemetry_interval_sec: int = 2

    # ------------------------------------------------------------ networking
    suffix_api_host: str = "0.0.0.0"
    suffix_api_port: int = 8000
    suffix_ws_path: str = "/ws"
    suffix_log_level: str = "INFO"
    suffix_enable_synthetic_fallback: bool = True
    suffix_attach_mcp: bool = True
    suffix_auto_launch_quantum_worker: bool = True

    # ------------------------------------------------------------- validators
    @field_validator("suffix_execution_mode")
    @classmethod
    def _no_live_money(cls, v: ExecutionMode) -> ExecutionMode:
        # Policy: real-money live trading is disabled in code. It cannot be
        # enabled by an environment variable, only by editing this validator.
        if v == "live":
            return "testnet"
        return v

    # --------------------------------------------------------------- derived
    @property
    def allowed_leverage(self) -> Tuple[int, ...]:
        parts: List[int] = []
        for chunk in self.suffix_allowed_leverage.split(","):
            chunk = chunk.strip()
            if chunk.isdigit():
                parts.append(int(chunk))
        return tuple(sorted(set(parts)) or (3, 5, 10))

    @property
    def quantum_symbols(self) -> List[str]:
        return [s.strip().upper() for s in self.suffix_quantum_symbols.split(",") if s.strip()]

    @property
    def watchlist(self) -> List[str]:
        return self.quantum_symbols

    @property
    def risk_min_usd(self) -> float:
        """Dollar floor of the 1% band, measured against starting capital."""
        return round(self.suffix_starting_capital * self.suffix_risk_min_pct / 100.0, 2)

    @property
    def risk_max_usd(self) -> float:
        """Dollar ceiling of the 2% band, measured against starting capital."""
        return round(
            min(
                self.suffix_starting_capital * self.suffix_risk_max_pct / 100.0,
                self.suffix_absolute_risk_ceiling,
            ),
            2,
        )

    @property
    def daily_loss_limit_usd(self) -> float:
        return round(self.suffix_starting_capital * self.suffix_daily_loss_limit_pct / 100.0, 2)

    # ------------------------------------------------- micro-structure aliases
    # Short, readable handles used by the broker, PILOT and the backtester.
    @property
    def paper_fee_bps(self) -> float:
        return self.suffix_paper_fee_bps

    @property
    def paper_slippage_bps(self) -> float:
        return self.suffix_paper_slippage_bps

    @property
    def paper_spread_bps(self) -> float:
        return self.suffix_paper_spread_bps

    @property
    def min_sharpe(self) -> float:
        return self.suffix_min_sharpe

    @property
    def min_profit_factor(self) -> float:
        return self.suffix_min_profit_factor

    @property
    def death_line(self) -> float:
        return self.suffix_death_line

    @property
    def starting_capital(self) -> float:
        return self.suffix_starting_capital

    @property
    def runtime_dir(self) -> Path:
        p = Path(os.getenv("SUFFIX_RUNTIME_DIR", str(ROOT_DIR / "runtime")))
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def cache_dir(self) -> Path:
        p = self.runtime_dir / "cache"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def data_dir(self) -> Path:
        p = self.runtime_dir / "data"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def ledger_path(self) -> Path:
        return self.runtime_dir / "ledger.db"

    @property
    def optuna_path(self) -> Path:
        return self.runtime_dir / "quantum_optuna.db"

    @property
    def registry_path(self) -> Path:
        return self.runtime_dir / "quantum_registry.json"

    @property
    def tts_enabled(self) -> bool:
        return self.suffix_tts_backend != "disabled"

    def public_snapshot(self) -> dict:
        """Safe-for-the-renderer view of the directive (no secrets)."""
        return {
            "version": self.suffix_version,
            "codename": self.suffix_codename,
            "tagline": self.suffix_tagline,
            "execution_mode": self.suffix_execution_mode,
            "starting_capital": self.suffix_starting_capital,
            "death_line": self.suffix_death_line,
            "risk_min_pct": self.suffix_risk_min_pct,
            "risk_max_pct": self.suffix_risk_max_pct,
            "risk_min_usd": self.risk_min_usd,
            "risk_max_usd": self.risk_max_usd,
            "absolute_risk_ceiling": self.suffix_absolute_risk_ceiling,
            "allowed_leverage": list(self.allowed_leverage),
            "max_concurrent_positions": self.suffix_max_concurrent_positions,
            "daily_loss_limit_usd": self.daily_loss_limit_usd,
            "daily_loss_limit_pct": self.suffix_daily_loss_limit_pct,
            "consecutive_loss_cooldown": self.suffix_consecutive_loss_cooldown,
            "min_sharpe": self.suffix_min_sharpe,
            "min_profit_factor": self.suffix_min_profit_factor,
            "mutation_generations": self.suffix_mutation_generations,
            "paper_fee_bps": self.suffix_paper_fee_bps,
            "paper_slippage_bps": self.suffix_paper_slippage_bps,
            "watchlist": self.watchlist,
            "quantum": {
                "enabled": self.suffix_quantum_enabled,
                "timeframe": self.suffix_quantum_timeframe,
                "study": self.suffix_quantum_study,
                "trials_per_generation": self.suffix_quantum_trials_per_generation,
                "background_interval_sec": self.suffix_quantum_bg_interval_sec,
            },
            "sidecars": {
                "stt": self.suffix_stt_backend,
                "tts": self.suffix_tts_backend,
                "finnhub_configured": bool(self.finnhub_api_key),
                "binance_testnet_configured": bool(self.binance_api_key),
                "tradingview_mcp": self.suffix_mcp_tradingview,
            },
        }


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached settings accessor (also used as a FastAPI dependency)."""
    return Settings()


settings = get_settings()
