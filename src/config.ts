import 'dotenv/config';
import { parseEncryptionKey } from './crypto';

// Fail loudly and immediately if required config is missing, rather than
// letting a blank token cause a confusing 401 three files away.

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : fallback;
}

export interface AppConfig {
  server: {
    port: number;
    // Public base URL this instance is reachable at — e.g.
    // https://hubspot-shopify-sync.onrender.com in production, or
    // http://localhost:3000 locally. Used to build both OAuth redirect URIs
    // (Shopify and HubSpot), so it's optional with a localhost fallback:
    // nothing breaks locally, and tokens already sitting in the database
    // keep working in production even if this is never set — it only
    // matters if a handshake needs to be (re-)run against the deployed URL.
    appUrl: string;
    // Global operator override for merchant-scoped endpoints (/sync-status,
    // deal-rules CRUD) — grants cross-merchant access without needing every
    // individual merchant's own per-merchant key (CLAUDE.md multi-merchant
    // step). Per-merchant keys are generated at HubSpot-connect time and
    // stored hashed in the merchants table, not here.
    adminApiKey: string;
    // sync_log rows carry customer emails and order numbers with no other
    // expiry mechanism (pre-launch audit, 2026-07-29) — this bounds how long
    // that PII sits in the database for a merchant who never triggers a GDPR
    // redact request. 90 days by default: long enough to debug a real sync
    // issue after the fact, short enough not to become its own data-retention
    // liability.
    syncLogRetentionDays: number;
  };
  db: {
    connectionString: string;
  };
  shopify: {
    storeDomain: string;
    adminAccessToken: string;
    apiKey: string;
    apiSecretKey: string;
    apiVersion: string;
  };
  hubspot: {
    clientId: string;
    clientSecret: string;
  };
  // Signs the stateless OAuth `state` param for both the Shopify and
  // HubSpot handshakes (see src/shopify/oauth.ts / src/hubspot/oauth.ts) —
  // deliberately its own secret rather than reusing SHOPIFY_API_SECRET_KEY,
  // since these are two independent trust boundaries.
  oauthStateSecret: string;
  // AES-256-GCM key encrypting merchants.shopify_access_token /
  // hubspot_access_token / hubspot_refresh_token at rest (src/crypto.ts,
  // applied in src/db/merchants.ts). Parsed eagerly so a malformed key fails
  // at boot, not on the first token read/write.
  encryptionKey: Buffer;
  billing: {
    // Shopify's Billing API requires an explicit `test: true` flag on every
    // charge to keep it from being real money (src/shopify/billing.ts).
    // Defaults to true — a forgotten/missing env var must fail *safe* (no
    // real charge happens) rather than fail dangerous (a real merchant gets
    // billed because a flag was never set). Only becomes false with an
    // explicit "false" in the environment.
    testMode: boolean;
  };
}

const REQUIRED_VARS = [
  'DATABASE_URL',
  'SHOPIFY_STORE_DOMAIN',
  'SHOPIFY_API_KEY',
  'SHOPIFY_API_SECRET_KEY',
  'HUBSPOT_CLIENT_ID',
  'HUBSPOT_CLIENT_SECRET',
  'OAUTH_STATE_SECRET',
  'ADMIN_API_KEY',
  'ENCRYPTION_KEY',
] as const;
// SHOPIFY_ADMIN_ACCESS_TOKEN is deliberately NOT required at boot: as of
// step 5, the Postgres row in `merchants` (see src/db/) is the real source
// of truth for this token, written there by the OAuth callback. This env
// var now only matters once, as a seed value read by src/shopify/token.ts
// on first run against an empty database — bridging whatever token you got
// from the step-2 handshake into real persistence. It's read as optional
// below and can be blank once that migration has run.

function loadConfig(): AppConfig {
  const missing = REQUIRED_VARS.filter((name) => {
    const value = process.env[name];
    return !value || value.trim() === '';
  });

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        `Copy .env.example to .env and fill these in before starting the server.`
    );
  }

  return {
    server: {
      port: Number(optional('PORT', '3000')),
      appUrl: optional('APP_URL', `http://localhost:${optional('PORT', '3000')}`),
      adminApiKey: process.env.ADMIN_API_KEY as string,
      syncLogRetentionDays: Number(optional('SYNC_LOG_RETENTION_DAYS', '90')),
    },
    db: {
      connectionString: process.env.DATABASE_URL as string,
    },
    shopify: {
      storeDomain: process.env.SHOPIFY_STORE_DOMAIN as string,
      adminAccessToken: optional('SHOPIFY_ADMIN_ACCESS_TOKEN', ''),
      apiKey: process.env.SHOPIFY_API_KEY as string,
      apiSecretKey: process.env.SHOPIFY_API_SECRET_KEY as string,
      apiVersion: optional('SHOPIFY_API_VERSION', '2026-07'),
    },
    hubspot: {
      clientId: process.env.HUBSPOT_CLIENT_ID as string,
      clientSecret: process.env.HUBSPOT_CLIENT_SECRET as string,
    },
    oauthStateSecret: process.env.OAUTH_STATE_SECRET as string,
    encryptionKey: parseEncryptionKey(process.env.ENCRYPTION_KEY as string),
    billing: {
      testMode: optional('SHOPIFY_BILLING_TEST_MODE', 'true') !== 'false',
    },
  };
}

export const config = loadConfig();
