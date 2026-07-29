// Historical backfill for one already-connected merchant — the reusable
// core of src/scripts/backfill.ts, extracted so src/hubspot/oauth.ts's
// OAuth callback can also trigger it directly (in the background) right
// after a merchant finishes connecting, rather than requiring the
// developer to run the CLI script by hand for every new install.
import { fetchAllPages } from './shopify/admin-graphql';
import {
  CUSTOMERS_QUERY,
  ORDERS_QUERY,
  mapGraphqlCustomer,
  mapGraphqlOrder,
  GraphqlCustomerNode,
  GraphqlOrderNode,
  CustomersQueryData,
  OrdersQueryData,
} from './shopify/graphqlMapping';
import { MerchantContext } from './hubspot/tokens';
import { syncCustomer, syncOrder } from './sync';
import { mapWithConcurrency } from './concurrency';
import { saveBackfillStatus } from './db/merchants';

export interface BackfillResult {
  customerCount: number;
  orderCount: number;
}

// Matches the concurrency level this app's own contact/deal upsert path was
// already stress-tested against (CLAUDE.md step 8's 5-concurrent-call
// test) — not chosen arbitrarily.
const BACKFILL_CONCURRENCY = 5;

// Persists status at each transition (12b, functional audit) so a merchant
// can actually see this finished — previously the onboarding page's "⏳
// running" never updated and there was no way to know completion short of
// reading server logs. Errors still propagate to the caller unchanged (the
// OAuth callback logs them, the CLI script surfaces them) — this only adds
// visibility, it doesn't change failure handling.
export async function backfillMerchant(shop: string, merchant: MerchantContext): Promise<BackfillResult> {
  const startedAt = new Date().toISOString();
  await saveBackfillStatus(shop, { status: 'running', startedAt });
  console.log(`Backfilling ${shop}...`);

  try {
    const customerNodes = await fetchAllPages<GraphqlCustomerNode, CustomersQueryData>(
      shop,
      CUSTOMERS_QUERY,
      (data) => data.customers,
      {},
      250,
      'Shopify backfill customers'
    );
    const customers = customerNodes.map(mapGraphqlCustomer);
    await mapWithConcurrency(customers, BACKFILL_CONCURRENCY, (customer) => syncCustomer(customer, merchant));

    const orderNodes = await fetchAllPages<GraphqlOrderNode, OrdersQueryData>(
      shop,
      ORDERS_QUERY,
      (data) => data.orders,
      { query: 'status:any' },
      250,
      'Shopify backfill orders'
    );
    const orders = orderNodes.map(mapGraphqlOrder);
    await mapWithConcurrency(orders, BACKFILL_CONCURRENCY, (order) => syncOrder(order, merchant));

    await saveBackfillStatus(shop, {
      status: 'complete',
      startedAt,
      completedAt: new Date().toISOString(),
      customerCount: customers.length,
      orderCount: orders.length,
    });
    console.log(`Backfill complete for ${shop}: ${customers.length} customer(s), ${orders.length} order(s).`);
    return { customerCount: customers.length, orderCount: orders.length };
  } catch (err) {
    await saveBackfillStatus(shop, {
      status: 'failed',
      startedAt,
      completedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
