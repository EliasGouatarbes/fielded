import { Connection } from './admin-graphql';
import { ShopifyAddress, ShopifyCustomer, ShopifyLineItem, ShopifyOrder } from '../sync';

// Query field selection and the mappers below are deliberately co-located —
// they must never drift apart, since the mapper assumes exactly these
// fields were requested.

export const CUSTOMERS_QUERY = `#graphql
  query BackfillCustomers($first: Int!, $after: String) {
    customers(first: $first, after: $after) {
      edges {
        cursor
        node {
          defaultEmailAddress { emailAddress }
          firstName
          lastName
          defaultPhoneNumber { phoneNumber }
          defaultAddress { address1 city province zip country }
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
        node {
          name
          currentTotalPriceSet { shopMoney { amount } }
          displayFinancialStatus
          displayFulfillmentStatus
          cancelledAt
          customer {
            defaultEmailAddress { emailAddress }
            firstName
            lastName
            defaultPhoneNumber { phoneNumber }
            defaultAddress { address1 city province zip country }
          }
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
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface GraphqlMoneyBag {
  shopMoney: { amount: string };
}

interface GraphqlAddress {
  address1?: string | null;
  city?: string | null;
  province?: string | null;
  zip?: string | null;
  country?: string | null;
}

export interface GraphqlCustomerNode {
  defaultEmailAddress?: { emailAddress: string } | null;
  firstName?: string | null;
  lastName?: string | null;
  defaultPhoneNumber?: { phoneNumber: string } | null;
  defaultAddress?: GraphqlAddress | null;
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
  lineItems?: { edges: Array<{ node: GraphqlLineItemNode }> } | null;
}

export interface CustomersQueryData {
  customers: Connection<GraphqlCustomerNode>;
}

export interface OrdersQueryData {
  orders: Connection<GraphqlOrderNode>;
}

function mapGraphqlAddress(address?: GraphqlAddress | null): ShopifyAddress | undefined {
  if (!address) return undefined;
  return {
    address1: address.address1,
    city: address.city,
    province: address.province,
    zip: address.zip,
    country: address.country,
  };
}

export function mapGraphqlCustomer(node: GraphqlCustomerNode): ShopifyCustomer {
  return {
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

export function mapGraphqlOrder(node: GraphqlOrderNode): ShopifyOrder {
  return {
    name: node.name,
    total_price: node.currentTotalPriceSet?.shopMoney?.amount,
    customer: node.customer ? mapGraphqlCustomer(node.customer) : undefined,
    financial_status: node.displayFinancialStatus,
    fulfillment_status: node.displayFulfillmentStatus,
    cancelled_at: node.cancelledAt,
    line_items: node.lineItems?.edges.map((edge) => mapGraphqlLineItem(edge.node)),
  };
}
