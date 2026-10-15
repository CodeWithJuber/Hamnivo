import { describe, expect, it } from 'vitest';
import {
  type AiDraftConversation,
  checkAiDraftDecision,
  draftOutcome,
  draftSurvivesOwnerChange,
} from '../src/ai-drafts.js';

const draft = { state: 'pending' as const };
const conversation = (patch: Partial<AiDraftConversation> = {}): AiDraftConversation => ({
  ownerMode: 'WAITING_HUMAN',
  ownerStaffId: null,
  status: 'open',
  ...patch,
});

describe('deciding on an AI draft (HNV-09-05)', () => {
  it('is open to anyone who may reply while the conversation waits, or to its owner', () => {
    expect(checkAiDraftDecision(draft, conversation(), 'me')).toBeNull();
    const mine = conversation({ ownerMode: 'HUMAN_ACTIVE', ownerStaffId: 'me' });
    expect(checkAiDraftDecision(draft, mine, 'me')).toBeNull();
    expect(checkAiDraftDecision(draft, conversation({ ownerMode: 'PAUSED' }), 'me')).toBeNull();
  });

  it('says why not', () => {
    expect(checkAiDraftDecision({ ...draft, state: 'approved' }, conversation(), 'me')).toBe(
      'not_pending',
    );
    expect(checkAiDraftDecision(draft, conversation({ status: 'resolved' }), 'me')).toBe(
      'resolved',
    );
    expect(checkAiDraftDecision(draft, conversation({ ownerMode: 'AI_ACTIVE' }), 'me')).toBe(
      'ai_owns',
    );
    const theirs = conversation({ ownerMode: 'HUMAN_ACTIVE', ownerStaffId: 'amina' });
    expect(checkAiDraftDecision(draft, theirs, 'me')).toBe('colleague_owns');
  });

  it('counts a sent text that differs in more than spacing as an edit', () => {
    expect(draftOutcome('Thanks, it ships today.', undefined)).toBe('approved');
    expect(draftOutcome('Thanks, it ships today.', '  Thanks, it ships today.\n')).toBe('approved');
    expect(draftOutcome('Thanks, it ships today.', 'Thanks, it ships tomorrow.')).toBe('edited');
  });

  it('keeps a draft only when a person picks the conversation up from the queue', () => {
    expect(draftSurvivesOwnerChange('WAITING_HUMAN', 'HUMAN_ACTIVE')).toBe(true);
    expect(draftSurvivesOwnerChange('PAUSED', 'HUMAN_ACTIVE')).toBe(true);
    expect(draftSurvivesOwnerChange('HUMAN_ACTIVE', 'HUMAN_ACTIVE')).toBe(false);
    expect(draftSurvivesOwnerChange('HUMAN_ACTIVE', 'WAITING_HUMAN')).toBe(false);
    expect(draftSurvivesOwnerChange('WAITING_HUMAN', 'AI_ACTIVE')).toBe(false);
    expect(draftSurvivesOwnerChange('HUMAN_ACTIVE', 'AI_ACTIVE')).toBe(false);
  });
});
