import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'org.mistroom.app',
  appName: 'MistRoom',
  webDir: '../frontend',
  server: {
    androidScheme: 'https'
  },
  plugins: {
    BluetoothLe: {
      displayStrings: {
        scanning: "Scanning for nearby emergency mesh peers...",
        cancel: "Cancel",
        availableDevices: "Available Mesh Devices",
        noDeviceFound: "No emergency devices in range"
      }
    }
  }
};

export default config;
