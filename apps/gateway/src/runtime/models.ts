import { createLanguageModel, ModelConfigError } from '@hamnivo/adapters/models';
import type { ModelChoice, ModelProviderKind } from '@hamnivo/contracts';
import { type Db, fromPublicId, schema, type TenantTx, withTenant } from '@hamnivo/db';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { LanguageModel } from 'ai';
import { eq } from 'drizzle-orm';
import type { AppConfig } from '../config.js';
import { SecretBroker } from '../secrets/secret-broker.service.js';
import { APP_DB, CONFIG } from '../tokens.js';

/** Test hook: when provided, every model choice resolves to this model. */
export const LANGUAGE_MODEL = Symbol('LANGUAGE_MODEL');

export interface ModelSpec {
  provider: ModelProviderKind;
  modelId: string;
  apiKey?: string;
  baseURL?: string;
}

export interface ResolvedModel {
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
 * time and never logged.
 */
@Injectable()
export class ModelFactory {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly secrets: SecretBroker,
    @Optional() @Inject(LANGUAGE_MODEL) private readonly override?: LanguageModel,
  ) {}

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
    const base = { provider: choice.provider, modelId: choice.modelId };
    if (this.override) return { ...base, model: this.override };
    let credentials: { apiKey?: string; baseURL?: string } | null;
    if (choice.connectionId) {
      credentials = await withTenant(this.db, { tenantId, actorId: 'ai' }, async (tx) => {
        const row = await this.connection(tx, choice);
        return {
          apiKey: await this.secrets.reveal(tx, tenantId, row.apiKeySecretId),
          ...(row.baseUrl ? { baseURL: row.baseUrl } : {}),
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
}
