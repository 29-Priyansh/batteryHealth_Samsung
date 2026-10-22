import { describe, expect, it } from 'vitest';
import { momentumTarget } from './BottomNav';

const W = 100; // tab width
const N = 3;

describe('momentumTarget', () => {
  it('stays put for a tiny, slow nudge', () => {
    expect(momentumTarget(10, 0.05, 0, W, N)).toBe(0);
  });

  it('commits to the neighbour after a short deliberate drag', () => {
    expect(momentumTarget(35, 0, 0, W, N)).toBe(1);
    expect(momentumTarget(165, 0, 2, W, N)).toBe(1);
  });

  it('lands on the centre tab when released at 90% of the way', () => {
    expect(momentumTarget(90, 0.1, 0, W, N)).toBe(1);
  });

  it('a quick flick commits even from a small drag', () => {
    expect(momentumTarget(15, 0.6, 0, W, N)).toBe(1);
    expect(momentumTarget(85, -0.6, 1, W, N)).toBe(0);
  });

  it('a strong flick can carry across two tabs', () => {
    expect(momentumTarget(60, 1.2, 0, W, N)).toBe(2);
  });

  it('never leaves the bar', () => {
    expect(momentumTarget(230, 2, 2, W, N)).toBe(2);
    expect(momentumTarget(-20, -2, 0, W, N)).toBe(0);
  });
});
