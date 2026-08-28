import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@renderer': resolve(__dirname, 'src/renderer/src'),
  '@task-manager/telemetry-types': resolve(__dirname, '../../packages/telemetry-types/src/index.ts'),
  '@task-manager/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
};

export default defineConfig({
  main: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias },
    plugins: [react(), tailwindcss()],
    build: {
      // Inline the few small images the UI uses as data: URIs. A packaged build
      // loads the renderer over file://, where the document's Content-Security-
      // Policy `img-src 'self'` does not reliably match a sibling asset file;
      // `data:` is explicitly allowed, so inlining removes the risk and a
      // request. The threshold is just above the app logo.
      assetsInlineLimit: 16 * 1024,
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
  },
});
