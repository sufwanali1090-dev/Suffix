"""SUFFIX TRADING DESK — FastAPI Backend Bridge.

Responsibilities
----------------
* **JSON-RPC 2.0 over HTTP** (``POST /rpc``) and **over WebSocket** (``/ws``) —
  the same dispatcher serves both transports, so the Electron main process and
  the renderer share one contract.
* **WebSocket streaming** — pushes ``telemetry`` frames, ``utterance`` payloads
  (with base64 audio when requested), ``event`` records and ``handshake``.
* **REST conveniences** — health, status, config, agents, quantum, ledger, and
  the TTS/STT endpoints used by the HUD.
* **Lifecycle** — boots SUFFIX (orchestrator + QUANTUM background worker + MCP)
  on startup and tears it all down cleanly on shutdown.

Run standalone with::

    python3 -m uvicorn server.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware

from server.config import settings
from server.contracts import RpcError, RpcRequest, RpcResponse
from server.ledger import get_ledger
from server.market_data import data_health, fetch_ohlcv, micro_snapshot, synthetic_ohlcv
from server.orchestrator import SuffixOrchestrator, get_orchestrator
from server.providers.stt import SpeechUnavailable, get_stt
from server.providers.tts import get_tts

logging.basicConfig(
    level=getattr(logging, settings.suffix_log_level.upper(), logging.INFO),
    format="%(asctime)s | %(levelname)-7s | %(name)-22s | %(message)s",
)
log = logging.getLogger("suffix.bridge")

# Third-party providers are chatty in exactly the situations we degrade through
# gracefully: yfinance screams about every blocked TLS handshake, and urllib3
# warns about the retries it is already handling. Those are expected conditions
# on this desk (the synthetic fallback exists for them), so demote them —
# otherwise the operator's console is nothing but Yahoo SSL noise.
for noisy in ("yfinance", "urllib3", "peewee", "asyncio", "httpx", "httpcore",
              "matplotlib", "numba", "PIL"):
    logging.getLogger(noisy).setLevel(logging.CRITICAL)


# =========================================================================== #
#  RPC envelope helpers
# =========================================================================== #
class RpcDispatcher:
    """Method registry shared by the HTTP and WebSocket transports."""

    def __init__(self) -> None:
        self.methods: Dict[str, Callable[..., Any]] = {}
        self.stats: Dict[str, Any] = {"calls": 0, "errors": 0, "by_method": {}}

    def register(self, name: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        def deco(fn: Callable[..., Any]) -> Callable[..., Any]:
            self.methods[name] = fn
            return fn
        return deco

    async def dispatch(self, request: Dict[str, Any], ws: Optional[WebSocket] = None) -> Dict[str, Any]:
        rid = request.get("id")
        method = request.get("method", "")
        params = request.get("params") or {}
        if not isinstance(params, dict):
            params = {"_positional": params} if isinstance(params, list) else {}
        fn = self.methods.get(method)
        if fn is None:
            self.stats["errors"] += 1
            return RpcResponse(id=rid, error=RpcError(
                code=-32601, message=f"Method not found: {method}",
                data={"available": sorted(self.methods)})).model_dump(mode="json")
        try:
            self.stats["calls"] += 1
            self.stats["by_method"][method] = self.stats["by_method"].get(method, 0) + 1
            import inspect

            kwargs = dict(params)
            if ws is not None and "ws" in inspect.signature(fn).parameters:
                kwargs["ws"] = ws
            result = fn(**kwargs)
            if asyncio.iscoroutine(result):
                result = await result
            return RpcResponse(id=rid, result=result if result is not None else {}).model_dump(mode="json")
        except TypeError as exc:
            self.stats["errors"] += 1
            return RpcResponse(id=rid, error=RpcError(
                code=-32602, message=f"Invalid params for {method}: {exc}")).model_dump(mode="json")
        except Exception as exc:  # noqa: BLE001
            self.stats["errors"] += 1
            log.exception("RPC %s failed", method)
            return RpcResponse(id=rid, error=RpcError(
                code=-32000, message=str(exc), data={"method": method})).model_dump(mode="json")


rpc = RpcDispatcher()


# =========================================================================== #
#  Application lifecycle
# =========================================================================== #
@asynccontextmanager
async def lifespan(app: FastAPI):
    desk = get_orchestrator()
    app.state.desk = desk
    await desk.startup()
    log.info("Bridge ready on %s:%s (WS %s)", settings.suffix_api_host,
             settings.suffix_api_port, settings.suffix_ws_path)
    try:
        yield
    finally:
        await desk.shutdown()
        get_ledger().close()
        log.info("Bridge stopped")


app = FastAPI(
    title="SUFFIX TRADING DESK — Backend Bridge",
    version=settings.suffix_version,
    description=f"{settings.suffix_codename}. {settings.suffix_tagline} "
                "JSON-RPC 2.0 over HTTP and WebSocket.",
    lifespan=lifespan,
)


# --------------------------------------------------------------------------- #
#  CORS + private-network access for the Electron renderer / live preview
# --------------------------------------------------------------------------- #
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],              # desktop shell + sandboxed preview origins
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)


class PreviewHeaderMiddleware(BaseHTTPMiddleware):
    """Allow embedding in the harness preview iframe and cross-origin fetches.

    The desk is a local-first tool: the API is unauthenticated by design and
    binds to loopback in normal desktop use. These headers only relax *browser*
    framing/XHR policy so the cinematic HUD can be shown in a proxied preview.
    """

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["Access-Control-Allow-Private-Network"] = "true"
        # Starlette's MutableHeaders supports `del`, not `pop`.
        if "x-frame-options" in response.headers:
            del response.headers["x-frame-options"]
        csp = response.headers.get("content-security-policy")
        if csp:
            response.headers["Content-Security-Policy"] = csp.replace(
                "frame-ancestors 'none'", "frame-ancestors *")
        else:
            response.headers["Content-Security-Policy"] = "frame-ancestors *"
        return response


app.add_middleware(PreviewHeaderMiddleware)


# --------------------------------------------------------------------------- #
#  The built HUD
# --------------------------------------------------------------------------- #
# The renderer bundle is served from the bridge itself so a single port
# (SUFFIX_API_PORT) is a complete desk: open it in a browser and the cinematic
# HUD comes up on the very origin it talks to. That matters in proxied preview
# environments where the API port is the one that gets exposed. The bundle uses
# relative asset paths and a relative WebSocket, so it needs no configuration.
#
# `dist/` is a build artifact and may be absent on a fresh checkout; the mount
# is only registered when it exists, and `/info` always stays the
# machine-readable view either way.
HUD_DIST = Path(__file__).resolve().parent.parent / "dist"
HUD_AVAILABLE = HUD_DIST.is_dir() and (HUD_DIST / "index.html").is_file()


# =========================================================================== #
#  REST surface
# =========================================================================== #
@app.get("/info")
async def info() -> Dict[str, Any]:
    return {
        "name": settings.suffix_codename,
        "tagline": settings.suffix_tagline,
        "version": settings.suffix_version,
        "transport": {"http_rpc": "/rpc", "websocket": settings.suffix_ws_path},
        "hud_served_here": HUD_AVAILABLE,
        "directive": {
            "starting_capital": settings.suffix_starting_capital,
            "death_line": settings.suffix_death_line,
            "risk_band_usd": [settings.risk_min_usd, settings.risk_max_usd],
            "leverage": list(settings.allowed_leverage),
            "gate": {"sharpe": settings.suffix_min_sharpe,
                     "profit_factor": settings.suffix_min_profit_factor},
            "generations": settings.suffix_mutation_generations,
        },
    }


if not HUD_AVAILABLE:

    @app.get("/")
    async def root() -> Dict[str, Any]:
        """Without a build there is no HUD to serve — point at how to get one."""
        return {
            **await info(),
            "note": "Run `npm run build`, then restart the bridge to serve the "
                    "HUD from this port. In development the Vite dev server "
                    "provides it on port 5173.",
        }


@app.get("/health")
async def health() -> Dict[str, Any]:
    desk: SuffixOrchestrator = app.state.desk
    stt_health = await asyncio.to_thread(get_stt().health)
    tts_health = await asyncio.to_thread(get_tts().health)
    return {
        "ok": True,
        "ts": int(time.time() * 1000),
        "risk_state": desk.broker.risk_state,
        "equity": desk.broker.equity(),
        "positions": len(desk.broker.positions),
        "subscribers": len(desk.subscribers),
        "rpc_stats": rpc.stats,
        "sidecars": {"stt": stt_health, "tts": tts_health, "mcp": desk.mcp.health()},
        "market_data": data_health(),
    }


@app.get("/status")
async def status() -> Dict[str, Any]:
    return app.state.desk.status()


@app.get("/config")
async def config() -> Dict[str, Any]:
    return settings.public_snapshot()


@app.get("/telemetry")
async def telemetry() -> Dict[str, Any]:
    return app.state.desk.telemetry().model_dump(mode="json")


@app.get("/agents")
async def agents() -> Dict[str, Any]:
    desk: SuffixOrchestrator = app.state.desk
    return {"agents": [s.model_dump(mode="json") for s in desk.agent_state.values()],
            "last_reports": {k.value: v.model_dump(mode="json") for k, v in desk.last_reports.items()}}


@app.get("/events")
async def events(limit: int = 120, channel: Optional[str] = None) -> Dict[str, Any]:
    desk: SuffixOrchestrator = app.state.desk
    persisted = await asyncio.to_thread(get_ledger().recent_events, limit, channel)
    return {"live": [e.model_dump(mode="json") for e in list(desk.events)[-limit:]],
            "persisted": persisted}


@app.get("/ledger")
async def ledger_stats() -> Dict[str, Any]:
    led = get_ledger()
    return {
        "stats": await asyncio.to_thread(led.stats),
        "trades": await asyncio.to_thread(led.recent_trades, 40),
        "verdicts": await asyncio.to_thread(led.recent_verdicts, 30),
        "extinctions": await asyncio.to_thread(led.extinctions, 40),
        "equity_curve": await asyncio.to_thread(led.equity_series, 240),
        "utterances": await asyncio.to_thread(led.recent_utterances, 30),
    }


@app.get("/quantum")
async def quantum_state() -> Dict[str, Any]:
    engine = app.state.desk.engine
    return {
        "state": engine.state().model_dump(mode="json"),
        "engine": engine.engine_info(),
        "active": engine.active_strategies(),
        "history": engine.history[-25:],
        "registry_size": len(engine.registry.active),
        "blacklist": sorted(list(engine.registry.blacklist))[:200],
    }


@app.get("/market/{symbol}")
async def market(symbol: str, timeframe: str = "1h", bars: int = 240) -> Dict[str, Any]:
    res = await asyncio.to_thread(fetch_ohlcv, symbol.upper(), timeframe, min(bars, 2000))
    df = res.value
    payload = {
        "symbol": symbol.upper(), "timeframe": timeframe,
        "quality": res.quality, "source": res.source, "detail": res.detail,
        "micro": (await asyncio.to_thread(micro_snapshot, symbol.upper())).value,
    }
    if df is not None and hasattr(df, "tail"):
        payload["candles"] = [
            {"t": str(idx), "o": float(r["open"]), "h": float(r["high"]),
             "l": float(r["low"]), "c": float(r["close"]), "v": float(r["volume"])}
            for idx, r in df.tail(bars).iterrows()
        ]
    return payload


# --------------------------------------------------------------------------- #
#  Voice sidecars
# --------------------------------------------------------------------------- #
class SpeakRequest(BaseModel):
    text: str
    voice: Optional[str] = None
    priority: str = "briefing"


@app.post("/tts")
async def tts_endpoint(req: SpeakRequest) -> Response:
    audio = await get_tts().synthesize(req.text, voice=req.voice, priority=req.priority)
    if audio is None:
        return JSONResponse(status_code=503,
                            content={"error": "tts_unavailable",
                                     "detail": get_tts().health(),
                                     "fallback": "browser_speech_synthesis"})
    return Response(content=audio[0], media_type=audio[1],
                    headers={"Cache-Control": "no-store"})


@app.get("/tts/health")
async def tts_health() -> Dict[str, Any]:
    return await asyncio.to_thread(get_tts().health)


@app.post("/stt")
async def stt_endpoint(request: Request) -> Dict[str, Any]:
    body = await request.body()
    content_type = request.headers.get("content-type", "audio/wav")
    try:
        result = await get_stt().transcribe(body, content_type=content_type)
        result["ok"] = True
        return result
    except SpeechUnavailable as exc:
        return JSONResponse(status_code=503,
                            content={"ok": False, "error": "stt_unavailable",
                                     "detail": str(exc), "health": get_stt().health()})


@app.get("/stt/health")
async def stt_health() -> Dict[str, Any]:
    return await asyncio.to_thread(get_stt().health)


# =========================================================================== #
#  JSON-RPC
# =========================================================================== #
@app.post("/rpc")
async def rpc_http(payload: Dict[str, Any]) -> JSONResponse:
    if isinstance(payload, list):                     # batch
        results = [await rpc.dispatch(item) for item in payload]
        return JSONResponse(content=results)
    result = await rpc.dispatch(payload)
    return JSONResponse(content=result)


@app.websocket(settings.suffix_ws_path)
async def websocket_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    desk: SuffixOrchestrator = ws.app.state.desk
    queue: asyncio.Queue = asyncio.Queue(maxsize=256)

    async def push(message: Dict[str, Any]) -> None:
        try:
            queue.put_nowait(message)
        except asyncio.QueueFull:
            pass

    desk.subscribe(push)
    desk.listeners += 1

    await ws.send_json({
        "type": "handshake",
        "version": settings.suffix_version,
        "directive": settings.public_snapshot(),
        "methods": sorted(rpc.methods),
        "telemetry": desk.telemetry().model_dump(mode="json"),
    })

    async def pump() -> None:
        while True:
            message = await queue.get()
            await ws.send_json(message)

    pump_task = asyncio.create_task(pump())
    try:
        while True:
            raw = await ws.receive_text()
            try:
                request = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json(RpcResponse(id=None, error=RpcError(
                    code=-32700, message="Parse error")).model_dump(mode="json"))
                continue
            if isinstance(request, dict) and request.get("method"):
                response = await rpc.dispatch(request, ws=ws)
                await ws.send_json(response)
            else:
                await ws.send_json({"type": "ack", "received": raw[:200]})
    except WebSocketDisconnect:
        log.info("WebSocket client disconnected")
    except Exception as exc:  # noqa: BLE001
        log.debug("WebSocket error: %s", exc)
    finally:
        pump_task.cancel()
        desk.unsubscribe(push)
        desk.listeners = max(0, desk.listeners - 1)


# =========================================================================== #
#  RPC method implementations
# =========================================================================== #
@rpc.register("system.ping")
def _ping() -> Dict[str, Any]:
    return {"pong": True, "ts": int(time.time() * 1000), "version": settings.suffix_version}


@rpc.register("system.config")
def _config() -> Dict[str, Any]:
    return settings.public_snapshot()


@rpc.register("system.status")
def _status() -> Dict[str, Any]:
    return app.state.desk.status()


@rpc.register("system.health")
async def _health() -> Dict[str, Any]:
    return await health()


@rpc.register("system.subscribe")
async def _subscribe(ws: Optional[WebSocket] = None, channels: Optional[List[str]] = None) -> Dict[str, Any]:
    desk: SuffixOrchestrator = app.state.desk
    return {"subscribed": channels or ["telemetry", "utterance", "event"],
            "subscribers": len(desk.subscribers)}


@rpc.register("system.shutdown_worker")
async def _shutdown_worker() -> Dict[str, Any]:
    await app.state.desk.engine.stop_background()
    return {"quantum_worker": "stopped"}


@rpc.register("desk.telemetry")
def _telemetry() -> Dict[str, Any]:
    return app.state.desk.telemetry().model_dump(mode="json")


@rpc.register("desk.brief")
async def _brief(symbol: Optional[str] = None, intent: str = "brief",
                 speak: bool = False) -> Dict[str, Any]:
    desk: SuffixOrchestrator = app.state.desk
    utterance = await desk.brief(symbol, intent, speak=speak, tts=get_tts())
    return utterance.model_dump(mode="json")


@rpc.register("desk.command")
async def _command(text: str, speak: bool = False) -> Dict[str, Any]:
    """Primary entry point for voice and UI commands."""
    desk: SuffixOrchestrator = app.state.desk
    return await desk.handle_command(text, speak=speak, tts=get_tts())


@rpc.register("desk.propose")
async def _propose(symbol: Optional[str] = None, leverage: Optional[int] = None,
                   risk_pct: Optional[float] = None) -> Dict[str, Any]:
    return await app.state.desk.propose(symbol, leverage, risk_pct)


@rpc.register("desk.manual_order")
async def _manual_order(symbol: str, side: str, leverage: int = 3, risk_pct: float = 1.0,
                        stop: Optional[float] = None, target: Optional[float] = None) -> Dict[str, Any]:
    return await app.state.desk.manual_order(symbol, side, leverage, risk_pct, stop, target)


@rpc.register("desk.flatten")
def _flatten(reason: str = "OPERATOR") -> Dict[str, Any]:
    return app.state.desk.flatten(reason)


@rpc.register("desk.kill_switch")
async def _kill_switch(reason: str = "OPERATOR") -> Dict[str, Any]:
    return await app.state.desk.kill_switch(reason)


@rpc.register("desk.resume")
def _resume() -> Dict[str, Any]:
    return app.state.desk.resume()


@rpc.register("desk.reset")
def _reset(reason: str = "operator reset") -> Dict[str, Any]:
    return app.state.desk.reset_desk(reason)


@rpc.register("desk.pause")
def _pause(paused: bool = True) -> Dict[str, Any]:
    app.state.desk.paused = bool(paused)
    return {"paused": app.state.desk.paused}


@rpc.register("agents.list")
def _agents() -> Dict[str, Any]:
    desk: SuffixOrchestrator = app.state.desk
    return {"agents": [s.model_dump(mode="json") for s in desk.agent_state.values()]}


@rpc.register("agents.report")
async def _agent_report(agent: str, symbol: Optional[str] = None) -> Dict[str, Any]:
    from server.contracts import AgentId

    desk: SuffixOrchestrator = app.state.desk
    try:
        agent_id = AgentId(agent.lower())
    except ValueError:
        raise HTTPException(status_code=400, detail=f"unknown agent {agent!r}")
    impl = desk.agents.get(agent_id)
    if impl is None:
        raise HTTPException(status_code=404, detail=f"agent {agent} not wired")
    symbol = (symbol or desk.ctx.symbol).upper()
    desk.ctx.symbol = symbol
    report = await impl.analyze(symbol, desk.ctx)
    desk.last_reports[agent_id] = report
    return report.model_dump(mode="json")


@rpc.register("agents.collate")
async def _collate(symbol: Optional[str] = None, intent: str = "full") -> Dict[str, Any]:
    desk: SuffixOrchestrator = app.state.desk
    symbol = (symbol or desk.ctx.symbol).upper()
    reports = await desk.gather(intent, symbol)
    rubric = desk.rubric(reports, intent)
    return {"symbol": symbol, "rubric": rubric,
            "reports": [r.model_dump(mode="json") for r in reports]}


@rpc.register("risk.evaluate")
async def _risk_evaluate(symbol: str = "BTC-USD", side: str = "long",
                         leverage: int = 3, risk_pct: float = 1.0,
                         stop: Optional[float] = None, target: Optional[float] = None,
                         execute: bool = False) -> Dict[str, Any]:
    """Adjudicate a trade without (or with) execution — the HUD's risk preview."""
    from server.contracts import TradeProposal, TradeSide
    from server.market_data import atr_based_bracket

    desk: SuffixOrchestrator = app.state.desk
    symbol = symbol.upper()
    trade_side = TradeSide.SHORT if side.lower() in ("short", "sell") else TradeSide.LONG
    bracket = await asyncio.to_thread(atr_based_bracket, symbol, desk.ctx.timeframe,
                                      14, 1.5, 2.0, trade_side.value)
    proposal = TradeProposal(
        symbol=symbol, side=trade_side, thesis="HUD risk preview",
        entry_price=float(bracket["entry"]),
        stop_price=float(stop) if stop else float(bracket["stop"]),
        take_profit_price=float(target) if target else float(bracket["target"]),
        risk_pct=float(risk_pct), leverage=int(leverage),
        timeframe=desk.ctx.timeframe, origin="sentinel",  # type: ignore[arg-type]
    )
    verdict = desk.sentinel.evaluate(proposal)
    out: Dict[str, Any] = {"proposal": proposal.model_dump(mode="json"),
                           "verdict": verdict.model_dump(mode="json")}
    if execute and verdict.decision != "VETO":
        out["execution"] = desk.pilot.execute(verdict).model_dump(mode="json")
    return out


@rpc.register("risk.state")
def _risk_state() -> Dict[str, Any]:
    return app.state.desk.sentinel.snapshot().model_dump(mode="json")


@rpc.register("ledger.stats")
def _ledger_stats() -> Dict[str, Any]:
    return get_ledger().stats()


@rpc.register("ledger.trades")
def _ledger_trades(limit: int = 40, status: Optional[str] = None) -> Dict[str, Any]:
    return {"trades": get_ledger().recent_trades(limit, status)}


@rpc.register("ledger.extinctions")
def _ledger_extinctions(limit: int = 40) -> Dict[str, Any]:
    return {"extinctions": get_ledger().extinctions(limit),
            "blacklisted": get_ledger().blacklist_count()}


@rpc.register("ledger.verdicts")
def _ledger_verdicts(limit: int = 30) -> Dict[str, Any]:
    return {"verdicts": get_ledger().recent_verdicts(limit)}


@rpc.register("ledger.equity")
def _ledger_equity(limit: int = 240) -> Dict[str, Any]:
    return {"equity_curve": get_ledger().equity_series(limit)}


@rpc.register("quantum.state")
def _quantum_state() -> Dict[str, Any]:
    engine = app.state.desk.engine
    return {"state": engine.state().model_dump(mode="json"),
            "engine": engine.engine_info(),
            "active": engine.active_strategies(),
            "blacklisted": len(engine.registry.blacklist)}


@rpc.register("quantum.run_generation")
async def _quantum_run(symbol: Optional[str] = None, trials: Optional[int] = None) -> Dict[str, Any]:
    engine = app.state.desk.engine
    return await asyncio.to_thread(engine.run_generation, symbol, trials)


@rpc.register("quantum.evolve")
async def _quantum_evolve(generations: int = 1, symbol: Optional[str] = None,
                          trials: Optional[int] = None) -> Dict[str, Any]:
    """Run N generations back-to-back — the 50-generation evolution directive."""
    engine = app.state.desk.engine
    generations = int(max(1, min(generations, settings.suffix_mutation_generations)))
    results = []

    async def one(gen: int) -> None:
        results.append(await asyncio.to_thread(engine.run_generation, symbol, trials))
        app.state.desk.emit_event("quantum", "info", f"Generation {gen} complete",
                                  results[-1].get("last_action", "") or
                                  f"promoted {len(results[-1].get('promoted', []))}")

    for gen in range(1, generations + 1):
        await one(gen)
    return {"generations_run": len(results), "results": results,
            "pressure": engine.engine_info()["pressure"]}


@rpc.register("quantum.kill_generation")
def _quantum_kill(reason: str = "MANUAL") -> Dict[str, Any]:
    return app.state.desk.engine.kill_generation(reason, "Operator terminated the generation")


@rpc.register("quantum.penalty")
def _quantum_penalty(loss_streak: Optional[int] = None) -> Dict[str, Any]:
    engine = app.state.desk.engine
    if loss_streak is not None:
        engine.pressure.update(int(loss_streak))
    info = engine.engine_info()
    return {"pressure": info["pressure"], "decay_formula": "exp(-k * loss_streak)",
            "k_formula": f"{settings.suffix_penalty_base_k} * (1 + 0.25 * streak)"}


@rpc.register("quantum.sandbox")
async def _quantum_sandbox(symbol: str, genome: Dict[str, Any]) -> Dict[str, Any]:
    desk: SuffixOrchestrator = app.state.desk
    df = await asyncio.to_thread(desk.engine.frame, symbol.upper())
    return await desk.sandbox.run(symbol.upper(), genome, df)


@rpc.register("quantum.signals")
async def _quantum_signals(symbol: str, genome: Dict[str, Any], bars: int = 120) -> Dict[str, Any]:
    desk: SuffixOrchestrator = app.state.desk
    df = await asyncio.to_thread(desk.engine.frame, symbol.upper())
    return await desk.sandbox.signal_preview(symbol.upper(), genome, df, bars)


@rpc.register("market.quote")
def _quote(symbol: str, timeframe: str = "1h") -> Dict[str, Any]:
    return micro_snapshot(symbol.upper()).value


@rpc.register("market.candles")
def _candles(symbol: str, timeframe: str = "1h", bars: int = 240) -> Dict[str, Any]:
    symbol = symbol.upper()
    res = fetch_ohlcv(symbol, timeframe, min(bars, 2000))
    df = res.value
    if df is None:
        df = synthetic_ohlcv(symbol, timeframe, bars)
    return {
        "symbol": symbol, "timeframe": timeframe, "quality": res.quality,
        "candles": [{"t": str(i), "o": float(r["open"]), "h": float(r["high"]),
                     "l": float(r["low"]), "c": float(r["close"]), "v": float(r["volume"])}
                    for i, r in df.tail(bars).iterrows()],
    }


@rpc.register("voice.transcribe")
async def _transcribe(audio_b64: str, content_type: str = "audio/wav") -> Dict[str, Any]:
    try:
        raw = base64.b64decode(audio_b64)
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="audio_b64 is not valid base64")
    try:
        result = await get_stt().transcribe(raw, content_type=content_type)
        result["ok"] = True
        if result.get("text"):
            result["command"] = await app.state.desk.handle_command(result["text"], speak=False)
        return result
    except SpeechUnavailable as exc:
        return {"ok": False, "error": "stt_unavailable", "detail": str(exc),
                "health": get_stt().health()}


@rpc.register("voice.speak")
async def _speak(text: str, voice: Optional[str] = None) -> Dict[str, Any]:
    audio = await get_tts().synthesize(text, voice=voice)
    if audio is None:
        return {"ok": False, "error": "tts_unavailable", "health": get_tts().health(),
                "fallback": "browser_speech_synthesis"}
    return {"ok": True, "mime": audio[1],
            "audio_b64": base64.b64encode(audio[0]).decode("ascii"),
            "bytes": len(audio[0])}


@rpc.register("voice.say")
async def _say(text: str, priority: str = "briefing") -> Dict[str, Any]:
    """Have SUFFIX speak an arbitrary line through the orchestrator."""
    from server.contracts import Utterance

    desk: SuffixOrchestrator = app.state.desk
    utterance = Utterance(text=text, voice_text=desk._voice_text(text),
                          priority=priority)  # type: ignore[arg-type]
    audio = await get_tts().synthesize(utterance.voice_text, priority=priority)
    if audio:
        utterance.audio_b64 = base64.b64encode(audio[0]).decode("ascii")
    desk.record_utterance(utterance)
    await desk._broadcast({"type": "utterance", "utterance": utterance.model_dump(mode="json")})
    return utterance.model_dump(mode="json")


@rpc.register("mcp.health")
def _mcp_health() -> Dict[str, Any]:
    return app.state.desk.mcp.health()


@rpc.register("mcp.attach")
async def _mcp_attach() -> Dict[str, Any]:
    return await app.state.desk.mcp.attach()


@rpc.register("mcp.tools")
def _mcp_tools() -> Dict[str, Any]:
    desk: SuffixOrchestrator = app.state.desk
    return {"tools": desk.mcp.tools, "status": desk.mcp.status}


@rpc.register("mcp.call")
async def _mcp_call(name: str, arguments: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return await app.state.desk.mcp.call_tool(name, arguments or {})


@rpc.register("gesture.event")
async def _gesture_event(gesture: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """MediaPipe hand-gesture router.

    Gestures are mapped to desk actions server-side so behaviour is identical
    whether the input came from the HUD camera, a voice command or the API.
    """
    desk: SuffixOrchestrator = app.state.desk
    g = gesture.lower().strip()
    payload = payload or {}
    desk.emit_event("gesture", "debug", f"Gesture: {g}", json.dumps(payload)[:160], payload)

    if g in ("open_palm", "palm", "stop"):
        desk.paused = True
        desk.emit_event("gesture", "info", "Open palm — desk paused",
                        "Telemetry held. Make a fist or say resume to continue.")
        return {"action": "pause", "paused": True}

    if g in ("closed_fist", "fist"):
        desk.paused = False
        desk.emit_event("gesture", "info", "Fist — desk resumed", "Telemetry streaming.")
        return {"action": "resume", "paused": False}

    if g in ("swipe_left", "swipe_right"):
        agent = payload.get("agent")
        desk.emit_event("gesture", "info",
                        f"Swipe {'left' if g.endswith('left') else 'right'} — telemetry view cycled",
                        f"Focused agent: {agent or 'next'}", payload)
        return {"action": "cycle_view", "direction": g.replace("swipe_", ""), "agent": agent}

    if g in ("pinch", "ok_sign"):
        symbol = str(payload.get("symbol") or desk.ctx.symbol).upper()
        intent = str(payload.get("intent", "brief"))
        utterance = await desk.brief(symbol, intent, speak=True, tts=get_tts())
        return {"action": "brief", "utterance": utterance.model_dump(mode="json")}

    if g in ("thumbs_up",):
        out = await desk.propose(desk.ctx.symbol)
        return {"action": "propose", **out}

    if g in ("thumbs_down",):
        return {"action": "flatten", **desk.flatten("GESTURE")}

    if g in ("victory", "peace", "two_fingers"):
        return {"action": "quantum", "state": desk.engine.state().model_dump(mode="json")}

    return {"action": "none", "gesture": gesture, "known": [
        "open_palm", "closed_fist", "swipe_left", "swipe_right", "pinch",
        "thumbs_up", "thumbs_down", "victory"]}


@rpc.register("rpc.describe")
def _describe() -> Dict[str, Any]:
    return {"methods": sorted(rpc.methods), "stats": rpc.stats}


# =========================================================================== #
#  HUD mount — MUST stay last
# =========================================================================== #
# Starlette matches routes in registration order and a Mount on "/" is a
# catch-all, so registering it here means every REST route, the RPC endpoint and
# the WebSocket above take precedence and only unmatched paths fall through to
# the bundle. Moving this earlier would shadow the API.
if HUD_AVAILABLE:
    app.mount("/", StaticFiles(directory=str(HUD_DIST), html=True), name="hud")
    log.info("HUD bundle mounted from %s (open http://%s:%s/)",
             HUD_DIST, settings.suffix_api_host, settings.suffix_api_port)


# =========================================================================== #
#  Entrypoint
# =========================================================================== #
def main() -> None:  # pragma: no cover - manual launch helper
    import uvicorn

    uvicorn.run("server.main:app", host=settings.suffix_api_host,
                port=settings.suffix_api_port, log_level=settings.suffix_log_level.lower(),
                ws="websockets")


if __name__ == "__main__":  # pragma: no cover
    main()
