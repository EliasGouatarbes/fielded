import { pool, ensureSchema } from './client';

export type SyncEntityType = 'customer' | 'order';
export type SyncStatus = 'success' | 'error';

export interface SyncLogEntry {
  entityType: SyncEntityType;
  shopifyId: string;
  hubspotId?: string;
  status: SyncStatus;
  errorMessage?: string;
  // Which merchant this entry belongs to (multi-merchant step) — optional
  // because a handful of failure paths in webhooks.ts log before a merchant
  // can be resolved at all (e.g. an unrecognized shop domain).
  shopDomain?: string;
}

// Best-effort: a broken logging call must never mask (or crash out) an
// otherwise-successful sync, so failures here are swallowed and reported to
// stderr rather than thrown.
export async function logSyncResult(entry: SyncLogEntry): Promise<void> {
  try {
    await ensureSchema();
    await pool.query(
      `INSERT INTO sync_log (entity_type, shopify_id, hubspot_id, status, error_message, shop_domain)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.entityType,
        entry.shopifyId,
        entry.hubspotId ?? null,
        entry.status,
        entry.errorMessage ?? null,
        entry.shopDomain ?? null,
      ]
    );
  } catch (err) {
    console.error('Failed to write sync_log entry:', err);
  }
}

export interface SyncLogRow extends SyncLogEntry {
  id: number;
  createdAt: string;
}

// `shopDomain` filters to one merchant's own entries (used by the
// per-merchant /sync-status auth path); omitted for the global operator key,
// which sees entries across every merchant.
export async function getRecentSyncLog(limit = 50, shopDomain?: string): Promise<SyncLogRow[]> {
  await ensureSchema();
  const result = await pool.query<{
    id: number;
    entity_type: SyncEntityType;
    shopify_id: string;
    hubspot_id: string | null;
    status: SyncStatus;
    error_message: string | null;
    shop_domain: string | null;
    created_at: string;
  }>(
    shopDomain
      ? 'SELECT * FROM sync_log WHERE shop_domain = $2 ORDER BY created_at DESC LIMIT $1'
      : 'SELECT * FROM sync_log ORDER BY created_at DESC LIMIT $1',
    shopDomain ? [limit, shopDomain] : [limit]
  );

  return result.rows.map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    shopifyId: row.shopify_id,
    hubspotId: row.hubspot_id ?? undefined,
    status: row.status,
    errorMessage: row.error_message ?? undefined,
    shopDomain: row.shop_domain ?? undefined,
    createdAt: row.created_at,
  }));
}
