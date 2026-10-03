import type { Provider } from '@nestjs/common';
import { VisitorInvites } from './invites.js';
import { VisitorTracker } from './tracker.service.js';
import { VisitorsController, VisitorsWidgetController } from './visitors.controller.js';
import { VisitorsService } from './visitors.service.js';

/** Website visitors in the API: the loader's reports, live visitors, the visitor card, invitations. */
export const VISITORS_API_CONTROLLERS = [VisitorsWidgetController, VisitorsController];

export const VISITORS_API_PROVIDERS: Provider[] = [VisitorInvites, VisitorTracker, VisitorsService];
