import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOrderContact, ShopifyOrder } from './sync';

test('resolveOrderContact prefers the billing address name, phone, and address over the customer profile', () => {
  const order: ShopifyOrder = {
    name: '#1009',
    customer: {
      email: 'test@gmail.com',
      first_name: 'Elias',
      last_name: 'Gouatarbes',
      phone: '+358 40 000 0000',
      default_address: { address1: 'Fredrikinkatu 24', city: 'Helsinki', country: 'Finland' },
    },
    billing_address: {
      first_name: 'Test',
      last_name: 'Test',
      phone: '+358 40 111 1111',
      address1: 'Testing street',
      city: 'Helsinki',
      zip: '00300',
      country: 'Finland',
    },
    shipping_address: {
      first_name: 'Test',
      last_name: 'Test',
      phone: '+358 40 111 1111',
      address1: 'Testing street',
      city: 'Helsinki',
      zip: '00300',
      country: 'Finland',
    },
  };
  assert.deepEqual(resolveOrderContact(order), {
    first_name: 'Test',
    last_name: 'Test',
    phone: '+358 40 111 1111',
    default_address: { address1: 'Testing street', city: 'Helsinki', province: undefined, zip: '00300', country: 'Finland' },
  });
});

test('resolveOrderContact falls back to the shipping address when billing has nothing', () => {
  const order: ShopifyOrder = {
    name: '#1010',
    customer: { email: 'test@gmail.com', first_name: 'Elias', last_name: 'Gouatarbes' },
    billing_address: undefined,
    shipping_address: {
      first_name: 'Jane',
      last_name: 'Doe',
      phone: '+358 40 222 2222',
      address1: '456 Side St',
      city: 'Turku',
      zip: '20100',
      country: 'Finland',
    },
  };
  assert.deepEqual(resolveOrderContact(order), {
    first_name: 'Jane',
    last_name: 'Doe',
    phone: '+358 40 222 2222',
    default_address: { address1: '456 Side St', city: 'Turku', province: undefined, zip: '20100', country: 'Finland' },
  });
});

test('resolveOrderContact falls back to the customer profile when neither address has anything', () => {
  const order: ShopifyOrder = {
    name: '#1011',
    customer: { email: 'test@gmail.com', first_name: 'Elias', last_name: 'Gouatarbes', phone: '+358 40 000 0000' },
  };
  assert.deepEqual(resolveOrderContact(order), { first_name: 'Elias', last_name: 'Gouatarbes', phone: '+358 40 000 0000' });
});

test('resolveOrderContact fills a missing address-block name/phone from the customer profile', () => {
  const order: ShopifyOrder = {
    name: '#1012',
    customer: { email: 'test@gmail.com', first_name: 'Elias', last_name: 'Gouatarbes', phone: '+358 40 000 0000' },
    billing_address: { address1: 'Testing street', city: 'Helsinki', zip: '00300', country: 'Finland' },
  };
  const resolved = resolveOrderContact(order);
  assert.equal(resolved.first_name, 'Elias');
  assert.equal(resolved.last_name, 'Gouatarbes');
  assert.equal(resolved.phone, '+358 40 000 0000');
  assert.equal(resolved.default_address?.address1, 'Testing street');
});

test('resolveOrderContact picks the order address block on phone alone, even with no name/address', () => {
  const order: ShopifyOrder = {
    name: '#1013',
    customer: { email: 'test@gmail.com', first_name: 'Elias', last_name: 'Gouatarbes', phone: '+358 40 000 0000' },
    billing_address: { phone: '+358 40 333 3333' },
  };
  const resolved = resolveOrderContact(order);
  assert.equal(resolved.phone, '+358 40 333 3333');
});
