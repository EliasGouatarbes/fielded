// One-time historical backfill (CLAUDE.md v1 scope + step 4): pulls every
// existing Shopify customer and order into HubSpot via the same upsert
// wrappers the webhook receiver uses, so installing on a store with existing
// history doesn't leave it stuck syncing only what happens from install day
// forward. Run with `npm run backfill -- <shop-domain>` (falls back to
// SHOPIFY_STORE_DOMAIN if omitted, for single-merchant local dev).
import { config } from '../config';
import { pool } from '../db/client';
import { fetchAllPages } from '../shopify/admin-rest';
import { normalizeShopDomain } from '../shopify/token';
import { resolveMerchantContext } from '../hubspot/tokens';
import { syncCustomer, syncOrder, ShopifyCustomer, ShopifyOrder } from '../sync';

async function backfill(): Promise<void> {
  const shopArg = process.argv[2] ?? config.shopify.storeDomain;
  const shop = normalizeShopDomain(shopArg);

  const merchant = await resolveMerchantContext(shop);
  if (!merchant) {
    throw new Error(`No merchant installed for ${shop}. Run the OAuth handshake at /auth/shopify?shop=${shop} first.`);
  }

  console.log(`Backfilling ${shop}...`);

  console.log('Fetching customers from Shopify...');
  const customers = await fetchAllPages<ShopifyCustomer>(
    shop,
    `/admin/api/${config.shopify.apiVersion}/customers.json?limit=250`,
    'customers'
  );
  console.log(`Found ${customers.length} customer(s). Syncing to HubSpot...`);
  for (const customer of customers) {
    await syncCustomer(customer, merchant);
  }
  console.log(`Synced ${customers.length} customer(s).`);

  console.log('Fetching orders from Shopify...');
  const orders = await fetchAllPages<ShopifyOrder>(
    shop,
    `/admin/api/${config.shopify.apiVersion}/orders.json?status=any&limit=250`,
    'orders'
  );
  console.log(`Found ${orders.length} order(s). Syncing to HubSpot...`);
  for (const order of orders) {
    await syncOrder(order, merchant);
  }
  console.log(`Synced ${orders.length} order(s).`);

  console.log('Backfill complete.');
}

backfill()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
