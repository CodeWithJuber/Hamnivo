import { describe, expect, it } from 'vitest';
import {
  type AlertSettings,
  type Attention,
  chooseDesktopAlerts,
  chooseSound,
  DEFAULT_SETTINGS,
  isActive,
  mergeSettings,
  soundFor,
} from '../src/lib/inbox-alerts';
import type { InboxAlert } from '../src/lib/inbox-live';

const alert = (kind: InboxAlert['kind'], conversationId: string, extra = {}): InboxAlert =>
  ({
    type: 'alert',
    kind,
    conversationId,
    customerName: 'Maya Khan',
    preview: 'Where is my order?',
    at: '2026-10-03T10:00:00.000Z',
    ...extra,
  }) as InboxAlert;

const elsewhere: Attention = { away: true, reading: () => false };
const sounds = (change: Partial<AlertSettings['sounds']> = {}): AlertSettings['sounds'] => ({
  ...DEFAULT_SETTINGS.sounds,
  ...change,
});
const desktop = (change: Partial<AlertSettings['desktop']> = {}): AlertSettings['desktop'] => ({
  ...DEFAULT_SETTINGS.desktop,
  ...change,
});

describe('which sound plays', () => {
  it('uses the sound chosen for each event', () => {
    const own = sounds({ newChat: 'bell', customerMessage: 'drop', assigned: 'ping' });
    expect(soundFor(own, 'chat_waiting')).toBe('bell');
    expect(soundFor(own, 'customer_message')).toBe('drop');
    expect(soundFor(own, 'assigned')).toBe('ping');
    // A chat past its reply time is as pressing as a new one waiting (H12).
    expect(soundFor(own, 'sla_overdue')).toBe('bell');
    expect(chooseSound([alert('assigned', 'c1')], own, elsewhere)).toEqual({
      sound: 'ping',
      volume: 60,
    });
  });

  it('plays nothing while muted, at volume 0, or when the event is set to no sound', () => {
    const waiting = [alert('chat_waiting', 'c1')];
    expect(chooseSound(waiting, sounds({ muted: true }), elsewhere)).toBeNull();
    expect(chooseSound(waiting, sounds({ volume: 0 }), elsewhere)).toBeNull();
    expect(chooseSound(waiting, sounds({ newChat: 'none' }), elsewhere)).toBeNull();
  });

  it('plays one sound for alerts that arrive together: the most important event', () => {
    const batch = [
      alert('customer_message', 'c1'),
      alert('assigned', 'c2'),
      alert('chat_waiting', 'c3'),
    ];
    expect(chooseSound(batch, sounds(), elsewhere)?.sound).toBe('chime');
    const late = [alert('assigned', 'c2'), alert('sla_overdue', 'c4')];
    expect(chooseSound(late, sounds({ assigned: 'ping' }), elsewhere)?.sound).toBe('chime');
    // With no sound for the first, the next one is heard.
    expect(chooseSound(batch, sounds({ newChat: 'none' }), elsewhere)?.sound).toBe('bell');
  });

  it('does not make a sound for a message in the very chat the person is reading', () => {
    const reading: Attention = { away: false, reading: (id) => id === 'c1' };
    expect(chooseSound([alert('customer_message', 'c1')], sounds(), reading)).toBeNull();
    expect(chooseSound([alert('customer_message', 'c2')], sounds(), reading)?.sound).toBe('pop');
    // A new chat or an assignment is still worth a sound.
    expect(chooseSound([alert('assigned', 'c1')], sounds(), reading)?.sound).toBe('bell');
  });
});

describe('which desktop alerts show', () => {
  const batch = [alert('customer_message', 'c1')];

  it('needs the setting on, the browser’s permission, and the person looking elsewhere', () => {
    expect(chooseDesktopAlerts(batch, desktop(), 'granted', elsewhere)).toHaveLength(1);
    expect(chooseDesktopAlerts(batch, desktop({ enabled: false }), 'granted', elsewhere)).toEqual(
      [],
    );
    for (const permission of ['default', 'denied', 'unsupported'] as const) {
      expect(chooseDesktopAlerts(batch, desktop(), permission, elsewhere)).toEqual([]);
    }
    const looking: Attention = { away: false, reading: () => false };
    expect(chooseDesktopAlerts(batch, desktop(), 'granted', looking)).toEqual([]);
  });

  it('leaves out the customer’s words when the person turned the preview off', () => {
    const [shown] = chooseDesktopAlerts(
      batch,
      desktop({ showPreview: false }),
      'granted',
      elsewhere,
    );
    expect(shown).toMatchObject({ conversationId: 'c1', name: 'Maya Khan', preview: null });
    const [withWords] = chooseDesktopAlerts(batch, desktop(), 'granted', elsewhere);
    expect(withWords?.preview).toBe('Where is my order?');
  });

  it('shows one alert for each chat, the one that says the most', () => {
    const shown = chooseDesktopAlerts(
      [
        alert('customer_message', 'c1', { preview: 'Hello?' }),
        alert('chat_waiting', 'c1'),
        alert('customer_message', 'c1', { preview: 'Anyone there?' }),
        alert('assigned', 'c2'),
      ],
      desktop(),
      'granted',
      elsewhere,
    );
    expect(shown.map((item) => [item.conversationId, item.kind])).toEqual([
      ['c1', 'chat_waiting'],
      ['c2', 'assigned'],
    ]);
  });

  it('shows at most three at a time', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) => alert('chat_waiting', id));
    expect(chooseDesktopAlerts(many, desktop(), 'granted', elsewhere)).toHaveLength(3);
  });
});

describe('changing the settings', () => {
  it('changes only what is named', () => {
    const next = mergeSettings(DEFAULT_SETTINGS, {
      sounds: { volume: 30, assigned: 'none' },
      desktop: { showPreview: false },
    });
    expect(next).toEqual({
      sounds: {
        muted: false,
        volume: 30,
        newChat: 'chime',
        customerMessage: 'pop',
        assigned: 'none',
      },
      desktop: { enabled: true, showPreview: false },
    });
    expect(mergeSettings(DEFAULT_SETTINGS, {})).toEqual(DEFAULT_SETTINGS);
    // The settings it started from are not touched.
    expect(DEFAULT_SETTINGS.sounds.volume).toBe(60);
  });
});

describe('being active', () => {
  it('counts Studio as in use for five minutes after the last touch', () => {
    const now = 10_000_000;
    expect(isActive(now - 60_000, now)).toBe(true);
    expect(isActive(now - 299_000, now)).toBe(true);
    expect(isActive(now - 300_000, now)).toBe(false);
  });
});
