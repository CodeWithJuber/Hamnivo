import { OperationReconcilers } from '../common/operation-reconcilers.js';
import { InboxAccess } from '../inbox/access.js';
import {
  InboxActionsController,
  ToolsController,
  WidgetActionsController,
} from './actions.controller.js';
import { ToolAdapters } from './adapters.js';
import { ActionsCacheRules } from './answer-cache.js';
import { ActionApprovals } from './approvals.service.js';
import { ActionExecutor } from './executor.service.js';
import { ToolGateway } from './gateway.service.js';
import { HandoffPackets } from './handoff.service.js';
import { InboxActions } from './inbox-actions.service.js';
import { SimulationsController } from './simulation.controller.js';
import { SimulationService } from './simulation.service.js';
import { ToolsService } from './tools.service.js';
import { ActionsWorker } from './worker.service.js';

/**
 * AI actions wiring (G07, G10, G11, G13–G15, D10). Both processes hold the tool adapters, the
 * gateway, the executor and approvals; the API serves Studio, the inbox and the widget; the worker
 * runs approved actions, reconciles lost answers and expires approvals.
 */
const shared = [
  // A reply that may rest on a tool's answer never enters or leaves the answer cache (K06).
  ActionsCacheRules,
  OperationReconcilers,
  ToolAdapters,
  ActionExecutor,
  ActionApprovals,
  HandoffPackets,
  ToolGateway,
];

export const ACTIONS_API_CONTROLLERS = [
  ToolsController,
  InboxActionsController,
  WidgetActionsController,
  SimulationsController,
];

export const ACTIONS_API_PROVIDERS = [...shared, ToolsService, InboxActions, SimulationService];

export const ACTIONS_WORKER_PROVIDERS = [...shared, InboxAccess, ActionsWorker];
