// Restores a backup.ts dump into whatever database DATABASE_URL currently
// points at. Insert-only (ON CONFLICT DO NOTHING, keyed on each table's
// primary key) — never deletes or overwrites an existing target row, so
// this is safe to re-run and can't destroy data already sitting in the
// target.
//
// Exists specifically to prove backup.ts's dumps are actually restorable —
// Supabase's own restore UI turned out to be a paid-plan feature this app's
// free tier doesn't have, confirmed against the dashboard rather than
// assumed. The real DLP question isn't "do backups exist," it's "can we
// recover from one," and this is how that gets answered without paying for
// a feature this app doesn't otherwise need.
//
// SAFETY: this WRITES to whatever DATABASE_URL is currently configured.
// Requires --target=<project-ref> naming the project you expect to be
// restoring into, checked against the actually-configured target before
// anything is written — protects against a stale/typo'd .env silently
// aiming this at the wrong database. Never pass production's project ref
// for a routine drill; drills belong against a disposable environment
// (this app's preprod database).
//
// Run with: npm run restore-drill -- <dump-file> --target=<project-ref>
import fs from 'fs';
import { pool, ensureSchema, databaseIdentity, projectRef } from '../db/client';
import { config } from '../config';

interface BackupFile {
  createdAt: string;
  sourceProjectRef: string;
  tables: {
    merchants: Array<Record<string, unknown>>;
    sync_log: Array<Record<string, unknown>>;
    access_log: Array<Record<string, unknown>>;
  };
}

// merchants.deal_rules/backfill_status are JSONB — node-postgres formats a
// raw JS array/object parameter as a Postgres ARRAY literal by default, not
// JSON, unless it's pre-stringified. sync_log/access_log have no JSON
// columns, so this only ever applies to merchants rows.
const JSON_COLUMNS = new Set(['deal_rules', 'backfill_status']);

function prepareValue(column: string, value: unknown): unknown {
  if (JSON_COLUMNS.has(column) && value !== null && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

async function restoreTable(
  table: string,
  primaryKey: string,
  rows: Array<Record<string, unknown>>
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  for (const row of rows) {
    const columns = Object.keys(row);
    const values = columns.map((c) => prepareValue(c, row[c]));
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const result = await pool.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT (${primaryKey}) DO NOTHING`,
      values
    );
    if ((result.rowCount ?? 0) > 0) inserted++;
    else skipped++;
  }
  return { inserted, skipped };
}

async function main(): Promise<void> {
  const file = process.argv[2];
  const targetArg = process.argv.find((a) => a.startsWith('--target='));

  if (!file || file.startsWith('--')) {
    throw new Error('Usage: npm run restore-drill -- <dump-file> --target=<project-ref>');
  }
  if (!targetArg) {
    throw new Error('Refusing to restore without --target=<project-ref> naming the database you expect to write to.');
  }

  const expectedRef = targetArg.slice('--target='.length);
  const actualRef = projectRef(config.db.connectionString);
  if (expectedRef !== actualRef) {
    throw new Error(
      `--target=${expectedRef} doesn't match the currently configured database ` +
        `(${databaseIdentity(config.db.connectionString)}). Refusing to restore — check DATABASE_URL before retrying.`
    );
  }

  const dump: BackupFile = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`Restoring ${file} (dumped ${dump.createdAt} from ${dump.sourceProjectRef}) into ${databaseIdentity(config.db.connectionString)}`);

  await ensureSchema();

  const merchants = await restoreTable('merchants', 'shop_domain', dump.tables.merchants);
  const syncLog = await restoreTable('sync_log', 'id', dump.tables.sync_log);
  const accessLog = await restoreTable('access_log', 'id', dump.tables.access_log);

  console.log(`merchants: ${merchants.inserted} inserted, ${merchants.skipped} already present`);
  console.log(`sync_log: ${syncLog.inserted} inserted, ${syncLog.skipped} already present`);
  console.log(`access_log: ${accessLog.inserted} inserted, ${accessLog.skipped} already present`);
}

main()
  .catch((err) => {
    console.error('Restore drill failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
