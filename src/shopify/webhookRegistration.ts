// Registers this app's Shopify webhook subscriptions for one shop — the
// reusable core of src/scripts/register-webhooks.ts, extracted so
// src/hubspot/oauth.ts's OAuth callback can also call it directly and make
// self-install actually work end to end (previously this was a CLI-only
// step nobody but the developer could run, silently leaving every new
// merchant's orders/customers un-synced after connecting).
import { config } from '../config';
import { shopifyGraphqlRequest } from './admin-graphql';

// refunds/create closes 10e (CLAUDE.md pre-launch audit): without it, a
// refunded order's Deal kept its pre-refund amount/stage indefinitely on
// the live webhook path (the historical backfill already picks refunds up
// via GraphQL's currentTotalPriceSet, but a merchant shouldn't have to wait
// for a backfill re-run). orders/delete + customers/delete close 12g
// (functional audit): without them, deleting an order/customer in Shopify
// left the corresponding HubSpot Deal/Contact orphaned with zero
// indication anything changed — see src/shopify/webhooks.ts for what these
// two actually do (log only, deliberately never touch the HubSpot record).
// app_subscriptions/update is billing (src/shopify/billing.ts): a merchant
// can cancel their subscription entirely from Shopify's own billing
// settings, outside this app's control — without this topic there'd be no
// way to find out, and syncing would keep running for free indefinitely.
const TOPICS = [
  'orders/create',
  'orders/updated',
  'customers/create',
  'refunds/create',
  'orders/delete',
  'customers/delete',
  'app_subscriptions/update',
];

// GraphQL's WebhookSubscriptionTopic enum, one per entry in TOPICS above —
// TOPICS itself stays REST-style (e.g. "orders/create") since it also drives
// the `/webhooks/shopify/${topic}` receiver path in src/shopify/webhooks.ts,
// which this migration does not touch.
const TOPIC_TO_GRAPHQL_ENUM: Record<string, string> = {
  'orders/create': 'ORDERS_CREATE',
  'orders/updated': 'ORDERS_UPDATED',
  'customers/create': 'CUSTOMERS_CREATE',
  'refunds/create': 'REFUNDS_CREATE',
  'orders/delete': 'ORDERS_DELETE',
  'customers/delete': 'CUSTOMERS_DELETE',
  'app_subscriptions/update': 'APP_SUBSCRIPTIONS_UPDATE',
};

interface ShopifyWebhookNode {
  id: string;
  topic: string;
  uri: string;
}

interface WebhookSubscriptionsData {
  webhookSubscriptions: { edges: Array<{ node: ShopifyWebhookNode }> };
}

interface WebhookSubscriptionCreateData {
  webhookSubscriptionCreate: {
    webhookSubscription: ShopifyWebhookNode | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}

interface WebhookSubscriptionUpdateData {
  webhookSubscriptionUpdate: {
    webhookSubscription: ShopifyWebhookNode | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}

const LIST_QUERY = `#graphql
  query ExistingWebhookSubscriptions($topics: [WebhookSubscriptionTopic!]) {
    webhookSubscriptions(first: 25, topics: $topics) {
      edges { node { id topic uri } }
    }
  }
`;

// `uri` is the current WebhookSubscriptionInput field for the callback
// address — `callbackUrl` also exists but is deprecated in favor of it.
const CREATE_MUTATION = `#graphql
  mutation CreateWebhookSubscription($topic: WebhookSubscriptionTopic!, $uri: String!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) {
      webhookSubscription { id topic uri }
      userErrors { field message }
    }
  }
`;

// Fixes a real duplication risk found in the pre-launch audit (2026-07-29):
// if APP_URL ever drifts from the address Shopify actually has on file for a
// topic (a custom-domain migration, a Render URL change), calling
// webhookSubscriptionCreate again doesn't fix the stale one — Shopify allows
// multiple subscriptions per topic, so it silently adds a second, leaving
// the first (now-dead) one still registered. Updating the existing
// subscription's `uri` in place is the correct fix for a stale registration.
const UPDATE_MUTATION = `#graphql
  mutation UpdateWebhookSubscription($id: ID!, $uri: String!) {
    webhookSubscriptionUpdate(id: $id, webhookSubscription: { uri: $uri, format: JSON }) {
      webhookSubscription { id topic uri }
      userErrors { field message }
    }
  }
`;

// Pure decision logic, independently unit-testable: given what's already
// registered, returns only the topics that still need creating. Search-
// before-create, same as everywhere else in this app — has to be safe to
// re-run (e.g. a merchant reconnecting HubSpot later for new scopes, as
// happened during this app's own line-items rollout) without erroring on
// already-registered topics.
export function topicsNeedingRegistration(
  existing: ShopifyWebhookNode[],
  topics: string[],
  appUrl: string,
  topicToEnum: Record<string, string>
): Array<{ topic: string; graphqlTopic: string; address: string }> {
  return topics
    .map((topic) => ({
      topic,
      graphqlTopic: topicToEnum[topic],
      address: `${appUrl}/webhooks/shopify/${topic}`,
    }))
    .filter(({ graphqlTopic, address }) => !existing.some((w) => w.topic === graphqlTopic && w.uri === address));
}

// A topic "needing registration" (topicsNeedingRegistration above) either has
// no subscription at all (real create case) or one at a stale address (needs
// updating in place, not a second create — see UPDATE_MUTATION's comment).
// Exported separately so this distinction is unit-testable without a live
// call.
export function findStaleSubscription(
  existing: ShopifyWebhookNode[],
  graphqlTopic: string
): ShopifyWebhookNode | undefined {
  return existing.find((w) => w.topic === graphqlTopic);
}

// Shared by registerWebhooksForShop (below) and getWebhookRegistrationStatus
// — one GraphQL call site instead of two.
async function listExistingSubscriptions(shop: string): Promise<ShopifyWebhookNode[]> {
  const graphqlTopics = TOPICS.map((topic) => TOPIC_TO_GRAPHQL_ENUM[topic]);
  const listData = await shopifyGraphqlRequest<WebhookSubscriptionsData>(
    shop,
    LIST_QUERY,
    { topics: graphqlTopics },
    'Shopify list webhook subscriptions'
  );
  return listData.webhookSubscriptions.edges.map((edge) => edge.node);
}

// Pure, unit-testable: which of `topics` are already registered? Reuses
// topicsNeedingRegistration's own match logic (a topic is "registered" iff
// it's NOT in that function's "missing" output) so the two can't drift
// apart. Powers the dashboard's status view (src/server.ts's
// GET /merchants/:shop/status) — a stale registration (topic present but
// pointing at an old address) correctly shows as not registered, same as
// topicsNeedingRegistration already treats it as needing re-creation.
export function deriveWebhookStatus(
  existing: ShopifyWebhookNode[],
  topics: string[],
  appUrl: string,
  topicToEnum: Record<string, string>
): Array<{ topic: string; registered: boolean }> {
  const missing = new Set(topicsNeedingRegistration(existing, topics, appUrl, topicToEnum).map((m) => m.topic));
  return topics.map((topic) => ({ topic, registered: !missing.has(topic) }));
}

// Read-only status check — unlike registerWebhooksForShop, this has no
// APP_URL-must-be-https guard, since it needs to work (and report the true
// mismatch) in local dev too.
export async function getWebhookRegistrationStatus(
  shop: string
): Promise<Array<{ topic: string; registered: boolean }>> {
  const existing = await listExistingSubscriptions(shop);
  return deriveWebhookStatus(existing, TOPICS, config.server.appUrl, TOPIC_TO_GRAPHQL_ENUM);
}

export async function registerWebhooksForShop(shop: string): Promise<void> {
  if (!config.server.appUrl.startsWith('https://')) {
    throw new Error(
      `APP_URL must be a real https:// URL for Shopify to call — got "${config.server.appUrl}".`
    );
  }

  const existing = await listExistingSubscriptions(shop);

  const missing = topicsNeedingRegistration(existing, TOPICS, config.server.appUrl, TOPIC_TO_GRAPHQL_ENUM);
  const missingTopics = new Set(missing.map((m) => m.topic));

  for (const topic of TOPICS.filter((t) => !missingTopics.has(t))) {
    const address = `${config.server.appUrl}/webhooks/shopify/${topic}`;
    const alreadyRegistered = existing.find((w) => w.topic === TOPIC_TO_GRAPHQL_ENUM[topic] && w.uri === address);
    console.log(`Already registered: ${topic} -> ${address} (id ${alreadyRegistered?.id})`);
  }

  for (const { topic, graphqlTopic, address } of missing) {
    const stale = findStaleSubscription(existing, graphqlTopic);
    if (stale) {
      const updateData = await shopifyGraphqlRequest<WebhookSubscriptionUpdateData>(
        shop,
        UPDATE_MUTATION,
        { id: stale.id, uri: address },
        `Shopify update webhook (${topic})`
      );
      const { webhookSubscription, userErrors } = updateData.webhookSubscriptionUpdate;
      if (userErrors.length > 0) {
        throw new Error(
          `Failed to update webhook subscription for ${topic}: ${userErrors.map((e) => e.message).join('; ')}`
        );
      }
      console.log(`Updated stale registration: ${topic} -> ${address} (id ${webhookSubscription?.id}, was ${stale.uri})`);
      continue;
    }

    const createData = await shopifyGraphqlRequest<WebhookSubscriptionCreateData>(
      shop,
      CREATE_MUTATION,
      { topic: graphqlTopic, uri: address },
      `Shopify create webhook (${topic})`
    );
    const { webhookSubscription, userErrors } = createData.webhookSubscriptionCreate;
    if (userErrors.length > 0) {
      throw new Error(
        `Failed to create webhook subscription for ${topic}: ${userErrors.map((e) => e.message).join('; ')}`
      );
    }
    console.log(`Registered: ${topic} -> ${address} (id ${webhookSubscription?.id})`);
  }
}
