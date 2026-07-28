// Historical backfill for one already-connected merchant — the reusable
// core of src/scripts/backfill.ts, extracted so src/hubspot/oauth.ts's
// OAuth callback can also trigger it directly (in the background) right
// after a merchant finishes connecting, rather than requiring the
// developer to run the CLI script by hand for every new install.
import { config } from './config';
import { fetchAllPages } from './shopify/admin-rest';
import { MerchantContext } from './hubspot/tokens';
import { syncCustomer, syncOrder, ShopifyCustomer, ShopifyOrder } from './sync';

export interface BackfillResult {
  customerCount: number;
  orderCount: number;
}

export async function backfillMerchant(shop: string, merchant: MerchantContext): Promise<BackfillResult> {
  console.log(`Backfilling ${shop}...`);

  const customers = await fetchAllPages<ShopifyCustomer>(
    shop,
    `/admin/api/${config.shopify.apiVersion}/customers.json?limit=250`,
    'customers'
  );
  for (const customer of customers) {
    await syncCustomer(customer, merchant);
  }

  const orders = await fetchAllPages<ShopifyOrder>(
    shop,
    `/admin/api/${config.shopify.apiVersion}/orders.json?status=any&limit=250`,
    'orders'
  );
  for (const order of orders) {
    await syncOrder(order, merchant);
  }

  console.log(`Backfill complete for ${shop}: ${customers.length} customer(s), ${orders.length} order(s).`);
  return { customerCount: customers.length, orderCount: orders.length };
}
