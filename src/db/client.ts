import { Pool } from 'pg';
import { config } from '../config';

// Supabase and Neon's free-tier connection strings both require TLS, but
// their certificate chains aren't always in Node's default trust store —
// rejectUnauthorized: false is the standard pragmatic default for talking to
// either from node-postgres. Revisit if this ever handles a provider with a
// properly chained cert.
export const pool = new Pool({
  connectionString: config.db.connectionString,
  ssl: { rejectUnauthorized: false },
});

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

      -- Covers an already-deployed merchants table predating this column
      -- (CREATE TABLE IF NOT EXISTS above is a no-op there) — idempotent,
      -- safe to run on every process start same as everything else here.
      ALTER TABLE merchants ADD COLUMN IF NOT EXISTS hubspot_connection_broken_at TIMESTAMPTZ;
    `
      )
      .then(() => undefined);
  }
  return schemaReady;
}
