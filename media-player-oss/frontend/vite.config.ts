import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8767',
        changeOrigin: true,
        // Preserve the browser Origin; Python explicitly gates development access.
      },
    },
  },
  build: { outDir: 'dist', assetsDir: 'assets', target: ['es2022', 'safari15'] },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], clearMocks: true },
});
