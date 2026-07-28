import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { syncCustomer, syncOrder, ShopifyCustomer, ShopifyOrder } from '../sync';
import { resolveMerchantContext } from '../hubspot/tokens';
import { logSyncResult, deleteSyncLogForShop, deleteSyncLogForCustomer } from '../db/syncLog';
import { deleteMerchant } from '../db/merchants';
import { normalizeShopDomain } from './token';
import { fetchOrderById } from './graphqlMapping';
import { isAuthError } from '../retry';
import { webhookRateLimiter } from '../rateLimit';

export const shopifyWebhookRouter = Router();
// Ahead of the HMAC check below deliberately — the point is to bound the
// cost of a flood of forged requests, which the HMAC check itself doesn't
// do for free (it's still a real crypto operation per request).
shopifyWebhookRouter.use(webhookRateLimiter);

// Every Shopify webhook is signed with SHOPIFY_API_SECRET_KEY over the raw
// request body (see server.ts's express.json({ verify }) for how req.rawBody
// gets populated) — re-serializing the parsed JSON wouldn't reproduce the
// same bytes Shopify signed, so this has to run against the raw buffer. This
// stays a single global secret (not per-merchant) because every merchant
// installs the same Partner-Dashboard app, which has one client secret.
function verifyShopifyWebhook(req: Request, res: Response, next: NextFunction): void {
  const hmacHeader = req.header('X-Shopify-Hmac-Sha256');
  if (!hmacHeader || !req.rawBody) {
    res.status(401).send('Missing HMAC signature.');
    return;
  }

  const digest = crypto.createHmac('sha256', config.shopify.apiSecretKey).update(req.rawBody).digest();
  const provided = Buffer.from(hmacHeader, 'base64');

  if (digest.length !== provided.length || !crypto.timingSafeEqual(digest, provided)) {
    res.status(401).send('Invalid HMAC signature.');
    return;
  }

  next();
}

shopifyWebhookRouter.use(verifyShopifyWebhook);

// Shopify sends this header on every webhook delivery — it's how a single
// shared receiver figures out which merchant a given payload belongs to
// (multi-merchant step). Anything unrecognized or not yet fully connected
// is logged and acknowledged with 200 rather than left for Shopify to keep
// retrying — retrying wouldn't help either case.
async function resolveMerchantOrRespond(
  req: Request,
  res: Response,
  entityType: 'order' | 'customer',
  shopifyId: string
) {
  const shopHeader = req.header('X-Shopify-Shop-Domain');
  if (!shopHeader) {
    res.status(400).send('Missing X-Shopify-Shop-Domain header.');
    return undefined;
  }
  const shopDomain = normalizeShopDomain(shopHeader);

  try {
    const merchant = await resolveMerchantContext(shopDomain);
    if (!merchant) {
      console.error(`Webhook for unrecognized shop ${shopDomain} — no merchant row.`);
      res.status(200).send('ok');
      return undefined;
    }
    return merchant;
  } catch (err) {
    // Shop installed via Shopify but never finished connecting HubSpot.
    await logSyncResult({
      entityType,
      shopifyId,
      status: 'error',
      errorMessage: err instanceof Error ? err.message : String(err),
      shopDomain,
    });
    res.status(200).send('ok');
    return undefined;
  }
}

// A 401/403 from HubSpot (src/retry.ts's isAuthError) means this merchant's
// connection itself is broken — almost always a revoked HubSpot access
// (already flagged on the merchant row by src/sync.ts's callers via
// markHubSpotConnectionBroken). Retrying the delivery can't fix that, so
// this acks with 200 instead of the usual 500 — otherwise Shopify would
// keep redelivering the same doomed webhook for up to 48 hours for a
// problem only the merchant reconnecting HubSpot can resolve. The failure
// itself is already in sync_log either way (src/sync.ts logs before
// rethrowing).
function respondToSyncFailure(res: Response, err: unknown, label: string): void {
  if (isAuthError(err)) {
    console.error(`${label}: HubSpot connection appears revoked — acking without retry.`);
    res.status(200).send('ok');
    return;
  }
  console.error(`Failed to sync ${label} webhook:`, err);
  res.status(500).send('Sync failed.');
}

shopifyWebhookRouter.post('/orders/create', async (req, res) => {
  const order = req.body as ShopifyOrder;
  const merchant = await resolveMerchantOrRespond(req, res, 'order', order.name);
  if (!merchant) return;

  try {
    await syncOrder(order, merchant);
    res.status(200).send('ok');
  } catch (err) {
    respondToSyncFailure(res, err, 'orders/create');
  }
});

shopifyWebhookRouter.post('/orders/updated', async (req, res) => {
  const order = req.body as ShopifyOrder;
  const merchant = await resolveMerchantOrRespond(req, res, 'order', order.name);
  if (!merchant) return;

  try {
    await syncOrder(order, merchant);
    res.status(200).send('ok');
  } catch (err) {
    respondToSyncFailure(res, err, 'orders/updated');
  }
});

shopifyWebhookRouter.post('/customers/create', async (req, res) => {
  const customer = req.body as ShopifyCustomer;
  const merchant = await resolveMerchantOrRespond(req, res, 'customer', customer.email ?? 'unknown');
  if (!merchant) return;

  try {
    await syncCustomer(customer, merchant);
    res.status(200).send('ok');
  } catch (err) {
    respondToSyncFailure(res, err, 'customers/create');
  }
});

// Closes 10e (CLAUDE.md pre-launch audit): a refund on an order changes its
// financial_status/total but nothing else fires for it on the live webhook
// path, so a refunded Deal previously kept its original amount/stage
// indefinitely. The Refund resource itself only carries a numeric
// `order_id` — no order name, total, or status — so this re-fetches the
// order's current (post-refund) state via GraphQL's currentTotalPriceSet
// (src/shopify/graphqlMapping.ts's fetchOrderById) and re-runs it through
// the exact same syncOrder path orders/create and orders/updated already
// use, rather than trying to compute the new total from the refund payload
// itself (refund/shipping/tax adjustments are exactly the kind of math
// Shopify itself warns against re-deriving by hand).
interface RefundPayload {
  order_id?: number;
}

shopifyWebhookRouter.post('/refunds/create', async (req, res) => {
  const { order_id: orderId } = req.body as RefundPayload;
  if (!orderId) {
    res.status(200).send('ok');
    return;
  }

  const merchant = await resolveMerchantOrRespond(req, res, 'order', String(orderId));
  if (!merchant) return;

  try {
    const order = await fetchOrderById(merchant.shopDomain, orderId);
    if (!order) {
      // Order no longer exists (e.g. deleted since) — nothing to re-sync.
      res.status(200).send('ok');
      return;
    }
    await syncOrder(order, merchant);
    res.status(200).send('ok');
  } catch (err) {
    respondToSyncFailure(res, err, 'refunds/create');
  }
});

// --- Shopify's three mandatory GDPR compliance webhooks ---
// Required for every public Shopify app regardless of what data it stores;
// app review checks for these. Unlike the three routes above, these must
// keep working even for a shop that's no longer a connected merchant (a
// shop/redact in particular can arrive after everything else about that
// shop is already gone), so they don't go through
// resolveMerchantOrRespond's "must have a live HubSpot connection" check —
// they read the shop domain straight from the payload Shopify's schema
// guarantees, and act directly against this app's own tables.

interface DataRequestPayload {
  shop_domain?: string;
  customer?: { id?: number; email?: string };
  orders_requested?: number[];
}

// This app doesn't hold customer data beyond `sync_log` rows (an email or
// order number plus a HubSpot id) and whatever's already been synced into
// the merchant's own HubSpot portal — which is that merchant's data, as
// data controller there, not this app's to hand over directly. Logged so
// the request isn't silently lost; fulfilling it (pointing the merchant at
// the right HubSpot contact) is a manual step, not automated here.
shopifyWebhookRouter.post('/customers/data_request', (req, res) => {
  const { shop_domain: shopDomain, customer, orders_requested: ordersRequested } = req.body as DataRequestPayload;
  console.log(
    `[GDPR] customers/data_request — shop=${shopDomain} customer=${customer?.email ?? customer?.id} ` +
      `orders=${JSON.stringify(ordersRequested ?? [])}. This app stores no customer data beyond sync_log ` +
      `entries and whatever already synced into that merchant's own HubSpot portal — fulfill manually.`
  );
  res.status(200).send('ok');
});

interface CustomerRedactPayload {
  shop_domain?: string;
  customer?: { id?: number; email?: string };
  orders_to_redact?: number[];
}

// Deletes this customer's own sync_log rows. Doesn't touch order-entity
// sync_log rows (keyed by Shopify's order *name*, e.g. "#1001" — not the
// numeric order ids this payload's `orders_to_redact` provides, so they
// can't be reliably correlated to this customer) or the HubSpot Contact
// itself (deleting a merchant's CRM record on a customer's request to
// Shopify, without the merchant's own judgment, is a bigger call than this
// webhook should make unilaterally) — both logged so they're not silently
// skipped.
shopifyWebhookRouter.post('/customers/redact', async (req, res) => {
  const { shop_domain: shopDomainRaw, customer, orders_to_redact: ordersToRedact } = req.body as CustomerRedactPayload;
  const shopDomain = shopDomainRaw ? normalizeShopDomain(shopDomainRaw) : undefined;

  if (shopDomain && customer?.email) {
    await deleteSyncLogForCustomer(shopDomain, customer.email);
  }
  console.log(
    `[GDPR] customers/redact — shop=${shopDomain} customer=${customer?.email ?? customer?.id}: deleted this ` +
      `customer's sync_log rows. NOT auto-deleted: order-entity sync_log rows for ` +
      `orders_to_redact=${JSON.stringify(ordersToRedact ?? [])} (can't be correlated by numeric order id), and ` +
      `the corresponding HubSpot Contact (requires merchant judgment) — handle both manually if required.`
  );
  res.status(200).send('ok');
});

interface ShopRedactPayload {
  shop_domain?: string;
}

// The one fully-automatable redact case: ~48h after a shop uninstalls,
// Shopify requires every trace of it gone. Deletes the merchants row
// (encrypted tokens included) and every sync_log row for that shop.
shopifyWebhookRouter.post('/shop/redact', async (req, res) => {
  const { shop_domain: shopDomainRaw } = req.body as ShopRedactPayload;
  if (shopDomainRaw) {
    const shopDomain = normalizeShopDomain(shopDomainRaw);
    await deleteSyncLogForShop(shopDomain);
    await deleteMerchant(shopDomain);
    console.log(`[GDPR] shop/redact — shop=${shopDomain}: deleted merchant row and all sync_log entries.`);
  }
  res.status(200).send('ok');
});
