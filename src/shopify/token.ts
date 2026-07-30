import https from 'https';
import { config } from '../config';
import { getMerchant, saveShopifyToken } from '../db/merchants';
import { withKeyedLock } from '../mutex';

export function normalizeShopDomain(domain: string): string {
  return domain.replace(/^https?:\/\//, '');
}

const REFRESH_SAFETY_MARGIN_MS = 2 * 60 * 1000;

interface ShopifyTokenResponse {
  access_token: string;
  scope: string;
  // Only present when the exchange requested an *expiring* token
  // (`expiring: 1`) — mandatory for a publicly-distributed app as of April
  // 2026 (found live, not from docs: Shopify started rejecting this app's
  // old non-expiring tokens outright the moment it switched to public
  // distribution — see CLAUDE.md). A merchant connected before this fix
  // has neither field and keeps using their existing token until they
  // reconnect.
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

// Shopify's OAuth token endpoint takes JSON (unlike HubSpot's, which is
// form-urlencoded — see hubspot/tokens.ts's exchangeHubSpotToken). Shared by
// both the initial authorization_code exchange (src/shopify/oauth.ts) and
// the refresh_token exchange below — same endpoint, same shape, Shopify
// just looks at which fields are present to know which grant is being used.
export function exchangeShopifyToken(shop: string, params: Record<string, string | number>): Promise<ShopifyTokenResponse> {
  const payload = JSON.stringify(params);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: shop,
        path: '/admin/oauth/access_token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error(`Could not parse Shopify token response: ${body}`));
            }
          } else {
            reject(new Error(`Shopify token exchange failed (${status}): ${body}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// The Postgres row is the real source of truth as of step 5. Takes the shop
// domain as a parameter (multi-merchant step) rather than always reading
// the single SHOPIFY_STORE_DOMAIN env var — that env var now only matters
// as a local-dev default (see callers) and as the seed value below for
// bridging an old single-store deployment's .env token into the database.
//
// Transparently refreshes an expiring token before it goes stale, the same
// shape as hubspot/tokens.ts's getHubSpotAccessToken — wrapped in a keyed
// lock so a burst of near-simultaneous calls near the expiry boundary
// triggers one refresh, not one per request. A merchant with no stored
// refresh token/expiry (connected before expiring tokens existed, or
// seeded from the legacy static env var) has nothing to refresh — returns
// what's stored as-is, same as this function always did.
export async function resolveShopifyAccessToken(shopDomain: string): Promise<string> {
  return withKeyedLock(`shopify-refresh:${shopDomain}`, async () => {
    const merchant = await getMerchant(shopDomain);

    if (!merchant) {
      if (config.shopify.adminAccessToken) {
        await saveShopifyToken(shopDomain, { accessToken: config.shopify.adminAccessToken });
        return config.shopify.adminAccessToken;
      }
      throw new Error(
        `No Shopify access token in the database or .env for ${shopDomain}. Run the OAuth handshake at /auth/shopify?shop=${shopDomain} first.`
      );
    }

    if (!merchant.shopifyRefreshToken || !merchant.shopifyTokenExpiresAt) {
      return merchant.shopifyAccessToken;
    }

    const expiresAt = merchant.shopifyTokenExpiresAt.getTime();
    if (expiresAt - Date.now() > REFRESH_SAFETY_MARGIN_MS) {
      return merchant.shopifyAccessToken;
    }

    const refreshed = await exchangeShopifyToken(shopDomain, {
      client_id: config.shopify.apiKey,
      client_secret: config.shopify.apiSecretKey,
      grant_type: 'refresh_token',
      refresh_token: merchant.shopifyRefreshToken,
    });

    await saveShopifyToken(shopDomain, {
      accessToken: refreshed.access_token,
      // Shopify rotates the refresh token on every use (the old one stops
      // working the moment a new one is issued) — must persist the new one
      // or the *next* refresh attempt fails with a dead token.
      refreshToken: refreshed.refresh_token,
      expiresAt: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000) : undefined,
    });

    return refreshed.access_token;
  });
}
