import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';

const BACKEND_ORIGIN = 'http://127.0.0.1:8700';

// `--mode native` builds the Capacitor bundle: it loads from capacitor://localhost, so API calls
// must target the backend origin. The iOS simulator shares the host loopback interface.
export default defineConfig(({ mode }) => {
  const native = mode === 'native';
  const apiBase = loadEnv(mode, process.cwd(), 'VITE_').VITE_API_BASE || BACKEND_ORIGIN;
  return {
    plugins: [react()],
    base: '/',
    define: native ? { 'import.meta.env.VITE_API_BASE': JSON.stringify(apiBase) } : {},
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: BACKEND_ORIGIN,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: native ? 'dist-native' : 'dist',
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
      css: { include: [/\/src\/style\.css/] },
    },
  };
});
