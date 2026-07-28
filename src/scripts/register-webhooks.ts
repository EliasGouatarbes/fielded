// CLI entry point for src/shopify/webhookRegistration.ts — mainly useful
// now for re-running by hand against a shop if the automatic registration
// in src/hubspot/oauth.ts's OAuth callback ever failed (e.g. local dev's
// non-https APP_URL, or a transient Shopify error) and needs retrying
// without the merchant having to redo the whole OAuth handshake. Run with:
// APP_URL=https://hubshop.onrender.com npm run register-webhooks -- <shop-domain>
// (falls back to SHOPIFY_STORE_DOMAIN if the shop arg is omitted, for
// single-merchant local dev).
import { config } from '../config';
import { pool } from '../db/client';
import { normalizeShopDomain } from '../shopify/token';
import { registerWebhooksForShop } from '../shopify/webhookRegistration';

const shop = normalizeShopDomain(process.argv[2] ?? config.shopify.storeDomain);

registerWebhooksForShop(shop)
  .then(() => console.log('Done.'))
  .catch((err) => {
    console.error('Failed to register webhooks:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
