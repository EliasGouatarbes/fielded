import { pool, ensureSchema } from './client';

export type SyncEntityType = 'customer' | 'order';
export type SyncStatus = 'success' | 'error';

export interface SyncLogEntry {
  entityType: SyncEntityType;
  shopifyId: string;
  hubspotId?: string;
  status: SyncStatus;
  errorMessage?: string;
}

// Best-effort: a broken logging call must never mask (or crash out) an
// otherwise-successful sync, so failures here are swallowed and reported to
// stderr rather than thrown.
export async function logSyncResult(entry: SyncLogEntry): Promise<void> {
  try {
    await ensureSchema();
    await pool.query(
      `INSERT INTO sync_log (entity_type, shopify_id, hubspot_id, status, error_message)
       VALUES ($1, $2, $3, $4, $5)`,
      [entry.entityType, entry.shopifyId, entry.hubspotId ?? null, entry.status, entry.errorMessage ?? null]
    );
  } catch (err) {
    console.error('Failed to write sync_log entry:', err);
  }
}

export interface SyncLogRow extends SyncLogEntry {
  id: number;
  createdAt: string;
}

export async function getRecentSyncLog(limit = 50): Promise<SyncLogRow[]> {
  await ensureSchema();
  const result = await pool.query<{
    id: number;
    entity_type: SyncEntityType;
    shopify_id: string;
    hubspot_id: string | null;
    status: SyncStatus;
    error_message: string | null;
    created_at: string;
  }>('SELECT * FROM sync_log ORDER BY created_at DESC LIMIT $1', [limit]);

  return result.rows.map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    shopifyId: row.shopify_id,
    hubspotId: row.hubspot_id ?? undefined,
    status: row.status,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
  }));
}
