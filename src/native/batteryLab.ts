import { registerPlugin } from '@capacitor/core';

/** Raw capability report from the native probe (M0). Values are as returned by the platform. */
export interface ProbeReport {
  [section: string]: Record<string, unknown>;
}

export interface BroadcastStats {
  seconds: number;
  broadcasts: number;
  levelChanges: number;
  voltageChanges: number;
  temperatureChanges: number;
  statusChanges: number;
}

export interface PermissionState {
  phoneState: boolean;
  notifications: boolean;
  usageAccess: boolean;
  ignoringBatteryOptimizations: boolean;
}

export interface BatteryLabPlugin {
  probe(): Promise<ProbeReport>;
  sampleBroadcasts(options: { seconds: number }): Promise<BroadcastStats>;
  getPermissions(): Promise<PermissionState>;
  requestPhoneState(): Promise<PermissionState>;
  requestNotifications(): Promise<PermissionState>;
  openBatteryOptimization(): Promise<void>;
  openUsageAccess(): Promise<void>;
  openAppDetails(): Promise<void>;
  getSetting(options: { key: string }): Promise<{ value: string | null }>;
  setSetting(options: { key: string; value: string }): Promise<void>;
}

export const BatteryLab = registerPlugin<BatteryLabPlugin>('BatteryLab');
