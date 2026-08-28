import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@task-manager/telemetry-types': resolve(
        __dirname,
        '../telemetry-types/src/index.ts',
      ),
    },
  },
});
