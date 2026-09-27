import type { Provider } from '@nestjs/common';
import { LanguageService } from '../language/language.service.js';
import type { PlatformOverrides } from '../platform/platform.module.js';
import { DECISION_FETCH, DecisionProviders } from './providers.js';
import { RoutingService } from './routing.service.js';
import { RubricsService } from './rubrics.service.js';
import { TeamsService } from './teams.service.js';

/** Routing and language services for both processes. */
export function decisionProviders(overrides: PlatformOverrides): Provider[] {
  return [
    { provide: DECISION_FETCH, useValue: overrides.decisionFetch ?? null },
    DecisionProviders,
    LanguageService,
    RoutingService,
  ];
}

/** Studio's routing administration (API process only). */
export const decisionAdminProviders: Provider[] = [TeamsService, RubricsService];
