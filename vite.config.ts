import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Renderer build.
 *
 * `base: './'` is required: Electron loads the production bundle from
 * `file://`, where absolute `/assets/...` URLs do not resolve.
 *
 * The dev server proxies the Python bridge so the HUD can always talk to a
 * same-origin relative path — in the browser, in the harness preview, and
 * inside Electron. Browser-facing code must never call 127.0.0.1 directly.
 */
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // Allow the proxied preview host (https://<port>-<sandbox>.e2b.app).
    allowedHosts: true,
    proxy: {
      '/rpc': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/status': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/config': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/telemetry': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/agents': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/events': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/ledger': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/quantum': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/market': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/tts': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/stt': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: mode !== 'production',
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          motion: ['framer-motion'],
          vision: ['@mediapipe/tasks-vision'],
        },
      },
    },
  },
  define: {
    __SUFFIX_BUILD__: JSON.stringify(new Date().toISOString()),
  },
}));
