import { useCallback, useEffect, useState } from 'react';

export type TextSize = 'normal' | 'large' | 'larger';
export const TEXT_SIZES: TextSize[] = ['normal', 'large', 'larger'];

/** Every size is relative, so the browser's and the device's own text size still apply. */
const SCALE: Record<TextSize, string> = { normal: '100%', large: '112.5%', larger: '125%' };

interface DisplayPrefs {
  textSize: TextSize;
  reduceMotion: boolean;
}

const DEFAULTS: DisplayPrefs = { textSize: 'normal', reduceMotion: false };

function read(key: string): DisplayPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<DisplayPrefs>;
    return {
      textSize: TEXT_SIZES.includes(stored.textSize as TextSize)
        ? (stored.textSize as TextSize)
        : DEFAULTS.textSize,
      reduceMotion: stored.reduceMotion === true,
    };
  } catch {
    return DEFAULTS;
  }
}

function systemReducesMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The visitor's display choices (W14): a larger text size and less motion, kept on this device.
 * The device's own settings come first: its text size scales everything, and when it asks for
 * less motion the chat moves less whatever the choice here.
 */
export function useDisplay(widgetId: string) {
  const key = `hamnivo:${widgetId}:display`;
  const [prefs, setPrefs] = useState<DisplayPrefs>(() => read(key));
  const [system, setSystem] = useState(systemReducesMotion);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setSystem(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const reduced = prefs.reduceMotion || system;
  useEffect(() => {
    const root = document.documentElement;
    root.style.fontSize = SCALE[prefs.textSize];
    root.dataset.motion = reduced ? 'reduce' : 'full';
    try {
      localStorage.setItem(key, JSON.stringify(prefs));
    } catch {
      // Not kept on this device; still applied now.
    }
  }, [key, prefs, reduced]);

  const setTextSize = useCallback(
    (textSize: TextSize) => setPrefs((p) => ({ ...p, textSize })),
    [],
  );
  const setReduceMotion = useCallback(
    (reduceMotion: boolean) => setPrefs((p) => ({ ...p, reduceMotion })),
    [],
  );
  return { prefs, system, reduced, setTextSize, setReduceMotion };
}

export type DisplayControls = ReturnType<typeof useDisplay>;
