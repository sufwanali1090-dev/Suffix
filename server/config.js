/**
 * config.js — one place where the desk reads its environment.
 * No dotenv dependency: a 25-line parser keeps `npm install` unnecessary.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = parseEnvFile(path.join(ROOT, '.env'));
const env = { ...fileEnv, ...process.env }; // real env wins

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d = false) =>
  v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v));
const str = (v, d = '') => (v === undefined || v === '' ? d : String(v));

export const config = {
  root: ROOT,
  dataDir: path.join(ROOT, 'data'),
  journalDir: path.join(ROOT, 'data', 'journal'),
  blotterDir: path.join(ROOT, 'data', 'blotter'),
  keysDir: path.join(ROOT, 'data', 'keys'),
  publicDir: path.join(ROOT, 'public'),

  host: str(env.HOST, '0.0.0.0'),
  port: num(env.PORT, 8787),

  finnhubKey: str(env.FINNHUB_KEY),
  quotePollMs: Math.max(5000, num(env.QUOTE_POLL_MS, 60000)),

  llm: {
    apiKey: str(env.ANTHROPIC_API_KEY),
    model: str(env.LLM_MODEL, 'claude-fable-5'),
    baseUrl: str(env.LLM_BASE_URL, 'https://api.anthropic.com/v1/messages'),
    maxTokens: num(env.LLM_MAX_TOKENS, 1024),
    timeoutMs: num(env.LLM_TIMEOUT_MS, 25000),
  },

  whisper: {
    bin: str(env.WHISPER_BIN),
    model: str(env.WHISPER_MODEL, 'ggml-small.bin'),
    args: str(env.WHISPER_ARGS),
  },

  tts: {
    bridgeUrl: str(env.TTS_BRIDGE_URL),
    format: str(env.TTS_DEFAULT_FORMAT, 'wav'),
  },

  tradingview: {
    mcpUrl: str(env.TRADINGVIEW_MCP_URL),
    symbols: str(env.TRADINGVIEW_SYMBOLS, 'NVDA,AAPL,SPY,QQQ,TSLA')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  },

  risk: {
    mode: str(env.EXECUTION_MODE, 'paper'), // paper | live (live intentionally unsupported here)
    equity: num(env.ACCOUNT_EQUITY, 25000),
    maxRiskPct: num(env.MAX_RISK_PCT, 1.0),
    maxPositionPct: num(env.MAX_POSITION_PCT, 10),
    maxDailyLossPct: num(env.MAX_DAILY_LOSS_PCT, 3),
  },

  demoFeed: bool(env.DEMO_FEED, false),
  // ALLOW_SIM=0 refuses the synthetic feed outright: with no key every market
  // panel then renders "—" instead. Set it for a strictly-real-data build.
  allowSim: bool(env.ALLOW_SIM, true),
};

export function describeConfig() {
  return {
    feed: config.finnhubKey ? 'finnhub' : config.demoFeed ? 'sim' : 'none',
    demoFeed: config.demoFeed,
    llm: config.llm.apiKey ? config.llm.model : 'local-router',
    whisper: Boolean(config.whisper.bin),
    ttsBridge: Boolean(config.tts.bridgeUrl),
    tradingviewMcp: Boolean(config.tradingview.mcpUrl),
    executionMode: config.risk.mode,
    quotePollMs: config.quotePollMs,
    allowSim: config.allowSim,
    limits: {
      equity: config.risk.equity,
      maxRiskPct: config.risk.maxRiskPct,
      maxPositionPct: config.risk.maxPositionPct,
      maxDailyLossPct: config.risk.maxDailyLossPct,
    },
  };
}
