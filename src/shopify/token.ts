import { config } from '../config';
import { getStoredAccessToken, saveAccessToken } from '../db/shopifyInstallations';

export function normalizeShopDomain(domain: string): string {
  return domain.replace(/^https?:\/\//, '');
}

// The Postgres row is the real source of truth as of step 5. Falls back to
// (and seeds the database from) SHOPIFY_ADMIN_ACCESS_TOKEN in .env — the
// placeholder storage the step-2 OAuth handshake used — so a store that
// already completed that handshake doesn't have to redo it after this
// migration.
export async function resolveShopifyAccessToken(): Promise<string> {
  const shop = normalizeShopDomain(config.shopify.storeDomain);

  const stored = await getStoredAccessToken(shop);
  if (stored) return stored;

  if (config.shopify.adminAccessToken) {
    await saveAccessToken(shop, config.shopify.adminAccessToken);
    return config.shopify.adminAccessToken;
  }

  throw new Error(
    'No Shopify access token in the database or .env. Run the OAuth handshake at /auth/shopify first.'
  );
}
