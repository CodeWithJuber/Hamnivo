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
    expect(isStaffOnly(holding('members.read'))).toBe(false);
    expect(isStaffOnly(holding('brands.manage', 'members.read'))).toBe(false);
  });

  it('follows the built-in roles', () => {
    expect(isStaffOnly(role('owner'))).toBe(false);
    expect(isStaffOnly(role('admin'))).toBe(false);
    expect(isStaffOnly(role('analyst'))).toBe(true);
    expect(isStaffOnly(role('knowledge_editor'))).toBe(true);
    // The Support agent role can see the team (read only), so by this rule it is not staff-only.
    expect(isStaffOnly(role('agent'))).toBe(false);
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
};
const allDone: SetupFacts = {
  connections: [{ status: 'active' }],
  brands: [{ status: 'active', allowedOrigins: ['https://shop.example.com'] }],
  agents: [{ status: 'active', publishedVersion: 1 }],
  members: [{ id: 'staff_me' }, { id: 'staff_other' }],
  invitations: [],
  selfId: 'staff_me',
};
const owner = role('owner');
const done = (facts: SetupFacts, can = owner) =>
  Object.fromEntries(setupSteps(facts, can).map((step) => [step.id, step.done]));

describe('setup steps', () => {
  it('lists the four steps in order for a new workspace, each with its page', () => {
    expect(setupSteps(nothingYet, owner)).toEqual([
      { id: 'engine', to: '/brands', done: false },
      { id: 'brand', to: '/brands', done: false },
      { id: 'agent', to: '/agents', done: false },
      { id: 'team', to: '/team', done: false },
    ]);
  });

  it('marks every step done when there is nothing left', () => {
    expect(done(allDone)).toEqual({ engine: true, brand: true, agent: true, team: true });
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

  it('counts an agent once a version is published', () => {
    const agent = (status: 'active' | 'archived', publishedVersion: number | null) =>
      done({ ...nothingYet, agents: [{ status, publishedVersion }] }).agent;
    expect(agent('active', 2)).toBe(true);
    expect(agent('active', null)).toBe(false);
    expect(agent('archived', 2)).toBe(false);
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
    ).toEqual(['brand', 'team']);
  });

  it('shows a step only to someone who can do it', () => {
    const ids = (can: (permission: string) => boolean) =>
      setupSteps(nothingYet, can).map((step) => step.id);
    expect(ids(holding('brands.manage'))).toEqual(['brand']);
    expect(ids(holding('integrations.manage'))).toEqual(['engine']);
    expect(ids(holding('agents.publish'))).toEqual(['agent']);
    expect(ids(holding('members.invite'))).toEqual(['team']);
    expect(ids(holding())).toEqual([]);
    // A supervisor reads agents and the team but publishes and invites nothing.
    expect(ids(role('supervisor'))).toEqual([]);
    expect(ids(role('admin'))).toEqual(['engine', 'brand', 'agent', 'team']);
  });
});
