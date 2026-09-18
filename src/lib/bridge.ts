/**
 * JSON-RPC 2.0 client for the SUFFIX Python bridge.
 *
 * Transport policy
 * ----------------
 * Everything is resolved against **relative** URLs so the exact same build runs
 * in three very different places:
 *
 *   1. Electron (file://)  → the preload exposes `apiOrigin`; we use it.
 *   2. Vite dev server     → relative paths, proxied to 127.0.0.1:8000.
 *   3. Harness preview     → relative paths through the same proxy. The
 *                            browser must NEVER be handed localhost URLs.
 *
 * `resolveOrigin()` is the single place that decides, and it deliberately
 * prefers a relative origin whenever one works.
 */

import type { RpcResponse } from '@/types/contract';

type PendingFn = (value: any) => void;

export class RpcError extends Error {
  readonly code: number;
  readonly data?: Record<string, any>;

  constructor(code: number, message: string, data?: Record<string, any>) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

export interface BridgeOptions {
  /** Absolute origin for Electron (file:// has no usable relative base). */
  origin?: string;
  wsUrl?: string;
  autoReconnect?: boolean;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export type SocketHandler = (message: any) => void;
export type StatusHandler = (status: BridgeStatus) => void;

export type BridgeStatus =
  | { state: 'idle' }
  | { state: 'connecting' }
  | { state: 'open' }
  | { state: 'closed'; code?: number; reason?: string }
  | { state: 'error'; message: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SuffixBridge {
  private origin: string;
  private wsUrlOverride?: string;
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: PendingFn; reject: PendingFn }>();
  private socketHandlers = new Set<SocketHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private reconnectAttempt = 0;
  private readonly autoReconnect: boolean;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private closedByUser = false;
  private status: BridgeStatus = { state: 'idle' };
  private lastError: string | null = null;

  constructor(options: BridgeOptions = {}) {
    this.origin = options.origin ?? '';
    this.wsUrlOverride = options.wsUrl;
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 900;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 12_000;
  }

  // ------------------------------------------------------------------ config
  setOrigin(origin: string): void {
    this.origin = origin.replace(/\/$/, '');
  }

  setWsUrl(url: string): void {
    this.wsUrlOverride = url;
  }

  get httpOrigin(): string {
    return this.origin;
  }

  get currentStatus(): BridgeStatus {
    return this.status;
  }

  get lastErrorText(): string | null {
    return this.lastError;
  }

  private setStatus(next: BridgeStatus): void {
    this.status = next;
    this.statusHandlers.forEach((h) => {
      try {
        h(next);
      } catch {
        /* a bad subscriber must not break the bridge */
      }
    });
  }

  private resolveHttp(path: string): string {
    return this.origin ? `${this.origin}${path}` : path;
  }

  private resolveWs(): string {
    if (this.wsUrlOverride) return this.wsUrlOverride;
    if (this.origin) {
      return `${this.origin.replace(/^http/, 'ws')}/ws`;
    }
    // Relative origin: build from the page location. `wss:` is mandatory when
    // the preview itself is served over HTTPS or the connection is blocked.
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  onMessage(handler: SocketHandler): () => void {
    this.socketHandlers.add(handler);
    return () => this.socketHandlers.delete(handler);
  }

  // --------------------------------------------------------------- HTTP RPC
  async call<T = any>(
    method: string,
    params: Record<string, any> = {},
    { timeoutMs = 120_000 }: { timeoutMs?: number } = {},
  ): Promise<T> {
    const id = this.nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.resolveHttp('/rpc'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new RpcError(res.status, `HTTP ${res.status} on ${method}`);
      }
      const payload = (await res.json()) as RpcResponse<T>;
      if (payload.error) {
        throw new RpcError(payload.error.code, payload.error.message, payload.error.data);
      }
      return payload.result as T;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new RpcError(-32001, `${method} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Convenience for RPC methods that return a payload needing no unwrapping. */
  async callSafe<T = any>(method: string, params: Record<string, any> = {}): Promise<T | null> {
    try {
      return await this.call<T>(method, params);
    } catch (err) {
      this.lastError = (err as Error).message;
      return null;
    }
  }

  async rest<T = any>(path: string, init?: RequestInit): Promise<T | null> {
    try {
      const res = await fetch(this.resolveHttp(path), init);
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  async health(): Promise<Record<string, any> | null> {
    return this.rest('/health');
  }

  // ------------------------------------------------------------ WebSocket
  connect(): void {
    this.closedByUser = false;
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const url = this.resolveWs();
    this.setStatus({ state: 'connecting' });
    try {
      this.socket = new WebSocket(url);
    } catch (err) {
      this.lastError = (err as Error).message;
      this.setStatus({ state: 'error', message: this.lastError });
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.setStatus({ state: 'open' });
    };

    this.socket.onmessage = (event) => {
      let parsed: any;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      // A JSON-RPC response answers a pending call; anything else is a push.
      if (parsed && parsed.jsonrpc === '2.0' && 'id' in parsed && parsed.id != null) {
        const waiter = this.pending.get(parsed.id);
        if (waiter) {
          this.pending.delete(parsed.id);
          if (parsed.error) {
            waiter.reject(new RpcError(parsed.error.code, parsed.error.message, parsed.error.data));
          } else {
            waiter.resolve(parsed.result);
          }
        }
        return;
      }
      this.socketHandlers.forEach((h) => {
        try {
          h(parsed);
        } catch {
          /* ignore subscriber faults */
        }
      });
    };

    this.socket.onerror = () => {
      // The error event carries no useful detail; `onclose` follows.
      this.lastError = `websocket error → ${url}`;
    };

    this.socket.onclose = (event) => {
      this.pending.forEach(({ reject }) => reject(new RpcError(-32002, 'socket closed')));
      this.pending.clear();
      this.setStatus({ state: 'closed', code: event.code, reason: event.reason });
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.autoReconnect || this.closedByUser) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** Math.min(this.reconnectAttempt, 5),
    );
    setTimeout(() => {
      if (!this.closedByUser) this.connect();
    }, delay);
  }

  disconnect(): void {
    this.closedByUser = true;
    try {
      this.socket?.close(1000, 'client disconnect');
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.setStatus({ state: 'idle' });
  }

  /** RPC over the socket, with automatic retry when the socket is reconnecting. */
  async callSocket<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        this.connect();
        await sleep(220 * (attempt + 1));
        if (this.socket?.readyState === WebSocket.OPEN) break;
      }
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return this.call<T>(method, params);
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        reject(err as Error);
        return;
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new RpcError(-32003, `${method} timed out over socket`));
        }
      }, 120_000);
    });
  }
}

/** Singleton used by the store. Origin is injected at boot from Electron. */
export const bridge = new SuffixBridge();
