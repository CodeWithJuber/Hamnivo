import type { Action, Card } from '@hamnivo/contracts';
import type { HamnivoClient } from './client.js';

export type CustomerAction = Action;
/** The approval card the conversation shows for a request. */
export type Approval = Extract<Card, { kind: 'approval' }>;

export interface ActionDecision {
  decision: 'approve' | 'decline';
  /** The hash on the card the customer looked at; the server refuses any other. */
  argumentsHash: string;
  /** Makes a repeated tap safe: the same id returns the same decision. */
  clientRequestId: string;
}

/**
 * AI actions in a conversation (widget API, G13/W16): the customer reads the live state of a
 * request the AI made for them and approves or declines exactly what the card showed. Requests
 * that need staff, or another customer's requests, are refused by the server.
 */
export class ActionsApi {
  constructor(private readonly client: HamnivoClient) {}

  private path(conversationId: string, actionId: string, rest = '') {
    return `/v1/widget/conversations/${encodeURIComponent(conversationId)}/actions/${encodeURIComponent(actionId)}${rest}`;
  }

  getAction(conversationId: string, actionId: string): Promise<CustomerAction> {
    return this.client.request('GET', this.path(conversationId, actionId));
  }

  /**
   * Fails with IDENTITY_REQUIRED when the request asks the customer to confirm who they are (the
   * host page signs them in, then the decision can be sent again), APPROVAL_MISMATCH when the
   * request changed after the card was shown, and APPROVAL_EXPIRED when it ran out.
   */
  decide(conversationId: string, actionId: string, input: ActionDecision): Promise<CustomerAction> {
    return this.client.request('POST', this.path(conversationId, actionId, '/decision'), input);
  }
}
