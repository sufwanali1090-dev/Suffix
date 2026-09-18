"""Agent 9 — LEDGER (The Book).

SQLite trade journal.  Records every fill, every verdict, every strategy
extinction and every dollar of equity the desk has ever held.  Written with the
stdlib ``sqlite3`` driver only: the book must never fail because a wheel is
missing.

Schema (WAL mode, safe for the async bridge + background QUANTUM worker):
    trades          — every open/close, win or loss
    verdicts        — SENTINEL decisions (audit trail for VETOs)
    extinctions     — killed strategies (Do-or-Die graveyard)
    blacklist       — genome hashes purged from active memory
    equity_curve    — timestamped balance snapshots (drives the HUD sparkline)
    utterances      — what SUFFIX said, when, and why
    events          — system event stream mirrored for post-mortems
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from server.config import settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS trades (
    trade_id      TEXT PRIMARY KEY,
    symbol        TEXT NOT NULL,
    side          TEXT NOT NULL,
    quantity      REAL NOT NULL,
    entry_price   REAL NOT NULL,
    exit_price    REAL,
    pnl           REAL DEFAULT 0,
    pnl_pct       REAL DEFAULT 0,
    fees          REAL DEFAULT 0,
    leverage      INTEGER DEFAULT 3,
    strategy_uid  TEXT,
    thesis        TEXT DEFAULT '',
    status        TEXT DEFAULT 'OPEN',
    opened_ms     INTEGER NOT NULL,
    closed_ms     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_closed ON trades(closed_ms);

CREATE TABLE IF NOT EXISTS verdicts (
    verdict_id    TEXT PRIMARY KEY,
    proposal_id   TEXT,
    symbol        TEXT,
    side          TEXT,
    decision      TEXT,
    reasons       TEXT,
    checks        TEXT,
    sizing        TEXT,
    equity        REAL,
    balance       REAL,
    drawdown_pct  REAL,
    risk_state    TEXT,
    ts            INTEGER
);
CREATE INDEX IF NOT EXISTS idx_verdicts_ts ON verdicts(ts);

CREATE TABLE IF NOT EXISTS extinctions (
    strategy_uid  TEXT PRIMARY KEY,
    symbol        TEXT,
    reason        TEXT,
    detail        TEXT,
    sharpe        REAL,
    profit_factor REAL,
    generation    INTEGER,
    genome        TEXT,
    ts            INTEGER
);

CREATE TABLE IF NOT EXISTS blacklist (
    strategy_uid  TEXT PRIMARY KEY,
    symbol        TEXT,
    generation    INTEGER,
    reason        TEXT,
    added_ms      INTEGER
);

CREATE TABLE IF NOT EXISTS equity_curve (
    ts            INTEGER,
    balance       REAL,
    equity        REAL,
    drawdown_pct  REAL,
    open_positions INTEGER
);
CREATE INDEX IF NOT EXISTS idx_equity_ts ON equity_curve(ts);

CREATE TABLE IF NOT EXISTS utterances (
    utterance_id  TEXT PRIMARY KEY,
    text          TEXT,
    voice_text    TEXT,
    priority      TEXT,
    intent        TEXT,
    trace         TEXT,
    ts            INTEGER
);

CREATE TABLE IF NOT EXISTS events (
    event_id      TEXT PRIMARY KEY,
    channel       TEXT,
    level         TEXT,
    title         TEXT,
    detail        TEXT,
    payload       TEXT,
    ts            INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
"""


class Ledger:
    """Thread-safe SQLite journal (single writer, many readers)."""

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path = Path(path or settings.ledger_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        # Set on close(). The background QUANTUM worker can still be finishing a
        # generation during shutdown; rather than raise "Cannot operate on a
        # closed database" we degrade to a no-op. Losing a shutdown-race journal
        # write is strictly better than a stack trace in the operator's console.
        self.closed = False
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False, timeout=30.0)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL;")
            self._conn.execute("PRAGMA synchronous=NORMAL;")
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    # ------------------------------------------------------------------ utils
    def _exec(self, sql: str, params: Iterable[Any] = ()) -> Optional[sqlite3.Cursor]:
        if self.closed:
            return None
        with self._lock:
            if self.closed:
                return None
            cur = self._conn.execute(sql, tuple(params))
            self._conn.commit()
            return cur

    def _query(self, sql: str, params: Iterable[Any] = ()) -> List[sqlite3.Row]:
        if self.closed:
            return []
        with self._lock:
            if self.closed:
                return []
            return list(self._conn.execute(sql, tuple(params)).fetchall())

    @staticmethod
    def _row(row: sqlite3.Row | None) -> Optional[Dict[str, Any]]:
        return dict(row) if row is not None else None

    def close(self) -> None:
        with self._lock:
            if self.closed:
                return
            self.closed = True
            try:
                self._conn.commit()
            except sqlite3.Error:
                pass
            self._conn.close()

    # ----------------------------------------------------------------- trades
    def open_trade(self, *, trade_id: str, symbol: str, side: str, quantity: float,
                   entry_price: float, leverage: int, fees: float,
                   strategy_uid: Optional[str], thesis: str = "") -> None:
        self._exec(
            """INSERT OR REPLACE INTO trades
               (trade_id, symbol, side, quantity, entry_price, leverage, fees,
                strategy_uid, thesis, status, opened_ms)
               VALUES (?,?,?,?,?,?,?,?,?, 'OPEN', ?)""",
            (trade_id, symbol, side, quantity, entry_price, leverage, fees,
             strategy_uid, thesis, int(time.time() * 1000)),
        )

    def close_trade(self, *, trade_id: str, exit_price: float, pnl: float,
                    pnl_pct: float, fees: float, status: str) -> None:
        self._exec(
            """UPDATE trades SET exit_price=?, pnl=?, pnl_pct=?, fees=fees+?,
               status=?, closed_ms=? WHERE trade_id=?""",
            (exit_price, pnl, pnl_pct, fees, status, int(time.time() * 1000), trade_id),
        )

    def recent_trades(self, limit: int = 50, status: Optional[str] = None) -> List[Dict[str, Any]]:
        if status:
            rows = self._query(
                "SELECT * FROM trades WHERE status=? ORDER BY opened_ms DESC LIMIT ?",
                (status, int(limit)))
        else:
            rows = self._query(
                "SELECT * FROM trades ORDER BY opened_ms DESC LIMIT ?", (int(limit),))
        return [dict(r) for r in rows]

    def open_tickets(self) -> List[Dict[str, Any]]:
        return [dict(r) for r in self._query("SELECT * FROM trades WHERE status='OPEN'")]

    def trade_stats(self) -> Dict[str, Any]:
        closed = self._query("SELECT pnl, pnl_pct, symbol, side, opened_ms, closed_ms, strategy_uid FROM trades WHERE status!='OPEN'")
        rows = [dict(r) for r in closed]
        wins = [r for r in rows if r["pnl"] > 0]
        losses = [r for r in rows if r["pnl"] < 0]
        gross_win = sum(r["pnl"] for r in wins)
        gross_loss = abs(sum(r["pnl"] for r in losses))
        return {
            "trades": len(rows),
            "wins": len(wins),
            "losses": len(losses),
            "win_rate": round(len(wins) / len(rows) * 100.0, 2) if rows else 0.0,
            "profit_factor": round(gross_win / gross_loss, 3) if gross_loss > 0 else (float("inf") if gross_win > 0 else 0.0),
            "gross_profit": round(gross_win, 2),
            "gross_loss": round(gross_loss, 2),
            "net_pnl": round(gross_win - gross_loss, 2),
            "avg_win": round(gross_win / len(wins), 4) if wins else 0.0,
            "avg_loss": round(-gross_loss / len(losses), 4) if losses else 0.0,
            "expectancy": round((gross_win - gross_loss) / len(rows), 4) if rows else 0.0,
        }

    # --------------------------------------------------------------- verdicts
    def record_verdict(self, verdict: Dict[str, Any]) -> None:
        self._exec(
            """INSERT OR REPLACE INTO verdicts
               (verdict_id, proposal_id, symbol, side, decision, reasons, checks,
                sizing, equity, balance, drawdown_pct, risk_state, ts)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (verdict.get("verdict_id"), verdict.get("proposal_id"), verdict.get("symbol"),
             verdict.get("side"), verdict.get("decision"),
             json.dumps(verdict.get("reasons", [])),
             json.dumps(verdict.get("checks", [])),
             json.dumps(verdict.get("sizing") or {}),
             verdict.get("equity", 0.0), verdict.get("balance", 0.0),
             verdict.get("drawdown_pct", 0.0), verdict.get("risk_state", "ARMED"),
             int(verdict.get("ts") or time.time() * 1000)),
        )

    def recent_verdicts(self, limit: int = 30) -> List[Dict[str, Any]]:
        rows = self._query("SELECT * FROM verdicts ORDER BY ts DESC LIMIT ?", (int(limit),))
        out = []
        for r in rows:
            d = dict(r)
            for k in ("reasons", "checks", "sizing"):
                try:
                    d[k] = json.loads(d[k]) if d[k] else ([] if k != "sizing" else {})
                except (TypeError, json.JSONDecodeError):
                    d[k] = [] if k != "sizing" else {}
            out.append(d)
        return out

    def veto_count_today(self) -> int:
        start = int(time.time() // 86400 * 86400 * 1000)
        row = self._query(
            "SELECT COUNT(*) AS c FROM verdicts WHERE decision='VETO' AND ts>=?", (start,))
        return int(row[0]["c"]) if row else 0

    # ------------------------------------------------------------ extinctions
    def extinct(self, record: Dict[str, Any]) -> None:
        self._exec(
            """INSERT OR REPLACE INTO extinctions
               (strategy_uid, symbol, reason, detail, sharpe, profit_factor,
                generation, genome, ts)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (record["strategy_uid"], record.get("symbol", ""), record.get("reason", "MANUAL"),
             record.get("detail", ""), record.get("sharpe", 0.0),
             record.get("profit_factor", 0.0), record.get("generation", 0),
             json.dumps(record.get("genome", {})), int(record.get("ts") or time.time() * 1000)),
        )
        self.blacklist_add(record["strategy_uid"], record.get("symbol", ""),
                           record.get("generation", 0), record.get("reason", "MANUAL"))

    def extinctions(self, limit: int = 100) -> List[Dict[str, Any]]:
        rows = self._query("SELECT * FROM extinctions ORDER BY ts DESC LIMIT ?", (int(limit),))
        out = []
        for r in rows:
            d = dict(r)
            try:
                d["genome"] = json.loads(d["genome"]) if d["genome"] else {}
            except (TypeError, json.JSONDecodeError):
                d["genome"] = {}
            out.append(d)
        return out

    def extinction_count(self) -> int:
        row = self._query("SELECT COUNT(*) AS c FROM extinctions")
        return int(row[0]["c"]) if row else 0

    # --------------------------------------------------------------- blacklist
    def blacklist_add(self, strategy_uid: str, symbol: str, generation: int, reason: str) -> None:
        self._exec(
            """INSERT OR REPLACE INTO blacklist (strategy_uid, symbol, generation, reason, added_ms)
               VALUES (?,?,?,?,?)""",
            (strategy_uid, symbol, int(generation), reason, int(time.time() * 1000)),
        )

    def blacklist_ids(self) -> List[str]:
        return [r["strategy_uid"] for r in self._query("SELECT strategy_uid FROM blacklist")]

    def is_blacklisted(self, strategy_uid: str) -> bool:
        rows = self._query("SELECT 1 FROM blacklist WHERE strategy_uid=? LIMIT 1", (strategy_uid,))
        return bool(rows)

    def blacklist_count(self) -> int:
        row = self._query("SELECT COUNT(*) AS c FROM blacklist")
        return int(row[0]["c"]) if row else 0

    def purge_blacklist(self, keep: int = 512) -> int:
        """Bound the blacklist table (oldest entries beyond ``keep`` are dropped)."""
        rows = self._query("SELECT strategy_uid FROM blacklist ORDER BY added_ms DESC LIMIT -1 OFFSET ?", (int(keep),))
        for r in rows:
            self._exec("DELETE FROM blacklist WHERE strategy_uid=?", (r["strategy_uid"],))
        return len(rows)

    # ------------------------------------------------------------ equity curve
    def record_equity(self, *, balance: float, equity: float,
                      drawdown_pct: float, open_positions: int, ts: Optional[int] = None) -> None:
        self._exec(
            "INSERT INTO equity_curve (ts, balance, equity, drawdown_pct, open_positions) VALUES (?,?,?,?,?)",
            (int(ts or time.time() * 1000), balance, equity, drawdown_pct, open_positions),
        )

    def equity_series(self, limit: int = 240) -> List[Dict[str, Any]]:
        rows = self._query(
            "SELECT * FROM equity_curve ORDER BY ts DESC LIMIT ?", (int(limit),))
        return [dict(r) for r in reversed(rows)]

    def prune_equity_curve(self, keep: int = 5000) -> None:
        self._exec(
            "DELETE FROM equity_curve WHERE ts < (SELECT MIN(ts) FROM (SELECT ts FROM equity_curve ORDER BY ts DESC LIMIT ?))",
            (int(keep),))

    # ------------------------------------------------------------- utterances
    def record_utterance(self, u: Dict[str, Any]) -> None:
        self._exec(
            """INSERT OR REPLACE INTO utterances
               (utterance_id, text, voice_text, priority, intent, trace, ts)
               VALUES (?,?,?,?,?,?,?)""",
            (u.get("utterance_id"), u.get("text"), u.get("voice_text", ""),
             u.get("priority", "briefing"), u.get("intent", ""),
             json.dumps(u.get("trace", [])), int(u.get("ts") or time.time() * 1000)),
        )

    def recent_utterances(self, limit: int = 40) -> List[Dict[str, Any]]:
        rows = self._query("SELECT * FROM utterances ORDER BY ts DESC LIMIT ?", (int(limit),))
        out = []
        for r in rows:
            d = dict(r)
            try:
                d["trace"] = json.loads(d["trace"]) if d["trace"] else []
            except (TypeError, json.JSONDecodeError):
                d["trace"] = []
            out.append(d)
        return out

    # ------------------------------------------------------------------ events
    def record_event(self, event: Dict[str, Any]) -> None:
        self._exec(
            """INSERT OR REPLACE INTO events (event_id, channel, level, title, detail, payload, ts)
               VALUES (?,?,?,?,?,?,?)""",
            (event.get("event_id"), event.get("channel", "system"), event.get("level", "info"),
             event.get("title", ""), event.get("detail", ""),
             json.dumps(event.get("payload", {})), int(event.get("ts") or time.time() * 1000)),
        )

    def recent_events(self, limit: int = 100, channel: Optional[str] = None) -> List[Dict[str, Any]]:
        if channel:
            rows = self._query("SELECT * FROM events WHERE channel=? ORDER BY ts DESC LIMIT ?",
                               (channel, int(limit)))
        else:
            rows = self._query("SELECT * FROM events ORDER BY ts DESC LIMIT ?", (int(limit),))
        out = []
        for r in rows:
            d = dict(r)
            try:
                d["payload"] = json.loads(d["payload"]) if d["payload"] else {}
            except (TypeError, json.JSONDecodeError):
                d["payload"] = {}
            out.append(d)
        return out

    def stats(self) -> Dict[str, Any]:
        return {
            "trades": self.trade_stats(),
            "extinctions": self.extinction_count(),
            "blacklisted": self.blacklist_count(),
            "verdicts": len(self._query("SELECT verdict_id FROM verdicts")),
            "equity_points": len(self._query("SELECT ts FROM equity_curve")),
            "db_path": str(self.path),
        }


_ledger: Optional[Ledger] = None
_ledger_lock = threading.Lock()


def get_ledger() -> Ledger:
    """Process-wide singleton."""
    global _ledger
    if _ledger is None:
        with _ledger_lock:
            if _ledger is None:
                _ledger = Ledger()
    return _ledger
