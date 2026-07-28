// Registers this app's Shopify webhook subscriptions for one shop — the
// reusable core of src/scripts/register-webhooks.ts, extracted so
// src/hubspot/oauth.ts's OAuth callback can also call it directly and make
// self-install actually work end to end (previously this was a CLI-only
// step nobody but the developer could run, silently leaving every new
// merchant's orders/customers un-synced after connecting).
import { config } from '../config';
import { resolveShopifyAccessToken } from './token';
import { shopifyAdminRequest } from './admin-rest';
import { withRetry } from '../retry';

const TOPICS = ['orders/create', 'orders/updated', 'customers/create'];

interface ShopifyWebhook {
  id: number;
  topic: string;
  address: string;
}

export async function registerWebhooksForShop(shop: string): Promise<void> {
  if (!config.server.appUrl.startsWith('https://')) {
    throw new Error(
      `APP_URL must be a real https:// URL for Shopify to call — got "${config.server.appUrl}".`
    );
  }

  const accessToken = await resolveShopifyAccessToken(shop);
  const apiPath = `/admin/api/${config.shopify.apiVersion}/webhooks.json`;

  // Search-before-create, same as everywhere else in this app: Shopify
  // rejects a second subscription for the same (topic, address) pair, so
  // this has to be safe to re-run (e.g. a merchant reconnecting HubSpot
  // later for new scopes, as happened during this app's own line-items
  // rollout) without erroring on already-registered topics.
  const { body: existingBody } = await withRetry(() => shopifyAdminRequest(shop, apiPath, accessToken, 'GET'), {
    label: 'Shopify list webhooks',
  });
  const existing = (JSON.parse(existingBody) as { webhooks: ShopifyWebhook[] }).webhooks;

  for (const topic of TOPICS) {
    const address = `${config.server.appUrl}/webhooks/shopify/${topic}`;
    const alreadyRegistered = existing.find((w) => w.topic === topic && w.address === address);

    if (alreadyRegistered) {
      console.log(`Already registered: ${topic} -> ${address} (id ${alreadyRegistered.id})`);
      continue;
    }

    const { body: createdBody } = await withRetry(
      () =>
        shopifyAdminRequest(shop, apiPath, accessToken, 'POST', {
          webhook: { topic, address, format: 'json' },
        }),
      { label: `Shopify create webhook (${topic})` }
    );
    const created = (JSON.parse(createdBody) as { webhook: ShopifyWebhook }).webhook;
    console.log(`Registered: ${topic} -> ${address} (id ${created.id})`);
  }
}
