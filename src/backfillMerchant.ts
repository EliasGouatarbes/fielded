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

export interface BackfillResult {
  customerCount: number;
  orderCount: number;
}

export async function backfillMerchant(shop: string, merchant: MerchantContext): Promise<BackfillResult> {
  console.log(`Backfilling ${shop}...`);

  const customerNodes = await fetchAllPages<GraphqlCustomerNode, CustomersQueryData>(
    shop,
    CUSTOMERS_QUERY,
    (data) => data.customers,
    {},
    250,
    'Shopify backfill customers'
  );
  const customers = customerNodes.map(mapGraphqlCustomer);
  for (const customer of customers) {
    await syncCustomer(customer, merchant);
  }

  const orderNodes = await fetchAllPages<GraphqlOrderNode, OrdersQueryData>(
    shop,
    ORDERS_QUERY,
    (data) => data.orders,
    { query: 'status:any' },
    250,
    'Shopify backfill orders'
  );
  const orders = orderNodes.map(mapGraphqlOrder);
  for (const order of orders) {
    await syncOrder(order, merchant);
  }

  console.log(`Backfill complete for ${shop}: ${customers.length} customer(s), ${orders.length} order(s).`);
  return { customerCount: customers.length, orderCount: orders.length };
}
