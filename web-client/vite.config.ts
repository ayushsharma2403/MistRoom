import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: ['browser', 'module', 'import', 'default'],
  },
  optimizeDeps: {
    exclude: ['@noble/hashes', '@noble/curves'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
  },
});
