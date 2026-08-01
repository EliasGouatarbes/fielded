import crypto from 'crypto';
import express from 'express';
import { config } from './config';
import { shopify, shopifyOAuthRouter } from './shopify/oauth';
import { hubspotOAuthRouter, hashAdminApiKey, generateAndStoreAdminApiKey } from './hubspot/oauth';
import { shopifyWebhookRouter } from './shopify/webhooks';
import { normalizeShopDomain } from './shopify/token';
import { pool, databaseIdentity } from './db/client';
import { getMerchant, saveDealRules, getShopsWithBrokenHubSpotConnection } from './db/merchants';
import { getRecentSyncLog, deleteOldSyncLog } from './db/syncLog';
import { logAccess, getRecentAccessLog, deleteOldAccessLog, getAccessVolumeAnomalies, isAdminAccessAnomalous, AccessAuthType } from './db/accessLog';
import { validateDealRules, DealRuleValidationError } from './hubspot/dealRules';
import { registerWebhooksForShop, getWebhookRegistrationStatus } from './shopify/webhookRegistration';
import { renderDashboardPage } from './dashboardPage';
import { renderPrivacyPolicyPage } from './privacyPolicyPage';
import { renderTermsPage } from './termsPage';
import { renderDpaPage } from './dpaPage';
import { renderPricingPage } from './pricingPage';
import { renderPage } from './htmlPage';
import { TRUST_PROXY_HOPS, apiRateLimiter, dataAccessRateLimiter } from './rateLimit';
import { backfillMerchant } from './backfillMerchant';
import { resolveMerchantContext } from './hubspot/tokens';
import { asyncHandler } from './asyncHandler';
import { fetchDealPipelineOptions, fetchOwnerOptions, describeOptionsFetchError } from './hubspot/options';

const app = express();
// Required for express-rate-limit (and any other X-Forwarded-For-based
// logic) to see real client IPs rather than Render's own proxy address —
// see src/rateLimit.ts for why this trusts only one hop.
app.set('trust proxy', TRUST_PROXY_HOPS);

// Defense-in-depth HTTPS enforcement — flagged by Shopify's AI Toolkit
// app-store review (requirement 3.1.1): Render terminates TLS and (per its
// own platform behavior) already redirects a custom domain's plain HTTP
// traffic at its edge, but that's an external guarantee this app's own code
// never actually verified. `req.secure` reflects the real origin protocol
// correctly here because `trust proxy` above is already set, so this reads
// Render's `X-Forwarded-Proto` rather than the (always-plain-HTTP) hop
// between Render's edge and this container. Skipped entirely when APP_URL
// itself isn't https:// (local dev), same convention already used by
// src/shopify/webhookRegistration.ts's own https-only guard — and skipped
// for /health specifically, since Render's own internal health probe may
// hit this container directly, bypassing the edge that sets that header.
if (config.server.appUrl.startsWith('https://')) {
  app.use((req, res, next) => {
    if (req.path === '/health' || req.secure) {
      if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
      next();
      return;
    }
    res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  });
}

app.use(
  express.json({
    // Stash the raw bytes alongside the parsed body — the webhook HMAC
    // check in shopify/webhooks.ts must verify against exactly what Shopify
    // signed, and re-serializing the parsed JSON isn't guaranteed to match.
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
    // express.json()'s own default is 100kb — found via a stress test
    // (2026-07-30) to be a real problem, not a theoretical one: a
    // synthetic-but-realistic order with 400 line items (properties, tax
    // lines, SKUs — the kind a genuine wholesale/bulk order carries) came
    // to 140kb and was rejected outright by body-parser before this app's
    // webhook handler ever ran. That order would never sync: no sync_log
    // row (the rejection happens before src/shopify/webhooks.ts's code
    // executes), and Shopify would retry the identical oversized payload
    // for up to 48 hours, failing the same way every time. 5mb is
    // generous for any realistic single order while still bounding
    // worst-case per-request memory; `webhookRateLimiter` (120/min) is the
    // complementary bound on total volume, same layering already used
    // elsewhere in this app.
    limit: '5mb',
  })
);

app.get('/health', asyncHandler(async (_req, res) => {
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
      // username@host, never the password — lets a remote check confirm
      // this deployment is actually pointed at the environment it's
      // supposed to be. Username specifically because Supabase's pooler
      // host is shared across projects in a region (see databaseIdentity).
      identity: databaseIdentity(config.db.connectionString),
    },
  });
}));

// The bare app URL — this app's "legacy install flow" setting (see
// shopify.app.testapp.toml) means Shopify sends merchants (and its own
// automated install-flow check) straight here, with ?shop=...&hmac=...&
// host=...&timestamp=... attached, expecting this exact request to kick off
// the OAuth handshake. Previously this route ignored those params entirely
// and just served a static page — a real bug (caught by Shopify's automated
// pre-submission check: "Immediately authenticates after install" failed,
// landing on this page's URL instead of Shopify's own grant screen), not
// just a cosmetic one. `shop` alone is enough to forward into /auth/shopify
// below, which builds the real authorize redirect and already sanitizes it —
// no need to re-verify this request's hmac here, since nothing trusts it yet
// (the OAuth callback's own hmac+state check is the actual trust boundary).
// A merchant with no shop context (e.g. guessing at the bare domain) still
// gets the same honest fallback page as before.
app.get('/', (req, res) => {
  const shop = typeof req.query.shop === 'string' ? req.query.shop : undefined;
  if (shop) {
    res.redirect(`/auth/shopify?shop=${encodeURIComponent(shop)}`);
    return;
  }

  res.type('html').send(
    renderPage(
      'HubSpot <-> Shopify Sync',
      `<h1>HubSpot &harr; Shopify Sync</h1>
      <p>This is the background service that syncs your Shopify store to HubSpot — there's nothing to do here directly.</p>
      <p>Looking for your dashboard? Use the link you saved when you connected HubSpot. If you can't find it, get in touch below and we'll help you back in.</p>`
    )
  );
});

// A real hosted URL here is a hard Shopify App Store submission requirement,
// not just body copy. DRAFT pending legal review (see CLAUDE.md) — content
// lives in src/privacyPolicyPage.ts. No auth, no user input reflected
// anywhere on the page, so no XSS surface to consider here.
app.get('/privacy-policy', (_req, res) => {
  res.type('html').send(renderPrivacyPolicyPage());
});

app.get('/terms', (_req, res) => {
  res.type('html').send(renderTermsPage());
});

app.get('/data-processing-agreement', (_req, res) => {
  res.type('html').send(renderDpaPage());
});

// Linked from Shopify Partner Dashboard's "manual pricing" plan as the
// "URL where merchants can find more pricing information."
app.get('/pricing', (_req, res) => {
  res.type('html').send(renderPricingPage());
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

// Records every successful read/write through this gate — the "who accessed
// customer data, when, from where" trail that was missing entirely before
// (src/db/accessLog.ts). Best-effort and not awaited on the request's
// critical path: a broken log write must never turn a legitimate request
// into a 500, and access_log is an audit trail, not something a caller is
// waiting on.
function recordAccess(req: express.Request, authType: AccessAuthType, shopDomain: string | undefined): void {
  logAccess({
    route: req.baseUrl + req.path,
    method: req.method,
    authType,
    shopDomain,
    ip: req.ip,
  }).catch((err) => console.error('logAccess call failed:', err));
}

const requireAdminOrMerchantAuth = asyncHandler(async (req, res, next) => {
  const provided = req.header('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const shopParam = (req.params.shop as string | undefined) ?? (typeof req.query.shop === 'string' ? req.query.shop : undefined);
  const shopDomain = shopParam ? normalizeShopDomain(shopParam) : undefined;

  if (provided && timingSafeEqualStrings(provided, config.server.adminApiKey)) {
    req.shopDomain = shopDomain;
    recordAccess(req, 'admin', shopDomain);
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
  recordAccess(req, 'merchant', shopDomain);
  next();
});

// --- Sync-status log (CLAUDE.md step 6, made per-merchant) ---
// Also surfaces broken HubSpot connections (10f) — a merchant-scoped
// request gets its own hubspotConnectionBrokenAt; the operator-wide view
// (admin key, no ?shop=) gets every currently-broken shop in one call,
// since that's the "proactive" part for a single-operator app with no
// email/Slack integration: this is the thing to actually check.
app.get('/sync-status', dataAccessRateLimiter, requireAdminOrMerchantAuth, asyncHandler(async (req, res) => {
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
}));

// --- Access log (who read customer/merchant data, when, from where) ---
// Same shape/auth as /sync-status: a merchant-scoped request sees only its
// own rows, the global operator key sees everything. This route's own hits
// are themselves logged by requireAdminOrMerchantAuth like any other.
app.get('/access-log', dataAccessRateLimiter, requireAdminOrMerchantAuth, asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  try {
    const entries = await getRecentAccessLog(limit, req.shopDomain);
    if (req.shopDomain) {
      res.json({ entries });
    } else {
      // DLP anomaly signal (operator-wide view only — a merchant-scoped
      // request has no business seeing volume across other merchants).
      const anomalies = await getAccessVolumeAnomalies();
      res.json({ entries, anomalies });
    }
  } catch (err) {
    console.error('Failed to fetch access log:', err);
    res.status(500).send('Failed to fetch access log.');
  }
}));

// --- Deal-mapping rules CRUD (CLAUDE.md multi-merchant step) ---
// REST-only for now, no UI — merchants (or their own tooling) call this
// directly with their per-merchant key. PUT replaces the whole ordered
// array since rule order is semantically meaningful (first match wins).
app.get('/merchants/:shop/deal-rules', apiRateLimiter, requireAdminOrMerchantAuth, asyncHandler(async (req, res) => {
  const shopDomain = normalizeShopDomain(req.params.shop);
  const merchant = await getMerchant(shopDomain);
  if (!merchant) {
    res.status(404).send('Unknown merchant.');
    return;
  }
  res.json({ rules: merchant.dealRules, dealPipeline: merchant.dealPipeline, dealStage: merchant.dealStage });
}));

app.put('/merchants/:shop/deal-rules', apiRateLimiter, requireAdminOrMerchantAuth, asyncHandler(async (req, res) => {
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
}));

// --- Dashboard data/action endpoints — same auth/rate-limit stack as the
// deal-rules routes above, consumed by src/dashboardPage.ts's client-side JS.
app.get('/merchants/:shop/status', apiRateLimiter, requireAdminOrMerchantAuth, asyncHandler(async (req, res) => {
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
    billingStatus: merchant.billingStatus,
    billingTrialEndsAt: merchant.billingTrialEndsAt,
  });
}));

// Feeds the dashboard's deal-rules editor real pipeline/stage/owner names
// instead of asking a merchant to type HubSpot's raw internal ids from
// memory. Pipelines and owners are fetched independently (Promise.allSettled)
// so, e.g., a merchant who hasn't yet reconnected for the newer
// crm.objects.owners.read scope still gets a working pipeline/stage picker
// — the dashboard falls back to plain text entry per-field, not all-or-
// nothing. Each error message is returned as-is (HubSpot's own
// MISSING_SCOPES errors already name the exact missing scope, per this
// project's established precedent for diagnosing scope gaps) rather than
// generalized, so a merchant/operator reading it knows exactly what to fix.
app.get('/merchants/:shop/hubspot-options', apiRateLimiter, requireAdminOrMerchantAuth, asyncHandler(async (req, res) => {
  const shopDomain = normalizeShopDomain(req.params.shop);

  // resolveMerchantContext throws (rather than returning null) for a
  // merchant that installed Shopify but never finished — or lost — their
  // HubSpot connection (src/hubspot/tokens.ts). Found the hard way in a
  // stress test (2026-07-30): with this call unwrapped, that throw becomes
  // an unhandled promise rejection inside an async Express 4 route handler
  // (Express 4 doesn't auto-catch those) — which crashed the *entire*
  // process on this Node version, not just this one request. Treated the
  // same as an actual HubSpot API failure below (graceful 200 with a clear
  // per-field error) rather than a 500, since a merchant with no working
  // HubSpot connection is an expected, recoverable state, not a bug.
  let ctx: Awaited<ReturnType<typeof resolveMerchantContext>>;
  try {
    ctx = await resolveMerchantContext(shopDomain);
  } catch (err) {
    console.error(`No usable HubSpot connection for ${shopDomain} (hubspot-options):`, err);
    const message = describeOptionsFetchError(err, 'pipeline/stage/owner dropdowns');
    res.json({ pipelines: null, pipelinesError: message, owners: null, ownersError: message });
    return;
  }
  if (!ctx) {
    res.status(404).send('Unknown merchant.');
    return;
  }

  const [pipelinesResult, ownersResult] = await Promise.allSettled([
    fetchDealPipelineOptions(ctx.hubspotClient),
    fetchOwnerOptions(ctx.hubspotClient),
  ]);

  if (pipelinesResult.status === 'rejected') console.error(`Failed to fetch HubSpot pipelines for ${shopDomain}:`, pipelinesResult.reason);
  if (ownersResult.status === 'rejected') console.error(`Failed to fetch HubSpot owners for ${shopDomain}:`, ownersResult.reason);

  // describeOptionsFetchError turns HubSpot's raw ApiException dump into
  // plain English for the common case (a missing-scope 403) and otherwise
  // falls back to the same header-stripped text sync_log already uses
  // (14d) — confirmed live against the real dev store's actual 403 before
  // its owners scope was granted (see src/hubspot/options.ts).
  res.json({
    pipelines: pipelinesResult.status === 'fulfilled' ? pipelinesResult.value : null,
    pipelinesError: pipelinesResult.status === 'rejected'
      ? describeOptionsFetchError(pipelinesResult.reason, 'pipeline/stage names')
      : undefined,
    owners: ownersResult.status === 'fulfilled' ? ownersResult.value : null,
    ownersError: ownersResult.status === 'rejected'
      ? describeOptionsFetchError(ownersResult.reason, 'the owner list')
      : undefined,
  });
}));

app.post('/merchants/:shop/retry-webhooks', apiRateLimiter, requireAdminOrMerchantAuth, asyncHandler(async (req, res) => {
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
}));

// Kicks off another historical backfill (12b, functional audit) — mainly
// for a failed run, but idempotent (search-before-create throughout) so
// it's also safe as a plain "re-check everything" action. Backgrounded,
// same as the OAuth callback's own trigger (src/hubspot/oauth.ts): a large
// store's import can take a while, and the caller just wants confirmation
// it started, not to block on it — progress is visible via the status
// endpoint above once src/backfillMerchant.ts writes its next transition.
app.post('/merchants/:shop/retry-backfill', apiRateLimiter, requireAdminOrMerchantAuth, asyncHandler(async (req, res) => {
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
}));

// Distinct from the ?regenerate_key=1 HubSpot-reconnect recovery path in
// src/hubspot/oauth.ts (for a merchant who lost their key entirely) — this
// is for a merchant who still has a valid key and wants to rotate it, so it
// only needs the same bearer-key auth every other merchant-scoped route
// already requires, not a full OAuth round-trip.
app.post('/merchants/:shop/admin-key/regenerate', apiRateLimiter, requireAdminOrMerchantAuth, asyncHandler(async (req, res) => {
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
}));

// Safety net for anything that reaches here unhandled — body-parser's
// PayloadTooLargeError/malformed-JSON SyntaxError, or any route error that
// slipped past its own try/catch. Without this, Express's built-in default
// error handler serves the error straight to the client — confirmed live in
// a stress test (2026-07-30): an oversized webhook body running locally got
// back a 413 page with a full stack trace, real local filesystem paths, and
// dependency internals. Production happened to mask this (an undocumented
// Render behavior this app shouldn't depend on staying true), so this makes
// the safe response explicit rather than incidental. Must be the last
// `app.use` (Express dispatches to the first 4-arg middleware it finds, in
// registration order) and keep all 4 parameters — that arity, not anything
// else, is what tells Express this is an error handler.
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status =
    (err as { status?: number; statusCode?: number } | undefined)?.status ??
    (err as { status?: number; statusCode?: number } | undefined)?.statusCode ??
    500;
  console.error(`Unhandled error on ${req.method} ${req.path}:`, err);
  if (res.headersSent) {
    return;
  }
  const message =
    status === 413 ? 'Request body too large.' : status === 400 ? 'Malformed request body.' : status < 500 ? 'Bad request.' : 'Internal server error.';
  res.status(status).send(message);
});

const server = app.listen(config.server.port, () => {
  console.log(`Server listening on http://localhost:${config.server.port}`);
  console.log(`Health check: http://localhost:${config.server.port}/health`);
  // Printed at boot specifically so it's impossible to lose track of which
  // Shopify store/database a running process is actually pointed at — the
  // pre-launch audit found local dev and Render silently sharing the same
  // Supabase database (CLAUDE.md, encryption-at-rest step) with no signal
  // that would have caught it earlier than a manual DB query. Host only,
  // never the connection string itself (which carries the DB password).
  console.log(`Shopify store: ${config.shopify.storeDomain}`);
  console.log(`Database: ${databaseIdentity(config.db.connectionString)}`);
});

// Runs once shortly after boot and then daily — matches ensureSchema's own
// "lazy, idempotent, runs in every process" style rather than needing a
// separate Render Cron Job (a paid-tier feature this app doesn't otherwise
// need). Errors are logged, not thrown: a missed cleanup run must never take
// the process down or block startup.
const SYNC_LOG_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
function runSyncLogCleanup(): void {
  deleteOldSyncLog(config.server.syncLogRetentionDays)
    .then((deleted) => {
      if (deleted > 0) console.log(`sync_log retention: deleted ${deleted} row(s) older than ${config.server.syncLogRetentionDays} days.`);
    })
    .catch((err) => console.error('sync_log retention cleanup failed:', err));
}
function runAccessLogCleanup(): void {
  deleteOldAccessLog(config.server.accessLogRetentionDays)
    .then((deleted) => {
      if (deleted > 0) console.log(`access_log retention: deleted ${deleted} row(s) older than ${config.server.accessLogRetentionDays} days.`);
    })
    .catch((err) => console.error('access_log retention cleanup failed:', err));
}
setTimeout(runSyncLogCleanup, 10_000).unref();
setTimeout(runAccessLogCleanup, 10_000).unref();
const syncLogCleanupInterval = setInterval(runSyncLogCleanup, SYNC_LOG_CLEANUP_INTERVAL_MS);
syncLogCleanupInterval.unref();
const accessLogCleanupInterval = setInterval(runAccessLogCleanup, SYNC_LOG_CLEANUP_INTERVAL_MS);
accessLogCleanupInterval.unref();

// DLP anomaly check — same "log loudly, no dedicated alert channel" pattern
// as 10f's broken-HubSpot-connection detection (this app still has no
// email/Slack integration). Runs on the same window the thresholds
// themselves are defined over (src/db/accessLog.ts) so a sustained anomaly
// gets logged repeatedly rather than only once at the moment it started.
const DLP_CHECK_INTERVAL_MS = 15 * 60 * 1000;
function runDlpAnomalyCheck(): void {
  getAccessVolumeAnomalies()
    .then((anomalies) => {
      if (isAdminAccessAnomalous(anomalies.adminAccessCount)) {
        console.error(`[DLP] Unusual admin-key access volume: ${anomalies.adminAccessCount} requests in the last hour.`);
      }
      for (const shop of anomalies.shopsOverThreshold) {
        console.error(`[DLP] Unusual access volume for ${shop.shopDomain}: ${shop.count} requests in the last hour.`);
      }
    })
    .catch((err) => console.error('DLP anomaly check failed:', err));
}
setTimeout(runDlpAnomalyCheck, 10_000).unref();
const dlpCheckInterval = setInterval(runDlpAnomalyCheck, DLP_CHECK_INTERVAL_MS);
dlpCheckInterval.unref();

// A Render deploy or restart sends SIGTERM, not a crash — previously
// unhandled, so in-flight requests were simply severed rather than allowed
// to finish (pre-launch audit, 2026-07-29). Shopify's own webhook retry
// covers any request actually lost this way, but closing the HTTP server
// and DB pool cleanly is strictly better than not trying. Force-exits after
// 10s in case something hangs during shutdown, rather than leaving Render to
// SIGKILL on its own schedule.
function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down gracefully...`);
  clearInterval(syncLogCleanupInterval);
  clearInterval(accessLogCleanupInterval);
  clearInterval(dlpCheckInterval);
  server.close(() => {
    pool
      .end()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('Error closing database pool during shutdown:', err);
        process.exit(1);
      });
  });
  setTimeout(() => {
    console.error('Graceful shutdown timed out, forcing exit.');
    process.exit(1);
  }, 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
