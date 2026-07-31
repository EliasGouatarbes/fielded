import { Connection, shopifyGraphqlRequest } from './admin-graphql';
import { ShopifyAddress, ShopifyCustomer, ShopifyLineItem, ShopifyOrder } from '../sync';

// The same field selection as ORDERS_QUERY's order node, just fetched by id
// instead of paginated — used by the refunds/create webhook handler
// (src/shopify/webhooks.ts) to re-fetch an order's *current* (post-refund)
// state, since the refund payload itself only carries a numeric order_id
// and no total/status fields.
const ORDER_NODE_FIELDS = `
  name
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  displayFinancialStatus
  displayFulfillmentStatus
  cancelledAt
  customer {
    id
    defaultEmailAddress { emailAddress }
    firstName
    lastName
    defaultPhoneNumber { phoneNumber }
    defaultAddress { address1 city province zip country company }
  }
  billingAddress { firstName lastName phone company address1 city province zip country }
  shippingAddress { firstName lastName phone company address1 city province zip country }
  lineItems(first: 250) {
    edges {
      node {
        title
        quantity
        sku
        variantTitle
        originalUnitPriceSet { shopMoney { amount } }
      }
    }
  }
`;

// Query field selection and the mappers below are deliberately co-located —
// they must never drift apart, since the mapper assumes exactly these
// fields were requested.

export const CUSTOMERS_QUERY = `#graphql
  query BackfillCustomers($first: Int!, $after: String) {
    customers(first: $first, after: $after) {
      edges {
        cursor
        node {
          id
          defaultEmailAddress { emailAddress }
          firstName
          lastName
          defaultPhoneNumber { phoneNumber }
          defaultAddress { address1 city province zip country company }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const ORDERS_QUERY = `#graphql
  query BackfillOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query) {
      edges {
        cursor
        node { ${ORDER_NODE_FIELDS} }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const ORDER_BY_ID_QUERY = `#graphql
  query OrderById($id: ID!) {
    order(id: $id) { ${ORDER_NODE_FIELDS} }
  }
`;

// `contactEmail` (the store's own support/business address, not a customer's)
// replaced the deprecated flat `email` field — same reasoning as the
// customer email fields above (this app targets API version 2026-07, past
// the deprecation). Queried once, right after the Shopify OAuth handshake
// (src/shopify/oauth.ts), purely so there's a way to reach a merchant
// directly later — this app has no other contact point on file for anyone.
const SHOP_QUERY = `#graphql
  query ShopContactInfo {
    shop { contactEmail }
  }
`;

interface ShopQueryData {
  shop: { contactEmail?: string | null };
}

interface GraphqlMoneyBag {
  shopMoney: { amount: string; currencyCode?: string };
}

interface GraphqlAddress {
  address1?: string | null;
  city?: string | null;
  province?: string | null;
  zip?: string | null;
  country?: string | null;
  company?: string | null;
}

export interface GraphqlCustomerNode {
  id?: string | null;
  defaultEmailAddress?: { emailAddress: string } | null;
  firstName?: string | null;
  lastName?: string | null;
  defaultPhoneNumber?: { phoneNumber: string } | null;
  defaultAddress?: GraphqlAddress | null;
}

interface GraphqlOrderAddress extends GraphqlAddress {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
}

interface GraphqlLineItemNode {
  title: string;
  quantity: number;
  sku?: string | null;
  variantTitle?: string | null;
  originalUnitPriceSet?: GraphqlMoneyBag | null;
}

export interface GraphqlOrderNode {
  name: string;
  currentTotalPriceSet?: GraphqlMoneyBag | null;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  cancelledAt?: string | null;
  customer?: GraphqlCustomerNode | null;
  billingAddress?: GraphqlOrderAddress | null;
  shippingAddress?: GraphqlOrderAddress | null;
  lineItems?: { edges: Array<{ node: GraphqlLineItemNode }> } | null;
}

export interface CustomersQueryData {
  customers: Connection<GraphqlCustomerNode>;
}

export interface OrdersQueryData {
  orders: Connection<GraphqlOrderNode>;
}

interface OrderByIdData {
  order: GraphqlOrderNode | null;
}

// GraphQL Admin API objects are addressed by a global id, not the numeric
// REST id Shopify's webhook payloads (e.g. refunds/create's `order_id`)
// carry — pure and exported so the id construction is independently
// testable without a live client.
export function orderGid(numericOrderId: number | string): string {
  return `gid://shopify/Order/${numericOrderId}`;
}

// Inverse of the above, for a customer's own id — used so a customer with
// no email (12d, functional audit) still has *something* logged in
// `sync_log` instead of vanishing with zero trace. Pure/exported for the
// same testability reason as `orderGid`.
export function numericIdFromGid(gid?: string | null): string | undefined {
  if (!gid) return undefined;
  const match = gid.match(/\/(\d+)$/);
  return match ? match[1] : undefined;
}

function mapGraphqlAddress(address?: GraphqlAddress | null): ShopifyAddress | undefined {
  if (!address) return undefined;
  return {
    address1: address.address1,
    city: address.city,
    province: address.province,
    zip: address.zip,
    country: address.country,
    company: address.company,
  };
}

export function mapGraphqlCustomer(node: GraphqlCustomerNode): ShopifyCustomer {
  return {
    id: numericIdFromGid(node.id),
    email: node.defaultEmailAddress?.emailAddress,
    first_name: node.firstName,
    last_name: node.lastName,
    phone: node.defaultPhoneNumber?.phoneNumber,
    default_address: mapGraphqlAddress(node.defaultAddress),
  };
}

function mapGraphqlLineItem(node: GraphqlLineItemNode): ShopifyLineItem {
  return {
    title: node.title,
    quantity: node.quantity,
    price: node.originalUnitPriceSet?.shopMoney?.amount,
    sku: node.sku,
    variant_title: node.variantTitle,
  };
}

function mapGraphqlOrderAddress(address?: GraphqlOrderAddress | null): ShopifyAddress | undefined {
  if (!address) return undefined;
  return {
    first_name: address.firstName,
    last_name: address.lastName,
    phone: address.phone,
    company: address.company,
    address1: address.address1,
    city: address.city,
    province: address.province,
    zip: address.zip,
    country: address.country,
  };
}

export function mapGraphqlOrder(node: GraphqlOrderNode): ShopifyOrder {
  return {
    name: node.name,
    total_price: node.currentTotalPriceSet?.shopMoney?.amount,
    currency: node.currentTotalPriceSet?.shopMoney?.currencyCode,
    customer: node.customer ? mapGraphqlCustomer(node.customer) : undefined,
    billing_address: mapGraphqlOrderAddress(node.billingAddress),
    shipping_address: mapGraphqlOrderAddress(node.shippingAddress),
    financial_status: node.displayFinancialStatus,
    fulfillment_status: node.displayFulfillmentStatus,
    cancelled_at: node.cancelledAt,
    line_items: node.lineItems?.edges.map((edge) => mapGraphqlLineItem(edge.node)),
  };
}

// Used by the refunds/create webhook handler (src/shopify/webhooks.ts) to
// re-fetch an order's current, post-refund state — the refund payload
// itself only carries a numeric order_id. Returns undefined if the order
// no longer exists (e.g. since deleted), so the caller can ack the webhook
// rather than fail it.
export async function fetchOrderById(shop: string, numericOrderId: number | string): Promise<ShopifyOrder | undefined> {
  const data = await shopifyGraphqlRequest<OrderByIdData>(
    shop,
    ORDER_BY_ID_QUERY,
    { id: orderGid(numericOrderId) },
    'Shopify fetch order by id (refund re-sync)'
  );
  return data.order ? mapGraphqlOrder(data.order) : undefined;
}

// Best-effort by design — callers should treat a failure here as non-fatal
// to onboarding (missing contact info is a worse outcome than a broken
// install). Returns undefined rather than throwing on a missing/blank email
// so callers don't need their own empty-string check.
export async function fetchShopContactEmail(shop: string): Promise<string | undefined> {
  const data = await shopifyGraphqlRequest<ShopQueryData>(shop, SHOP_QUERY, undefined, 'Shopify fetch shop contact email');
  return data.shop.contactEmail || undefined;
}
