// CLI entry point for src/backfillMerchant.ts — mainly useful now for
// re-running by hand if the automatic background backfill triggered by
// src/hubspot/oauth.ts's OAuth callback ever failed partway through and
// needs retrying (safe to re-run: same search-before-create upsert
// wrappers the webhook receiver uses). Run with:
// `npm run backfill -- <shop-domain>` (falls back to SHOPIFY_STORE_DOMAIN
// if omitted, for single-merchant local dev).
import { config } from '../config';
import { pool } from '../db/client';
import { normalizeShopDomain } from '../shopify/token';
import { resolveMerchantContext } from '../hubspot/tokens';
import { backfillMerchant } from '../backfillMerchant';

async function main(): Promise<void> {
  const shop = normalizeShopDomain(process.argv[2] ?? config.shopify.storeDomain);

  const merchant = await resolveMerchantContext(shop);
  if (!merchant) {
    throw new Error(`No merchant installed for ${shop}. Run the OAuth handshake at /auth/shopify?shop=${shop} first.`);
  }

  await backfillMerchant(shop, merchant);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
