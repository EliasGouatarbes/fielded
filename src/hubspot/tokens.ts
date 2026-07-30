import https from 'https';
import { Client as HubSpotClient } from '@hubspot/api-client';
import { config } from '../config';
import { getMerchant, saveHubSpotConnection, markHubSpotConnectionBroken, BillingStatus } from '../db/merchants';
import { withKeyedLock } from '../mutex';
import { DealRule } from './dealRules';

const TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';
const REFRESH_SAFETY_MARGIN_MS = 2 * 60 * 1000;

interface HubSpotTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

// Thrown instead of a plain Error when HubSpot's refresh_token exchange
// fails specifically because the merchant revoked this app's access from
// inside their HubSpot portal — HubSpot's response body is
// `{status: "BAD_REFRESH_TOKEN", error: "invalid_grant", ...}` in that
// case, distinguishable from other failure modes (bad client secret,
// transient network issues) that a retry might still recover from. Once
// revoked there's no endpoint to un-revoke it — the merchant must redo the
// full /auth/hubspot handshake. Distinct type lets callers (getHubSpotAccess
// Token below, and the webhook receiver) react differently: stop retrying
// (retrying can't fix this) and flag the merchant row instead.
export class HubSpotRefreshTokenRevokedError extends Error {}

// HubSpot's OAuth token endpoint takes form-urlencoded, not JSON (unlike
// Shopify's — see src/shopify/oauth.ts's fetchShopifyAccessToken). Shared by
// both the initial authorization_code exchange (src/hubspot/oauth.ts) and
// the refresh_token exchange below.
export function exchangeHubSpotToken(params: Record<string, string>): Promise<HubSpotTokenResponse> {
  const payload = new URLSearchParams(params).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      TOKEN_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
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
              reject(new Error(`Could not parse HubSpot token response: ${body}`));
            }
          } else {
            reject(classifyTokenExchangeFailure(status, body));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Pure classification, extracted so it's unit-testable without a live HTTPS
// call: does this failed token-exchange response mean the refresh token was
// specifically revoked (HubSpot's `{status: "BAD_REFRESH_TOKEN", error:
// "invalid_grant", ...}` body), or some other failure (bad client secret,
// malformed request, transient issue)?
export function classifyTokenExchangeFailure(status: number, body: string): Error {
  const parsed = tryParseJson(body);
  if (parsed?.status === 'BAD_REFRESH_TOKEN' || parsed?.error === 'invalid_grant') {
    return new HubSpotRefreshTokenRevokedError(`HubSpot refresh token revoked or invalid (${status}): ${body}`);
  }
  return new Error(`HubSpot token exchange failed (${status}): ${body}`);
}

function tryParseJson(body: string): { status?: string; error?: string } | undefined {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

// One-time-per-connect lookup of the portal (hub) id behind an access token
// — HubSpot's token response itself doesn't include it.
export function fetchHubSpotPortalId(accessToken: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(`https://api.hubapi.com/oauth/v1/access-tokens/${accessToken}`, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            try {
              const parsed = JSON.parse(body) as { hub_id: number };
              resolve(String(parsed.hub_id));
            } catch {
              reject(new Error(`Could not parse HubSpot access-token response: ${body}`));
            }
          } else {
            reject(new Error(`HubSpot access-token lookup failed (${status}): ${body}`));
          }
        });
      })
      .on('error', reject);
  });
}

// Reads the merchant's stored HubSpot access token, transparently
// refreshing it first if it's expired or about to be (HubSpot access tokens
// last 30 minutes; refresh tokens don't expire unless revoked). Wrapped in
// a keyed lock so a burst of near-simultaneous webhook deliveries near the
// expiry boundary triggers one refresh, not one per request.
export async function getHubSpotAccessToken(shopDomain: string): Promise<string> {
  return withKeyedLock(`hubspot-refresh:${shopDomain}`, async () => {
    const merchant = await getMerchant(shopDomain);
    if (!merchant || !merchant.hubspotAccessToken || !merchant.hubspotRefreshToken) {
      throw new Error(
        `No HubSpot connection for ${shopDomain}. Visit /auth/hubspot?shop=${shopDomain} to connect it.`
      );
    }

    const expiresAt = merchant.hubspotTokenExpiresAt?.getTime() ?? 0;
    if (expiresAt - Date.now() > REFRESH_SAFETY_MARGIN_MS) {
      return merchant.hubspotAccessToken;
    }

    let refreshed: HubSpotTokenResponse;
    try {
      refreshed = await exchangeHubSpotToken({
        grant_type: 'refresh_token',
        refresh_token: merchant.hubspotRefreshToken,
        client_id: config.hubspot.clientId,
        client_secret: config.hubspot.clientSecret,
      });
    } catch (err) {
      if (err instanceof HubSpotRefreshTokenRevokedError) {
        await markHubSpotConnectionBroken(shopDomain);
      }
      throw err;
    }

    await saveHubSpotConnection(shopDomain, {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
      portalId: merchant.hubspotPortalId ?? (await fetchHubSpotPortalId(refreshed.access_token)),
    });

    return refreshed.access_token;
  });
}

// No client caching — the SDK client is a thin wrapper, so constructing
// fresh per call is simplest and guarantees the token is never stale. Worth
// revisiting only if merchant count/volume grows far past this app's
// current target.
export async function resolveHubSpotClient(shopDomain: string): Promise<HubSpotClient> {
  return new HubSpotClient({ accessToken: await getHubSpotAccessToken(shopDomain) });
}

export interface MerchantContext {
  shopDomain: string;
  hubspotClient: HubSpotClient;
  dealPipeline: string;
  dealStage: string;
  dealRules: DealRule[];
  billingStatus: BillingStatus | null;
}

// Resolves everything a sync operation needs for one merchant in one call:
// the DB row (for pipeline/stage/rules) plus a live HubSpot client (which
// may trigger a token refresh). Returns null if the shop was never
// installed, and throws (via getHubSpotAccessToken) if it installed via
// Shopify but never finished connecting HubSpot — callers distinguish
// those two cases because they're handled differently (see webhooks.ts).
export async function resolveMerchantContext(shopDomain: string): Promise<MerchantContext | null> {
  const merchant = await getMerchant(shopDomain);
  if (!merchant) return null;

  return {
    shopDomain,
    hubspotClient: await resolveHubSpotClient(shopDomain),
    dealPipeline: merchant.dealPipeline,
    dealStage: merchant.dealStage,
    dealRules: merchant.dealRules,
    billingStatus: merchant.billingStatus,
  };
}
