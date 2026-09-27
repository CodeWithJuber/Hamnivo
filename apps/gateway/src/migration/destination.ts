import { ChatwootError, ChatwootImporter } from '@hamnivo/chatwoot';
import type { PreflightCheck } from '@hamnivo/contracts';
import { schema, type TenantTx } from '@hamnivo/db';
import { type OpenedSource, readExport, type SourceSystem } from '@hamnivo/migration-sdk';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { ConnectionRuntime } from '../authority/registry.js';
import type { AppConfig } from '../config.js';

type Check = z.infer<typeof PreflightCheck>;

/** The brand's Chatwoot connection (the one its live inbox belongs to). */
export async function brandConnectionId(tx: TenantTx, brandId: string): Promise<string | null> {
  const [inbox] = await tx
    .select({ connectionId: schema.authorityInboxes.connectionId })
    .from(schema.authorityInboxes)
    .where(
      and(
        eq(schema.authorityInboxes.brandId, brandId),
        eq(schema.authorityInboxes.purpose, 'live'),
      ),
    )
    .limit(1);
  return inbox?.connectionId ?? null;
}

/** The brand's import inbox, if one was created. */
export async function importInboxOf(
  tx: TenantTx,
  connectionId: string,
  brandId: string,
): Promise<typeof schema.authorityInboxes.$inferSelect | null> {
  const [inbox] = await tx
    .select()
    .from(schema.authorityInboxes)
    .where(
      and(
        eq(schema.authorityInboxes.connectionId, connectionId),
        eq(schema.authorityInboxes.brandId, brandId),
        eq(schema.authorityInboxes.purpose, 'import'),
        eq(schema.authorityInboxes.status, 'active'),
      ),
    )
    .limit(1);
  return inbox ?? null;
}

export function importerFor(runtime: ConnectionRuntime, config: AppConfig): ChatwootImporter {
  return new ChatwootImporter({
    baseUrl: runtime.baseUrl,
    accountId: runtime.accountId,
    token: runtime.integrationToken,
    timeoutMs: config.CHATWOOT_TIMEOUT_MS,
  });
}

/**
 * Readiness of the destination (M01): the import inbox must stay quiet (no webhook, bot,
 * auto-assignment, greeting or survey), and no automation or integration may act on imported
 * conversations. Reads only; nothing is created here.
 */
export async function destinationChecks(
  importer: ChatwootImporter,
  importInbox: { externalInboxId: number } | null,
): Promise<Check[]> {
  const checks: Check[] = [{ code: 'authority_connected', status: 'ok' }];
  const inboxId = importInbox?.externalInboxId ?? null;
  try {
    if (inboxId === null) {
      checks.push({ code: 'import_inbox', status: 'ok', detail: 'will_create' });
    } else {
      const settings = await importer.inspectInbox(inboxId);
      const noisy = [
        settings.webhookUrl ? 'webhook' : null,
        settings.agentBot ? 'agent_bot' : null,
        settings.autoAssignment ? 'auto_assignment' : null,
        settings.greeting ? 'greeting' : null,
        settings.csat ? 'csat' : null,
        settings.workingHours ? 'working_hours' : null,
        settings.lockToSingleConversation ? 'single_conversation' : null,
      ].filter((v): v is string => v !== null);
      checks.push(
        noisy.length === 0
          ? { code: 'import_inbox', status: 'ok' }
          : { code: 'import_inbox', status: 'blocked', detail: noisy.join(',') },
      );
    }
    const rules = await importer.listAutomationRules();
    checks.push({ code: 'authority_admin', status: 'ok' });
    const acting = rules.filter(
      (rule) =>
        rule.active &&
        (rule.inboxIds === null
          ? inboxId === null || !rule.excludedInboxIds.includes(inboxId)
          : inboxId !== null && rule.inboxIds.includes(inboxId)),
    );
    checks.push(
      acting.length === 0
        ? { code: 'automations', status: 'ok' }
        : { code: 'automations', status: 'blocked', detail: String(acting.length) },
    );
    const hooks = (await importer.listIntegrationHooks()).filter(
      (hook) => hook.enabled && (hook.inboxId === null || hook.inboxId === inboxId),
    );
    checks.push(
      hooks.length === 0
        ? { code: 'integrations', status: 'ok' }
        : {
            code: 'integrations',
            status: 'blocked',
            detail: [...new Set(hooks.map((h) => h.app))].join(','),
          },
    );
  } catch (error) {
    const denied = error instanceof ChatwootError && (error.status === 401 || error.status === 403);
    checks.push({
      code: denied ? 'authority_admin' : 'authority_unreachable',
      status: 'blocked',
      ...(error instanceof ChatwootError ? { detail: `HTTP ${error.status}` } : {}),
    });
  }
  return checks;
}

/** How a job's stored export is read: an API source is stored as a Hamnivo package. */
export function uploadFormat(job: { sourceKind: string; sourceSystem: string }): SourceSystem {
  return (job.sourceKind === 'api' ? 'hamnivo' : job.sourceSystem) as SourceSystem;
}

const parsed = new Map<string, OpenedSource>();

/** Reads an uploaded export, keeping the last few parses in memory (a job reads it per pass). */
export function readUpload(
  file: { id: string; name: string; sha256: Buffer },
  raw: Uint8Array,
  system: SourceSystem,
): OpenedSource {
  const key = `${file.id}:${file.sha256.toString('hex')}`;
  const cached = parsed.get(key);
  if (cached) return cached;
  const opened = readExport(raw, file.name, system);
  parsed.set(key, opened);
  while (parsed.size > 4) parsed.delete(parsed.keys().next().value as string);
  return opened;
}
