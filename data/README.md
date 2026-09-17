# data/

Operator-owned files. Everything here is optional, and nothing here is fetched or invented
at runtime.

| file | read by | shape |
| --- | --- | --- |
| `.env` (repo root, not here) | `server/config.js` | `FINNHUB_KEY`, `ANTHROPIC_API_KEY`, `WHISPER_BIN`, `TTS_BRIDGE_URL`, `TRADINGVIEW_MCP_URL`, limits |
| `smart-money.json` | CAPITOL | copy `smart-money.example.json` → an array of filings: `ticker, person, party, chamber, transaction, amount_range_us, transaction_date, filed_date, source` |
| `watch-trending.json` | SCOUT | copy `watch-trending.example.json` → the symbols you want swept for viral flow |
| `journal/*.jsonl` | LEDGER | written, not read — one line per command/report/veto/fill |
| `blotter/positions.json` | PILOT | paper positions only; delete it to reset the desk's memory |
| `keys/sentinel_ed25519_*.pem` | SENTINEL | the private half stays here (0600, gitignored); the master loads only the public half |

The two `*.example.json` files ship as **schemas, not data**. If you want CAPITOL to speak, put
your own export in — a CSV→JSON of congressional trades, your broker's insider report, your 13F
parser. The agent will refuse to narrate anything it cannot read from a file or an endpoint.
