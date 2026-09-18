/**
 * SUFFIX TRADING DESK — Electron main process.
 *
 * Duties
 * ------
 * 1. Own the window: frameless, dark, cinematic; a custom title bar lives in
 *    the renderer and drives the window through the typed preload bridge.
 * 2. Own the Python bridge lifetime: in production the desk spawns
 *    `uvicorn server.main:app` as a child process, streams its logs, and takes
 *    it down on quit. In development the developer runs the API themselves so
 *    hot-reload stays fast (`npm run dev` runs both).
 * 3. Own privileged capabilities: only ``main`` may touch the filesystem, spawn
 *    processes or open external URLs. The renderer is fully sandboxed
 *    (contextIsolation on, nodeIntegration off, no remote module).
 * 4. Grant camera access for the MediaPipe gesture engine, since Electron
 *    denies media permissions by default.
 */

import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  session,
  Menu,
  nativeTheme,
  globalShortcut,
  type IpcMainInvokeEvent,
} from 'electron';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as http from 'node:http';

// --------------------------------------------------------------------------- //
//  Constants
// --------------------------------------------------------------------------- //
const IS_DEV = process.env.SUFFIX_DEV === '1' || !app.isPackaged;
const DEV_SERVER_URL = process.env.SUFFIX_DEV_URL ?? 'http://localhost:5173';
const API_HOST = process.env.SUFFIX_API_HOST ?? '127.0.0.1';
const API_PORT = Number(process.env.SUFFIX_API_PORT ?? 8000);
const API_ORIGIN = `http://${API_HOST}:${API_PORT}`;
const WS_URL = `ws://${API_HOST}:${API_PORT}${process.env.SUFFIX_WS_PATH ?? '/ws'}`;

let mainWindow: BrowserWindow | null = null;
// stdio is ['ignore','pipe','pipe'] → stdin is null, both outputs are pipes.
let pythonProc: ChildProcessByStdio<null, Readable, Readable> | null = null;
const pythonLog: string[] = [];

// --------------------------------------------------------------------------- //
//  Python backend supervision
// --------------------------------------------------------------------------- //
function projectRoot(): string {
  // Packaged: resources/ holds the extraResources copies; dev: repo root.
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..');
}

function resolvePython(): string {
  const candidates = [
    process.env.SUFFIX_PYTHON,
    path.join(projectRoot(), '.venv', 'bin', 'python3'),
    path.join(projectRoot(), '.venv', 'bin', 'python'),
    path.join(projectRoot(), '.venv', 'Scripts', 'python.exe'),
    'python3',
    'python',
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (c === 'python3' || c === 'python') return c;
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return 'python3';
}

function pushLog(line: string): void {
  const stamped = `[backend] ${line.trimEnd()}`;
  pythonLog.push(stamped);
  if (pythonLog.length > 400) pythonLog.shift();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('backend:log', stamped);
  }
  if (IS_DEV) process.stdout.write(`${stamped}\n`);
}

function startBackend(): void {
  if (IS_DEV && process.env.SUFFIX_SKIP_BACKEND === '1') {
    pushLog('skipping backend spawn (SUFFIX_SKIP_BACKEND=1)');
    return;
  }
  const python = resolvePython();
  const args = [
    '-m', 'uvicorn', 'server.main:app',
    '--host', '127.0.0.1',
    '--port', String(API_PORT),
    '--log-level', 'info',
  ];
  pushLog(`spawning: ${python} ${args.join(' ')}`);
  try {
    pythonProc = spawn(python, args, {
      cwd: projectRoot(),
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONPATH: projectRoot() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    pythonProc.stdout.on('data', (d: Buffer) => pushLog(d.toString()));
    pythonProc.stderr.on('data', (d: Buffer) => pushLog(d.toString()));
    pythonProc.on('error', (err) => pushLog(`spawn error: ${err.message}`));
    pythonProc.on('exit', (code, signal) => {
      pushLog(`backend exited code=${code} signal=${signal}`);
      pythonProc = null;
    });
  } catch (err) {
    pushLog(`failed to spawn backend: ${(err as Error).message}`);
  }
}

function stopBackend(): void {
  if (!pythonProc) return;
  pushLog('stopping backend…');
  try {
    pythonProc.kill('SIGTERM');
    setTimeout(() => {
      try {
        pythonProc?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 3000).unref?.();
  } catch {
    /* ignore */
  }
  pythonProc = null;
}

function backendHealth(): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const req = http.get(`${API_ORIGIN}/health`, { timeout: 2500 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () =>
        resolve({
          ok: res.statusCode === 200,
          detail: body.slice(0, 600),
          latencyMs: Date.now() - started,
        }),
      );
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, detail: 'timeout', latencyMs: Date.now() - started });
    });
    req.on('error', (err) =>
      resolve({ ok: false, detail: err.message, latencyMs: Date.now() - started }),
    );
  });
}

// --------------------------------------------------------------------------- //
//  Window
// --------------------------------------------------------------------------- //
function createWindow(): void {
  Menu.setApplicationMenu(null); // the HUD owns its own chrome

  mainWindow = new BrowserWindow({
    width: 1680,
    height: 1020,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    backgroundColor: '#03040a',
    title: 'SUFFIX TRADING DESK',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 14, y: 16 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs Node's path/child APIs for the typed bridge
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false, // the orb must keep animating unfocused
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (IS_DEV) mainWindow?.webContents.openDevTools({ mode: 'detach' });
  });

  if (IS_DEV) {
    void mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // External links open in the user's browser, never inside the shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isDevServer = IS_DEV && url.startsWith(DEV_SERVER_URL);
    if (!isDevServer && !url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    pushLog(`renderer gone: ${details.reason}`);
  });
}

// --------------------------------------------------------------------------- //
//  Permissions — the gesture engine needs the camera
// --------------------------------------------------------------------------- //
function configurePermissions(): void {
  const allowed = new Set(['media', 'camera', 'microphone', 'speaker-selection', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  // MediaPipe loads its .task/.wasm assets from the CDN + jsdelivr; keep the CSP
  // permissive enough for wasm while still blocking inline script injection.
  nativeTheme.themeSource = 'dark';
}

// --------------------------------------------------------------------------- //
//  IPC surface (typed in electron/preload.ts)
// --------------------------------------------------------------------------- //
function registerIpc(): void {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    isDev: IS_DEV,
    apiOrigin: API_ORIGIN,
    wsUrl: WS_URL,
    packaged: app.isPackaged,
  }));

  ipcMain.handle('backend:health', () => backendHealth());
  ipcMain.handle('backend:logs', () => pythonLog.slice(-200));
  ipcMain.handle('backend:restart', async () => {
    stopBackend();
    await new Promise((r) => setTimeout(r, 800));
    startBackend();
    return { restarted: true };
  });
  ipcMain.handle('backend:start', () => {
    if (!pythonProc) startBackend();
    return { running: Boolean(pythonProc) };
  });

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:fullscreen', () => {
    if (!mainWindow) return false;
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return mainWindow.isFullScreen();
  });

  ipcMain.handle('system:openExternal', async (_e: IpcMainInvokeEvent, url: string) => {
    if (!/^https?:\/\//i.test(url)) return { opened: false, reason: 'blocked scheme' };
    await shell.openExternal(url);
    return { opened: true };
  });

  ipcMain.handle('system:saveAudio', async (_e: IpcMainInvokeEvent, payload: {
    filename: string;
    base64: string;
  }) => {
    const dir = path.join(app.getPath('userData'), 'voice');
    fs.mkdirSync(dir, { recursive: true });
    const safe = payload.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const target = path.join(dir, safe);
    fs.writeFileSync(target, Buffer.from(payload.base64, 'base64'));
    return { path: target };
  });
}

// --------------------------------------------------------------------------- //
//  Lifecycle
// --------------------------------------------------------------------------- //
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    configurePermissions();
    registerIpc();
    startBackend();
    createWindow();

    // Global push-to-talk: hold Ctrl/Cmd+Shift+Space to address SUFFIX.
    globalShortcut.register('CommandOrControl+Shift+Space', () => {
      mainWindow?.webContents.send('shortcut:push-to-talk');
    });
    globalShortcut.register('CommandOrControl+Shift+X', () => {
      mainWindow?.webContents.send('shortcut:kill-switch');
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    globalShortcut.unregisterAll();
    stopBackend();
  });

  app.on('will-quit', () => {
    stopBackend();
  });
}

process.on('uncaughtException', (err) => {
  // A crash in main must not silently kill a live paper position's telemetry.
  pushLog(`uncaughtException: ${err.stack ?? err.message}`);
});
process.on('unhandledRejection', (reason) => {
  pushLog(`unhandledRejection: ${String(reason)}`);
});
