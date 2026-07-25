import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { syncCustomer, syncOrder, ShopifyCustomer, ShopifyOrder } from '../sync';
import { resolveMerchantContext } from '../hubspot/tokens';
import { logSyncResult } from '../db/syncLog';
import { normalizeShopDomain } from './token';

export const shopifyWebhookRouter = Router();

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

shopifyWebhookRouter.post('/orders/create', async (req, res) => {
  const order = req.body as ShopifyOrder;
  const merchant = await resolveMerchantOrRespond(req, res, 'order', order.name);
  if (!merchant) return;

  try {
    await syncOrder(order, merchant);
    res.status(200).send('ok');
  } catch (err) {
    console.error('Failed to sync orders/create webhook:', err);
    res.status(500).send('Sync failed.');
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
    console.error('Failed to sync orders/updated webhook:', err);
    res.status(500).send('Sync failed.');
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
    console.error('Failed to sync customers/create webhook:', err);
    res.status(500).send('Sync failed.');
  }
});
