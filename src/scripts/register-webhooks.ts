// One-time webhook subscription registration (CLAUDE.md step 8, first
// task): tells Shopify to actually call this app's webhook receiver.
// Requires a real https:// address (Shopify rejects localhost), so this
// could only happen after step 7's deploy. Run with, e.g.:
// APP_URL=https://hubshop.onrender.com npm run register-webhooks -- <shop-domain>
// (falls back to SHOPIFY_STORE_DOMAIN if the shop arg is omitted, for
// single-merchant local dev).
import { config } from '../config';
import { pool } from '../db/client';
import { resolveShopifyAccessToken, normalizeShopDomain } from '../shopify/token';
import { shopifyAdminRequest } from '../shopify/admin-rest';
import { withRetry } from '../retry';

const TOPICS = ['orders/create', 'orders/updated', 'customers/create'];

interface ShopifyWebhook {
  id: number;
  topic: string;
  address: string;
}

async function registerWebhooks(): Promise<void> {
  if (!config.server.appUrl.startsWith('https://')) {
    throw new Error(
      `APP_URL must be a real https:// URL for Shopify to call — got "${config.server.appUrl}". ` +
        `Run with e.g.: APP_URL=https://hubshop.onrender.com npm run register-webhooks -- <shop-domain>`
    );
  }

  const shop = normalizeShopDomain(process.argv[2] ?? config.shopify.storeDomain);
  const accessToken = await resolveShopifyAccessToken(shop);
  const apiPath = `/admin/api/${config.shopify.apiVersion}/webhooks.json`;

  // Search-before-create, same as everywhere else in this app: Shopify
  // rejects a second subscription for the same (topic, address) pair, so
  // this has to be safe to re-run without erroring on already-registered
  // topics.
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

  console.log('Done.');
}

registerWebhooks()
  .catch((err) => {
    console.error('Failed to register webhooks:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
