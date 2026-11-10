import type { CapacitorConfig } from '@capacitor/cli';
import { loadEnv } from 'vite';

const backendOrigin = loadEnv('native', process.cwd(), 'VITE_').VITE_API_BASE || 'http://127.0.0.1:8700';

// webDir is the `vite build --mode native` output; its API calls target the backend directly.
const config: CapacitorConfig = {
  appId: 'com.cloudoss.app',
  appName: '轻存储',
  webDir: 'dist-native',
  server: {
    hostname: 'localhost',
    iosScheme: 'capacitor',
  },
  ios: {
    scheme: 'App',
    contentInset: 'automatic',
  },
  plugins: {
    CloudFiles: { backendOrigin },
  },
};

export default config;
