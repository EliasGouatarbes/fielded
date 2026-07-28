import crypto from 'crypto';
import express from 'express';
import { config } from './config';
import { shopify, shopifyOAuthRouter } from './shopify/oauth';
import { hubspotOAuthRouter, hashAdminApiKey } from './hubspot/oauth';
import { shopifyWebhookRouter } from './shopify/webhooks';
import { normalizeShopDomain } from './shopify/token';
import { pool } from './db/client';
import { getMerchant, saveDealRules } from './db/merchants';
import { getRecentSyncLog } from './db/syncLog';
import { validateDealRules, DealRuleValidationError } from './hubspot/dealRules';

const app = express();
app.use(
  express.json({
    // Stash the raw bytes alongside the parsed body — the webhook HMAC
    // check in shopify/webhooks.ts must verify against exactly what Shopify
    // signed, and re-serializing the parsed JSON isn't guaranteed to match.
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  })
);

app.get('/health', async (_req, res) => {
  let dbConnected = false;
  try {
    await pool.query('SELECT 1');
    dbConnected = true;
  } catch (err) {
    console.error('Health check: database ping failed:', err);
  }

  res.json({
    status: 'ok',
    // RENDER_GIT_COMMIT is set automatically by Render itself on every
    // deploy — reading it (rather than maintaining a hand-bumped version
    // string) means this always reflects exactly what Render actually
    // built, with zero chance of drifting out of sync. Undefined outside
    // Render (e.g. local dev). Compare against `git rev-parse HEAD`/
    // `git log` to confirm a given deploy actually picked up a push.
    version: {
      gitCommit: process.env.RENDER_GIT_COMMIT ?? null,
    },
    shopify: {
      storeDomain: config.shopify.storeDomain,
      apiVersion: config.shopify.apiVersion,
      sdkLoaded: Boolean(shopify),
    },
    hubspot: {
      oauthConfigured: Boolean(config.hubspot.clientId && config.hubspot.clientSecret),
    },
    database: {
      connected: dbConnected,
    },
  });
});

// --- OAuth handshakes (CLAUDE.md multi-merchant step) ---
// Shopify install first (src/shopify/oauth.ts), then HubSpot connect
// (src/hubspot/oauth.ts) — the Shopify callback's success page links into
// the HubSpot flow. Both routers register their own absolute paths.
app.use(shopifyOAuthRouter);
app.use(hubspotOAuthRouter);

// --- Shopify webhook receiver (CLAUDE.md step 3) ---
app.use('/webhooks/shopify', shopifyWebhookRouter);

// --- Auth for merchant-scoped endpoints (/sync-status, deal-rules CRUD) ---
// Two ways in: the global ADMIN_API_KEY (operator key — cross-merchant
// access, e.g. GET /sync-status with no ?shop= returns entries for every
// merchant), or a merchant's own per-merchant key (generated at HubSpot
// connect time, stored hashed on the merchants row) scoped to just that shop.
function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}

async function requireAdminOrMerchantAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  const provided = req.header('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const shopParam = (req.params.shop as string | undefined) ?? (typeof req.query.shop === 'string' ? req.query.shop : undefined);
  const shopDomain = shopParam ? normalizeShopDomain(shopParam) : undefined;

  if (provided && timingSafeEqualStrings(provided, config.server.adminApiKey)) {
    req.shopDomain = shopDomain;
    next();
    return;
  }

  if (!shopDomain || !provided) {
    res.status(401).send('Unauthorized.');
    return;
  }

  const merchant = await getMerchant(shopDomain);
  if (!merchant?.adminApiKeyHash || !timingSafeEqualStrings(hashAdminApiKey(provided), merchant.adminApiKeyHash)) {
    res.status(401).send('Unauthorized.');
    return;
  }

  req.shopDomain = shopDomain;
  next();
}

// --- Sync-status log (CLAUDE.md step 6, made per-merchant) ---
app.get('/sync-status', requireAdminOrMerchantAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  try {
    const entries = await getRecentSyncLog(limit, req.shopDomain);
    res.json({ entries });
  } catch (err) {
    console.error('Failed to fetch sync log:', err);
    res.status(500).send('Failed to fetch sync log.');
  }
});

// --- Deal-mapping rules CRUD (CLAUDE.md multi-merchant step) ---
// REST-only for now, no UI — merchants (or their own tooling) call this
// directly with their per-merchant key. PUT replaces the whole ordered
// array since rule order is semantically meaningful (first match wins).
app.get('/merchants/:shop/deal-rules', requireAdminOrMerchantAuth, async (req, res) => {
  const shopDomain = normalizeShopDomain(req.params.shop);
  const merchant = await getMerchant(shopDomain);
  if (!merchant) {
    res.status(404).send('Unknown merchant.');
    return;
  }
  res.json({ rules: merchant.dealRules, dealPipeline: merchant.dealPipeline, dealStage: merchant.dealStage });
});

app.put('/merchants/:shop/deal-rules', requireAdminOrMerchantAuth, async (req, res) => {
  const shopDomain = normalizeShopDomain(req.params.shop);
  const merchant = await getMerchant(shopDomain);
  if (!merchant) {
    res.status(404).send('Unknown merchant.');
    return;
  }

  try {
    const rules = validateDealRules((req.body as { rules?: unknown })?.rules ?? req.body);
    await saveDealRules(shopDomain, rules);
    res.json({ rules });
  } catch (err) {
    if (err instanceof DealRuleValidationError) {
      res.status(400).send(err.message);
      return;
    }
    console.error('Failed to save deal rules:', err);
    res.status(500).send('Failed to save deal rules.');
  }
});

app.listen(config.server.port, () => {
  console.log(`Server listening on http://localhost:${config.server.port}`);
  console.log(`Health check: http://localhost:${config.server.port}/health`);
});
