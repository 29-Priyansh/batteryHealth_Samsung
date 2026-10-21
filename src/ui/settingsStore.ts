import { Capacitor } from '@capacitor/core';
import { BatteryLab } from '../native/batteryLab';

// Small key/value settings. Native SQLite-backed on device; localStorage in the browser dev server.
export async function loadSetting<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = Capacitor.isNativePlatform()
      ? (await BatteryLab.getSetting({ key })).value
      : localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export async function saveSetting(key: string, value: unknown): Promise<void> {
  const raw = JSON.stringify(value);
  if (Capacitor.isNativePlatform()) await BatteryLab.setSetting({ key, value: raw });
  else {
    try { localStorage.setItem(key, raw); } catch { /* dev only */ }
  }
}
