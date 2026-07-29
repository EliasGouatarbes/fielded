import { pool, ensureSchema } from './client';
import { DealRule } from '../hubspot/dealRules';
import { config } from '../config';
import { encrypt, decrypt } from '../crypto';

// Tracks one historical-backfill run so a merchant (via the dashboard) can
// see it actually finished, rather than the onboarding page's static "⏳
// running" that never updates. `startedAt` carries through unchanged from
// the 'running' write to whichever terminal write follows it, so the
// dashboard can show how long it took.
export interface BackfillStatus {
  status: 'running' | 'complete' | 'failed';
  startedAt: string;
  completedAt?: string;
  customerCount?: number;
  orderCount?: number;
  error?: string;
}

export interface Merchant {
  shopDomain: string;
  shopifyAccessToken: string;
  hubspotPortalId: string | null;
  hubspotAccessToken: string | null;
  hubspotRefreshToken: string | null;
  hubspotTokenExpiresAt: Date | null;
  hubspotConnectionBrokenAt: Date | null;
  dealPipeline: string;
  dealStage: string;
  dealRules: DealRule[];
  adminApiKeyHash: string | null;
  backfillStatus: BackfillStatus | null;
}

interface MerchantRow {
  shop_domain: string;
  shopify_access_token: string;
  hubspot_portal_id: string | null;
  hubspot_access_token: string | null;
  hubspot_refresh_token: string | null;
  hubspot_token_expires_at: Date | null;
  hubspot_connection_broken_at: Date | null;
  deal_pipeline: string;
  deal_stage: string;
  deal_rules: DealRule[];
  admin_api_key_hash: string | null;
  backfill_status: BackfillStatus | null;
}

function toMerchant(row: MerchantRow): Merchant {
  return {
    shopDomain: row.shop_domain,
    shopifyAccessToken: decrypt(row.shopify_access_token, config.encryptionKey),
    hubspotPortalId: row.hubspot_portal_id,
    hubspotAccessToken: row.hubspot_access_token ? decrypt(row.hubspot_access_token, config.encryptionKey) : null,
    hubspotRefreshToken: row.hubspot_refresh_token ? decrypt(row.hubspot_refresh_token, config.encryptionKey) : null,
    hubspotTokenExpiresAt: row.hubspot_token_expires_at,
    hubspotConnectionBrokenAt: row.hubspot_connection_broken_at,
    dealPipeline: row.deal_pipeline,
    dealStage: row.deal_stage,
    dealRules: row.deal_rules,
    adminApiKeyHash: row.admin_api_key_hash,
    backfillStatus: row.backfill_status,
  };
}

export async function getMerchant(shopDomain: string): Promise<Merchant | null> {
  await ensureSchema();
  const result = await pool.query<MerchantRow>('SELECT * FROM merchants WHERE shop_domain = $1', [shopDomain]);
  const row = result.rows[0];
  return row ? toMerchant(row) : null;
}

// Shopify half of onboarding (existing OAuth handshake, unchanged logic —
// only the destination table/column names changed).
export async function saveShopifyToken(shopDomain: string, accessToken: string): Promise<void> {
  await ensureSchema();
  await pool.query(
    `INSERT INTO merchants (shop_domain, shopify_access_token, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (shop_domain) DO UPDATE SET shopify_access_token = EXCLUDED.shopify_access_token, updated_at = now()`,
    [shopDomain, encrypt(accessToken, config.encryptionKey)]
  );
}

// HubSpot half of onboarding — requires the Shopify row to already exist
// (the merchant must have installed via Shopify first; /auth/hubspot
// enforces this before redirecting).
export async function saveHubSpotConnection(
  shopDomain: string,
  params: { accessToken: string; refreshToken: string; expiresAt: Date; portalId: string }
): Promise<void> {
  await ensureSchema();
  await pool.query(
    `UPDATE merchants
     SET hubspot_access_token = $2,
         hubspot_refresh_token = $3,
         hubspot_token_expires_at = $4,
         hubspot_portal_id = $5,
         hubspot_connected_at = now(),
         hubspot_connection_broken_at = NULL,
         updated_at = now()
     WHERE shop_domain = $1`,
    [
      shopDomain,
      encrypt(params.accessToken, config.encryptionKey),
      encrypt(params.refreshToken, config.encryptionKey),
      params.expiresAt,
      params.portalId,
    ]
  );
}

// Set when a token refresh fails specifically because the merchant revoked
// this app's access from inside their HubSpot portal (see
// HubSpotRefreshTokenRevokedError, src/hubspot/tokens.ts) — distinguishes
// "needs a real reconnect" from a transient failure. Cleared automatically
// by saveHubSpotConnection above the moment a merchant does reconnect.
export async function markHubSpotConnectionBroken(shopDomain: string): Promise<void> {
  await ensureSchema();
  await pool.query(
    `UPDATE merchants SET hubspot_connection_broken_at = now(), updated_at = now() WHERE shop_domain = $1`,
    [shopDomain]
  );
}

// Powers the operator-wide view on /sync-status (no ?shop=) — surfaces
// every merchant currently needing a HubSpot reconnect in one call, rather
// than requiring the operator to check each shop individually.
export async function getShopsWithBrokenHubSpotConnection(): Promise<string[]> {
  await ensureSchema();
  const result = await pool.query<{ shop_domain: string }>(
    'SELECT shop_domain FROM merchants WHERE hubspot_connection_broken_at IS NOT NULL ORDER BY hubspot_connection_broken_at DESC'
  );
  return result.rows.map((row) => row.shop_domain);
}

export async function saveDealRules(shopDomain: string, rules: DealRule[]): Promise<void> {
  await ensureSchema();
  await pool.query(
    `UPDATE merchants SET deal_rules = $2, updated_at = now() WHERE shop_domain = $1`,
    [shopDomain, JSON.stringify(rules)]
  );
}

// Called by src/backfillMerchant.ts at each state transition (running ->
// complete|failed) — written as a full replacement object each time rather
// than a partial JSONB patch, so there's no read-modify-write race between
// concurrent callers (the OAuth callback's background run and a manual
// `npm run backfill`/dashboard retry landing close together).
export async function saveBackfillStatus(shopDomain: string, status: BackfillStatus): Promise<void> {
  await ensureSchema();
  await pool.query(`UPDATE merchants SET backfill_status = $2, updated_at = now() WHERE shop_domain = $1`, [
    shopDomain,
    JSON.stringify(status),
  ]);
}

export async function saveAdminApiKeyHash(shopDomain: string, hash: string): Promise<void> {
  await ensureSchema();
  await pool.query(
    `UPDATE merchants SET admin_api_key_hash = $2, updated_at = now() WHERE shop_domain = $1`,
    [shopDomain, hash]
  );
}

// Shopify's mandatory `shop/redact` GDPR webhook (src/shopify/webhooks.ts)
// — sent ~48h after a shop uninstalls, requiring every trace of that shop
// to be deleted. Plain DELETE, no soft-delete/archive: there's no feature
// in this app that depends on a record of a shop having once existed, and
// keeping one around would defeat the point of the redact request. Safe to
// call on a shop that's already gone (no-op).
export async function deleteMerchant(shopDomain: string): Promise<void> {
  await ensureSchema();
  await pool.query('DELETE FROM merchants WHERE shop_domain = $1', [shopDomain]);
}
