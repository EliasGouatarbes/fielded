// Self-managed logical backup, built because Supabase's self-serve restore
// (Database -> Backups, "restore to a new project") turned out to be a
// paid-plan feature this app's free tier doesn't have — confirmed directly
// against the dashboard, not assumed. Rather than pay for a Pro plan this
// single-operator/pre-launch app doesn't otherwise need, this dumps the
// three tables this app actually owns (merchants, sync_log, access_log) to
// a local JSON file. Read-only against the source database — never writes
// anything. Pairs with restoreDrill.ts, which proves a dump is actually
// usable by restoring it into a *different* database (never the source).
//
// Run with: npm run backup
// Always dumps every row in every table — this app is single-digit
// merchants today, so there's no per-shop filtering to bother with.
//
// The output file contains real customer emails/order numbers (sync_log,
// access_log) and encrypted-but-real access tokens (merchants) — treat it
// like the database itself: never commit it (backups/ is gitignored),
// store it somewhere access-controlled, delete it once it's served its
// purpose.
import fs from 'fs';
import path from 'path';
import { pool, ensureSchema, databaseIdentity, projectRef } from '../db/client';
import { config } from '../config';

interface BackupFile {
  createdAt: string;
  sourceProjectRef: string;
  tables: {
    merchants: unknown[];
    sync_log: unknown[];
    access_log: unknown[];
  };
}

async function main(): Promise<void> {
  await ensureSchema();

  const identity = databaseIdentity(config.db.connectionString);
  console.log(`Backing up from: ${identity}`);

  const [merchants, syncLog, accessLog] = await Promise.all([
    pool.query('SELECT * FROM merchants'),
    pool.query('SELECT * FROM sync_log'),
    pool.query('SELECT * FROM access_log'),
  ]);

  const dump: BackupFile = {
    createdAt: new Date().toISOString(),
    sourceProjectRef: projectRef(config.db.connectionString),
    tables: {
      merchants: merchants.rows,
      sync_log: syncLog.rows,
      access_log: accessLog.rows,
    },
  };

  const backupsDir = path.join(__dirname, '..', '..', 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const timestamp = dump.createdAt.replace(/[:.]/g, '-');
  const outFile = path.join(backupsDir, `backup-${dump.sourceProjectRef}-${timestamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(dump, null, 2), 'utf8');

  console.log(
    `Wrote ${outFile}: ${merchants.rows.length} merchant(s), ${syncLog.rows.length} sync_log row(s), ` +
      `${accessLog.rows.length} access_log row(s).`
  );
  console.log('Contains real customer PII and access tokens (encrypted). Store securely; never commit.');
}

main()
  .catch((err) => {
    console.error('Backup failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
