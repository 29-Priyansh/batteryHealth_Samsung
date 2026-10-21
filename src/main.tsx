import { render } from 'preact';
import { useState } from 'preact/hooks';
import { ParametersScreen } from './ui/ParametersScreen';
import { ProbeScreen } from './ui/ProbeScreen';
import './ui/style.css';

const SCREENS = { parameters: 'Parameters', probe: 'Diagnostics' } as const;
type Screen = keyof typeof SCREENS;

function App() {
  const [screen, setScreen] = useState<Screen>('parameters');
  return (
    <>
      <header>
        <h1>Battery Lab</h1>
        <nav>
          {(Object.keys(SCREENS) as Screen[]).map((s) => (
            <button class={s === screen ? 'tab on' : 'tab'} onClick={() => setScreen(s)}>{SCREENS[s]}</button>
          ))}
        </nav>
      </header>
      <main>{screen === 'parameters' ? <ParametersScreen /> : <ProbeScreen />}</main>
    </>
  );
}

render(<App />, document.getElementById('app')!);
