import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const BACKEND_ORIGIN = 'http://127.0.0.1:8790';

// One bundle serves the Web build and both Capacitor apps; native builds choose their server at runtime.
export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: BACKEND_ORIGIN,
        changeOrigin: true,
        // Preserve the browser Origin; the backend explicitly gates development access.
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    target: ['es2022', 'safari15'],
    rollupOptions: {
      input: {
        main: 'index.html',
        preview: 'preview.html',
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    clearMocks: true,
    css: { include: [/\/src\/modules\/drive\/(?:drive|markdown-preview|office-preview)\.css/, /\/src\/shared\/.*\.css/] },
  },
});
