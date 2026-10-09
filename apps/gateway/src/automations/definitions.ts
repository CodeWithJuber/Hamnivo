import { AutomationDefinition } from '@hamnivo/contracts';
import { schema, type TenantTx, toPublicId } from '@hamnivo/db';
import type { AutomationFacts } from '@hamnivo/domain/automations';
import { and, asc, eq, isNotNull } from 'drizzle-orm';

/** A rule that runs: its published definition, as of the version that was published. */
export interface PublishedAutomation {
  id: string;
  /** aut_… */
  publicId: string;
  brandId: string;
  name: string;
  versionId: string;
  version: number;
  definition: AutomationDefinition;
}

/** A stored definition, or null when it no longer parses (a rule that cannot run is skipped). */
export function storedDefinition(value: unknown): AutomationDefinition | null {
  const result = AutomationDefinition.safeParse(value);
  return result.success ? result.data : null;
}

/** The brand's rules of one kind that are on and published, oldest first (the brand's order). */
export async function publishedAutomations(
  tx: TenantTx,
  brandId: string,
  kind: 'visitor' | 'conversation',
): Promise<PublishedAutomation[]> {
  const a = schema.automations;
  const v = schema.automationVersions;
  const rows = await tx
    .select({
      id: a.id,
      brandId: a.brandId,
      name: v.name,
      versionId: v.id,
      version: v.version,
      definition: v.definition,
    })
    .from(a)
    .innerJoin(v, eq(v.id, a.publishedVersionId))
    .where(
      and(
        eq(a.brandId, brandId),
        eq(a.kind, kind),
        eq(a.enabled, true),
        isNotNull(a.publishedVersionId),
      ),
    )
    .orderBy(asc(a.createdAt), asc(a.id));
  return rows.flatMap((row) => {
    const definition = storedDefinition(row.definition);
    return definition ? [{ ...row, publicId: toPublicId('automation', row.id), definition }] : [];
  });
}

/** Whether any of these rules asks who is online (the only fact that costs a lookup). */
export const asksAnyoneOnline = (rules: readonly PublishedAutomation[]): boolean =>
  rules.some((rule) => rule.definition.conditions.some((c) => c.field === 'anyone_online'));

export type { AutomationFacts };
