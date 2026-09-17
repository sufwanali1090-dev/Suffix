/**
 * llm.js — optional reasoning layer for the master.
 *
 * With ANTHROPIC_API_KEY set, the master asks a long-context model to (a) route
 * and (b) synthesize the specialists' findings into one spoken answer. Without
 * a key, the deterministic router and template synthesis take over — the desk
 * stays fully functional, just terser. The model is never the source of a
 * number: every figure in the prompt arrives from an agent reading a feed, and
 * the model is told explicitly not to invent, only to compose.
 */
import { config } from './config.js';
import { fetchJson, truncate } from './util.js';

export function llmAvailable() {
  return Boolean(config.llm.apiKey);
}

const SYSTEM = `You are the master orchestrator of a market research desk ("F.R.I.D.A.Y.").
You do not analyse, forecast, or trade. You route to specialists and you synthesize.
HARD RULES:
1. Never state a number that is not present in the agent reports you are given.
   If a report says data is unavailable, say so plainly — a dash, not a guess.
2. Never predict. Probabilities are allowed only as the quant phrased them.
3. Anything involving money requires the risk officer's stamp; you cannot grant it.
4. Keep it conversational and short: 2-4 sentences for speech, one clause per
   specialist that answered. Plain text, no markdown, no bullet lists.`;

export async function synthesizeReply({ command, reports, session, extra = '' }) {
  if (!llmAvailable()) return null;
  const pack = Object.entries(reports).map(([id, r]) => ({
    agent: id,
    status: r.status,
    headline: r.headline,
    bullets: (r.bullets || []).slice(0, 6),
    speech: r.speech,
    dataKeys: Object.keys(r.data || {}).slice(0, 18),
  }));
  const prompt = `Operator command: "${command}"
Session: ${session?.label ?? 'unknown'}${session?.countdownMs ? `, ${Math.round(session.countdownMs / 60000)} min to ${session.countingTo}` : ''}
Specialist reports:
${JSON.stringify(pack, null, 1)}
${extra ? `Desk notes: ${extra}` : ''}
Write the single spoken answer the master gives. Then a final line starting with "CARD: " naming the one number the operator should look at.`;

  const res = await fetchJson(config.llm.baseUrl, {
    timeoutMs: config.llm.timeoutMs,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.llm.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: {
      model: config.llm.model,
      max_tokens: config.llm.maxTokens,
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    },
  });
  if (!res.ok) {
    config.llm.lastError = res.reason;
    return null;
  }
  const text = (res.json?.content ?? [])
    .map((b) => b.text ?? '')
    .join(' ')
    .trim();
  if (!text) return null;
  const [speech, ...rest] = text.split(/\n(?=CARD:)/);
  return {
    speech: truncate(String(speech || text).replace(/^CARD:.*$/m, '').trim(), 900),
    card: rest.join(' ').replace(/^CARD:\s*/, '').trim() || null,
    model: config.llm.model,
    raw: text,
  };
}

export async function routeWithModel({ command, agentIds }) {
  if (!llmAvailable()) return null;
  const prompt = `Route this operator command to specialist agents. Reply JSON only.
Agents: ${agentIds.join(', ')}
Agent jobs: atlas=macro/rates, capitol=congress+insider filings, scout=trending movers,
athena=structure/levels/fundamentals, chartist=drive the screens, oracle=probability forecast,
sentinel=risk sizing+stamp, pilot=execution, ledger=journal/health.
Command: "${command}"
JSON: {"agents":["id",...],"symbol":"TICKER or null","params":{"qty":null,"side":"buy|sell|null","interval":null,"proposalId":null},"reasoning":"one clause"}
Rules: analysis never executes; "buy/sell/place" => pilot AND sentinel; approving/stamping => sentinel only; max 3 agents.`;
  const res = await fetchJson(config.llm.baseUrl, {
    timeoutMs: config.llm.timeoutMs,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.llm.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: {
      model: config.llm.model,
      max_tokens: 400,
      system: 'You are a strict router for an agent desk. Output only the requested JSON.',
      messages: [{ role: 'user', content: prompt }],
    },
  });
  if (!res.ok) return null;
  const text = (res.json?.content ?? []).map((b) => b.text ?? '').join('').trim();
  try {
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed.agents)) return null;
    return { ...parsed, agents: parsed.agents.filter((a) => agentIds.includes(a)) };
  } catch {
    return null;
  }
}

export const lastError = () => config.llm.lastError ?? null;
