import { schema, type TenantTx } from '@hamnivo/db';
import type { AuthorityMessage } from '@hamnivo/domain';
import { and, eq, inArray } from 'drizzle-orm';

/**
 * How customers see a teammate: the first name they chose, or the first word of their name, and
 * their photo when they set one (Inbox, Alerts, "How customers see you"). The home screen and their
 * replies in the chat use the same rule, so a full name or an email never reaches a customer.
 */
export interface StaffFace {
  name: string;
  photoUrl: string | null;
}

/** The name customers see: the one chosen, or the first word of the display name. */
export function shownName(row: { displayName: string; publicName: string | null }): string {
  const chosen = row.publicName?.trim();
  if (chosen) return chosen.slice(0, 40);
  return firstName(row.displayName);
}

/** The first word of a name; "Team" when there is none. */
export function firstName(name: string): string {
  return (name.trim().split(/\s+/)[0] ?? '').slice(0, 40) || 'Team';
}

/**
 * The teammates who wrote these messages, keyed by the authority's user reference. A Chatwoot user
 * Hamnivo created is linked to its staff member for this connection; a link revoked since still
 * names who wrote the reply. Users without a link are left out (the caller falls back to the
 * first word of the name the authority sent).
 */
export async function staffFaces(
  tx: TenantTx,
  connectionId: string,
  messages: readonly AuthorityMessage[],
): Promise<Map<string, StaffFace>> {
  const refs = new Set<number>();
  for (const message of messages) {
    if (message.sender.kind !== 'user') continue;
    const ref = Number(message.sender.ref);
    if (Number.isSafeInteger(ref)) refs.add(ref);
  }
  const faces = new Map<string, StaffFace>();
  if (refs.size === 0) return faces;
  const l = schema.staffAuthorityLinks;
  const sm = schema.staffMembers;
  const rows = await tx
    .select({
      externalUserId: l.externalUserId,
      displayName: sm.displayName,
      publicName: sm.publicName,
      photoUrl: sm.photoUrl,
    })
    .from(l)
    .innerJoin(sm, and(eq(sm.tenantId, l.tenantId), eq(sm.id, l.staffMemberId)))
    .where(and(eq(l.connectionId, connectionId), inArray(l.externalUserId, [...refs])));
  for (const row of rows) {
    faces.set(String(row.externalUserId), { name: shownName(row), photoUrl: row.photoUrl });
  }
  return faces;
}
