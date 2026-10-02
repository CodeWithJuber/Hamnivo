import type { HelpArticle, HelpSearchResponse } from '@hamnivo/contracts';
import { type Db, toPublicId, withTenant } from '@hamnivo/db';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppError } from '../common/app-error.js';
import { RetrievalService } from '../knowledge/retrieval.service.js';
import { APP_DB, REDIS } from '../tokens.js';
import { brandSurface } from './settings.service.js';
import type { WidgetClaims } from './tokens.service.js';

/** Searches one widget session may run per minute (each one embeds the query). */
const SEARCHES_PER_MINUTE = 20;
const RESULTS = 5;

/** A passage cut at a word boundary, at most `max` characters. */
export function excerptOf(text: string, max = 600): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Help before a conversation (W17): the brand's own knowledge, searched with the same retrieval
 * the assistant uses and the same rule for customers (public sources only, current and reviewed
 * versions). The answer is the source itself, never generated text.
 */
@Injectable()
export class WidgetHelpService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly retrieval: RetrievalService,
  ) {}

  private async allow(claims: WidgetClaims): Promise<void> {
    const key = `hamnivo:help:${claims.sessionId}`;
    try {
      const used = await this.redis.incr(key);
      if (used === 1) await this.redis.expire(key, 60);
      if (used > SEARCHES_PER_MINUTE) {
        throw new AppError('RATE_LIMITED', {
          detail: 'Too many searches. Please wait a moment.',
          retryAfter: 30,
        });
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Without Valkey the global rate limit still applies.
    }
  }

  async search(claims: WidgetClaims, query: string): Promise<HelpSearchResponse> {
    await this.allow(claims);
    return withTenant(this.db, { tenantId: claims.tenantId }, async (tx) => {
      const { settings } = await brandSurface(tx, claims.brandId);
      if (!settings.help.search) {
        throw new AppError('FEATURE_DISABLED', { detail: 'Help search is turned off.' });
      }
      const passages = await this.retrieval.search(tx, {
        brandId: claims.brandId,
        audience: 'customer',
        query,
        limit: RESULTS * 3,
      });
      // The best passage of each document.
      const seen = new Set<string>();
      const items: HelpArticle[] = [];
      for (const passage of passages) {
        if (seen.has(passage.documentId)) continue;
        seen.add(passage.documentId);
        items.push({
          id: toPublicId('document', passage.documentId),
          title: passage.title.slice(0, 300),
          heading: passage.heading?.slice(0, 300) ?? null,
          excerpt: excerptOf(passage.text),
          url: passage.url,
          version: passage.version,
        });
        if (items.length === RESULTS) break;
      }
      return { query, items };
    });
  }
}
