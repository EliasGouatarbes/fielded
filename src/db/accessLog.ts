import { pool, ensureSchema } from './client';

export type AccessAuthType = 'admin' | 'merchant';

export interface AccessLogEntry {
  route: string;
  method: string;
  authType: AccessAuthType;
  shopDomain?: string;
  ip?: string;
}

// Best-effort, matching logSyncResult's own convention (src/db/syncLog.ts):
// a broken logging call must never fail the request it's logging access for.
export async function logAccess(entry: AccessLogEntry): Promise<void> {
  try {
    await ensureSchema();
    await pool.query(
      `INSERT INTO access_log (route, method, auth_type, shop_domain, ip)
       VALUES ($1, $2, $3, $4, $5)`,
      [entry.route, entry.method, entry.authType, entry.shopDomain ?? null, entry.ip ?? null]
    );
  } catch (err) {
    console.error('Failed to write access_log entry:', err);
  }
}

export interface AccessLogRow extends AccessLogEntry {
  id: number;
  createdAt: string;
}

// shopDomain filters to one merchant's own entries (a merchant-scoped key
// should only ever see rows it caused, same restriction as getRecentSyncLog).
export async function getRecentAccessLog(limit = 50, shopDomain?: string): Promise<AccessLogRow[]> {
  await ensureSchema();
  const result = await pool.query<{
    id: number;
    route: string;
    method: string;
    auth_type: AccessAuthType;
    shop_domain: string | null;
    ip: string | null;
    created_at: string;
  }>(
    shopDomain
      ? 'SELECT * FROM access_log WHERE shop_domain = $2 ORDER BY created_at DESC LIMIT $1'
      : 'SELECT * FROM access_log ORDER BY created_at DESC LIMIT $1',
    shopDomain ? [limit, shopDomain] : [limit]
  );

  return result.rows.map((row) => ({
    id: row.id,
    route: row.route,
    method: row.method,
    authType: row.auth_type,
    shopDomain: row.shop_domain ?? undefined,
    ip: row.ip ?? undefined,
    createdAt: row.created_at,
  }));
}

// Shopify's mandatory `shop/redact` GDPR webhook — same treatment as
// deleteSyncLogForShop, no exceptions for audit-trail purposes.
export async function deleteAccessLogForShop(shopDomain: string): Promise<void> {
  await ensureSchema();
  await pool.query('DELETE FROM access_log WHERE shop_domain = $1', [shopDomain]);
}

// Same retention rationale as deleteOldSyncLog (src/db/syncLog.ts): this
// table accumulates IPs and shop domains with no other expiry path.
export async function deleteOldAccessLog(retentionDays: number): Promise<number> {
  await ensureSchema();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await pool.query('DELETE FROM access_log WHERE created_at < $1', [cutoff]);
  return result.rowCount ?? 0;
}

// DLP building block: a crude but real "is someone pulling an unusual
// amount of customer/order data" signal, queried from the audit trail
// itself rather than tracked in-process (in-memory counters reset on every
// deploy/restart and aren't visible remotely — this app already has that
// exact lesson from broken-HubSpot-connection detection, 10f). No
// email/Slack notification channel exists for this app (same 10f
// precedent) — this is surfaced through GET /access-log's existing
// operator-wide response instead of a new alert, and logged loudly at
// startup-interval so it's at least in Render's own log stream.
//
// Thresholds are deliberately generous, not tuned per deployment: this
// app's dashboard has no auto-polling (src/dashboardPage.ts — manual
// refresh only), so legitimate use is a handful of requests per visit.
// ADMIN_ANOMALY_THRESHOLD covers the single global operator key (there's
// only one, so "who" doesn't matter, only volume); PER_SHOP_ANOMALY_THRESHOLD
// covers a single merchant's own key being used far more than a merchant
// checking their own dashboard ever would.
const ANOMALY_WINDOW_MINUTES = 60;
const ADMIN_ANOMALY_THRESHOLD = 30;
const PER_SHOP_ANOMALY_THRESHOLD = 15;

export interface AccessVolumeAnomalies {
  adminAccessCount: number;
  shopsOverThreshold: Array<{ shopDomain: string; count: number }>;
}

export async function getAccessVolumeAnomalies(): Promise<AccessVolumeAnomalies> {
  await ensureSchema();
  const cutoff = new Date(Date.now() - ANOMALY_WINDOW_MINUTES * 60 * 1000);

  const adminResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM access_log WHERE auth_type = 'admin' AND created_at > $1`,
    [cutoff]
  );

  const shopResult = await pool.query<{ shop_domain: string; count: string }>(
    `SELECT shop_domain, COUNT(*) AS count FROM access_log
     WHERE auth_type = 'merchant' AND shop_domain IS NOT NULL AND created_at > $1
     GROUP BY shop_domain
     HAVING COUNT(*) > $2`,
    [cutoff, PER_SHOP_ANOMALY_THRESHOLD]
  );

  return {
    adminAccessCount: Number(adminResult.rows[0]?.count ?? 0),
    shopsOverThreshold: shopResult.rows.map((row) => ({ shopDomain: row.shop_domain, count: Number(row.count) })),
  };
}

export function isAdminAccessAnomalous(count: number): boolean {
  return count > ADMIN_ANOMALY_THRESHOLD;
}
