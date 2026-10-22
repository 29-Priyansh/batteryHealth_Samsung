import { App as CapApp } from '@capacitor/app';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { BottomNav } from './ui/BottomNav';
import { ToastHost } from './ui/components';
import { ParametersScreen } from './ui/ParametersScreen';
import { ResultsScreen } from './ui/ResultsScreen';
import { handleBack } from './ui/backStack';
import { closeReach, installReach, type ReachController } from './ui/reachability';
import { TestScreen } from './ui/TestScreen';
import { BatteryLab } from './native/batteryLab';
import { Capacitor } from '@capacitor/core';
import { parseOpen, requestOpen, setHour12 } from './ui/time';
import './ui/style.css';

type Screen = 'test' | 'results' | 'parameters';

const NAV = [
  { key: 'test' as const, label: 'Test', icon: 'test' },
  { key: 'results' as const, label: 'Results', icon: 'results' },
  { key: 'parameters' as const, label: 'Setup', icon: 'setup' },
];

const TITLES: Record<Screen, string> = { test: 'Battery Lab', results: 'Results', parameters: 'What to compare' };

function App() {
  const [screen, setScreen] = useState<Screen>('test');
  const reach = useRef<ReachController | null>(null);
  useEffect(() => {
    reach.current = installReach({
      root: window,
      scrollTop: () => window.scrollY,
      header: () => document.querySelector('.appbar'),
      title: () => document.querySelector('.appbar h1'),
      content: () => document.querySelector('main'),
      ignore: '.scrim, .bottomnav, .detail-page',
    });
    return () => reach.current?.destroy();
  }, []);
  useEffect(() => reach.current?.refresh(), [screen]);

  // Phone's 12/24-hour setting, and notification taps (at launch or while running) → Test tab.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    void BatteryLab.getDeviceInfo().then((i) => setHour12(i.is24Hour));
    const open = (action: string | null) => {
      const r = parseOpen(action);
      if (!r) return;
      setScreen('test');
      requestOpen(r);
    };
    void BatteryLab.getLaunchAction().then((r) => open(r.action));
    const sub = BatteryLab.addListener('openRequest', (e) => open(e.action));
    return () => { void sub.then((h) => h.remove()); };
  }, []);

  // Android back: close the top layer, then the reach space, then go to the Test tab, then leave.
  const screenRef = useRef(screen);
  screenRef.current = screen;
  useEffect(() => {
    const sub = CapApp.addListener('backButton', () => {
      if (handleBack() || closeReach()) return;
      if (screenRef.current !== 'test') setScreen('test');
      else void CapApp.minimizeApp();
    });
    return () => { void sub.then((h) => h.remove()); };
  }, []);
  return (
    <>
      <header class="appbar"><h1>{TITLES[screen]}</h1></header>
      <main>
        {screen === 'test' ? <TestScreen /> : screen === 'results' ? <ResultsScreen /> : <ParametersScreen />}
      </main>
      <BottomNav items={NAV} active={screen} onChange={setScreen} />
      <ToastHost />
    </>
  );
}

render(<App />, document.getElementById('app')!);
