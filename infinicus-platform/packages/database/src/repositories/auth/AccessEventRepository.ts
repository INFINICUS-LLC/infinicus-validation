import { withTransaction } from '../../client.js';

export type AccessEventType =
  | 'login' | 'logout' | 'failed_auth' | 'permission_denied'
  | 'sensitive_data_access' | 'api_key_usage' | 'session_revocation';

export interface AccessEvent {
  id: string;
  tenantId: string | null;
  userId: string | null;
  eventType: AccessEventType;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  occurredAt: Date;
}

function rowToAccessEvent(row: Record<string, unknown>): AccessEvent {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string | null,
    userId: row.user_id as string | null,
    eventType: row.event_type as AccessEventType,
    ipAddress: row.ip_address as string | null,
    userAgent: row.user_agent as string | null,
    metadata: row.metadata as Record<string, unknown>,
    occurredAt: row.occurred_at as Date,
  };
}

/**
 * audit.access_events has nullable tenant_id (failed_auth may occur before a
 * tenant is known) and no RLS enforced against app_test_user beyond the
 * standard tenant-isolation policy — writes here use the plain
 * withTransaction since a login attempt frequently predates tenant context.
 */
export class AccessEventRepository {
  async record(
    tenantId: string | null,
    userId: string | null,
    eventType: AccessEventType,
    ipAddress: string | null = null,
    userAgent: string | null = null,
    metadata: Record<string, unknown> = {}
  ): Promise<AccessEvent> {
    return withTransaction(async (client) => {
      // access_events_isolation only admits rows where tenant_id IS NULL or
      // tenant_id matches app.tenant_id — a non-null tenantId must be set
      // in-session before the insert or RLS rejects the write.
      if (tenantId) {
        await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
      }
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO audit.access_events (tenant_id, user_id, event_type, ip_address, user_agent, metadata)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [tenantId, userId, eventType, ipAddress, userAgent, JSON.stringify(metadata)]
      );
      return rowToAccessEvent(result.rows[0]);
    });
  }

  /** tenantId scopes visibility per RLS (pass the caller's known tenant to see its tenant-scoped events alongside tenant-less ones). */
  async listForUser(userId: string, tenantId: string | null = null, limit = 50): Promise<AccessEvent[]> {
    return withTransaction(async (client) => {
      if (tenantId) {
        await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
      }
      const result = await client.query<Record<string, unknown>>(
        'SELECT * FROM audit.access_events WHERE user_id = $1 ORDER BY occurred_at DESC LIMIT $2',
        [userId, limit]
      );
      return result.rows.map(rowToAccessEvent);
    });
  }

  /**
   * Counts this user's 'failed_auth' events with metadata.reason = 'bad_password'
   * since the given time — the login-lockout check's sole data source (no
   * separate failed-attempt counter column; this read-back keeps the account
   * lockout gate to a pure function of the audit trail that already exists).
   * Deliberately scoped to 'bad_password' only: 'unknown_email' failures carry
   * no userId (nothing to count against), and 'account_not_active'/
   * 'account_locked' failures are already-known-account states, not attackable
   * password guesses — counting them would let an attacker who trips lockout
   * once keep the account locked indefinitely just by continuing to hit it.
   */
  async countRecentFailedPasswordAttempts(userId: string, since: Date): Promise<number> {
    return withTransaction(async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit.access_events
         WHERE user_id = $1 AND event_type = 'failed_auth' AND metadata->>'reason' = 'bad_password' AND occurred_at > $2`,
        [userId, since]
      );
      return parseInt(result.rows[0].count, 10);
    });
  }
}
