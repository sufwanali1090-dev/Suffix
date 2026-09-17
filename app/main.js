/**
 * main.js — the desktop shell.
 *
 * The HUD is a web page, so Electron does exactly three things a browser can't:
 *   1. boot the desk server as a child process and keep it alive with the window;
 *   2. grant microphone/camera to the renderer (hands steering + speech-in);
 *   3. hold a global push-to-talk shortcut so you can talk to the desk from
 *      another app without alt-tabbing into a window.
 *
 * It is ~100 lines on purpose. Any business logic in a desktop shell is business
 * logic the browser build cannot have.
 */
import { app, BrowserWindow, globalShortcut, ipcMain, session, Menu } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const URL = `http://127.0.0.1:${PORT}`;
let server = null;
let win = null;

function startServer() {
  return new Promise((resolve, reject) => {
    const alreadyUp = fetch(`${URL}/healthz`, { signal: AbortSignal.timeout(1200) })
      .then((r) => (r.ok ? 'reused' : null))
      .catch(() => null);
    alreadyUp.then((reuse) => {
      if (reuse) return resolve({ reused: true });
      server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(PORT) },
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      server.on('error', reject);
      const t0 = Date.now();
      const wait = setInterval(async () => {
        const ok = await fetch(`${URL}/healthz`, { signal: AbortSignal.timeout(700) })
          .then((r) => r.ok)
          .catch(() => false);
        if (ok) {
          clearInterval(wait);
          resolve({ reused: false });
        } else if (Date.now() - t0 > 15000) {
          clearInterval(wait);
          reject(new Error('desk server did not come up within 15s — run `npm start` to see the error'));
        }
      }, 350);
    });
  });
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: '#04060c',
    title: 'F.R.I.D.A.Y. · the desk',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => (win = null));
  // F11-style kiosk toggle for wall-mounted screens.
  win.on('page-title-updated', (e) => e.preventDefault());
  await win.loadURL(URL);
  return win;
}

// Microphone + camera for speech-in and hand tracking. Nothing else is granted.
session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
  const allowed = new Set(['media', 'audioCapture', 'videoCapture', 'notifications']);
  cb(allowed.has(permission));
});

Menu.setApplicationMenu(
  Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'Desk',
      submenu: [
        { label: 'Toggle push-to-talk', accelerator: 'CmdOrCtrl+Shift+Space', click: () => win?.webContents.send('desk:talk', true) },
        { label: 'Toggle voices', accelerator: 'CmdOrCtrl+M', click: () => win?.webContents.send('desk:voices', true) },
        { label: 'Focus mode (hide panels)', accelerator: 'CmdOrCtrl+B', click: () => win?.webContents.send('desk:focusmode', true) },
        { type: 'separator' },
        { label: 'Reload desk', role: 'reload' },
        { label: 'DevTools', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'Quit', role: 'quit' },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ])
);

ipcMain.handle('desk:info', () => ({ version: app.getVersion(), electron: process.versions.electron, platform: process.platform }));
ipcMain.handle('desk:kiosk', (e, on) => {
  if (!win) return false;
  if (on) win.setFullScreen(true);
  else win.setFullScreen(false);
  return win.isFullScreen();
});

app.whenReady().then(async () => {
  try {
    await startServer();
  } catch (err) {
    console.error('[desktop]', err.message);
  }
  await createWindow();
  globalShortcut.register('CommandOrControl+Shift+Space', () => win?.webContents.send('desk:talk', true));
  app.on('activate', () => (BrowserWindow.getAllWindows().length ? null : createWindow()));
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  server?.kill('SIGTERM');
});
app.on('window-all-closed', () => {
  server?.kill('SIGTERM');
  app.quit();
});
