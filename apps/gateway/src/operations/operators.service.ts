import { type Db, schema } from '@hamnivo/db';
import { isPlatformRole } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { AuthSession } from '../identity/auth.factory.js';
import type { OperatorContext } from '../identity/request-auth.js';
import { PLATFORM_DB } from '../tokens.js';

/**
 * Platform operators (A17), read through the hamnivo_platform database role on every request, so
 * a disabled operator loses the console at once. Without DATABASE_PLATFORM_URL there is no
 * platform console at all.
 */
@Injectable()
export class OperatorsService {
  constructor(@Inject(PLATFORM_DB) private readonly platform: Db | null) {}

  get enabled(): boolean {
    return this.platform !== null;
  }

  async operator(session: AuthSession): Promise<OperatorContext | null> {
    if (!this.platform) return null;
    const [row] = await this.platform
      .select()
      .from(schema.platformOperators)
      .where(eq(schema.platformOperators.authUserId, session.user.id));
    if (row?.status !== 'active' || !isPlatformRole(row.role)) return null;
    return {
      principal: {
        kind: 'platform',
        operatorId: row.id,
        role: row.role,
        status: row.status,
        mfa: Boolean((session.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled),
        authenticatedAt: new Date(session.session.createdAt),
      },
      name: row.displayName,
      email: row.email,
    };
  }
}
