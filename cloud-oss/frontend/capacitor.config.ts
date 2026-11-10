import type { CapacitorConfig } from '@capacitor/cli';

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
  },
};

export default config;
