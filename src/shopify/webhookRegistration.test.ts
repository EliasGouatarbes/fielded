import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topicsNeedingRegistration } from './webhookRegistration';

const TOPICS = ['orders/create', 'orders/updated', 'customers/create', 'refunds/create'];
const TOPIC_TO_GRAPHQL_ENUM: Record<string, string> = {
  'orders/create': 'ORDERS_CREATE',
  'orders/updated': 'ORDERS_UPDATED',
  'customers/create': 'CUSTOMERS_CREATE',
  'refunds/create': 'REFUNDS_CREATE',
};
const APP_URL = 'https://hubshop.onrender.com';

test('topicsNeedingRegistration returns nothing when all 4 topics are already registered', () => {
  const existing = TOPICS.map((topic, i) => ({
    id: `gid://shopify/WebhookSubscription/${i}`,
    topic: TOPIC_TO_GRAPHQL_ENUM[topic],
    uri: `${APP_URL}/webhooks/shopify/${topic}`,
  }));

  const missing = topicsNeedingRegistration(existing, TOPICS, APP_URL, TOPIC_TO_GRAPHQL_ENUM);
  assert.deepEqual(missing, []);
});

test('topicsNeedingRegistration returns all 4 topics with correct enum + address when none are registered', () => {
  const missing = topicsNeedingRegistration([], TOPICS, APP_URL, TOPIC_TO_GRAPHQL_ENUM);
  assert.deepEqual(missing, [
    { topic: 'orders/create', graphqlTopic: 'ORDERS_CREATE', address: `${APP_URL}/webhooks/shopify/orders/create` },
    { topic: 'orders/updated', graphqlTopic: 'ORDERS_UPDATED', address: `${APP_URL}/webhooks/shopify/orders/updated` },
    {
      topic: 'customers/create',
      graphqlTopic: 'CUSTOMERS_CREATE',
      address: `${APP_URL}/webhooks/shopify/customers/create`,
    },
    { topic: 'refunds/create', graphqlTopic: 'REFUNDS_CREATE', address: `${APP_URL}/webhooks/shopify/refunds/create` },
  ]);
});

test('topicsNeedingRegistration returns only the missing topics on partial overlap', () => {
  const existing = [
    { id: 'gid://shopify/WebhookSubscription/1', topic: 'ORDERS_CREATE', uri: `${APP_URL}/webhooks/shopify/orders/create` },
  ];

  const missing = topicsNeedingRegistration(existing, TOPICS, APP_URL, TOPIC_TO_GRAPHQL_ENUM);
  assert.deepEqual(
    missing.map((m) => m.topic),
    ['orders/updated', 'customers/create', 'refunds/create']
  );
});

test('topicsNeedingRegistration treats a matching topic with a different uri as still missing', () => {
  const existing = [
    { id: 'gid://shopify/WebhookSubscription/1', topic: 'ORDERS_CREATE', uri: 'https://old-url.example.com/webhooks/shopify/orders/create' },
  ];

  const missing = topicsNeedingRegistration(existing, TOPICS, APP_URL, TOPIC_TO_GRAPHQL_ENUM);
  assert.ok(missing.some((m) => m.topic === 'orders/create'));
});
