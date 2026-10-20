import { WorkflowContextReader } from './context-reader.service.js';
import { WorkflowRunner } from './runner.service.js';
import { WorkflowsController } from './workflows.controller.js';
import { WorkflowsService } from './workflows.service.js';
export const WORKFLOWS_API_CONTROLLERS = [WorkflowsController];
export const WORKFLOWS_API_PROVIDERS = [WorkflowsService, WorkflowContextReader];
export const WORKFLOWS_WORKER_PROVIDERS = [WorkflowsService, WorkflowRunner, WorkflowContextReader];
