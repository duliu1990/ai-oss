import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mediaplayeross.app',
  appName: '轻听',
  webDir: 'dist',
  loggingBehavior: 'debug',
  server: {
    hostname: 'localhost',
    androidScheme: 'https',
    iosScheme: 'capacitor',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
  },
  ios: {
    scheme: 'App',
  },
};

export default config;
