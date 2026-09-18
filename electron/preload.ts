/**
 * SUFFIX TRADING DESK — preload bridge.
 *
 * The renderer never sees Node. It receives exactly one frozen, auditable
 * object: `window.suffix`. Every method maps to an explicit `ipcMain.handle`
 * channel in `electron/main.ts`; there is no dynamic channel passthrough, so
 * the renderer cannot reach arbitrary main-process capability.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type Unsubscribe = () => void;

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: NodeJS.Platform;
  arch: string;
  isDev: boolean;
  apiOrigin: string;
  wsUrl: string;
  packaged: boolean;
}

export interface BackendHealth {
  ok: boolean;
  detail: string;
  latencyMs: number;
}

export interface SuffixBridge {
  readonly version: string;
  appInfo(): Promise<AppInfo>;

  backend: {
    health(): Promise<BackendHealth>;
    logs(): Promise<string[]>;
    restart(): Promise<{ restarted: boolean }>;
    start(): Promise<{ running: boolean }>;
    onLog(cb: (line: string) => void): Unsubscribe;
  };

  window: {
    minimize(): Promise<void>;
    maximize(): Promise<boolean>;
    close(): Promise<void>;
    toggleFullscreen(): Promise<boolean>;
  };

  system: {
    openExternal(url: string): Promise<{ opened: boolean; reason?: string }>;
    saveAudio(filename: string, base64: string): Promise<{ path: string }>;
  };

  shortcuts: {
    onPushToTalk(cb: () => void): Unsubscribe;
    onKillSwitch(cb: () => void): Unsubscribe;
  };

  /** True when running inside the Electron shell (vs a plain browser). */
  readonly isElectron: true;
}

const bridge: SuffixBridge = {
  version: '1.0.0',
  isElectron: true,

  appInfo: () => ipcRenderer.invoke('app:info'),

  backend: {
    health: () => ipcRenderer.invoke('backend:health'),
    logs: () => ipcRenderer.invoke('backend:logs'),
    restart: () => ipcRenderer.invoke('backend:restart'),
    start: () => ipcRenderer.invoke('backend:start'),
    onLog: (cb) => {
      const handler = (_e: IpcRendererEvent, line: string) => cb(line);
      ipcRenderer.on('backend:log', handler);
      return () => ipcRenderer.removeListener('backend:log', handler);
    },
  },

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    toggleFullscreen: () => ipcRenderer.invoke('window:fullscreen'),
  },

  system: {
    openExternal: (url: string) => ipcRenderer.invoke('system:openExternal', url),
    saveAudio: (filename: string, base64: string) =>
      ipcRenderer.invoke('system:saveAudio', { filename, base64 }),
  },

  shortcuts: {
    onPushToTalk: (cb) => {
      const handler = () => cb();
      ipcRenderer.on('shortcut:push-to-talk', handler);
      return () => ipcRenderer.removeListener('shortcut:push-to-talk', handler);
    },
    onKillSwitch: (cb) => {
      const handler = () => cb();
      ipcRenderer.on('shortcut:kill-switch', handler);
      return () => ipcRenderer.removeListener('shortcut:kill-switch', handler);
    },
  },
};

contextBridge.exposeInMainWorld('suffix', Object.freeze(bridge));
