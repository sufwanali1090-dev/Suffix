/**
 * preload.js — the smallest possible bridge between the desktop shell and the
 * HUD: three events in, two capabilities out. The renderer stays a plain web
 * page, which is what lets the same build run in a browser at localhost:8787.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desk', {
  isDesktop: true,
  info: () => ipcRenderer.invoke('desk:info'),
  kiosk: (on) => ipcRenderer.invoke('desk:kiosk', Boolean(on)),
  onTalk: (fn) => ipcRenderer.on('desk:talk', () => fn()),
  onVoices: (fn) => ipcRenderer.on('desk:voices', () => fn()),
  onFocusMode: (fn) => ipcRenderer.on('desk:focusmode', () => fn()),
});
