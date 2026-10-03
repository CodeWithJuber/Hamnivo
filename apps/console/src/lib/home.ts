/**
 * What the top of Home shows. Staff who do not run the workspace get a short summary of their
 * chats; people who do get a checklist of what is left to set up. Both read only what existing
 * endpoints and permissions already give.
 */
import type { Can } from './nav';
import type {
  Agent,
  AuthorityConnection,
  Brand,
  Invitation,
  Member,
  ModelConnection,
} from './types';

/**
 * Someone who does not manage brands is staff, not an administrator: Home leads with their chats.
 * Support agents and supervisors can see the team, and they are staff all the same.
 */
export function isStaffOnly(can: Can): boolean {
  return !can('brands.manage');
}

/** What it takes to do each setup step; someone with none of these has no step to be shown. */
const SETUP_PERMISSIONS = [
  'integrations.manage',
  'brands.manage',
  'agents.publish',
  'members.invite',
] as const;

export const canSetUp = (can: Can) => SETUP_PERMISSIONS.some((permission) => can(permission));

export type SetupStepId = 'brand' | 'engine' | 'aikey' | 'agent' | 'team';

export interface SetupStep {
  id: SetupStepId;
  /** The page where the step is done. */
  to: '/brands' | '/models' | '/agents' | '/team';
  done: boolean;
}

/** An agent as the checklist reads it: whether its published version answers with the practice model. */
export type AgentFact = Pick<Agent, 'status' | 'publishedVersion'> & {
  /** The published version's model is the offline practice model; `undefined` when not known. */
  usesMock?: boolean | undefined;
};

/** What each list says, or `undefined` when this person cannot read it or it did not load. */
export interface SetupFacts {
  connections: readonly Pick<AuthorityConnection, 'status'>[] | undefined;
  brands: readonly Pick<Brand, 'status' | 'allowedOrigins'>[] | undefined;
  agents: readonly AgentFact[] | undefined;
  members: readonly Pick<Member, 'id'>[] | undefined;
  invitations: readonly Pick<Invitation, 'status'>[] | undefined;
  /** The signed-in person's staff member ID: they are not the teammate to invite. */
  selfId: string | undefined;
  /**
   * AI keys: the workspace's own connections, and whether the server holds a key of its own for
   * any provider. Left out, the step is not shown.
   */
  models?: {
    connections: readonly Pick<ModelConnection, 'status'>[] | undefined;
    serverKey: boolean | undefined;
  };
}

/** Whether anyone besides this person is in the workspace or invited: unknown if not readable. */
function hasTeammate(facts: SetupFacts): boolean | undefined {
  if (facts.members?.some((member) => member.id !== facts.selfId)) return true;
  if (facts.invitations?.some((i) => i.status === 'pending' || i.status === 'accepted')) {
    return true;
  }
  return facts.members && facts.invitations ? false : undefined;
}

/**
 * Whether the workspace has an AI key to answer with: one of its own that is on, or one the
 * server holds. `undefined` when the lists cannot say.
 */
function hasAiKey(models: NonNullable<SetupFacts['models']>): boolean | undefined {
  if (models.connections?.some((c) => c.status === 'active')) return true;
  if (models.serverKey === true) return true;
  return models.connections && models.serverKey !== undefined ? false : undefined;
}

/**
 * Whether an AI agent is live with a real model. An agent that answers with the offline practice
 * model does not count: customers would get canned replies. `undefined` when an agent is
 * published but its model is not known (so nothing is guessed either way).
 */
function hasLiveAgent(agents: readonly AgentFact[]): boolean | undefined {
  const published = agents.filter((a) => a.status === 'active' && a.publishedVersion !== null);
  if (published.some((a) => a.usesMock === false)) return true;
  return published.some((a) => a.usesMock === undefined) ? undefined : false;
}

/**
 * The setup steps this person can do and the lists can tell about, in the order to do them: the
 * brand and its website first, then the chat engine for it, an AI key, the agent and the team. A
 * step the lists cannot tell about is left out, never guessed. Nothing detects the install code
 * running on a website, so "add a brand" counts once a brand has a website allowed to load it.
 */
export function setupSteps(facts: SetupFacts, can: Can): SetupStep[] {
  const steps: SetupStep[] = [];
  if (can('brands.manage') && facts.brands) {
    steps.push({
      id: 'brand',
      to: '/brands',
      done: facts.brands.some((b) => b.status === 'active' && b.allowedOrigins.length > 0),
    });
  }
  if (can('integrations.manage') && facts.connections) {
    // A connection that needs attention is still connected; its page says what is wrong.
    steps.push({
      id: 'engine',
      to: '/brands',
      done: facts.connections.some((c) => c.status === 'active' || c.status === 'degraded'),
    });
  }
  if (can('integrations.manage') && facts.models) {
    const key = hasAiKey(facts.models);
    if (key !== undefined) steps.push({ id: 'aikey', to: '/models', done: key });
  }
  if (can('agents.publish') && facts.agents) {
    const live = hasLiveAgent(facts.agents);
    if (live !== undefined) steps.push({ id: 'agent', to: '/agents', done: live });
  }
  const teammate = hasTeammate(facts);
  if (can('members.invite') && teammate !== undefined) {
    steps.push({ id: 'team', to: '/team', done: teammate });
  }
  return steps;
}
