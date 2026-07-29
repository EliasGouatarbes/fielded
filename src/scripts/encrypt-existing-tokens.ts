// One-time migration: encrypts any plaintext shopify_access_token /
// hubspot_access_token / hubspot_refresh_token already sitting in the
// `merchants` table, now that src/db/merchants.ts reads/writes those columns
// through src/crypto.ts. Safe to re-run — looksEncrypted() skips rows
// already in `iv:authTag:ciphertext` form, so a partial prior run (or
// running this again after a fresh install added new plaintext rows before
// this script existed) doesn't double-encrypt anything.
//
// Deliberately does NOT import src/config.ts (which requires every OAuth var
// to already be set) — this only needs DATABASE_URL and ENCRYPTION_KEY, same
// reasoning as src/scripts/migrate-merchants.ts. Run once against the live
// database — `npm run encrypt-existing-tokens` — before deploying the
// encrypt/decrypt code in src/db/merchants.ts.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { encrypt, looksEncrypted, parseEncryptionKey } from '../crypto';

if (!process.env.DATABASE_URL) {
  throw new Error('Missing DATABASE_URL.');
}
if (!process.env.ENCRYPTION_KEY) {
  throw new Error('Missing ENCRYPTION_KEY.');
}

// Was `rejectUnauthorized: false` — the same MITM exposure src/db/client.ts
// fixed for the running app (pre-launch security audit's 10h), never
// applied here since this script deliberately opens its own Pool instead of
// importing that module. Reuses the same committed CA cert (not a secret,
// same reasoning as client.ts).
const SUPABASE_CA_CERT = fs.readFileSync(path.join(__dirname, '../db/supabase-ca.crt'), 'utf8');

const key = parseEncryptionKey(process.env.ENCRYPTION_KEY);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { ca: SUPABASE_CA_CERT, rejectUnauthorized: true },
});

interface Row {
  shop_domain: string;
  shopify_access_token: string;
  hubspot_access_token: string | null;
  hubspot_refresh_token: string | null;
}

function encryptIfPlaintext(value: string): string {
  return looksEncrypted(value) ? value : encrypt(value, key);
}

async function migrate(): Promise<void> {
  const result = await pool.query<Row>(
    'SELECT shop_domain, shopify_access_token, hubspot_access_token, hubspot_refresh_token FROM merchants'
  );

  let updated = 0;
  for (const row of result.rows) {
    const shopifyAccessToken = encryptIfPlaintext(row.shopify_access_token);
    const hubspotAccessToken = row.hubspot_access_token ? encryptIfPlaintext(row.hubspot_access_token) : null;
    const hubspotRefreshToken = row.hubspot_refresh_token ? encryptIfPlaintext(row.hubspot_refresh_token) : null;

    const changed =
      shopifyAccessToken !== row.shopify_access_token ||
      hubspotAccessToken !== row.hubspot_access_token ||
      hubspotRefreshToken !== row.hubspot_refresh_token;

    if (!changed) {
      console.log(`${row.shop_domain}: already encrypted, skipping.`);
      continue;
    }

    await pool.query(
      `UPDATE merchants
       SET shopify_access_token = $2, hubspot_access_token = $3, hubspot_refresh_token = $4
       WHERE shop_domain = $1`,
      [row.shop_domain, shopifyAccessToken, hubspotAccessToken, hubspotRefreshToken]
    );
    updated += 1;
    console.log(`${row.shop_domain}: encrypted.`);
  }

  console.log(`Done. ${updated}/${result.rows.length} row(s) updated.`);
}

migrate()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
