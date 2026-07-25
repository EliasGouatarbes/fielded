import { config } from '../config';
import { getMerchant, saveShopifyToken } from '../db/merchants';

export function normalizeShopDomain(domain: string): string {
  return domain.replace(/^https?:\/\//, '');
}

// The Postgres row is the real source of truth as of step 5. Takes the shop
// domain as a parameter (multi-merchant step) rather than always reading
// the single SHOPIFY_STORE_DOMAIN env var — that env var now only matters
// as a local-dev default (see callers) and as the seed value below for
// bridging an old single-store deployment's .env token into the database.
export async function resolveShopifyAccessToken(shopDomain: string): Promise<string> {
  const stored = await getMerchant(shopDomain);
  if (stored) return stored.shopifyAccessToken;

  if (config.shopify.adminAccessToken) {
    await saveShopifyToken(shopDomain, config.shopify.adminAccessToken);
    return config.shopify.adminAccessToken;
  }

  throw new Error(
    `No Shopify access token in the database or .env for ${shopDomain}. Run the OAuth handshake at /auth/shopify?shop=${shopDomain} first.`
  );
}
