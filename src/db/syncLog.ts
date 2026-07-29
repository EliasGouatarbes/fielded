import { pool, ensureSchema } from './client';

export type SyncEntityType = 'customer' | 'order';
// 'skipped' (12d, functional audit): a legitimate, expected non-sync — e.g.
// a customer with no email — distinct from 'error' (something went wrong)
// so it doesn't read as a failure in the dashboard's activity feed.
// 'deleted' (12g, functional audit): the Shopify order/customer itself was
// deleted — logged for visibility, but (deliberately, matching the
// customers/redact GDPR handler's own precedent) never means the
// corresponding HubSpot Deal/Contact was touched.
export type SyncStatus = 'success' | 'error' | 'skipped' | 'deleted';

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

// Shopify's mandatory `shop/redact` GDPR webhook — deletes every log entry
// for a shop, no exceptions (an audit trail isn't a valid reason to retain
// data after a redact request).
export async function deleteSyncLogForShop(shopDomain: string): Promise<void> {
  await ensureSchema();
  await pool.query('DELETE FROM sync_log WHERE shop_domain = $1', [shopDomain]);
}

// Shopify's mandatory `customers/redact` GDPR webhook — deletes only the
// customer-entity rows for this email (order-entity rows are keyed by
// Shopify's order *name*, e.g. "#1001", not the numeric order id Shopify's
// redact payload provides in `orders_to_redact`, so those can't be reliably
// correlated to this customer without also storing the numeric id; noted
// as a known gap rather than silently doing nothing).
export async function deleteSyncLogForCustomer(shopDomain: string, email: string): Promise<void> {
  await ensureSchema();
  await pool.query(
    `DELETE FROM sync_log WHERE shop_domain = $1 AND entity_type = 'customer' AND shopify_id = $2`,
    [shopDomain, email]
  );
}
