import { describe, expect, it } from 'vitest';
import {
  actionCode,
  compareCase,
  containToolOutput,
  fenceToolResult,
  parseTextDecision,
  renderHandoffNote,
  sanitizeToolSchema,
  summarizeSimulation,
  TOOL_DATA_NOTICE,
} from '../../src/actions/index.js';

describe('containToolOutput', () => {
  it('keeps plain JSON data and text as data', () => {
    expect(containToolOutput({ status: 'shipped', count: 2 })).toEqual({
      ok: true,
      data: { status: 'shipped', count: 2 },
      bytes: JSON.stringify({ status: 'shipped', count: 2 }).length,
    });
    expect(containToolOutput('Order is on its way')).toMatchObject({
      ok: true,
      data: { text: 'Order is on its way' },
    });
    expect(containToolOutput('{"status":"shipped"}')).toMatchObject({
      data: { status: 'shipped' },
    });
  });

  it('refuses an oversized result before and after parsing', () => {
    expect(containToolOutput('x'.repeat(2000), { maxBytes: 1000 })).toMatchObject({
      ok: false,
      reason: 'oversized',
    });
    expect(
      containToolOutput(
        { items: Array.from({ length: 50 }, () => 'y'.repeat(50)) },
        { maxBytes: 1000 },
      ),
    ).toMatchObject({ ok: false, reason: 'oversized' });
  });

  it('refuses malformed results', () => {
    expect(containToolOutput('{"status": ')).toMatchObject({ ok: false, reason: 'malformed' });
    expect(containToolOutput({ n: Number.NaN })).toMatchObject({ ok: false, reason: 'malformed' });
    expect(containToolOutput({ when: new Date() })).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
    expect(containToolOutput({ f: () => 1 })).toMatchObject({ ok: false, reason: 'malformed' });
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 20; i += 1) {
      deep.next = {};
      deep = deep.next as Record<string, unknown>;
    }
    expect(containToolOutput(root)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(containToolOutput('   ')).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('checks the output schema when the tool has one', () => {
    const schema = sanitizeToolSchema(
      {
        type: 'object',
        properties: { status: { type: 'string', enum: ['shipped', 'pending'] } },
        required: ['status'],
      },
      { trusted: true },
    );
    if (!schema.ok) throw new Error(schema.problem);
    expect(containToolOutput({ status: 'shipped' }, { schema: schema.schema }).ok).toBe(true);
    expect(containToolOutput({ status: 'teleported' }, { schema: schema.schema })).toMatchObject({
      ok: false,
      reason: 'schema_mismatch',
    });
  });

  it('removes control and direction-override characters from strings', () => {
    const result = containToolOutput({ note: 'Ship\u202e today\u0000' });
    expect(result).toMatchObject({ ok: true, data: { note: 'Ship today' } });
  });

  it('fences results for the model with the untrusted-data notice', () => {
    expect(fenceToolResult({ status: 'ok', summary: 'Found', data: { a: 1 } })).toEqual({
      status: 'ok',
      summary: 'Found',
      data: { a: 1 },
      notice: TOOL_DATA_NOTICE,
    });
  });
});

describe('text decisions', () => {
  it('reads a whole-message decision with its code', () => {
    const code = actionCode('act_01j9zk7w3xq8r4t2v6m5n1p0cd');
    expect(code).toMatch(/^[0-9A-F]{6}$/);
    expect(parseTextDecision(`APPROVE ${code}`)).toEqual({ decision: 'approve', code });
    expect(parseTextDecision(`decline ${code.toLowerCase()}.`)).toEqual({
      decision: 'decline',
      code,
    });
    expect(parseTextDecision(`haan ${code}`)).toEqual({ decision: 'approve', code });
  });

  it('ignores sentences that merely contain the words', () => {
    expect(parseTextDecision('I approve of this 4F2A9C thing')).toBeNull();
    expect(parseTextDecision('approve')).toBeNull();
    expect(parseTextDecision('maybe 4F2A9C')).toBeNull();
  });
});

describe('handoff note', () => {
  it('lists why, what was tried, what is pending and facts with sources', () => {
    const text = renderHandoffNote({
      version: 1,
      reason: 'customer_request',
      reasonText: 'The customer asked to talk to a person.',
      request: 'Please change my delivery address',
      replyLanguage: 'ur',
      attempts: [{ kind: 'tool', label: 'Order status', outcome: 'completed' }],
      pending: [
        {
          actionId: 'act_1',
          title: 'Change delivery address for NL-1048',
          state: 'awaiting_approval',
          approver: 'customer',
          expiresAt: '2026-09-27T13:00:00.000Z',
        },
      ],
      facts: [
        {
          label: 'Order NL-1048',
          value: 'paid, preparing',
          source: { kind: 'tool', ref: 'act_0', observedAt: '2026-09-27T12:39:00.000Z' },
        },
      ],
    });
    expect(text).toContain('Handoff: The customer asked to talk to a person.');
    expect(text).toContain('- Order status: completed');
    expect(text).toContain('waiting for approval (customer approves), until 2026-09-27 13:00 UTC');
    expect(text).toContain('- Order NL-1048: paid, preparing (tool result, 2026-09-27 12:39 UTC)');
  });
});

describe('simulation comparison', () => {
  const definition = {
    id: 'c1',
    name: 'Address change',
    messages: ['Please update delivery address'],
    tools: {},
    expect: {
      outcome: 'replied' as const,
      actions: [{ tool: 'update_address', decision: 'approval' as const }],
    },
  };
  const baseline = {
    outcome: 'replied' as const,
    handoffReason: null,
    replies: ['A'],
    actions: [],
  };
  const candidate = {
    outcome: 'replied' as const,
    handoffReason: null,
    replies: ['B'],
    actions: [
      {
        tool: 'update_address',
        decision: 'approval' as const,
        argumentsHash: 'h',
        reason: 'policy',
      },
    ],
  };

  it('shows what the draft changes and whether expectations hold', () => {
    const comparison = compareCase(definition, candidate, baseline);
    expect(comparison.changes).toEqual([
      'New action: update_address (approval)',
      'Reply text differs',
    ]);
    expect(comparison.failures).toEqual([]);
    expect(summarizeSimulation([comparison])).toEqual({
      cases: 1,
      changed: 1,
      failed: 0,
      passed: true,
    });
  });

  it('fails a case whose expectation the draft does not meet', () => {
    const comparison = compareCase(definition, baseline, null);
    expect(comparison.failures).toEqual(['Expected update_address (approval)']);
    expect(summarizeSimulation([comparison]).passed).toBe(false);
  });
});
