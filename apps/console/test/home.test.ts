import { presetPermissions } from '@hamnivo/policy';
import { describe, expect, it } from 'vitest';
import { canSetUp, isStaffOnly, type SetupFacts, setupSteps } from '../src/lib/home';

const holding = (...permissions: string[]) => {
  const held = new Set(permissions);
  return (permission: string) => held.has(permission);
};
const role = (key: Parameters<typeof presetPermissions>[0]) => holding(...presetPermissions(key));

describe('who gets "Your chats" and who gets "Get set up"', () => {
  it('treats someone who neither manages brands nor sees the team as staff', () => {
    expect(isStaffOnly(holding('conversations.read'))).toBe(true);
    expect(isStaffOnly(holding())).toBe(true);
    expect(isStaffOnly(holding('brands.manage'))).toBe(false);
    expect(isStaffOnly(holding('members.read'))).toBe(true);
    expect(isStaffOnly(holding('brands.manage', 'members.read'))).toBe(false);
  });

  it('follows the built-in roles', () => {
    expect(isStaffOnly(role('owner'))).toBe(false);
    expect(isStaffOnly(role('admin'))).toBe(false);
    expect(isStaffOnly(role('analyst'))).toBe(true);
    expect(isStaffOnly(role('knowledge_editor'))).toBe(true);
    // Support agents can see the team (read only) and are staff all the same.
    expect(isStaffOnly(role('agent'))).toBe(true);
  });
});

describe('who is looked at for setup at all', () => {
  it('is whoever can do at least one step', () => {
    expect(canSetUp(holding('integrations.manage'))).toBe(true);
    expect(canSetUp(holding('brands.manage'))).toBe(true);
    expect(canSetUp(holding('agents.publish'))).toBe(true);
    expect(canSetUp(holding('members.invite'))).toBe(true);
    expect(canSetUp(role('owner'))).toBe(true);
    expect(canSetUp(role('developer'))).toBe(true);
  });

  it('is not someone who can only look', () => {
    expect(canSetUp(holding('members.read', 'agents.read'))).toBe(false);
    expect(canSetUp(role('supervisor'))).toBe(false);
    expect(canSetUp(role('agent'))).toBe(false);
    expect(canSetUp(role('finance'))).toBe(false);
  });
});

const nothingYet: SetupFacts = {
  connections: [],
  brands: [],
  agents: [],
  members: [{ id: 'staff_me' }],
  invitations: [],
  selfId: 'staff_me',
  models: { connections: [], serverKey: false },
};
const allDone: SetupFacts = {
  connections: [{ status: 'active' }],
  brands: [{ status: 'active', allowedOrigins: ['https://shop.example.com'] }],
  agents: [{ status: 'active', publishedVersion: 1, usesMock: false }],
  members: [{ id: 'staff_me' }, { id: 'staff_other' }],
  invitations: [],
  selfId: 'staff_me',
  models: { connections: [{ status: 'active' }], serverKey: false },
};
const owner = role('owner');
const done = (facts: SetupFacts, can = owner) =>
  Object.fromEntries(setupSteps(facts, can).map((step) => [step.id, step.done]));

describe('setup steps', () => {
  it('lists the five steps in order for a new workspace, each with its page', () => {
    // The brand and its website come first: the chat engine is connected for a brand.
    expect(setupSteps(nothingYet, owner)).toEqual([
      { id: 'brand', to: '/brands', done: false },
      { id: 'engine', to: '/brands', done: false },
      { id: 'aikey', to: '/models', done: false },
      { id: 'agent', to: '/agents', done: false },
      { id: 'team', to: '/team', done: false },
    ]);
  });

  it('marks every step done when there is nothing left', () => {
    expect(done(allDone)).toEqual({
      brand: true,
      engine: true,
      aikey: true,
      agent: true,
      team: true,
    });
  });

  it('counts a connection as made once it is active, or active but needing attention', () => {
    const connection = (status: 'provisioning' | 'active' | 'degraded' | 'disabled') =>
      done({ ...nothingYet, connections: [{ status }] }).engine;
    expect(connection('active')).toBe(true);
    expect(connection('degraded')).toBe(true);
    expect(connection('provisioning')).toBe(false);
    expect(connection('disabled')).toBe(false);
  });

  it('counts a brand once it can load the chat on a website', () => {
    const brand = (status: 'active' | 'disabled', allowedOrigins: string[]) =>
      done({ ...nothingYet, brands: [{ status, allowedOrigins }] }).brand;
    expect(brand('active', ['https://shop.example.com'])).toBe(true);
    expect(brand('active', [])).toBe(false);
    expect(brand('disabled', ['https://shop.example.com'])).toBe(false);
  });

  describe('the AI key', () => {
    const key = (models: SetupFacts['models']) =>
      setupSteps({ ...nothingYet, models }, owner).find((step) => step.id === 'aikey')?.done;

    it('counts a key of the workspace’s own that is on, or one the server holds', () => {
      expect(key({ connections: [{ status: 'active' }], serverKey: false })).toBe(true);
      expect(key({ connections: [], serverKey: true })).toBe(true);
      expect(key({ connections: [{ status: 'disabled' }], serverKey: false })).toBe(false);
      expect(key({ connections: [], serverKey: false })).toBe(false);
    });

    it('leaves the step out when the lists cannot say, instead of guessing', () => {
      expect(key({ connections: undefined, serverKey: undefined })).toBeUndefined();
      expect(key({ connections: [], serverKey: undefined })).toBeUndefined();
      // One answer is enough when it is yes.
      expect(key({ connections: undefined, serverKey: true })).toBe(true);
      expect(key({ connections: [{ status: 'active' }], serverKey: undefined })).toBe(true);
    });

    it('is not asked of a workspace that never loaded the facts', () => {
      const { models: _unused, ...without } = nothingYet;
      expect(setupSteps(without, owner).map((step) => step.id)).not.toContain('aikey');
    });
  });

  describe('an AI agent', () => {
    const agent = (agents: SetupFacts['agents']) =>
      setupSteps({ ...nothingYet, agents }, owner).find((step) => step.id === 'agent')?.done;

    it('counts once a version is published with a real model', () => {
      expect(agent([{ status: 'active', publishedVersion: 2, usesMock: false }])).toBe(true);
      expect(agent([{ status: 'active', publishedVersion: null, usesMock: false }])).toBe(false);
      expect(agent([{ status: 'archived', publishedVersion: 2, usesMock: false }])).toBe(false);
      expect(agent([])).toBe(false);
    });

    it('does not count an agent that answers with the offline practice model', () => {
      expect(agent([{ status: 'active', publishedVersion: 2, usesMock: true }])).toBe(false);
      // One real agent among practice ones is enough.
      expect(
        agent([
          { status: 'active', publishedVersion: 1, usesMock: true },
          { status: 'active', publishedVersion: 3, usesMock: false },
        ]),
      ).toBe(true);
    });

    it('leaves the step out when a published agent’s model is not known', () => {
      expect(agent([{ status: 'active', publishedVersion: 2 }])).toBeUndefined();
      expect(
        agent([
          { status: 'active', publishedVersion: 1, usesMock: true },
          { status: 'active', publishedVersion: 2 },
        ]),
      ).toBeUndefined();
      // An unpublished agent has no model to be unsure about.
      expect(agent([{ status: 'active', publishedVersion: null }])).toBe(false);
    });
  });

  it('counts a teammate who joined, or an invitation sent, but not the person themselves', () => {
    const team = (facts: Partial<SetupFacts>) => done({ ...nothingYet, ...facts }).team;
    expect(team({})).toBe(false);
    expect(team({ members: [{ id: 'staff_me' }, { id: 'staff_other' }] })).toBe(true);
    expect(team({ invitations: [{ status: 'pending' }] })).toBe(true);
    expect(team({ invitations: [{ status: 'accepted' }] })).toBe(true);
    expect(team({ invitations: [{ status: 'revoked' }] })).toBe(false);
  });

  it('leaves out a step the lists cannot tell about, instead of guessing', () => {
    const unknown: SetupFacts = {
      connections: undefined,
      brands: undefined,
      agents: undefined,
      members: undefined,
      invitations: undefined,
      selfId: 'staff_me',
    };
    expect(setupSteps(unknown, owner)).toEqual([]);
    // Members known but not the invitations: only a teammate settles it either way.
    expect(
      setupSteps({ ...unknown, members: [{ id: 'staff_me' }] }, owner).map((step) => step.id),
    ).toEqual([]);
    expect(
      setupSteps({ ...unknown, members: [{ id: 'staff_me' }, { id: 'staff_x' }] }, owner),
    ).toEqual([{ id: 'team', to: '/team', done: true }]);
    // The list says nothing for steps it did load.
    expect(
      setupSteps({ ...nothingYet, connections: undefined, agents: undefined }, owner).map(
        (step) => step.id,
      ),
    ).toEqual(['brand', 'aikey', 'team']);
  });

  it('shows a step only to someone who can do it', () => {
    const ids = (can: (permission: string) => boolean) =>
      setupSteps(nothingYet, can).map((step) => step.id);
    expect(ids(holding('brands.manage'))).toEqual(['brand']);
    expect(ids(holding('integrations.manage'))).toEqual(['engine', 'aikey']);
    expect(ids(holding('agents.publish'))).toEqual(['agent']);
    expect(ids(holding('members.invite'))).toEqual(['team']);
    expect(ids(holding())).toEqual([]);
    // A supervisor reads agents and the team but publishes and invites nothing.
    expect(ids(role('supervisor'))).toEqual([]);
    expect(ids(role('admin'))).toEqual(['brand', 'engine', 'aikey', 'agent', 'team']);
  });
});
