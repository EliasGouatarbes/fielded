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

// Mirrors Shopify's AppSubscriptionStatus enum values directly (PENDING,
// ACTIVE, CANCELLED, DECLINED, EXPIRED, FROZEN) rather than inventing our
// own — one less mapping to keep in sync with Shopify's own source of
// truth. `null` means no subscription has ever been created for this shop
// (a merchant who installed via Shopify but hasn't reached the billing
// confirmation step yet).
export type BillingStatus = 'PENDING' | 'ACTIVE' | 'CANCELLED' | 'DECLINED' | 'EXPIRED' | 'FROZEN';

export interface Merchant {
  shopDomain: string;
  shopifyAccessToken: string;
  shopifyRefreshToken: string | null;
  shopifyTokenExpiresAt: Date | null;
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
  billingSubscriptionId: string | null;
  billingStatus: BillingStatus | null;
  billingTrialEndsAt: Date | null;
  shopContactEmail: string | null;
}

interface MerchantRow {
  shop_domain: string;
  shopify_access_token: string;
  shopify_refresh_token: string | null;
  shopify_token_expires_at: Date | null;
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
  billing_subscription_id: string | null;
  billing_status: BillingStatus | null;
  billing_trial_ends_at: Date | null;
  shop_contact_email: string | null;
}

function toMerchant(row: MerchantRow): Merchant {
  return {
    shopDomain: row.shop_domain,
    shopifyAccessToken: decrypt(row.shopify_access_token, config.encryptionKey),
    shopifyRefreshToken: row.shopify_refresh_token ? decrypt(row.shopify_refresh_token, config.encryptionKey) : null,
    shopifyTokenExpiresAt: row.shopify_token_expires_at,
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
    billingSubscriptionId: row.billing_subscription_id,
    billingStatus: row.billing_status,
    billingTrialEndsAt: row.billing_trial_ends_at,
    shopContactEmail: row.shop_contact_email,
  };
}

export async function getMerchant(shopDomain: string): Promise<Merchant | null> {
  await ensureSchema();
  const result = await pool.query<MerchantRow>('SELECT * FROM merchants WHERE shop_domain = $1', [shopDomain]);
  const row = result.rows[0];
  return row ? toMerchant(row) : null;
}

// Shopify half of onboarding (initial OAuth handshake) and the ongoing
// token-refresh path (src/shopify/token.ts) both write through here.
// `refreshToken`/`expiresAt` are optional: Shopify only issues them for an
// *expiring* offline token (requested via `expiring: 1` on the exchange,
// mandatory for a publicly-distributed app since April 2026 — see
// CLAUDE.md) — a merchant connected before that fix, or seeded from the
// legacy static SHOPIFY_ADMIN_ACCESS_TOKEN env var, has neither and simply
// keeps using its access token as-is until they reconnect.
export async function saveShopifyToken(
  shopDomain: string,
  params: { accessToken: string; refreshToken?: string; expiresAt?: Date }
): Promise<void> {
  await ensureSchema();
  await pool.query(
    `INSERT INTO merchants (shop_domain, shopify_access_token, shopify_refresh_token, shopify_token_expires_at, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (shop_domain) DO UPDATE SET
       shopify_access_token = EXCLUDED.shopify_access_token,
       shopify_refresh_token = EXCLUDED.shopify_refresh_token,
       shopify_token_expires_at = EXCLUDED.shopify_token_expires_at,
       updated_at = now()`,
    [
      shopDomain,
      encrypt(params.accessToken, config.encryptionKey),
      params.refreshToken ? encrypt(params.refreshToken, config.encryptionKey) : null,
      params.expiresAt ?? null,
    ]
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

// Called only from the HubSpot OAuth callback (src/hubspot/oauth.ts), and
// only when this merchant has no default pipeline/stage on file yet —
// there was previously no write path for these two columns at all (only
// per-rule pipeline/stage, via saveDealRules above, ever got a real value).
// A merchant who never configures a deal rule fell through to
// evaluateDealRules' "no rules matched" branch, which returned these two
// blank strings as-is; upsertDealByName then omits both properties from the
// HubSpot create call entirely rather than sending an empty string. Found
// live (2026-07-31): HubSpot does NOT visibly default a pipeline-less deal
// onto any board — the record exists and is reachable directly, but isn't
// visible on any pipeline view, which reads as "deals aren't syncing" even
// though the sync itself succeeded.
export async function saveDealPipelineDefaults(shopDomain: string, pipeline: string, stage: string): Promise<void> {
  await ensureSchema();
  await pool.query(
    `UPDATE merchants SET deal_pipeline = $2, deal_stage = $3, updated_at = now() WHERE shop_domain = $1`,
    [shopDomain, pipeline, stage]
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

// Called right after appSubscriptionCreate succeeds (src/shopify/billing.ts)
// — status starts as 'PENDING' until the merchant actually approves the
// charge on Shopify's confirmation page. `trialEndsAt` is computed once
// here (createdAt + trialDays) rather than re-derived later, since
// Shopify's AppSubscription object doesn't expose a direct "trial end"
// field of its own.
export async function saveBillingSubscription(
  shopDomain: string,
  params: { subscriptionId: string; status: BillingStatus; trialEndsAt: Date }
): Promise<void> {
  await ensureSchema();
  await pool.query(
    `UPDATE merchants
     SET billing_subscription_id = $2, billing_status = $3, billing_trial_ends_at = $4, updated_at = now()
     WHERE shop_domain = $1`,
    [shopDomain, params.subscriptionId, params.status, params.trialEndsAt]
  );
}

// Updates just the status — called both right after the merchant approves
// on Shopify's confirmation page (src/shopify/oauth.ts) and whenever
// Shopify's app_subscriptions/update webhook reports a change (a
// cancellation, a declined payment, a freeze) that didn't originate from an
// action in this app at all.
export async function updateBillingStatus(shopDomain: string, status: BillingStatus): Promise<void> {
  await ensureSchema();
  await pool.query(`UPDATE merchants SET billing_status = $2, updated_at = now() WHERE shop_domain = $1`, [
    shopDomain,
    status,
  ]);
}

// Best-effort, non-blocking: fetched right after the Shopify OAuth exchange
// (src/shopify/oauth.ts) so there's some way to reach a paying merchant
// directly (e.g. "you need to reconnect HubSpot after this update") without
// needing real notification infrastructure yet — there's no other contact
// point captured anywhere in this app. Not encrypted at rest, consistent
// with shop_domain itself already being plaintext in this same table; this
// app's existing encryption bar (src/crypto.ts) is reserved for actual
// access-granting secrets (OAuth tokens), not general account metadata.
export async function saveShopifyContactEmail(shopDomain: string, contactEmail: string): Promise<void> {
  await ensureSchema();
  await pool.query(
    `UPDATE merchants SET shop_contact_email = $2, updated_at = now() WHERE shop_domain = $1`,
    [shopDomain, contactEmail]
  );
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
