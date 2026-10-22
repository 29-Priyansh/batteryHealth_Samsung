import { App as CapApp } from '@capacitor/app';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { BottomNav } from './ui/BottomNav';
import { ToastHost } from './ui/components';
import { ParametersScreen } from './ui/ParametersScreen';
import { ProbeScreen } from './ui/ProbeScreen';
import { handleBack } from './ui/backStack';
import { closeReach, installReach, type ReachController } from './ui/reachability';
import { TestScreen } from './ui/TestScreen';
import './ui/style.css';

type Screen = 'test' | 'parameters' | 'probe';

const NAV = [
  { key: 'test' as const, label: 'Test', icon: 'test' },
  { key: 'parameters' as const, label: 'Setup', icon: 'setup' },
  { key: 'probe' as const, label: 'Diagnostics', icon: 'diag' },
];

const TITLES: Record<Screen, string> = { test: 'Battery Lab', parameters: 'What to compare', probe: 'Diagnostics' };

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
        {screen === 'test' ? <TestScreen /> : screen === 'parameters' ? <ParametersScreen /> : <ProbeScreen />}
      </main>
      <BottomNav items={NAV} active={screen} onChange={setScreen} />
      <ToastHost />
    </>
  );
}

render(<App />, document.getElementById('app')!);
