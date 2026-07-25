// One-time historical backfill (CLAUDE.md v1 scope + step 4): pulls every
// existing Shopify customer and order into HubSpot via the same upsert
// wrappers the webhook receiver uses, so installing on a store with existing
// history doesn't leave it stuck syncing only what happens from install day
// forward. Run with `npm run backfill`.
import { config } from '../config';
import { pool } from '../db/client';
import { fetchAllPages } from '../shopify/admin-rest';
import { syncCustomer, syncOrder, ShopifyCustomer, ShopifyOrder } from '../sync';

async function backfill(): Promise<void> {
  console.log('Fetching customers from Shopify...');
  const customers = await fetchAllPages<ShopifyCustomer>(
    `/admin/api/${config.shopify.apiVersion}/customers.json?limit=250`,
    'customers'
  );
  console.log(`Found ${customers.length} customer(s). Syncing to HubSpot...`);
  for (const customer of customers) {
    await syncCustomer(customer);
  }
  console.log(`Synced ${customers.length} customer(s).`);

  console.log('Fetching orders from Shopify...');
  const orders = await fetchAllPages<ShopifyOrder>(
    `/admin/api/${config.shopify.apiVersion}/orders.json?status=any&limit=250`,
    'orders'
  );
  console.log(`Found ${orders.length} order(s). Syncing to HubSpot...`);
  for (const order of orders) {
    await syncOrder(order);
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
