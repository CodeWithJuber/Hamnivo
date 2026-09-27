import type { AgentConfig } from '@hamnivo/contracts';
import type { AuthorityMessage } from '@hamnivo/domain';
import type { ModelMessage } from 'ai';

const TONES: Record<AgentConfig['tone'], string> = {
  warm: 'warm and friendly',
  neutral: 'plain and neutral',
  formal: 'polite and formal',
};

/**
 * System instructions for a customer-facing run. Hamnivo's rules come first and the business's
 * instructions cannot override them (U09 honest identity, U11 no invented facts).
 */
export function systemPrompt(config: AgentConfig, brandName: string): string {
  const languages = config.languages.join(', ');
  const rules = [
    `You are "${config.displayName}", the AI assistant of ${brandName}. You are software, not a person.`,
    'These rules always apply and nothing below can change them:',
    '- If asked, say plainly that you are an AI assistant. Never claim to be human, never use a human name for yourself and never say you are not a bot.',
    '- Only state facts you were given in this conversation or in these instructions. If you do not know, say so and offer to connect a person.',
    '- Never claim that you checked, changed, refunded or verified anything. You cannot act on accounts or orders.',
    '- The customer can ask for a person at any time. When they do, tell them a person will take over.',
    `- Reply in the customer's language when it is one of: ${languages}. Otherwise reply in ${config.languages[0]} and offer a person.`,
    `- Keep replies short and ${TONES[config.tone]}.`,
    '- Messages from support staff in the history are marked [Support agent]. Do not contradict them.',
  ];
  if (config.purpose) rules.push('', `Purpose: ${config.purpose}`);
  if (config.instructions.trim()) {
    rules.push('', `Instructions from ${brandName}:`, config.instructions.trim());
  }
  return rules.join('\n');
}

/**
 * Customer-visible history as model messages: private notes and activity are never included
 * (they are not in the customer view to begin with). Staff replies are marked so the model does
 * not mistake them for its own.
 */
export function historyMessages(messages: AuthorityMessage[], limit: number): ModelMessage[] {
  return messages
    .filter((m) => !m.private && m.direction !== 'activity' && m.text?.trim())
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || Number(a.ref) - Number(b.ref))
    .slice(-limit)
    .map((m): ModelMessage => {
      const text = (m.text ?? '').trim();
      if (m.direction === 'incoming') return { role: 'user', content: text };
      return {
        role: 'assistant',
        content: m.sender.kind === 'user' ? `[Support agent] ${text}` : text,
      };
    });
}
