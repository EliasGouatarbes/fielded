// Registers this app's Shopify webhook subscriptions for one shop — the
// reusable core of src/scripts/register-webhooks.ts, extracted so
// src/hubspot/oauth.ts's OAuth callback can also call it directly and make
// self-install actually work end to end (previously this was a CLI-only
// step nobody but the developer could run, silently leaving every new
// merchant's orders/customers un-synced after connecting).
import { config } from '../config';
import { shopifyGraphqlRequest } from './admin-graphql';

const TOPICS = ['orders/create', 'orders/updated', 'customers/create'];

// GraphQL's WebhookSubscriptionTopic enum, one per entry in TOPICS above —
// TOPICS itself stays REST-style (e.g. "orders/create") since it also drives
// the `/webhooks/shopify/${topic}` receiver path in src/shopify/webhooks.ts,
// which this migration does not touch.
const TOPIC_TO_GRAPHQL_ENUM: Record<string, string> = {
  'orders/create': 'ORDERS_CREATE',
  'orders/updated': 'ORDERS_UPDATED',
  'customers/create': 'CUSTOMERS_CREATE',
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

export async function registerWebhooksForShop(shop: string): Promise<void> {
  if (!config.server.appUrl.startsWith('https://')) {
    throw new Error(
      `APP_URL must be a real https:// URL for Shopify to call — got "${config.server.appUrl}".`
    );
  }

  const graphqlTopics = TOPICS.map((topic) => TOPIC_TO_GRAPHQL_ENUM[topic]);
  const listData = await shopifyGraphqlRequest<WebhookSubscriptionsData>(
    shop,
    LIST_QUERY,
    { topics: graphqlTopics },
    'Shopify list webhook subscriptions'
  );
  const existing = listData.webhookSubscriptions.edges.map((edge) => edge.node);

  const missing = topicsNeedingRegistration(existing, TOPICS, config.server.appUrl, TOPIC_TO_GRAPHQL_ENUM);
  const missingTopics = new Set(missing.map((m) => m.topic));

  for (const topic of TOPICS.filter((t) => !missingTopics.has(t))) {
    const address = `${config.server.appUrl}/webhooks/shopify/${topic}`;
    const alreadyRegistered = existing.find((w) => w.topic === TOPIC_TO_GRAPHQL_ENUM[topic] && w.uri === address);
    console.log(`Already registered: ${topic} -> ${address} (id ${alreadyRegistered?.id})`);
  }

  for (const { topic, graphqlTopic, address } of missing) {
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
