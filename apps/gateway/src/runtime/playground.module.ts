import { ConversationMemoryController } from '../memory/conversation-memory.controller.js';
import { ConversationMemoryService } from '../memory/conversation-memory.service.js';
import { PlaygroundController } from './playground.controller.js';
import { PlaygroundService } from './playground.service.js';
import { PlaygroundLimiter } from './playground-limit.js';

/**
 * Two staff tools beside the agent editor and the inbox (API process only): "Test your AI", a
 * scratch conversation with an agent's own model, and the lookup that tells the inbox which
 * customer's memory a conversation belongs to.
 */
export const PLAYGROUND_API_CONTROLLERS = [PlaygroundController, ConversationMemoryController];

export const PLAYGROUND_API_PROVIDERS = [
  PlaygroundService,
  PlaygroundLimiter,
  ConversationMemoryService,
];
