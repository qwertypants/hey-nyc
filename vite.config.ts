import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * `base` supports repository-subpath hosting, e.g.
 *   https://<user>.github.io/eat-outside-nyc/
 *
 * Set VITE_BASE_PATH=/repo/ to override. In CI, deploy.yml derives it from the
 * repository name so a fork deploys correctly without a local edit.
 */
const base = process.env.VITE_BASE_PATH || './';

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    target: 'es2022',
    // Keep the vendor chunk separate so a data-only change does not invalidate it.
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ['maplibre-gl'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['tests/python/**', 'node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/**/*.{ts,tsx}'],
    },
  },
});
