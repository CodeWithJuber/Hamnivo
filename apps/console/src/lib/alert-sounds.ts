/**
 * The five notification sounds built into Studio. They are made here, from a few sine waves that
 * fade away, so there is no audio file to license, download or keep (see CREDITS.md). Rendering is
 * a plain function from a name to samples, so tests can check it without a sound card; playing
 * them uses the browser's Web Audio.
 */
import type { AlertSound } from '@hamnivo/contracts';

export type SoundName = AlertSound;

/** One tone: a base pitch with overtones that fade away, optionally sliding to another pitch. */
interface Tone {
  /** Seconds after the start. */
  at: number;
  /** Hertz at the start of the tone. */
  from: number;
  /** Hertz at the end of the slide (the same as `from` for a steady tone). */
  to?: number;
  /** How long the slide takes, in seconds. */
  slide?: number;
  /** Seconds for the tone to fade to about a thousandth of its start. */
  fade: number;
  gain: number;
  /** Overtones as [multiple of the base pitch, loudness]. The base pitch itself is [1, 1]. */
  overtones: readonly (readonly [number, number])[];
}

interface Recipe {
  seconds: number;
  tones: readonly Tone[];
}

const SOFT: Tone['overtones'] = [
  [1, 1],
  [2, 0.3],
  [3, 0.1],
];
/** A struck bell is not a clean series of overtones; these spacings give it its metal. */
const BELL: Tone['overtones'] = [
  [1, 1],
  [2, 0.6],
  [2.76, 0.45],
  [5.4, 0.25],
  [8.93, 0.12],
];

const RECIPES: Record<SoundName, Recipe> = {
  // Two rising notes, like a door chime: the sound for a new chat.
  chime: {
    seconds: 0.85,
    tones: [
      { at: 0, from: 659.25, fade: 0.45, gain: 0.55, overtones: SOFT },
      { at: 0.14, from: 880, fade: 0.6, gain: 0.55, overtones: SOFT },
    ],
  },
  // A short bubble that rises: for a new message.
  pop: {
    seconds: 0.22,
    tones: [
      {
        at: 0,
        from: 480,
        to: 900,
        slide: 0.07,
        fade: 0.16,
        gain: 0.8,
        overtones: [
          [1, 1],
          [2, 0.15],
        ],
      },
    ],
  },
  // One struck bell.
  bell: {
    seconds: 1.1,
    tones: [{ at: 0, from: 784, fade: 0.9, gain: 0.45, overtones: BELL }],
  },
  // A drop of water: the pitch falls away quickly.
  drop: {
    seconds: 0.4,
    tones: [
      {
        at: 0,
        from: 1250,
        to: 420,
        slide: 0.12,
        fade: 0.28,
        gain: 0.75,
        overtones: [
          [1, 1],
          [2, 0.08],
        ],
      },
    ],
  },
  // One clear, high note.
  ping: {
    seconds: 0.5,
    tones: [
      {
        at: 0,
        from: 1318.5,
        fade: 0.34,
        gain: 0.7,
        overtones: [
          [1, 1],
          [2, 0.2],
        ],
      },
    ],
  },
};

/** Every sound the contract names, in the order the settings list them. */
export const SOUND_NAMES = Object.keys(RECIPES) as SoundName[];

/** Seconds of a quick rise at the start of every tone, so none begins with a click. */
const ATTACK = 0.004;
/** The loudest sample of every sound, so a volume setting means the same for all of them. */
const PEAK = 0.8;

/**
 * The samples of a sound, mono, from -1 to 1. The same name and rate always give the same samples.
 */
export function renderSound(name: SoundName, sampleRate = 44_100): Float32Array {
  const recipe = RECIPES[name];
  const out = new Float32Array(Math.max(1, Math.round(recipe.seconds * sampleRate)));
  for (const tone of recipe.tones) {
    const first = Math.round(tone.at * sampleRate);
    const decay = Math.log(1000) / tone.fade;
    const loudest = tone.overtones.reduce((sum, [, level]) => sum + level, 0);
    // The phase is summed sample by sample so a slide in pitch stays smooth.
    let phase = 0;
    for (let i = first; i < out.length; i += 1) {
      const t = (i - first) / sampleRate;
      const slid = tone.slide && tone.to !== undefined ? Math.min(1, t / tone.slide) : 0;
      // Pitch slides at a steady ratio, which is how a rising or falling note sounds even.
      const hertz = tone.to !== undefined ? tone.from * (tone.to / tone.from) ** slid : tone.from;
      phase += (2 * Math.PI * hertz) / sampleRate;
      const envelope = Math.min(1, t / ATTACK) * Math.exp(-decay * t);
      let value = 0;
      for (const [multiple, level] of tone.overtones) value += level * Math.sin(phase * multiple);
      out[i] = (out[i] ?? 0) + (value / loudest) * envelope * tone.gain;
    }
  }
  // Fade the last few milliseconds to silence and scale the whole sound to the same peak.
  const tail = Math.min(out.length, Math.round(0.01 * sampleRate));
  for (let i = 0; i < tail; i += 1) {
    const at = out.length - 1 - i;
    out[at] = (out[at] ?? 0) * (i / tail);
  }
  let loudest = 0;
  for (const sample of out) loudest = Math.max(loudest, Math.abs(sample));
  if (loudest > 0)
    for (let i = 0; i < out.length; i += 1) out[i] = ((out[i] ?? 0) / loudest) * PEAK;
  return out;
}

/** The gain for a volume from 0 to 100. Squared, so the slider feels even to the ear. */
export const gainFor = (volume: number) => (Math.min(100, Math.max(0, volume)) / 100) ** 2;

// ------------------------------------------------------------------ playing (browser only)

type AudioContextLike = AudioContext;
let context: AudioContextLike | undefined;
const buffers = new Map<string, AudioBuffer>();

function audio(): AudioContextLike | null {
  if (typeof window === 'undefined') return null;
  const Context =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return null;
  context ??= new Context();
  return context;
}

/**
 * Browsers keep a page silent until the person has touched it. This listens for the first touch
 * or key press and wakes the sound system then, so alerts that come later can be heard.
 */
export function unlockAudioOnFirstTouch(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const wake = () => {
    void audio()?.resume();
    stop();
  };
  const stop = () => {
    window.removeEventListener('pointerdown', wake);
    window.removeEventListener('keydown', wake);
  };
  window.addEventListener('pointerdown', wake, { once: true });
  window.addEventListener('keydown', wake, { once: true });
  return stop;
}

/** Plays a sound at a volume from 0 to 100. Resolves to false when the browser keeps it silent. */
export async function playSound(name: SoundName, volume: number): Promise<boolean> {
  const gain = gainFor(volume);
  if (gain === 0) return false;
  try {
    const sound = audio();
    if (!sound) return false;
    if (sound.state === 'suspended') await sound.resume();
    if (sound.state !== 'running') return false;
    const key = `${name}@${sound.sampleRate}`;
    let buffer = buffers.get(key);
    if (!buffer) {
      const samples = renderSound(name, sound.sampleRate);
      buffer = sound.createBuffer(1, samples.length, sound.sampleRate);
      buffer.copyToChannel(new Float32Array(samples), 0);
      buffers.set(key, buffer);
    }
    const source = sound.createBufferSource();
    const level = sound.createGain();
    level.gain.value = gain;
    source.buffer = buffer;
    source.connect(level).connect(sound.destination);
    source.start();
    return true;
  } catch {
    return false;
  }
}
