import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topicsNeedingRegistration, deriveWebhookStatus, findStaleSubscription } from './webhookRegistration';

const TOPICS = [
  'orders/create',
  'orders/updated',
  'customers/create',
  'refunds/create',
  'orders/delete',
  'customers/delete',
];
const TOPIC_TO_GRAPHQL_ENUM: Record<string, string> = {
  'orders/create': 'ORDERS_CREATE',
  'orders/updated': 'ORDERS_UPDATED',
  'customers/create': 'CUSTOMERS_CREATE',
  'refunds/create': 'REFUNDS_CREATE',
  'orders/delete': 'ORDERS_DELETE',
  'customers/delete': 'CUSTOMERS_DELETE',
};
const APP_URL = 'https://hubshop.onrender.com';

test('topicsNeedingRegistration returns nothing when all 6 topics are already registered', () => {
  const existing = TOPICS.map((topic, i) => ({
    id: `gid://shopify/WebhookSubscription/${i}`,
    topic: TOPIC_TO_GRAPHQL_ENUM[topic],
    uri: `${APP_URL}/webhooks/shopify/${topic}`,
  }));

  const missing = topicsNeedingRegistration(existing, TOPICS, APP_URL, TOPIC_TO_GRAPHQL_ENUM);
  assert.deepEqual(missing, []);
});

test('topicsNeedingRegistration returns all 6 topics with correct enum + address when none are registered', () => {
  const missing = topicsNeedingRegistration([], TOPICS, APP_URL, TOPIC_TO_GRAPHQL_ENUM);
  assert.deepEqual(
    missing,
    TOPICS.map((topic) => ({
      topic,
      graphqlTopic: TOPIC_TO_GRAPHQL_ENUM[topic],
      address: `${APP_URL}/webhooks/shopify/${topic}`,
    }))
  );
});

test('topicsNeedingRegistration returns only the missing topics on partial overlap', () => {
  const existing = [
    { id: 'gid://shopify/WebhookSubscription/1', topic: 'ORDERS_CREATE', uri: `${APP_URL}/webhooks/shopify/orders/create` },
  ];

  const missing = topicsNeedingRegistration(existing, TOPICS, APP_URL, TOPIC_TO_GRAPHQL_ENUM);
  assert.deepEqual(
    missing.map((m) => m.topic),
    ['orders/updated', 'customers/create', 'refunds/create', 'orders/delete', 'customers/delete']
  );
});

test('topicsNeedingRegistration treats a matching topic with a different uri as still missing', () => {
  const existing = [
    { id: 'gid://shopify/WebhookSubscription/1', topic: 'ORDERS_CREATE', uri: 'https://old-url.example.com/webhooks/shopify/orders/create' },
  ];

  const missing = topicsNeedingRegistration(existing, TOPICS, APP_URL, TOPIC_TO_GRAPHQL_ENUM);
  assert.ok(missing.some((m) => m.topic === 'orders/create'));
});

test('deriveWebhookStatus reports every topic unregistered when nothing exists', () => {
  const status = deriveWebhookStatus([], TOPICS, APP_URL, TOPIC_TO_GRAPHQL_ENUM);
  assert.deepEqual(status, TOPICS.map((topic) => ({ topic, registered: false })));
});

test('deriveWebhookStatus reports every topic registered when all match', () => {
  const existing = TOPICS.map((topic, i) => ({
    id: `gid://shopify/WebhookSubscription/${i}`,
    topic: TOPIC_TO_GRAPHQL_ENUM[topic],
    uri: `${APP_URL}/webhooks/shopify/${topic}`,
  }));

  const status = deriveWebhookStatus(existing, TOPICS, APP_URL, TOPIC_TO_GRAPHQL_ENUM);
  assert.deepEqual(status, TOPICS.map((topic) => ({ topic, registered: true })));
});

test('deriveWebhookStatus reports a mix on partial overlap', () => {
  const existing = [
    { id: 'gid://shopify/WebhookSubscription/1', topic: 'ORDERS_CREATE', uri: `${APP_URL}/webhooks/shopify/orders/create` },
    { id: 'gid://shopify/WebhookSubscription/2', topic: 'CUSTOMERS_CREATE', uri: `${APP_URL}/webhooks/shopify/customers/create` },
  ];

  const status = deriveWebhookStatus(existing, TOPICS, APP_URL, TOPIC_TO_GRAPHQL_ENUM);
  assert.deepEqual(status, [
    { topic: 'orders/create', registered: true },
    { topic: 'orders/updated', registered: false },
    { topic: 'customers/create', registered: true },
    { topic: 'refunds/create', registered: false },
    { topic: 'orders/delete', registered: false },
    { topic: 'customers/delete', registered: false },
  ]);
});

test('deriveWebhookStatus treats a stale registration (wrong uri) as not registered', () => {
  const existing = [
    { id: 'gid://shopify/WebhookSubscription/1', topic: 'ORDERS_CREATE', uri: 'https://old-url.example.com/webhooks/shopify/orders/create' },
  ];

  const status = deriveWebhookStatus(existing, TOPICS, APP_URL, TOPIC_TO_GRAPHQL_ENUM);
  const ordersCreate = status.find((s) => s.topic === 'orders/create');
  assert.equal(ordersCreate?.registered, false);
});

test('findStaleSubscription finds an existing registration for the topic regardless of its uri', () => {
  const existing = [
    { id: 'gid://shopify/WebhookSubscription/1', topic: 'ORDERS_CREATE', uri: 'https://old-url.example.com/webhooks/shopify/orders/create' },
  ];
  const stale = findStaleSubscription(existing, 'ORDERS_CREATE');
  assert.equal(stale?.id, 'gid://shopify/WebhookSubscription/1');
});

test('findStaleSubscription returns undefined when no subscription exists for the topic', () => {
  const existing = [
    { id: 'gid://shopify/WebhookSubscription/1', topic: 'ORDERS_CREATE', uri: `${APP_URL}/webhooks/shopify/orders/create` },
  ];
  assert.equal(findStaleSubscription(existing, 'CUSTOMERS_CREATE'), undefined);
});
