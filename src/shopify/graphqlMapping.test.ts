import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapGraphqlCustomer,
  mapGraphqlOrder,
  orderGid,
  numericIdFromGid,
  GraphqlCustomerNode,
  GraphqlOrderNode,
} from './graphqlMapping';

test('orderGid builds a GraphQL global id from a numeric REST order id', () => {
  assert.equal(orderGid(6000123456789), 'gid://shopify/Order/6000123456789');
  assert.equal(orderGid('6000123456789'), 'gid://shopify/Order/6000123456789');
});

test('numericIdFromGid extracts the trailing numeric id from a global id', () => {
  assert.equal(numericIdFromGid('gid://shopify/Customer/7123456789'), '7123456789');
});

test('numericIdFromGid returns undefined for a missing or malformed value', () => {
  assert.equal(numericIdFromGid(undefined), undefined);
  assert.equal(numericIdFromGid(null), undefined);
  assert.equal(numericIdFromGid(''), undefined);
  assert.equal(numericIdFromGid('not-a-gid'), undefined);
});

test('mapGraphqlCustomer maps a fully-populated node', () => {
  const node: GraphqlCustomerNode = {
    id: 'gid://shopify/Customer/7123456789',
    defaultEmailAddress: { emailAddress: 'jane@example.com' },
    firstName: 'Jane',
    lastName: 'Doe',
    defaultPhoneNumber: { phoneNumber: '+15551234567' },
    defaultAddress: { address1: '123 Main St', city: 'Springfield', province: 'IL', zip: '62704', country: 'US', company: 'Acme Inc' },
  };

  assert.deepEqual(mapGraphqlCustomer(node), {
    id: '7123456789',
    email: 'jane@example.com',
    first_name: 'Jane',
    last_name: 'Doe',
    phone: '+15551234567',
    default_address: { address1: '123 Main St', city: 'Springfield', province: 'IL', zip: '62704', country: 'US', company: 'Acme Inc' },
  });
});

test('mapGraphqlCustomer handles missing nested fields', () => {
  const node: GraphqlCustomerNode = { firstName: 'Jane', lastName: null };
  const mapped = mapGraphqlCustomer(node);
  assert.equal(mapped.email, undefined);
  assert.equal(mapped.phone, undefined);
  assert.equal(mapped.default_address, undefined);
  assert.equal(mapped.first_name, 'Jane');
});

test('mapGraphqlOrder maps a fully-populated node with line items', () => {
  const node: GraphqlOrderNode = {
    name: '#1001',
    currentTotalPriceSet: { shopMoney: { amount: '42.50', currencyCode: 'EUR' } },
    displayFinancialStatus: 'paid',
    displayFulfillmentStatus: 'fulfilled',
    cancelledAt: null,
    customer: { firstName: 'Jane', defaultEmailAddress: { emailAddress: 'jane@example.com' } },
    billingAddress: {
      firstName: 'John',
      lastName: 'Smith',
      phone: '+358401112222',
      company: 'Acme Oy',
      address1: '456 Side St',
      city: 'Turku',
      province: null,
      zip: '20100',
      country: 'Finland',
    },
    shippingAddress: {
      firstName: 'John',
      lastName: 'Smith',
      phone: '+358401112222',
      company: 'Acme Oy',
      address1: '456 Side St',
      city: 'Turku',
      province: null,
      zip: '20100',
      country: 'Finland',
    },
    lineItems: {
      edges: [
        {
          node: {
            title: 'T-Shirt',
            quantity: 2,
            sku: 'TSHIRT-1',
            variantTitle: 'Large / Blue',
            originalUnitPriceSet: { shopMoney: { amount: '20.00' } },
          },
        },
        {
          node: {
            title: 'Sticker Pack',
            quantity: 1,
            sku: null,
            variantTitle: null,
            originalUnitPriceSet: { shopMoney: { amount: '2.50' } },
          },
        },
      ],
    },
  };

  const mapped = mapGraphqlOrder(node);
  assert.equal(mapped.name, '#1001');
  assert.equal(mapped.total_price, '42.50');
  assert.equal(mapped.currency, 'EUR');
  assert.equal(mapped.financial_status, 'paid');
  assert.equal(mapped.fulfillment_status, 'fulfilled');
  assert.equal(mapped.cancelled_at, null);
  assert.equal(mapped.customer?.email, 'jane@example.com');
  const expectedAddress = {
    first_name: 'John',
    last_name: 'Smith',
    phone: '+358401112222',
    company: 'Acme Oy',
    address1: '456 Side St',
    city: 'Turku',
    province: null,
    zip: '20100',
    country: 'Finland',
  };
  assert.deepEqual(mapped.billing_address, expectedAddress);
  assert.deepEqual(mapped.shipping_address, expectedAddress);
  assert.deepEqual(mapped.line_items, [
    { title: 'T-Shirt', quantity: 2, price: '20.00', sku: 'TSHIRT-1', variant_title: 'Large / Blue' },
    { title: 'Sticker Pack', quantity: 1, price: '2.50', sku: null, variant_title: null },
  ]);
});

test('mapGraphqlOrder handles a missing customer and no line items', () => {
  const node: GraphqlOrderNode = { name: '#1002' };
  const mapped = mapGraphqlOrder(node);
  assert.equal(mapped.customer, undefined);
  assert.equal(mapped.billing_address, undefined);
  assert.equal(mapped.shipping_address, undefined);
  assert.equal(mapped.line_items, undefined);
  assert.equal(mapped.total_price, undefined);
});
