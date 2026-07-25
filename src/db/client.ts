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

// Bare-bones schema setup: one small table, no real migration history to
// manage yet. Idempotent, so it's safe to call on every process start
// (server, backfill script) rather than needing a separate migrate step.
export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = pool
      .query(
        `
      CREATE TABLE IF NOT EXISTS shopify_installations (
        shop_domain TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS sync_log (
        id BIGSERIAL PRIMARY KEY,
        entity_type TEXT NOT NULL,
        shopify_id TEXT NOT NULL,
        hubspot_id TEXT,
        status TEXT NOT NULL,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS sync_log_created_at_idx ON sync_log (created_at DESC);
    `
      )
      .then(() => undefined);
  }
  return schemaReady;
}
