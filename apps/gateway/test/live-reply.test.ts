import { describe, expect, it, vi } from 'vitest';
import { LiveReply } from '../src/runtime/live-reply.js';
import { draftPasses } from '../src/runtime/replies.service.js';
import { parseRunSignal } from '../src/runtime/run-signals.js';
import { SentenceGate } from '../src/runtime/stream-gate.js';

describe('what of a reply may show while it is written', () => {
  it('lets out whole sentences and lines only', () => {
    const gate = new SentenceGate(() => true);
    expect(gate.push('Express delivery')).toBe('');
    expect(gate.push(' takes two days. It costs')).toBe('Express delivery takes two days.');
    expect(gate.push(' $9.90 (3.5 kg max).\n- Order before 2')).toBe(
      ' It costs $9.90 (3.5 kg max).\n',
    );
    expect(gate.push(' pm')).toBe('');
    expect(gate.end()).toBe('- Order before 2 pm');
    expect(gate.end()).toBe('');
  });

  it('leaves citation markers out, even split across two pieces', () => {
    const gate = new SentenceGate(() => true);
    expect(gate.push('Returns are free [')).toBe('');
    expect(gate.push('2]. Refunds take')).toBe('Returns are free.');
    expect(gate.push(' five days [1].\n[3] Ask us.')).toBe(' Refunds take five days.\n');
    expect(gate.end()).toBe(' Ask us.');
    expect(gate.shown).toBe('Returns are free. Refunds take five days.\n Ask us.');
  });

  it('leaves memory markers out as well', () => {
    const gate = new SentenceGate(() => true);
    expect(gate.push('You told us you like email [M')).toBe('');
    expect(gate.push('1]. We will write there.')).toBe('You told us you like email.');
    expect(gate.end()).toBe(' We will write there.');
  });

  it('holds everything back from the first sentence a check would stop', () => {
    const gate = new SentenceGate(draftPasses);
    expect(gate.push('Thanks for waiting. ')).toBe('Thanks for waiting.');
    expect(gate.held).toBe(false);
    // "Checked" needs a receipt for a lookup in this conversation: the full checks decide.
    expect(gate.push('I checked your order. ')).toBe('');
    expect(gate.held).toBe(true);
    expect(gate.push('It arrives Monday. ')).toBe('');
    expect(gate.end()).toBe('');
    expect(gate.shown).toBe('Thanks for waiting.');
    // A refund said to be done is held back the same way.
    const refund = new SentenceGate(draftPasses);
    expect(refund.push('Your refund has been processed. ')).toBe('');
    expect(refund.held).toBe(true);
  });

  it('never shows a claim to be a person', () => {
    const gate = new SentenceGate(draftPasses);
    expect(gate.push('Hello! I am a human agent, not a bot. ')).toBe('');
    expect(gate.held).toBe(true);
  });

  it('reads right-to-left and Hindi sentence ends', () => {
    const gate = new SentenceGate(() => true);
    expect(gate.push('شكرا لك؟ نعم')).toBe('شكرا لك؟');
    expect(gate.push('। आपका ऑर्डर आ गया। ')).toBe(' نعم। आपका ऑर्डर आ गया।');
  });
});

describe('a reply as the customer sees it', () => {
  function live(words = true) {
    const sent: Array<{ type: string; data: Record<string, unknown> }> = [];
    const discarded: Array<[string, string]> = [];
    const reply = new LiveReply(
      {
        signals: {
          publish: vi.fn(async (_t: string, _c: string, signal) => {
            sent.push(signal as never);
          }),
        },
        discard: vi.fn(async (draftId: string, reason: string) => {
          discarded.push([draftId, reason]);
        }),
        passes: () => true,
      },
      'tenant',
      'conversation',
      'run_1',
      words,
    );
    return { reply, sent, discarded };
  }
  const steps = (sent: Array<{ type: string; data: Record<string, unknown> }>) =>
    sent.filter((s) => s.type === 'activity').map((s) => `${s.data.kind} ${s.data.state}`);
  const words = (sent: Array<{ type: string; data: Record<string, unknown> }>) =>
    sent.filter((s) => s.type === 'message.delta').map((s) => s.data.textDelta);

  it('says each step once, ends every one it started, and publishes words in order', async () => {
    const { reply, sent, discarded } = live();
    await reply.step('run', 'started');
    await reply.step('searching', 'started');
    await reply.step('searching', 'started');
    await reply.step('searching', 'finished');
    reply.write('Yes. Express ');
    reply.write('takes two days.\n');
    reply.markPublished();
    await reply.close();
    expect(steps(sent)).toEqual([
      'run started',
      'searching started',
      'searching finished',
      'writing started',
      'writing finished',
      'run finished',
    ]);
    expect(words(sent)).toEqual(['Yes.', ' Express takes two days.\n']);
    const indexes = sent.filter((s) => s.type === 'message.delta').map((s) => s.data.index);
    expect(indexes).toEqual([0, 1]);
    expect(discarded).toEqual([]);
  });

  it('withdraws a draft that will not be the reply, with the reason, and starts a new one', async () => {
    const { reply, sent, discarded } = live();
    await reply.step('run', 'started');
    reply.write('Let me look that up. ');
    reply.write('Checking.\n');
    const first = reply.currentDraft;
    await reply.restart('superseded');
    reply.write('It ships today.\n');
    expect(reply.currentDraft).not.toBe(first);
    reply.reason = 'takeover';
    await reply.close();
    expect(discarded.map(([, reason]) => reason)).toEqual(['superseded', 'takeover']);
    expect(discarded[0]?.[0]).toBe(first);
    const deltas = sent.filter((s) => s.type === 'message.delta');
    expect(deltas.at(-1)?.data.index).toBe(0);
    expect(steps(sent).at(-1)).toBe('run finished');
  });

  it('stops showing words at once when the customer presses Stop', async () => {
    const { reply, sent, discarded } = live();
    await reply.step('run', 'started');
    reply.write('First sentence. ');
    reply.write('Second sentence. ');
    await reply.stop();
    reply.write('Third sentence. ');
    reply.end();
    await reply.close();
    // What was out before Stop was withdrawn; nothing after it went out.
    expect(words(sent)).toEqual(['First sentence.', ' Second sentence.']);
    expect(discarded.map(([, reason]) => reason)).toEqual(['cancelled']);
  });

  it('says only the steps where the checks could still hold the reply back', async () => {
    const { reply, sent, discarded } = live(false);
    await reply.step('run', 'started');
    reply.write('Your order ships today. ');
    reply.end();
    await reply.close();
    expect(words(sent)).toEqual([]);
    expect(discarded).toEqual([]);
    expect(steps(sent)).toEqual(['run started', 'run finished']);
  });
});

describe('run signals read back from Redis', () => {
  it('accepts the two kinds field by field, and nothing else', () => {
    const activity = {
      type: 'activity',
      data: { runId: 'run_1', kind: 'searching', label: '', state: 'started' },
    };
    const delta = {
      type: 'message.delta',
      data: { runId: 'run_1', draftId: 'd', index: 0, textDelta: 'Hi.' },
    };
    expect(parseRunSignal(JSON.stringify(activity))).toEqual(activity);
    expect(parseRunSignal(JSON.stringify(delta))).toEqual(delta);
    expect(
      parseRunSignal(JSON.stringify({ ...activity, data: { ...activity.data, kind: 'hack' } })),
    ).toBeNull();
    expect(
      parseRunSignal(JSON.stringify({ ...delta, data: { ...delta.data, index: -1 } })),
    ).toBeNull();
    expect(parseRunSignal(JSON.stringify({ type: 'typing', data: { runId: 'x' } }))).toBeNull();
    expect(parseRunSignal('not json')).toBeNull();
  });
});
