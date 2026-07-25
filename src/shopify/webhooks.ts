import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { syncCustomer, syncOrder, ShopifyCustomer, ShopifyOrder } from '../sync';

export const shopifyWebhookRouter = Router();

// Every Shopify webhook is signed with SHOPIFY_API_SECRET_KEY over the raw
// request body (see server.ts's express.json({ verify }) for how req.rawBody
// gets populated) — re-serializing the parsed JSON wouldn't reproduce the
// same bytes Shopify signed, so this has to run against the raw buffer.
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

shopifyWebhookRouter.post('/orders/create', async (req, res) => {
  try {
    await syncOrder(req.body as ShopifyOrder);
    res.status(200).send('ok');
  } catch (err) {
    console.error('Failed to sync orders/create webhook:', err);
    res.status(500).send('Sync failed.');
  }
});

shopifyWebhookRouter.post('/orders/updated', async (req, res) => {
  try {
    await syncOrder(req.body as ShopifyOrder);
    res.status(200).send('ok');
  } catch (err) {
    console.error('Failed to sync orders/updated webhook:', err);
    res.status(500).send('Sync failed.');
  }
});

shopifyWebhookRouter.post('/customers/create', async (req, res) => {
  try {
    await syncCustomer(req.body as ShopifyCustomer);
    res.status(200).send('ok');
  } catch (err) {
    console.error('Failed to sync customers/create webhook:', err);
    res.status(500).send('Sync failed.');
  }
});
