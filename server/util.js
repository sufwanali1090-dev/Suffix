/**
 * util.js — small shared helpers. Kept dependency-free on purpose.
 */
import crypto from 'node:crypto';

export const nowIso = () => new Date().toISOString();

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function uid(prefix = '') {
  const s = crypto.randomBytes(6).toString('hex');
  return prefix ? `${prefix}_${s}` : s;
}

export function round(n, dp = 2) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Price formatting: tick-size-ish heuristic. null/NaN renders as an em dash. */
export function fmtPrice(n, dp) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const digits = dp ?? (v >= 1000 ? 0 : v >= 100 ? 2 : v >= 1 ? 2 : 4);
  return v.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtPct(n, dp = 2) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  return `${v > 0 ? '+' : ''}${v.toFixed(dp)}%`;
}

export function fmtUsd(n) {
  if (!Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: Math.abs(Number(n)) >= 1000 ? 0 : 2,
  });
}

/** "47s" / "3m 12s" / "1h 04m" */
export function fmtCountdown(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function truncate(text, max = 600) {
  const t = String(text ?? '').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** fetch with an AbortController timeout; never throws, always {ok, ...}. */
export async function fetchJson(url, { timeoutMs = 8000, headers, method = 'GET', body } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: { accept: 'application/json', ...(headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        reason: `http ${res.status}${json?.error ? `: ${json.error.message || json.error}` : ''}`,
        latencyMs: Date.now() - started,
        raw: json ?? text.slice(0, 400),
      };
    }
    return { ok: true, status: res.status, json, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      reason: err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(err?.message || err),
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Deterministic pseudo-random generator (mulberry32) — used by the sim feed. */
export function rng(seedText) {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i++) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
