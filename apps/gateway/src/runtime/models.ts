import type { LanguageModelV4 } from '@ai-sdk/provider';
import { createLanguageModel, ModelConfigError } from '@hamnivo/adapters/models';
import { guardedFetch } from '@hamnivo/adapters/net';
import { type ModelChoice, type ModelProviderKind, recommendedModel } from '@hamnivo/contracts';
import { type Db, fromPublicId, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { LanguageModel } from 'ai';
import { and, desc, eq } from 'drizzle-orm';
import { meteredModel } from '../billing/ai-credits.model.js';
import {
  type AiAttemptSpec,
  AiCreditsService,
  type AiSource,
} from '../billing/ai-credits.service.js';
import type { AppConfig } from '../config.js';
import { EgressService } from '../developer/egress.service.js';
import { SecretBroker } from '../secrets/secret-broker.service.js';
import { APP_DB, CONFIG } from '../tokens.js';

/** Test hook: when provided, every model choice resolves to this model. */
export const LANGUAGE_MODEL = Symbol('LANGUAGE_MODEL');

export interface ModelSpec {
  provider: ModelProviderKind;
  modelId: string;
  apiKey?: string;
  baseURL?: string;
  /** How the model is reached, for a server the tenant named (the egress guard). */
  fetch?: typeof globalThis.fetch;
}

export interface ResolvedModel {
  source: AiSource;
  connectionId?: string;
  model: LanguageModel;
  provider: ModelProviderKind;
  modelId: string;
}

/** A model choice that cannot run: missing or disabled credentials, a disallowed model. */
export class ModelUnavailableError extends Error {
  constructor(
    readonly reason:
      | 'no_credentials'
      | 'connection_disabled'
      | 'provider_mismatch'
      | 'model_not_allowed'
      | 'provider_not_supported',
    message: string,
  ) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}

function languageModelFor(spec: ModelSpec): LanguageModel {
  try {
    return createLanguageModel(spec);
  } catch (error) {
    if (error instanceof ModelConfigError) {
      throw new ModelUnavailableError('no_credentials', error.message);
    }
    throw error;
  }
}

/**
 * Turns an agent's model choice into a language model. Tenant connections supply their own
 * encrypted key; otherwise the platform key for that provider is used. Keys are revealed just in
 * time and never logged. A tenant connection with a server address of its own (a base URL) is
 * called through the egress guard, never straight: the address is the tenant's input. The
 * platform's own addresses (the administrator's settings) are not.
 */
@Injectable()
export class ModelFactory {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly secrets: SecretBroker,
    private readonly egress: EgressService,
    private readonly credits: AiCreditsService,
    @Optional() @Inject(LANGUAGE_MODEL) private readonly override?: LanguageModel,
  ) {}

  /**
   * The offline test model may not answer customers here: production, unless ALLOW_MOCK_MODEL is
   * set. It answers every question with the same fixed text.
   */
  testModelBarred(choice: Pick<ModelChoice, 'provider'>): boolean {
    if (choice.provider !== 'mock') return false;
    return !(this.config.ALLOW_MOCK_MODEL ?? this.config.NODE_ENV !== 'production');
  }

  /** The platform's own model, when the server has a key: the first of Anthropic, OpenAI, Google. */
  platformChoice(): ModelChoice | null {
    for (const provider of ['anthropic', 'openai', 'google'] as const) {
      const modelId = recommendedModel(provider);
      if (this.platform(provider) && modelId) return { provider, modelId };
    }
    return null;
  }

  /**
   * A real model to answer customers with: the workspace's own key (the one named, or its newest
   * active one), else the platform's. Null when there is none, or a key whose model cannot be
   * told (an OpenAI-compatible server with no model listed).
   */
  async liveChoice(tx: TenantTx, connectionId?: string): Promise<ModelChoice | null> {
    const rows = await tx
      .select()
      .from(schema.modelConnections)
      .where(
        and(
          eq(schema.modelConnections.status, 'active'),
          ...(connectionId
            ? [eq(schema.modelConnections.id, fromPublicId('modelConnection', connectionId))]
            : []),
        ),
      )
      .orderBy(desc(schema.modelConnections.createdAt));
    for (const row of rows) {
      const modelId = row.allowedModels[0] ?? recommendedModel(row.provider);
      if (modelId) {
        return {
          provider: row.provider,
          modelId,
          connectionId: toPublicId('modelConnection', row.id),
        };
      }
    }
    return connectionId ? null : this.platformChoice();
  }

  private platform(provider: ModelProviderKind): { apiKey?: string; baseURL?: string } | null {
    const c = this.config;
    switch (provider) {
      case 'anthropic':
        return c.ANTHROPIC_API_KEY ? { apiKey: c.ANTHROPIC_API_KEY } : null;
      case 'openai':
        return c.OPENAI_API_KEY ? { apiKey: c.OPENAI_API_KEY } : null;
      case 'google':
        return c.GOOGLE_GENERATIVE_AI_API_KEY ? { apiKey: c.GOOGLE_GENERATIVE_AI_API_KEY } : null;
      case 'openai-compatible':
        return c.OPENAI_COMPATIBLE_BASE_URL
          ? {
              baseURL: c.OPENAI_COMPATIBLE_BASE_URL,
              ...(c.OPENAI_COMPATIBLE_API_KEY ? { apiKey: c.OPENAI_COMPATIBLE_API_KEY } : {}),
            }
          : null;
      case 'mock':
        return {};
    }
  }

  private async connection(tx: TenantTx, choice: ModelChoice) {
    const [row] = await tx
      .select()
      .from(schema.modelConnections)
      .where(
        eq(schema.modelConnections.id, fromPublicId('modelConnection', choice.connectionId ?? '')),
      );
    if (row?.status !== 'active') {
      throw new ModelUnavailableError(
        'connection_disabled',
        'The model connection is missing or disabled.',
      );
    }
    if (row.provider !== choice.provider) {
      throw new ModelUnavailableError(
        'provider_mismatch',
        `The connection is for ${row.provider}, not ${choice.provider}.`,
      );
    }
    if (row.allowedModels.length > 0 && !row.allowedModels.includes(choice.modelId)) {
      throw new ModelUnavailableError(
        'model_not_allowed',
        `${choice.modelId} is not allowed on this connection.`,
      );
    }
    return row;
  }

  /** Throws ModelUnavailableError when the choice cannot run (checked before publishing). */
  async check(tx: TenantTx, choice: ModelChoice): Promise<void> {
    let credentials: { apiKey?: string; baseURL?: string } | null;
    if (choice.connectionId) {
      const row = await this.connection(tx, choice);
      // The key itself stays sealed; a placeholder is enough to build the model.
      credentials = { apiKey: 'unrevealed', ...(row.baseUrl ? { baseURL: row.baseUrl } : {}) };
    } else {
      credentials = this.platform(choice.provider);
    }
    if (!credentials) {
      throw new ModelUnavailableError(
        'no_credentials',
        `No ${choice.provider} key is configured. Add a model connection first.`,
      );
    }
    languageModelFor({ provider: choice.provider, modelId: choice.modelId, ...credentials });
  }

  async resolve(tenantId: string, choice: ModelChoice): Promise<ResolvedModel> {
    const base = {
      provider: choice.provider,
      modelId: choice.modelId,
      source: (choice.connectionId ? 'byok' : 'managed') as AiSource,
      ...(choice.connectionId ? { connectionId: choice.connectionId } : {}),
    };
    if (this.override) return { ...base, model: this.override };
    let credentials: Omit<ModelSpec, 'provider' | 'modelId'> | null;
    if (choice.connectionId) {
      credentials = await withTenant(this.db, { tenantId, actorId: 'ai' }, async (tx) => {
        const row = await this.connection(tx, choice);
        return {
          apiKey: await this.secrets.reveal(tx, tenantId, row.apiKeySecretId),
          ...(row.baseUrl
            ? {
                baseURL: row.baseUrl,
                // The address is the tenant's: public HTTPS (or a trusted origin), the workspace's
                // allowed hosts, checked again for every connection, no redirects.
                fetch: guardedFetch(await this.egress.policyIn(tx), { refuseRedirects: true }),
              }
            : {}),
        };
      });
    } else {
      credentials = this.platform(choice.provider);
    }
    if (!credentials) {
      throw new ModelUnavailableError(
        'no_credentials',
        `No ${choice.provider} key is configured for this agent.`,
      );
    }
    return { ...base, model: languageModelFor({ ...base, ...credentials }) };
  }

  /** A configured tenant connection always means BYOK; failure never selects platform credentials. */
  async executeAttempt<T>(
    tenantId: string,
    choice: ModelChoice,
    attempt: Pick<AiAttemptSpec, 'key' | 'reserveTokens' | 'timeoutMs' | 'attribution'>,
    operation: (resolved: ResolvedModel) => Promise<T>,
  ): Promise<T> {
    const resolved = await this.resolve(tenantId, choice);
    if (typeof resolved.model !== 'object' || resolved.model.specificationVersion !== 'v4') {
      throw new Error('Metered AI requires a version 4 language model.');
    }
    const model = meteredModel(resolved.model as LanguageModelV4, this.credits, {
      ...attempt,
      tenantId,
      provider: resolved.provider,
      modelId: resolved.modelId,
      source: resolved.source,
      ...(resolved.connectionId ? { connectionId: resolved.connectionId } : {}),
    });
    return operation({ ...resolved, model });
  }
}
