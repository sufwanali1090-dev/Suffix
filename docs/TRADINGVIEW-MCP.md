# The chart takeover — driving real TradingView

This is the part people rewind the video for. The rule that makes it work:

> The technician does not **describe** the chart. It **issues commands**.

`server/agents/chartist.js` returns `actions[]` — `setSymbol`, `setInterval`, `drawLevel`,
`clearLevels`, `annotate` — and each one is sent to two sinks:

1. **the desk chart** (always): the SVG in `public/js/panels.js#applyChartAction`. This is
   why the desk is impressive in a browser with nothing installed;
2. **your real TradingView**, when `TRADINGVIEW_MCP_URL` points at a bridge
   (`server/charting/mcp-bridge.js`). If the bridge is missing, the report *says so*
   ("No MCP bridge configured, so only the desk chart moved") rather than implying it drew
   on your screen.

## The bridge contract

```jsonc
POST <TRADINGVIEW_MCP_URL>
{
  "action": "add_price_line",       // mapped from drawLevel; see VERB_MAP in mcp-bridge.js
  "symbol": "NASDAQ:NVDA",
  "interval": "D",
  "price": 178.98,
  "label": "demand",
  "color": "#2fe08a",
  "text": null
}
→ 200 { "ok": true }
```

Verb mapping (`charting/mcp-bridge.js`):

| desk action | bridge verb |
| --- | --- |
| `setSymbol` | `switch_symbol` |
| `setInterval` | `set_timeframe` |
| `drawLevel` | `add_price_line` |
| `clearLevels` | `remove_all_price_lines` |
| `annotate` | `add_note` |
| `screenshot` | `capture_chart` |
| `focusOrb` | *(desk only — never forwarded)* |

Change the map, not the agent, if your MCP server names its tools differently.

## Wiring it to Claude Code

Install any open-source TradingView MCP server that can reach the desktop app (it needs the
accessibility/automation path to your TradingView window, e.g. a bridge that accepts
`switch_symbol` / `add_price_line` / `remove_all_price_lines`). Then give Claude Code the
same contract this desk already speaks:

```jsonc
// .mcp.json  (project root)
{
  "mcpServers": {
    "tradingview": {
      "command": "npx",
      "args": ["-y", "<your-tradingview-mcp-package>", "--port", "8899"]
    }
  }
}
```

and the shim that turns an HTTP POST into an MCP tool call (this is the whole bridge —
~40 lines, and it is the file you edit if your tool names differ):

```python
# save as tv-bridge.py and run it; then TRADINGVIEW_MCP_URL=http://127.0.0.1:8899/call
from fastmcp import FastMCP
from aiohttp import web

mcp = FastMCP("tradingview")          # whatever client your MCP server exposes

@mcp.tool()
async def switch_symbol(symbol: str): ...
@mcp.tool()
async def set_timeframe(interval: str): ...
@mcp.tool()
async def add_price_line(price: float, label: str, color: str = "#2fe08a"): ...
@mcp.tool()
async def remove_all_price_lines(): ...

async def handle(request):
    j = await request.json()
    fn = {"switch_symbol": switch_symbol, "set_timeframe": set_timeframe,
          "add_price_line": add_price_line, "remove_all_price_lines": remove_all_price_lines}[j["action"]]
    return web.json_response({"ok": True, "result": str(await fn(**{k: v for k, v in j.items() if k != "action"}))})

app = web.Application()
app.router.add_post("/call", handle)
web.run_app(app, port=8899)
```

```bash
# .env
TRADINGVIEW_MCP_URL=http://127.0.0.1:8899/call
TRADINGVIEW_SYMBOLS=NVDA,AAPL,SPY,QQQ,TSLA,AMD   # the recon universe SCOUT sweeps
```

## Try it

```bash
# 1. does the bridge answer at all?
curl -s localhost:8899/call -H 'content-type: application/json' \
  -d '{"action":"switch_symbol","symbol":"NASDAQ:NVDA"}'

# 2. does the desk forward to it?
curl -s localhost:8787/api/desk | jq '.bridge'          # configured: true, sent: n
curl -s -X POST localhost:8787/api/command -H 'content-type: application/json' \
  -d '{"text":"pull up NVDA and mark the levels"}' | jq -r '.reply.speech'
# expect: "… Sent to TradingView over the MCP bridge." instead of "only the desk chart moved"

# 3. draw one line by hand (operator override, same sink Chartist uses)
curl -s -X POST localhost:8787/api/chart -H 'content-type: application/json' \
  -d '{"action":"drawLevel","payload":{"symbol":"NVDA","price":179,"kind":"support","label":"my shelf"}}'
```

The HUD mirrors it live: watch `chart.action` on `GET /api/stream` (`curl -N`) and the SVG
lines appear on the Screens panel as the agent emits them.

## In Claude Code, out loud

Because the same verbs are plain tools, the desk's trick is reproducible in a Claude Code
session without this repo:

```
Pull up NVDA on my TradingView, mark the last two swing highs as supply and the
demand shelf at 179, then draw where you would put the stop. Say the numbers.
```

Claude Code calls `switch_symbol` → `add_price_line` ×3 on your real chart. Now paste that
into `POST /api/command` on the desk and the same work is routed by the master, sized by
Sentinel's absence, and voiced by nine different throats.

## Limits worth stating

* TradingView automation is fiddly: window focus, zoom level, and multi-monitor layouts all
  matter. Expect the occasional mis-click and keep `screenshot`/`capture_chart` in the loop
  so the agent can see what it drew.
* Drawing on a chart is *not* a trade. Nothing in this file touches an order path — the
  stamp in `store/approvals.js` is the only thing that gets near execution.
* If the bridge is down, the desk degrades to the in-app chart. That is the desired failure:
  a chart takeover that silently stopped taking over would be the first thing you'd trust
  less and use more.
