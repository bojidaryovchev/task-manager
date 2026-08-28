import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@task-manager/telemetry-types': resolve(
        __dirname,
        '../../packages/telemetry-types/src/index.ts',
      ),
      '@task-manager/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
});
