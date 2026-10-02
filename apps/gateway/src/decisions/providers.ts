import { createJevDecisionProvider, JEV_PROVIDER_ID } from '@hamnivo/adapters/jev';
import {
  createMockDecisionProvider,
  type DecisionAnswers,
  type DecisionProvider,
  type DecisionQuestions,
  type DecisionRequest,
  type DecisionResult,
  type RoutingIntent,
} from '@hamnivo/domain';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AppConfig } from '../config.js';
import { CONFIG } from '../tokens.js';

/** Test hook: the transport the Jev SDK uses (a fake Jev in integration tests). */
export const DECISION_FETCH = Symbol('DECISION_FETCH');

export const MOCK_MODEL_VERSION = 'decision-mock-1';

export interface RubricProviderSpec {
  provider: 'jev' | 'mock' | 'none';
  modelVersion: string | null;
  intents: readonly RoutingIntent[];
}

/** A provider that is named but cannot run: every decision is honestly `unavailable`. */
function notConfigured(id: string): DecisionProvider {
  return {
    id,
    async decide<const Q extends DecisionQuestions>(
      request: DecisionRequest<Q>,
    ): Promise<DecisionResult<DecisionAnswers<Q>>> {
      return {
        provider: id,
        task: request.task,
        rubricVersion: request.rubricVersion,
        latencyMs: 0,
        ...(request.language ? { language: request.language } : {}),
        status: 'unavailable',
        retryable: false,
        reason: 'auth',
      };
    },
  };
}

/**
 * Decision providers for rubrics (J01, J06). Jev providers are kept per pinned model, so their
 * circuit breaker remembers failures across decisions in this process. The deadline is set per
 * request from the rubric. Credentials are the platform's `JEV_API_KEY`; they never leave the
 * gateway and are never logged.
 */
@Injectable()
export class DecisionProviders {
  private readonly jev = new Map<string, DecisionProvider>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(DECISION_FETCH) private readonly fetchOverride?: typeof fetch | null,
  ) {}

  /** The provider a rubric names, or null for baseline-only rubrics. */
  forRubric(spec: RubricProviderSpec): DecisionProvider | null {
    switch (spec.provider) {
      case 'none':
        return null;
      case 'mock':
        return createMockDecisionProvider({
          modelVersion: spec.modelVersion ?? MOCK_MODEL_VERSION,
          rules: {
            intent: {
              type: 'choice',
              keywords: Object.fromEntries(spec.intents.map((i) => [i.key, i.keywords])),
            },
          },
        });
      case 'jev': {
        const model = spec.modelVersion ?? '';
        const apiKey = this.config.JEV_API_KEY ?? (this.fetchOverride ? 'test-key' : undefined);
        if (!apiKey || !model) return notConfigured(JEV_PROVIDER_ID);
        let provider = this.jev.get(model);
        if (!provider) {
          provider = createJevDecisionProvider({
            apiKey,
            model,
            ...(this.config.JEV_BASE_URL ? { baseURL: this.config.JEV_BASE_URL } : {}),
            ...(this.fetchOverride ? { fetch: this.fetchOverride } : {}),
          });
          this.jev.set(model, provider);
        }
        return provider;
      }
    }
  }
}
