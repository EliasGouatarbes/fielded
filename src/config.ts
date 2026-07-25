import 'dotenv/config';

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
    // http://localhost:3000 locally. Used only to build the OAuth redirect
    // URI, so it's optional with a localhost fallback: nothing breaks
    // locally, and the Shopify token already sitting in the database (step
    // 5) keeps working in production even if this is never set — it only
    // matters if the handshake needs to be re-run against the deployed URL.
    appUrl: string;
    // Gates GET /sync-status (step 6) — required once the server is
    // publicly reachable, per the step-7 plan in CLAUDE.md.
    adminApiKey: string;
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
    accessToken: string;
    dealPipeline: string;
    dealStage: string;
  };
}

const REQUIRED_VARS = [
  'DATABASE_URL',
  'SHOPIFY_STORE_DOMAIN',
  'SHOPIFY_API_KEY',
  'SHOPIFY_API_SECRET_KEY',
  'HUBSPOT_ACCESS_TOKEN',
  'ADMIN_API_KEY',
] as const;
// SHOPIFY_ADMIN_ACCESS_TOKEN is deliberately NOT required at boot: as of
// step 5, the Postgres row in `shopify_installations` (see src/db/) is the
// real source of truth for this token, written there by the OAuth callback.
// This env var now only matters once, as a seed value read by
// src/shopify/token.ts on first run against an empty database — bridging
// whatever token you got from the step-2 handshake into real persistence.
// It's read as optional below and can be blank once that migration has run.

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
      accessToken: process.env.HUBSPOT_ACCESS_TOKEN as string,
      // Optional: if unset, deal creation omits pipeline/dealstage and lets
      // HubSpot fall back to the portal's default pipeline and its first
      // stage. Set these if that default isn't what you want, or if deal
      // creation errors demanding a dealstage.
      dealPipeline: optional('HUBSPOT_DEAL_PIPELINE', ''),
      dealStage: optional('HUBSPOT_DEAL_STAGE', ''),
    },
  };
}

export const config = loadConfig();
