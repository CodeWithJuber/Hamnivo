import { z } from 'zod';
import { ModelConnection } from './agents.js';
import type { RouteDef } from './routes.js';
import {
  ModelProbeResult,
  ModelSetupStatus,
  OnboardingProgress,
  PublishWidgetAppearanceRequest,
  ReplaceModelKeyRequest,
  SaveWidgetAppearanceDraftRequest,
  TestModelConnectionRequest,
  UpdateOnboardingRequest,
  UpdateWidgetAppearanceRequest,
  WidgetAppearanceView,
} from './setup.js';

const connectionParams = z.object({ connectionId: z.string().meta({ description: 'mcn_…' }) });
const brandParams = z.object({ brandId: z.string().meta({ description: 'Brand ID (brd_…)' }) });

/** What a business owner sets up from Studio: AI keys and their test, the chat's look, the wizard. */
export const setupRoutes = {
  getModelSetupStatus: {
    method: 'get',
    path: '/v1/admin/model-connections/status',
    operationId: 'getModelSetupStatus',
    summary:
      'Which AI keys the server holds (yes or no), whether Jev is set up, and the last test of each connection (integrations.manage)',
    tags: ['Agents'],
    auth: 'staff_session',
    success: { status: 200, description: 'Setup status', schema: ModelSetupStatus },
  },
  testModelConnection: {
    method: 'post',
    path: '/v1/admin/model-connections/{connectionId}/test',
    operationId: 'testModelConnection',
    summary:
      'Make one real call of a few tokens with the connection’s key and say in plain words whether it worked (integrations.manage)',
    tags: ['Agents'],
    auth: 'staff_session',
    params: connectionParams,
    body: TestModelConnectionRequest,
    success: { status: 200, description: 'The outcome of the test', schema: ModelProbeResult },
  },
  rotateModelConnectionKey: {
    method: 'post',
    path: '/v1/admin/model-connections/{connectionId}/rotate',
    operationId: 'rotateModelConnectionKey',
    summary:
      'Replace the connection’s key in place; agents that use it keep working (integrations.manage, fresh sign-in)',
    tags: ['Agents'],
    auth: 'staff_session',
    params: connectionParams,
    body: ReplaceModelKeyRequest,
    success: { status: 200, description: 'Key replaced', schema: ModelConnection },
  },
  getWidgetAppearance: {
    method: 'get',
    path: '/v1/admin/brands/{brandId}/appearance',
    operationId: 'getWidgetAppearance',
    summary: 'How the brand’s chat looks and what it says (widget.configure)',
    tags: ['Widget'],
    auth: 'staff_session',
    params: brandParams,
    success: { status: 200, description: 'Appearance', schema: WidgetAppearanceView },
  },
  setWidgetAppearance: {
    method: 'put',
    path: '/v1/admin/brands/{brandId}/appearance',
    operationId: 'setWidgetAppearance',
    summary:
      'Set the chat’s colour, logo, corners, greeting, offline text, rating and privacy link; the colour must be readable (widget.configure)',
    tags: ['Widget'],
    auth: 'staff_session',
    params: brandParams,
    body: UpdateWidgetAppearanceRequest,
    success: { status: 200, description: 'Appearance saved', schema: WidgetAppearanceView },
  },
  saveWidgetAppearanceDraft: {
    method: 'put',
    path: '/v1/admin/brands/{brandId}/appearance/draft',
    operationId: 'saveWidgetAppearanceDraft',
    summary: 'Save appearance without changing the live widget',
    tags: ['Widget'],
    auth: 'staff_session',
    params: brandParams,
    body: SaveWidgetAppearanceDraftRequest,
    success: { status: 200, description: 'Draft saved', schema: WidgetAppearanceView },
  },
  publishWidgetAppearance: {
    method: 'post',
    path: '/v1/admin/brands/{brandId}/appearance/publish',
    operationId: 'publishWidgetAppearance',
    summary: 'Publish the reviewed appearance draft',
    tags: ['Widget'],
    auth: 'staff_session',
    params: brandParams,
    body: PublishWidgetAppearanceRequest,
    success: { status: 200, description: 'Appearance published', schema: WidgetAppearanceView },
  },
  getOnboarding: {
    method: 'get',
    path: '/v1/admin/onboarding',
    operationId: 'getOnboarding',
    summary: 'Where the owner is in the setup wizard (brands.manage)',
    tags: ['Administration'],
    auth: 'staff_session',
    success: { status: 200, description: 'Progress', schema: OnboardingProgress },
  },
  updateOnboarding: {
    method: 'put',
    path: '/v1/admin/onboarding',
    operationId: 'updateOnboarding',
    summary: 'Mark wizard steps done or skipped, or finish it (brands.manage)',
    tags: ['Administration'],
    auth: 'staff_session',
    body: UpdateOnboardingRequest,
    success: { status: 200, description: 'Progress', schema: OnboardingProgress },
  },
} as const satisfies Record<string, RouteDef>;
