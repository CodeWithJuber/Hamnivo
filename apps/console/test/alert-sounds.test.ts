import { ALERT_SOUNDS } from '@hamnivo/contracts';
import { describe, expect, it } from 'vitest';
import { gainFor, renderSound, SOUND_NAMES } from '../src/lib/alert-sounds';

const RATE = 22_050;

/** How much of one pitch a stretch of samples holds (the Goertzel measure). */
function energyAt(samples: Float32Array, from: number, to: number, hertz: number): number {
  const w = (2 * Math.PI * hertz) / RATE;
  const k = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i += 1) {
    const s0 = (samples[i] ?? 0) + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - k * s1 * s2;
}

/** Rising crossings of zero per second in a stretch: a rough measure of pitch. */
function crossingsPerSecond(samples: Float32Array, from: number, to: number): number {
  let crossings = 0;
  for (let i = Math.round(from * RATE) + 1; i < Math.round(to * RATE); i += 1) {
    if ((samples[i - 1] ?? 0) < 0 && (samples[i] ?? 0) >= 0) crossings += 1;
  }
  return crossings / (to - from);
}

describe('notification sounds', () => {
  it('are the five the settings offer, in the same order', () => {
    expect(SOUND_NAMES).toEqual([...ALERT_SOUNDS]);
    expect(SOUND_NAMES).toHaveLength(5);
  });

  for (const name of SOUND_NAMES) {
    it(`${name}: is short, audible and starts and ends in silence`, () => {
      const samples = renderSound(name, RATE);
      const seconds = samples.length / RATE;
      expect(seconds).toBeGreaterThan(0.15);
      expect(seconds).toBeLessThanOrEqual(1.2);
      const peak = Math.max(...samples.map(Math.abs));
      expect(peak).toBeCloseTo(0.8, 2);
      // No click at either end.
      expect(Math.abs(samples[0] ?? 1)).toBeLessThan(0.01);
      expect(Math.abs(samples.at(-1) ?? 1)).toBeLessThan(0.01);
      // Something is heard along the first tenth of a second, and it fades away by the end.
      const rms = (from: number, to: number) => {
        let sum = 0;
        for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i += 1) {
          sum += (samples[i] ?? 0) ** 2;
        }
        return Math.sqrt(sum / ((to - from) * RATE));
      };
      expect(rms(0, 0.1)).toBeGreaterThan(0.05);
      expect(rms(seconds - 0.05, seconds)).toBeLessThan(0.05);
    });

    it(`${name}: is the same every time`, () => {
      expect(Array.from(renderSound(name, RATE))).toEqual(Array.from(renderSound(name, RATE)));
    });
  }

  it('differ from one another', () => {
    const firsts = SOUND_NAMES.map((name) =>
      Array.from(renderSound(name, RATE).slice(0, 2000), (x) => x.toFixed(3)).join(),
    );
    expect(new Set(firsts).size).toBe(SOUND_NAMES.length);
  });

  it('chime plays a low note and then a higher one', () => {
    const chime = renderSound('chime', RATE);
    // E5 first (before the second note starts at 0.14 s), then A5.
    expect(energyAt(chime, 0.02, 0.13, 659.25)).toBeGreaterThan(
      energyAt(chime, 0.02, 0.13, 880) * 5,
    );
    expect(energyAt(chime, 0.3, 0.45, 880)).toBeGreaterThan(energyAt(chime, 0.3, 0.45, 740) * 3);
  });

  it('ping is one clear high note', () => {
    const ping = renderSound('ping', RATE);
    expect(energyAt(ping, 0.01, 0.2, 1318.5)).toBeGreaterThan(energyAt(ping, 0.01, 0.2, 990) * 20);
  });

  it('pop rises in pitch and drop falls', () => {
    const pop = renderSound('pop', RATE);
    expect(crossingsPerSecond(pop, 0.09, 0.15)).toBeGreaterThan(crossingsPerSecond(pop, 0, 0.02));
    const drop = renderSound('drop', RATE);
    expect(crossingsPerSecond(drop, 0.2, 0.3)).toBeLessThan(crossingsPerSecond(drop, 0, 0.03));
  });
});

describe('volume', () => {
  it('goes from silent to full, quieter in the middle than a straight line would be', () => {
    expect(gainFor(0)).toBe(0);
    expect(gainFor(100)).toBe(1);
    expect(gainFor(50)).toBe(0.25);
    expect(gainFor(-10)).toBe(0);
    expect(gainFor(250)).toBe(1);
  });
});
