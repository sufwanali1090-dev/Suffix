#!/usr/bin/env node
/**
 * Marks the compiled Electron output as CommonJS.
 *
 * The repo root is `"type": "module"` so Vite/React tooling stays ESM, but
 * Electron's main + preload scripts are the most portable as CommonJS. Rather
 * than fight module interop in the TS config, we drop a minimal package.json
 * into `dist-electron/` that pins that subtree to CJS.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = resolve(root, 'dist-electron');

mkdirSync(out, { recursive: true });
writeFileSync(
  resolve(out, 'package.json'),
  JSON.stringify({ type: 'commonjs' }, null, 2) + '\n',
  'utf8',
);

console.log('[build] dist-electron marked as CommonJS');
