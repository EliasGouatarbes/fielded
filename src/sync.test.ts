import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOrderContactName, ShopifyOrder } from './sync';

test('resolveOrderContactName prefers the billing address name over the customer profile', () => {
  const order: ShopifyOrder = {
    name: '#1009',
    customer: { email: 'test@gmail.com', first_name: 'Elias', last_name: 'Gouatarbes' },
    billing_address: { first_name: 'Test', last_name: 'Test' },
    shipping_address: { first_name: 'Test', last_name: 'Test' },
  };
  assert.deepEqual(resolveOrderContactName(order), { first_name: 'Test', last_name: 'Test' });
});

test('resolveOrderContactName falls back to the shipping address when billing has no name', () => {
  const order: ShopifyOrder = {
    name: '#1010',
    customer: { email: 'test@gmail.com', first_name: 'Elias', last_name: 'Gouatarbes' },
    billing_address: { address1: '123 Main St' },
    shipping_address: { first_name: 'Jane', last_name: 'Doe' },
  };
  assert.deepEqual(resolveOrderContactName(order), { first_name: 'Jane', last_name: 'Doe' });
});

test('resolveOrderContactName falls back to the customer profile when neither address has a name', () => {
  const order: ShopifyOrder = {
    name: '#1011',
    customer: { email: 'test@gmail.com', first_name: 'Elias', last_name: 'Gouatarbes' },
  };
  assert.deepEqual(resolveOrderContactName(order), { first_name: 'Elias', last_name: 'Gouatarbes' });
});
