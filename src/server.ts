import crypto from 'crypto';
import express from 'express';
import { config } from './config';
import { shopify, shopifyOAuthRouter } from './shopify/oauth';
import { hubspotOAuthRouter, hashAdminApiKey, generateAndStoreAdminApiKey } from './hubspot/oauth';
import { shopifyWebhookRouter } from './shopify/webhooks';
import { normalizeShopDomain } from './shopify/token';
import { pool } from './db/client';
import { getMerchant, saveDealRules, getShopsWithBrokenHubSpotConnection } from './db/merchants';
import { getRecentSyncLog } from './db/syncLog';
import { validateDealRules, DealRuleValidationError } from './hubspot/dealRules';
import { registerWebhooksForShop, getWebhookRegistrationStatus } from './shopify/webhookRegistration';
import { renderDashboardPage } from './dashboardPage';
import { TRUST_PROXY_HOPS, apiRateLimiter } from './rateLimit';
import { backfillMerchant } from './backfillMerchant';
import { resolveMerchantContext } from './hubspot/tokens';

const app = express();
// Required for express-rate-limit (and any other X-Forwarded-For-based
// logic) to see real client IPs rather than Render's own proxy address —
// see src/rateLimit.ts for why this trusts only one hop.
app.set('trust proxy', TRUST_PROXY_HOPS);
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

// --- Merchant dashboard (closes the "no UI after onboarding" gap found in
// the functional audit) --- Static shell; all auth and data-loading happens
// client-side against the JSON endpoints below, so no server-side session
// and no request data is ever interpolated into this response.
app.get('/dashboard', (_req, res) => {
  res.type('html').send(renderDashboardPage());
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
// Also surfaces broken HubSpot connections (10f) — a merchant-scoped
// request gets its own hubspotConnectionBrokenAt; the operator-wide view
// (admin key, no ?shop=) gets every currently-broken shop in one call,
// since that's the "proactive" part for a single-operator app with no
// email/Slack integration: this is the thing to actually check.
app.get('/sync-status', apiRateLimiter, requireAdminOrMerchantAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  try {
    const entries = await getRecentSyncLog(limit, req.shopDomain);
    if (req.shopDomain) {
      const merchant = await getMerchant(req.shopDomain);
      res.json({ entries, hubspotConnectionBrokenAt: merchant?.hubspotConnectionBrokenAt ?? null });
    } else {
      const brokenConnections = await getShopsWithBrokenHubSpotConnection();
      res.json({ entries, brokenConnections });
    }
  } catch (err) {
    console.error('Failed to fetch sync log:', err);
    res.status(500).send('Failed to fetch sync log.');
  }
});

// --- Deal-mapping rules CRUD (CLAUDE.md multi-merchant step) ---
// REST-only for now, no UI — merchants (or their own tooling) call this
// directly with their per-merchant key. PUT replaces the whole ordered
// array since rule order is semantically meaningful (first match wins).
app.get('/merchants/:shop/deal-rules', apiRateLimiter, requireAdminOrMerchantAuth, async (req, res) => {
  const shopDomain = normalizeShopDomain(req.params.shop);
  const merchant = await getMerchant(shopDomain);
  if (!merchant) {
    res.status(404).send('Unknown merchant.');
    return;
  }
  res.json({ rules: merchant.dealRules, dealPipeline: merchant.dealPipeline, dealStage: merchant.dealStage });
});

app.put('/merchants/:shop/deal-rules', apiRateLimiter, requireAdminOrMerchantAuth, async (req, res) => {
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

// --- Dashboard data/action endpoints — same auth/rate-limit stack as the
// deal-rules routes above, consumed by src/dashboardPage.ts's client-side JS.
app.get('/merchants/:shop/status', apiRateLimiter, requireAdminOrMerchantAuth, async (req, res) => {
  const shopDomain = normalizeShopDomain(req.params.shop);
  const merchant = await getMerchant(shopDomain);
  if (!merchant) {
    res.status(404).send('Unknown merchant.');
    return;
  }

  let webhooks: Array<{ topic: string; registered: boolean }> | null = null;
  let webhooksError: string | undefined;
  try {
    webhooks = await getWebhookRegistrationStatus(shopDomain);
  } catch (err) {
    webhooksError = err instanceof Error ? err.message : String(err);
    console.error(`Failed to fetch webhook status for ${shopDomain}:`, err);
  }

  res.json({
    shopDomain: merchant.shopDomain,
    hubspotPortalId: merchant.hubspotPortalId,
    hubspotConnectionBrokenAt: merchant.hubspotConnectionBrokenAt,
    dealPipeline: merchant.dealPipeline,
    dealStage: merchant.dealStage,
    webhooks,
    webhooksError,
    backfillStatus: merchant.backfillStatus,
  });
});

app.post('/merchants/:shop/retry-webhooks', apiRateLimiter, requireAdminOrMerchantAuth, async (req, res) => {
  const shopDomain = normalizeShopDomain(req.params.shop);
  const merchant = await getMerchant(shopDomain);
  if (!merchant) {
    res.status(404).send('Unknown merchant.');
    return;
  }

  try {
    await registerWebhooksForShop(shopDomain);
    res.json({ ok: true });
  } catch (err) {
    console.error(`Retry webhook registration failed for ${shopDomain}:`, err);
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// Kicks off another historical backfill (12b, functional audit) — mainly
// for a failed run, but idempotent (search-before-create throughout) so
// it's also safe as a plain "re-check everything" action. Backgrounded,
// same as the OAuth callback's own trigger (src/hubspot/oauth.ts): a large
// store's import can take a while, and the caller just wants confirmation
// it started, not to block on it — progress is visible via the status
// endpoint above once src/backfillMerchant.ts writes its next transition.
app.post('/merchants/:shop/retry-backfill', apiRateLimiter, requireAdminOrMerchantAuth, async (req, res) => {
  const shopDomain = normalizeShopDomain(req.params.shop);
  const merchant = await getMerchant(shopDomain);
  if (!merchant) {
    res.status(404).send('Unknown merchant.');
    return;
  }

  try {
    const ctx = await resolveMerchantContext(shopDomain);
    if (!ctx) {
      res.status(404).send('Unknown merchant.');
      return;
    }
    backfillMerchant(shopDomain, ctx).catch((err) =>
      console.error(`Background retry-backfill failed for ${shopDomain}:`, err)
    );
    res.json({ ok: true, status: 'running' });
  } catch (err) {
    console.error(`Failed to start backfill retry for ${shopDomain}:`, err);
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// Distinct from the ?regenerate_key=1 HubSpot-reconnect recovery path in
// src/hubspot/oauth.ts (for a merchant who lost their key entirely) — this
// is for a merchant who still has a valid key and wants to rotate it, so it
// only needs the same bearer-key auth every other merchant-scoped route
// already requires, not a full OAuth round-trip.
app.post('/merchants/:shop/admin-key/regenerate', apiRateLimiter, requireAdminOrMerchantAuth, async (req, res) => {
  const shopDomain = normalizeShopDomain(req.params.shop);
  const merchant = await getMerchant(shopDomain);
  if (!merchant) {
    res.status(404).send('Unknown merchant.');
    return;
  }

  const adminApiKey = await generateAndStoreAdminApiKey(shopDomain);
  res.json({
    adminApiKey,
    note: 'Save this now — it will not be shown again. Your previous key no longer works.',
  });
});

app.listen(config.server.port, () => {
  console.log(`Server listening on http://localhost:${config.server.port}`);
  console.log(`Health check: http://localhost:${config.server.port}/health`);
});
