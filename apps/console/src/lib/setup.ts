/**
 * Everything a business owner sets up from Studio alone, read and written through the API: the AI
 * key's status and test, how the chat looks, the setup wizard's progress, and the test chat.
 */
import { bestOn, type ThemeIssue, validateTheme } from '@hamnivo/brand';
import type * as C from '@hamnivo/contracts';
import { api } from './api';
import { GATEWAY_ORIGIN, WIDGET_ORIGIN } from './config';
import { keys, useStudioMutation, useStudioQuery } from './queries';
import { useTenant } from './tenant';
import type { ModelConnection } from './types';

export type ModelSetupStatus = C.ModelSetupStatus;
export type ModelProbeResult = C.ModelProbeResult;
export type ModelProbeKind = C.ModelProbeKind;
export type ModelConnectionTest = C.ModelConnectionTest;
export type WidgetAppearance = C.WidgetAppearance;
export type WidgetAppearanceView = C.WidgetAppearanceView;
export type OnboardingProgress = C.OnboardingProgress;
export type OnboardingStep = C.OnboardingStep;
export type KeyedProvider = C.KeyedProvider;

export const setupKeys = {
  modelStatus: ['model-connections', 'status'],
  appearance: (brandId: string) => ['widget-appearance', brandId],
  onboarding: ['onboarding'],
} as const;

/** Which keys the server holds, whether Jev is set up, and the last test of each connection. */
export function useModelStatus() {
  const { can } = useTenant();
  return useStudioQuery<ModelSetupStatus>(
    setupKeys.modelStatus,
    '/v1/admin/model-connections/status',
    {
      enabled: can('integrations.manage'),
    },
  );
}

/** One real call of a few tokens with a connection's key; the answer says in plain words if it worked. */
export function useTestConnection() {
  return useStudioMutation(
    (vars: { connectionId: string; modelId?: string | undefined }, tenant) =>
      api<ModelProbeResult>(`/v1/admin/model-connections/${vars.connectionId}/test`, {
        method: 'POST',
        tenant,
        body: vars.modelId ? { modelId: vars.modelId } : {},
      }),
    [setupKeys.modelStatus],
  );
}

/** Replaces a connection's key in place; agents that use it carry on with the new one. */
export function useReplaceKey() {
  return useStudioMutation(
    (vars: { connectionId: string; apiKey: string }, tenant) =>
      api<ModelConnection>(`/v1/admin/model-connections/${vars.connectionId}/rotate`, {
        method: 'POST',
        tenant,
        body: { apiKey: vars.apiKey },
      }),
    [keys.modelConnections, setupKeys.modelStatus],
  );
}

/** How a brand's chat looks and what it says (W03). */
export function useAppearance(brandId: string, enabled = true) {
  return useStudioQuery<WidgetAppearanceView>(
    setupKeys.appearance(brandId),
    `/v1/admin/brands/${brandId}/appearance`,
    { enabled },
  );
}

/** Saves how a brand's chat looks. The gateway checks the colour again and says what is wrong. */
export function useSaveAppearance(brandId: string) {
  return useStudioMutation(
    (body: WidgetAppearance, tenant) =>
      api<WidgetAppearanceView>(`/v1/admin/brands/${brandId}/appearance`, {
        method: 'PUT',
        tenant,
        body,
      }),
    [setupKeys.appearance(brandId)],
  );
}

/** Where the owner is in the setup wizard. */
export function useOnboarding() {
  const { can } = useTenant();
  return useStudioQuery<OnboardingProgress>(setupKeys.onboarding, '/v1/admin/onboarding', {
    enabled: can('brands.manage'),
  });
}

/** Whether any key of any provider is held by the server itself. */
export const hasServerKey = (status: ModelSetupStatus | undefined): boolean | undefined =>
  status ? Object.values(status.serverKeys).some(Boolean) : undefined;

// ── The main colour ───────────────────────────────────────────────────────────────────────────

/** The chat panel's own surface and text colour: what the main colour is checked against. */
const PANEL = { surface: '#FFFFFF', text: '#192A30' } as const;
const HEX = /^#[0-9a-f]{6}$/i;

export const isHexColour = (value: string) => HEX.test(value.trim());

/** The colour of text on the main colour: white or ink, whichever reads better. */
export const onColour = (colour: string) => bestOn(colour, ['#FFFFFF', PANEL.text]);

export type ColourProblem = 'text' | 'faint' | null;

export interface ColourCheck {
  /** The text colour the chat will use on it. */
  on: string;
  problem: ColourProblem;
  /** The closest colour that passes, a little darker, when this one does not. */
  suggestion: string | null;
}

/** Mixes a colour towards black by `amount` (0 to 1). */
function darker(colour: string, amount: number): string {
  const channel = (start: number) =>
    Math.round(Number.parseInt(colour.slice(start, start + 2), 16) * (1 - amount))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(1)}${channel(3)}${channel(5)}`.toUpperCase();
}

/** What the repo's own contrast check (the one the gateway runs on save) says about a colour. */
export function issuesOf(colour: string): ThemeIssue[] {
  return validateTheme({
    accent: colour,
    onAccent: onColour(colour),
    surface: PANEL.surface,
    text: PANEL.text,
  });
}

/**
 * Checks a main colour the way the gateway will: text on it must be readable and it must show on
 * a white page. For one that fails, the nearest passing colour is found by darkening it a step at
 * a time, so the owner keeps the hue.
 */
export function checkColour(colour: string): ColourCheck | null {
  if (!isHexColour(colour)) return null;
  const value = colour.trim().toUpperCase();
  const issue = issuesOf(value)[0];
  const on = onColour(value);
  if (!issue) return { on, problem: null, suggestion: null };
  let suggestion: string | null = null;
  for (let step = 1; step <= 40 && !suggestion; step += 1) {
    const candidate = darker(value, step * 0.025);
    if (issuesOf(candidate).length === 0) suggestion = candidate;
  }
  return { on, problem: issue.field === 'accent' ? 'faint' : 'text', suggestion };
}

// ── The test chat ─────────────────────────────────────────────────────────────────────────────

/**
 * The widget page for a brand, opened inside Studio as a test chat. It runs the real widget for
 * the real brand: `test=1` makes the gateway allow Studio's own page for it, give it a session of
 * its own and mark the conversations it starts as tests, so reports and counts leave them out.
 */
export function testChatUrl(
  widgetId: string,
  locale: string,
  /** Studio's own address, which the gateway allows to frame the chat for tests only. */
  host: string = window.location.origin,
): string {
  const query = new URLSearchParams({
    widgetId,
    host,
    api: GATEWAY_ORIGIN,
    mode: 'inline',
    locale,
    test: '1',
    instance: 'studio-test',
  });
  return `${WIDGET_ORIGIN}/?${query}`;
}
