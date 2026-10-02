import { type Db, resolveStaffMemberships, schema } from '@hamnivo/db';
import { eq } from 'drizzle-orm';

/**
 * Ends a person's sign-in sessions after they lost their access (A02). Access to the tenant
 * itself ends on their very next request whatever happens here: every request and every live
 * stream heartbeat loads the membership and grants again. Sessions are global to the person, so
 * they end only when no active membership is left anywhere; one workspace's removal never signs
 * someone out of another workspace. Call it after the change has committed.
 */
export async function endSessionsIfNoAccessLeft(db: Db, authUserId: string): Promise<number> {
  const memberships = await resolveStaffMemberships(db, authUserId);
  const stillActive = memberships.some(
    (m) => m.staffStatus === 'active' && m.tenantStatus === 'active',
  );
  if (stillActive) return 0;
  const ended = await db
    .delete(schema.authSession)
    .where(eq(schema.authSession.userId, authUserId))
    .returning({ id: schema.authSession.id });
  return ended.length;
}
