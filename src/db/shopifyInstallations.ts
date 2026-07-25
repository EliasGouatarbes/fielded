import { pool, ensureSchema } from './client';

export async function getStoredAccessToken(shopDomain: string): Promise<string | null> {
  await ensureSchema();
  const result = await pool.query<{ access_token: string }>(
    'SELECT access_token FROM shopify_installations WHERE shop_domain = $1',
    [shopDomain]
  );
  return result.rows[0]?.access_token ?? null;
}

export async function saveAccessToken(shopDomain: string, accessToken: string): Promise<void> {
  await ensureSchema();
  await pool.query(
    `INSERT INTO shopify_installations (shop_domain, access_token, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (shop_domain) DO UPDATE SET access_token = EXCLUDED.access_token, updated_at = now()`,
    [shopDomain, accessToken]
  );
}
