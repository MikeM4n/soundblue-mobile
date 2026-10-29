import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.soundblue.mobile',
  appName: 'SoundBlue',
  webDir: 'dist',
  android: {
    androidScheme: 'https',
    appendUserAgent: ' Brave',
  },
};

export default config;
