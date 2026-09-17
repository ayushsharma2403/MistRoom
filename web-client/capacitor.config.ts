import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mistroom.app',
  appName: 'MistRoom',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    BluetoothLe: {
      displayStrings: {
        scanning: 'Scanning for nearby MistRoom nodes...',
        cancel: 'Cancel',
        availableDevices: 'Nearby Nodes',
        noDeviceFound: 'No nearby nodes found.',
      },
    },
  },
};

export default config;
