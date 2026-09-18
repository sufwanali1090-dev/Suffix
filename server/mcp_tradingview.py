"""TradingView Desktop MCP bridge — Agent 5 CHARTIST's hands.

Bridges to a local MCP server that drives the TradingView Desktop application
(setup: https://www.cloud9markets.com/claude-tradingview-setup.html).  The MCP
client speaks JSON-RPC 2.0 over stdio, which is the transport the MCP spec
defines for local servers.

Behaviour
---------
* ``attach()``            — spawn the configured MCP command, run ``initialize``.
* ``list_tools()``        — enumerate what the server exposes.
* ``call_tool()``         — generic MCP ``tools/call``.
* ``draw_setup()``        — CHARTIST-specific: set symbol/timeframe and plot
                            support/resistance/stop levels.
* ``get_state()``         — current chart context.

The bridge is *optional by design*: if the MCP server is absent, every call
returns ``{"status": "mcp_unavailable"}`` and CHARTIST says so out loud rather
than pretending the chart moved.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
from typing import Any, Dict, List, Optional

from server.config import settings

log = logging.getLogger("suffix.mcp")


class TradingViewMCP:
    """Minimal, dependency-free MCP stdio client."""

    def __init__(self) -> None:
        self.command = settings.tradingview_mcp_command
        self.args = [a for a in settings.tradingview_mcp_args.split(",") if a]
        self.enabled = settings.suffix_mcp_tradingview
        self.proc: Optional[asyncio.subprocess.Process] = None
        self.tools: List[Dict[str, Any]] = []
        self.status = "offline"
        self.last_error: Optional[str] = None
        self._id = 0
        self._lock = asyncio.Lock()
        self._buffer = b""

    # ------------------------------------------------------------------ plumbing
    def _next_id(self) -> int:
        self._id += 1
        return self._id

    @property
    def available(self) -> bool:
        return self.enabled and self.proc is not None and self.proc.returncode is None

    async def attach(self) -> Dict[str, Any]:
        """Spawn the MCP server and complete the MCP handshake."""
        if not self.enabled:
            self.status = "disabled"
            return {"status": "disabled", "detail": "SUFFIX_MCP_TRADINGVIEW=0"}
        if self.available:
            return {"status": "already_attached", "tools": len(self.tools)}
        # Resolve to a full path and spawn THAT, never the bare name. On Windows
        # `npx` is a `npx.cmd` shim and CreateProcess only ever appends `.exe`,
        # so passing the bare command fails with FileNotFoundError even though
        # the availability check above succeeded.
        executable = shutil.which(self.command)
        if executable is None:
            self.status = "unavailable"
            self.last_error = f"command '{self.command}' not found on PATH"
            log.warning("TradingView MCP unavailable: %s", self.last_error)
            return {"status": "unavailable", "detail": self.last_error}

        try:
            self.proc = await asyncio.create_subprocess_exec(
                executable, *self.args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            init = await self._rpc("initialize", {
                "protocolVersion": "2024-11-05",
                "capabilities": {"roots": {"listChanged": False}, "sampling": {}},
                "clientInfo": {"name": "suffix-trading-desk", "version": settings.suffix_version},
            }, timeout=15.0)
            await self._notify("notifications/initialized", {})
            listed = await self._rpc("tools/list", {}, timeout=10.0)
            self.tools = listed.get("tools", []) if isinstance(listed, dict) else []
            self.status = "attached"
            log.info("TradingView MCP attached: %d tools (%s)", len(self.tools),
                     ", ".join(t.get("name", "?") for t in self.tools[:8]))
            return {"status": "attached", "server": init, "tools": self.tools}
        except Exception as exc:  # noqa: BLE001 - optional dependency
            self.status = "error"
            self.last_error = str(exc)
            log.warning("TradingView MCP attach failed: %s", exc)
            await self.detach()
            return {"status": "error", "detail": str(exc)}

    async def detach(self) -> None:
        if self.proc is not None:
            try:
                self.proc.terminate()
                await asyncio.wait_for(self.proc.wait(), timeout=3.0)
            except (asyncio.TimeoutError, ProcessLookupError):
                try:
                    self.proc.kill()
                except ProcessLookupError:
                    pass
            except Exception:  # noqa: BLE001
                pass
            self.proc = None
        self.status = "offline"

    async def _send(self, payload: Dict[str, Any]) -> None:
        assert self.proc is not None and self.proc.stdin is not None
        line = (json.dumps(payload) + "\n").encode()
        self.proc.stdin.write(line)
        await self.proc.stdin.drain()

    async def _notify(self, method: str, params: Dict[str, Any]) -> None:
        await self._send({"jsonrpc": "2.0", "method": method, "params": params})

    async def _read_message(self, timeout: float) -> Dict[str, Any]:
        assert self.proc is not None and self.proc.stdout is not None

        async def _readline() -> bytes:
            return await self.proc.stdout.readline()  # type: ignore[union-attr]

        while True:
            line = await asyncio.wait_for(_readline(), timeout=timeout)
            if not line:
                raise RuntimeError("MCP server closed the stream")
            text = line.decode(errors="replace").strip()
            if not text:
                continue
            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                continue          # servers sometimes log to stdout; skip noise
            if "id" in msg:       # only responses matter; notifications are dropped
                return msg

    async def _rpc(self, method: str, params: Dict[str, Any], timeout: float = 20.0) -> Any:
        async with self._lock:
            if self.proc is None:
                raise RuntimeError("MCP server not attached")
            rid = self._next_id()
            await self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
            msg = await self._read_message(timeout)
            if "error" in msg:
                raise RuntimeError(f"MCP error: {msg['error']}")
            return msg.get("result", {})

    # ------------------------------------------------------------------ surface
    async def call_tool(self, name: str, arguments: Dict[str, Any],
                        timeout: float = 25.0) -> Dict[str, Any]:
        if not self.available:
            return {"status": "mcp_unavailable", "detail": self.last_error or self.status}
        try:
            result = await self._rpc("tools/call", {"name": name, "arguments": arguments}, timeout)
            return {"status": "ok", "tool": name, "result": result}
        except Exception as exc:  # noqa: BLE001
            log.warning("MCP tool %s failed: %s", name, exc)
            return {"status": "error", "tool": name, "detail": str(exc)}

    def _pick(self, *candidates: str) -> Optional[str]:
        """Find the first tool whose name loosely matches any candidate."""
        names = [t.get("name", "") for t in self.tools]
        for cand in candidates:
            for name in names:
                if cand in name.lower():
                    return name
        return None

    async def draw_setup(self, drawing: Dict[str, Any]) -> Dict[str, Any]:
        """Ask the desktop chart to display the agent's technical setup."""
        if not self.available:
            return {"status": "mcp_unavailable", "detail": self.last_error or self.status}
        symbol = drawing.get("symbol", "BTCUSD")
        timeframe = drawing.get("timeframe", "60")
        levels = drawing.get("levels", {})
        applied: List[str] = []

        sym_tool = self._pick("set_symbol", "symbol", "chart_set")
        if sym_tool:
            ack = await self.call_tool(sym_tool, {"symbol": symbol, "timeframe": timeframe})
            if ack.get("status") == "ok":
                applied.append(f"{sym_tool}→{symbol}/{timeframe}")

        line_tool = self._pick("draw_line", "horizontal_line", "add_line", "draw")
        for label, price in levels.items():
            if not isinstance(price, (int, float)):
                continue
            if line_tool:
                ack = await self.call_tool(line_tool, {
                    "price": float(price), "price1": float(price),
                    "text": f"SUFFIX {label.upper()}", "color": "#22d3ee",
                })
                if ack.get("status") == "ok":
                    applied.append(f"{label}@{float(price):,.4f}")

        return {"status": "drawn" if applied else "no_matching_tools",
                "applied": applied, "tools_available": len(self.tools)}

    async def get_state(self) -> Dict[str, Any]:
        if not self.available:
            return {"status": self.status, "detail": self.last_error}
        tool = self._pick("get_state", "chart_state", "get_symbol", "state")
        if not tool:
            return {"status": "no_matching_tools", "tools_available": len(self.tools)}
        return await self.call_tool(tool, {})

    async def screenshot(self) -> Dict[str, Any]:
        tool = self._pick("screenshot", "capture", "snapshot")
        if not tool:
            return {"status": "no_matching_tools"}
        return await self.call_tool(tool, {})

    def health(self) -> Dict[str, Any]:
        return {
            "enabled": self.enabled,
            "status": self.status,
            "command": f"{self.command} {' '.join(self.args)}",
            "tools": len(self.tools),
            "last_error": self.last_error,
            "cdp": settings.tradingview_desktop_cdp,
            "docs": "https://www.cloud9markets.com/claude-tradingview-setup.html",
        }
