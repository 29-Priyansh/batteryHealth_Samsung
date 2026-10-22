import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

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

export type Row = Record<string, string | number | null>;

export interface SessionRow extends Row {
  id: string;
  type: 'charging' | 'draining';
  status: string;
  start_wall: number;
}

export interface CurrentState {
  battery: { level: number; status: number; plugged: number; tempC: number; voltageMv: number } | null;
  auto: Record<string, string | null>;
  radio: string | null;
  activeSession: SessionRow | null;
  activeValues: Record<string, { value: string | null; src: string }> | null;
  counts: { samples: number; events: number; changes: number } | null;
  live: LiveEstimate | null;
}

/** Live indicator for the active session (display only; results come from src/engine). */
export interface LiveEstimate {
  limit: number;
  /** +1 charging, -1 discharging, 0 neither. */
  direction: number;
  steps: number;
  ratePerHour: number | null;
  hoursToLimit: number | null;
  measured: boolean;
  instantMa: number | null;
  instantHours: number | null;
  summary: string;
  config: string;
}

export interface SessionData {
  session: SessionRow;
  samples: Row[];
  events: Row[];
  configStates: Row[];
  paramValues: Row[];
  configChanges: Row[];
  build: Row | null;
}

export interface StartSessionOptions {
  type: 'charging' | 'draining';
  target?: number;
  threshold?: number;
  /** Manual parameter values confirmed by the user; null = unknown. */
  manual: Record<string, string | null>;
  trackedParams: string[];
  conditions?: Record<string, unknown>;
  notes?: string;
}

export interface SampleAddedEvent {
  sessionId: string;
  wall: number;
  level: number;
  status: number;
  plugged: number;
  reason: string;
}

export interface BatteryLabPlugin {
  getCurrentState(): Promise<CurrentState>;
  startSession(options: StartSessionOptions): Promise<SessionRow>;
  pauseSession(): Promise<SessionRow>;
  /** Change where the active session stops: charging target or draining lower level. */
  setLimit(options: { value: number }): Promise<SessionRow>;
  resumeSession(): Promise<SessionRow>;
  stopSession(options?: { confirmations?: Record<string, unknown> }): Promise<SessionRow>;
  logChange(options: { param: string; value: string | null; windowStartWall?: number }): Promise<SessionRow>;
  listSessions(): Promise<{ sessions: (SessionRow & { sample_count: number; change_count: number })[] }>;
  getSessionData(options: { id: string }): Promise<SessionData>;
  deleteSession(options: { id: string }): Promise<void>;
  getOverhead(): Promise<{ days: Row[] }>;
  addListener(event: 'sampleAdded', fn: (e: SampleAddedEvent) => void): Promise<PluginListenerHandle>;

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
