import type { Provider } from '@nestjs/common';
import { ChecksService } from '../checks/checks.service.js';
import { ChecksAdminService } from '../checks/checks-admin.service.js';
import { ReplyChecksService } from '../checks/reply-checks.service.js';
import { LanguageService } from '../language/language.service.js';
import type { PlatformOverrides } from '../platform/platform.module.js';
import { DECISION_FETCH, DecisionProviders } from './providers.js';
import { RoutingService } from './routing.service.js';
import { RubricsService } from './rubrics.service.js';
import { TeamRoutingService } from './team-routing.service.js';

/** Routing, language and reply-check services for both processes. */
export function decisionProviders(overrides: PlatformOverrides): Provider[] {
  return [
    { provide: DECISION_FETCH, useValue: overrides.decisionFetch ?? null },
    DecisionProviders,
    ChecksService,
    ReplyChecksService,
    LanguageService,
    RoutingService,
  ];
}

/** Studio's routing and check administration (API process only). */
export const decisionAdminProviders: Provider[] = [
  TeamRoutingService,
  RubricsService,
  ChecksAdminService,
];
