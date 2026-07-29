// One-time migration (CLAUDE.md multi-merchant step): renames the old
// single-shop `shopify_installations` table into the new `merchants` shape
// and seeds deal_pipeline/deal_stage on the existing row from the
// soon-to-be-removed HUBSPOT_DEAL_PIPELINE/HUBSPOT_DEAL_STAGE env vars.
// Safe to re-run: every step is guarded so a partial prior run doesn't fail
// the next one. Run once against the live database with
// `npm run migrate-merchants` before deploying the multi-merchant code.
//
// Deliberately does NOT import src/config.ts (which now requires
// HUBSPOT_CLIENT_ID/HUBSPOT_CLIENT_SECRET/OAUTH_STATE_SECRET at boot) — this
// is a pure database operation that only needs DATABASE_URL, and must be
// runnable before those HubSpot OAuth env vars exist yet.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('Missing DATABASE_URL.');
}

// Was `rejectUnauthorized: false` — the same MITM exposure src/db/client.ts
// fixed for the running app (pre-launch security audit's 10h), never
// applied here since this script deliberately opens its own Pool instead of
// importing that module. Reuses the same committed CA cert (not a secret,
// same reasoning as client.ts).
const SUPABASE_CA_CERT = fs.readFileSync(path.join(__dirname, '../db/supabase-ca.crt'), 'utf8');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { ca: SUPABASE_CA_CERT, rejectUnauthorized: true },
});

async function columnExists(table: string, column: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return (result.rowCount ?? 0) > 0;
}

async function tableExists(table: string): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [table]);
  return (result.rowCount ?? 0) > 0;
}

async function migrate(): Promise<void> {
  const hasOldTable = await tableExists('shopify_installations');
  const hasNewTable = await tableExists('merchants');

  if (hasOldTable && !hasNewTable) {
    console.log('Renaming shopify_installations -> merchants...');
    await pool.query('ALTER TABLE shopify_installations RENAME TO merchants');
  } else if (hasNewTable) {
    console.log('merchants table already exists, skipping rename.');
  } else {
    console.log('No existing shopify_installations table found — nothing to rename.');
  }

  if (await tableExists('merchants')) {
    if (await columnExists('merchants', 'access_token')) {
      console.log('Renaming merchants.access_token -> shopify_access_token...');
      await pool.query('ALTER TABLE merchants RENAME COLUMN access_token TO shopify_access_token');
    }

    console.log('Adding new merchants columns (if missing)...');
    await pool.query(`
      ALTER TABLE merchants
        ADD COLUMN IF NOT EXISTS hubspot_portal_id BIGINT,
        ADD COLUMN IF NOT EXISTS hubspot_access_token TEXT,
        ADD COLUMN IF NOT EXISTS hubspot_refresh_token TEXT,
        ADD COLUMN IF NOT EXISTS hubspot_token_expires_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS hubspot_connected_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS deal_pipeline TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS deal_stage TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS deal_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS admin_api_key_hash TEXT
    `);

    const seedPipeline = process.env.HUBSPOT_DEAL_PIPELINE ?? '';
    const seedStage = process.env.HUBSPOT_DEAL_STAGE ?? '';
    if (seedPipeline || seedStage) {
      console.log(`Seeding deal_pipeline/deal_stage from env for existing rows with none set...`);
      await pool.query(
        `UPDATE merchants SET deal_pipeline = $1 WHERE deal_pipeline = ''`,
        [seedPipeline]
      );
      await pool.query(`UPDATE merchants SET deal_stage = $1 WHERE deal_stage = ''`, [seedStage]);
    }
  }

  if (await columnExists('sync_log', 'shop_domain')) {
    console.log('sync_log.shop_domain already exists.');
  } else {
    console.log('Adding sync_log.shop_domain...');
    await pool.query('ALTER TABLE sync_log ADD COLUMN shop_domain TEXT');
  }
  await pool.query('CREATE INDEX IF NOT EXISTS sync_log_shop_created_idx ON sync_log (shop_domain, created_at DESC)');

  console.log('Migration complete.');
}

migrate()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
