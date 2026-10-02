import type { CacheExclusionRule, ModuleDataClass } from '@hamnivo/domain';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CacheExclusions } from '../cache/store.js';

/**
 * What a reply from an agent that may call tools can rest on: a tool's answer about one customer,
 * or an action (G15). Such a reply is never stored in, or served from, the answer cache (K06).
 */
export const TOOL_DATA_CLASS: ModuleDataClass = 'actions.tool_result';

export const ACTIONS_CACHE_RULE: CacheExclusionRule = {
  id: 'actions.tools',
  check(request) {
    return request.dataClasses.some((c) => c.startsWith('actions.')) ? 'tool_result' : null;
  },
};

/** Adds the actions rule to the cache exclusions of this process (API and worker). */
@Injectable()
export class ActionsCacheRules implements OnModuleInit {
  constructor(private readonly exclusions: CacheExclusions) {}

  onModuleInit(): void {
    this.exclusions.register(ACTIONS_CACHE_RULE);
  }
}
