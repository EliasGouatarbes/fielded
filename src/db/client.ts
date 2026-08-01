import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { config } from '../config';

// Was `rejectUnauthorized: false` (10h, CLAUDE.md pre-launch audit) —
// traffic was still encrypted, but the client never verified it was
// actually talking to Supabase, so a network-positioned attacker could MITM
// with a self-signed cert undetected. Fixed with Supabase's actual root CA
// (downloaded from the project's Database -> Settings -> SSL Configuration
// page, not a secret — it only lets this app verify the server's identity,
// same as any CA in a normal trust store, so it's safe to commit rather
// than juggle as a multi-line env var). Same CA works for both the direct
// connection host and the Session Pooler host this app actually uses (step
// 5's `aws-0-<region>.pooler.supabase.com`) — it's Supabase's shared
// platform root, not project-specific, confirmed live against this app's
// real pooler connection string.
const SUPABASE_CA_CERT = fs.readFileSync(path.join(__dirname, 'supabase-ca.crt'), 'utf8');

export const pool = new Pool({
  connectionString: config.db.connectionString,
  ssl: { ca: SUPABASE_CA_CERT, rejectUnauthorized: true },
});

// node-postgres's Pool re-emits an idle client's error as pool.emit('error',
// ...) (see node_modules/pg-pool's own source) — with no listener attached,
// that's an unhandled EventEmitter error, which crashes the entire Node
// process. A dropped idle connection is routine (Supabase's pooler recycles
// them proactively), not fatal: log it and let the pool open a fresh
// connection on the next query, same as it already does for any other idle
// client replacement. Found in the pre-launch audit (2026-07-29) — this had
// no listener at all before, meaning any such drop took the whole service
// down, not just one query.
pool.on('error', (err) => {
  console.error('Unexpected error on idle database client (pool recovers automatically):', err);
});

// Identifies *which* database a connection string points at without ever
// exposing the password — username@host. Host alone isn't enough: Supabase's
// pooler hostname (aws-0-<region>.pooler.supabase.com) is shared
// infrastructure across every project in that region, so two completely
// different projects/databases show the identical host; only the username
// (postgres.<project-ref>) actually distinguishes them. Shared by server.ts
// (boot log / GET /health) and the backup/restore-drill scripts, which use
// it as a safety confirmation before writing anywhere.
export function databaseIdentity(connectionString: string): string {
  const url = new URL(connectionString);
  return `${url.username}@${url.host}`;
}

// The bare project-ref portion of databaseIdentity's username
// (postgres.<ref> -> <ref>) — what an operator actually recognizes at a
// glance and what restoreDrill.ts's --target confirmation flag is compared
// against.
export function projectRef(connectionString: string): string {
  const url = new URL(connectionString);
  return url.username.replace(/^postgres\./, '');
}

let schemaReady: Promise<void> | undefined;

// Bare-bones schema setup, idempotent so it's safe to call on every process
// start (server, backfill/register-webhooks scripts) rather than needing a
// separate migrate step. This targets the full multi-merchant `merchants`
// shape directly for fresh environments — an existing deployment with data
// in the older `shopify_installations` table needs the one-time manual
// migration documented in CLAUDE.md (rename + ADD COLUMN IF NOT EXISTS) run
// once against that database before deploying this code.
export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = pool
      .query(
        `
      CREATE TABLE IF NOT EXISTS merchants (
        shop_domain TEXT PRIMARY KEY,
        shopify_access_token TEXT NOT NULL,
        shopify_refresh_token TEXT,
        shopify_token_expires_at TIMESTAMPTZ,

        hubspot_portal_id BIGINT,
        hubspot_access_token TEXT,
        hubspot_refresh_token TEXT,
        hubspot_token_expires_at TIMESTAMPTZ,
        hubspot_connected_at TIMESTAMPTZ,
        hubspot_connection_broken_at TIMESTAMPTZ,

        deal_pipeline TEXT NOT NULL DEFAULT '',
        deal_stage TEXT NOT NULL DEFAULT '',
        deal_rules JSONB NOT NULL DEFAULT '[]'::jsonb,

        admin_api_key_hash TEXT,
        backfill_status JSONB,

        billing_subscription_id TEXT,
        billing_status TEXT,
        billing_trial_ends_at TIMESTAMPTZ,

        shop_contact_email TEXT,

        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS sync_log (
        id BIGSERIAL PRIMARY KEY,
        entity_type TEXT NOT NULL,
        shopify_id TEXT NOT NULL,
        hubspot_id TEXT,
        shop_domain TEXT,
        status TEXT NOT NULL,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS sync_log_created_at_idx ON sync_log (created_at DESC);
      CREATE INDEX IF NOT EXISTS sync_log_shop_created_idx ON sync_log (shop_domain, created_at DESC);

      -- Records every authenticated read of merchant/customer data through
      -- the admin/merchant-key-gated routes (/sync-status, /merchants/:shop/*,
      -- /dashboard's data endpoints) — see src/db/accessLog.ts. shop_domain is
      -- nullable: the global operator key can hit these routes with no
      -- ?shop= at all (e.g. GET /sync-status across every merchant).
      CREATE TABLE IF NOT EXISTS access_log (
        id BIGSERIAL PRIMARY KEY,
        route TEXT NOT NULL,
        method TEXT NOT NULL,
        auth_type TEXT NOT NULL,
        shop_domain TEXT,
        ip TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS access_log_created_at_idx ON access_log (created_at DESC);
      CREATE INDEX IF NOT EXISTS access_log_shop_created_idx ON access_log (shop_domain, created_at DESC);

      -- Covers an already-deployed merchants table predating these columns
      -- (CREATE TABLE IF NOT EXISTS above is a no-op there) — idempotent,
      -- safe to run on every process start same as everything else here.
      ALTER TABLE merchants ADD COLUMN IF NOT EXISTS hubspot_connection_broken_at TIMESTAMPTZ;
      ALTER TABLE merchants ADD COLUMN IF NOT EXISTS shopify_refresh_token TEXT;
      ALTER TABLE merchants ADD COLUMN IF NOT EXISTS shopify_token_expires_at TIMESTAMPTZ;
      ALTER TABLE merchants ADD COLUMN IF NOT EXISTS backfill_status JSONB;
      ALTER TABLE merchants ADD COLUMN IF NOT EXISTS billing_subscription_id TEXT;
      ALTER TABLE merchants ADD COLUMN IF NOT EXISTS billing_status TEXT;
      ALTER TABLE merchants ADD COLUMN IF NOT EXISTS billing_trial_ends_at TIMESTAMPTZ;
      ALTER TABLE merchants ADD COLUMN IF NOT EXISTS shop_contact_email TEXT;
    `
      )
      .then(() => undefined);
  }
  return schemaReady;
}
