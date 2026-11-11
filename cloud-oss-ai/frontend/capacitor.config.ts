import type { CapacitorConfig } from '@capacitor/cli';

// The server address is chosen at runtime in the app (see src/shared/platform/connection.ts),
// so the same dist/ bundle serves the Web build and both native apps.
const config: CapacitorConfig = {
  appId: 'com.cloudossai.app',
  appName: '轻云',
  webDir: 'dist',
  loggingBehavior: 'debug',
  server: {
    hostname: 'localhost',
    androidScheme: 'https',
    iosScheme: 'capacitor',
    // Self-hosted servers often run plain HTTP (LAN or a bare IP), so both apps may reach http:// origins.
    cleartext: true,
  },
  android: {
    // The bundle loads from https://localhost; calling an http:// server from it is mixed content.
    allowMixedContent: true,
  },
  ios: {
    scheme: 'App',
    // The page pads itself with env(safe-area-inset-*); a native inset on top would double it.
    contentInset: 'never',
  },
};

export default config;
