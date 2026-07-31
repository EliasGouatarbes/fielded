import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOrderContact, ShopifyOrder } from './sync';

test('resolveOrderContact prefers the billing address name and address over the customer profile', () => {
  const order: ShopifyOrder = {
    name: '#1009',
    customer: {
      email: 'test@gmail.com',
      first_name: 'Elias',
      last_name: 'Gouatarbes',
      default_address: { address1: 'Fredrikinkatu 24', city: 'Helsinki', country: 'Finland' },
    },
    billing_address: { first_name: 'Test', last_name: 'Test', address1: 'Testing street', city: 'Helsinki', zip: '00300', country: 'Finland' },
    shipping_address: { first_name: 'Test', last_name: 'Test', address1: 'Testing street', city: 'Helsinki', zip: '00300', country: 'Finland' },
  };
  assert.deepEqual(resolveOrderContact(order), {
    first_name: 'Test',
    last_name: 'Test',
    default_address: { address1: 'Testing street', city: 'Helsinki', province: undefined, zip: '00300', country: 'Finland' },
  });
});

test('resolveOrderContact falls back to the shipping address when billing has nothing', () => {
  const order: ShopifyOrder = {
    name: '#1010',
    customer: { email: 'test@gmail.com', first_name: 'Elias', last_name: 'Gouatarbes' },
    billing_address: undefined,
    shipping_address: { first_name: 'Jane', last_name: 'Doe', address1: '456 Side St', city: 'Turku', zip: '20100', country: 'Finland' },
  };
  assert.deepEqual(resolveOrderContact(order), {
    first_name: 'Jane',
    last_name: 'Doe',
    default_address: { address1: '456 Side St', city: 'Turku', province: undefined, zip: '20100', country: 'Finland' },
  });
});

test('resolveOrderContact falls back to the customer profile when neither address has anything', () => {
  const order: ShopifyOrder = {
    name: '#1011',
    customer: { email: 'test@gmail.com', first_name: 'Elias', last_name: 'Gouatarbes' },
  };
  assert.deepEqual(resolveOrderContact(order), { first_name: 'Elias', last_name: 'Gouatarbes' });
});

test('resolveOrderContact fills a missing address-block name from the customer profile', () => {
  const order: ShopifyOrder = {
    name: '#1012',
    customer: { email: 'test@gmail.com', first_name: 'Elias', last_name: 'Gouatarbes' },
    billing_address: { address1: 'Testing street', city: 'Helsinki', zip: '00300', country: 'Finland' },
  };
  const resolved = resolveOrderContact(order);
  assert.equal(resolved.first_name, 'Elias');
  assert.equal(resolved.last_name, 'Gouatarbes');
  assert.equal(resolved.default_address?.address1, 'Testing street');
});
