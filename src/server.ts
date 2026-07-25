import crypto from 'crypto';
import https from 'https';
import express from 'express';
import '@shopify/shopify-api/adapters/node';
import { shopifyApi, ApiVersion } from '@shopify/shopify-api';
import { config } from './config';
import { hubspotClient } from './hubspot/client';
import { shopifyWebhookRouter } from './shopify/webhooks';
import { pool } from './db/client';
import { saveAccessToken } from './db/shopifyInstallations';
import { getRecentSyncLog } from './db/syncLog';
import { normalizeShopDomain } from './shopify/token';

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

// --- Shopify client ---
// This app was created via the Partner Dashboard as an OAuth-based app type,
// so (unlike HubSpot) there's no static Admin API token available up front —
// the routes below run a one-time OAuth handshake to mint one for the dev
// store. Also used for its `utils.sanitizeShop`/`utils.validateHmac` helpers
// during that handshake.
const appUrl = new URL(config.server.appUrl);

const shopify = shopifyApi({
  apiKey: config.shopify.apiKey,
  apiSecretKey: config.shopify.apiSecretKey,
  scopes: ['read_orders', 'read_customers', 'read_products'],
  hostName: appUrl.host,
  hostScheme: appUrl.protocol === 'https:' ? 'https' : 'http',
  apiVersion: config.shopify.apiVersion as ApiVersion,
  isEmbeddedApp: false,
});

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
    shopify: {
      storeDomain: config.shopify.storeDomain,
      apiVersion: config.shopify.apiVersion,
      sdkLoaded: Boolean(shopify),
    },
    hubspot: {
      sdkLoaded: Boolean(hubspotClient),
      authenticated: Boolean(config.hubspot.accessToken),
    },
    database: {
      connected: dbConnected,
    },
  });
});

// --- Shopify OAuth handshake (one-time, CLAUDE.md step 2) ---
// Classic authorization-code flow ("legacy install flow" in the Partner
// Dashboard), run once by hand against the single dev store. Not a
// merchant-facing install flow (that's step 9) — so the state nonce lives in
// memory rather than in a real session store; only one handshake is ever in
// flight. We drive the token exchange ourselves (rather than
// shopify.auth.begin/callback) because those helpers set the state cookie
// with `Secure`, which browsers silently drop on a plain http://localhost
// redirect URI like the one registered for this app.
const OAUTH_SCOPES = 'read_orders,read_customers,read_products';
const OAUTH_CALLBACK_PATH = '/auth/shopify/callback';
let pendingOAuthState: string | null = null;

function fetchShopifyAccessToken(
  shop: string,
  code: string
): Promise<{ access_token: string; scope: string }> {
  const payload = JSON.stringify({
    client_id: config.shopify.apiKey,
    client_secret: config.shopify.apiSecretKey,
    code,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: shop,
        path: '/admin/oauth/access_token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error(`Could not parse Shopify token response: ${body}`));
            }
          } else {
            reject(new Error(`Shopify token exchange failed (${status}): ${body}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

app.get('/auth/shopify', (req, res) => {
  const requestedShop =
    typeof req.query.shop === 'string'
      ? req.query.shop
      : config.shopify.storeDomain.replace(/^https?:\/\//, '');

  let shop: string;
  try {
    shop = shopify.utils.sanitizeShop(requestedShop, true)!;
  } catch {
    res.status(400).send('Invalid or missing "shop" domain.');
    return;
  }

  pendingOAuthState = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${config.server.appUrl}${OAUTH_CALLBACK_PATH}`;

  const authorizeUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authorizeUrl.searchParams.set('client_id', config.shopify.apiKey);
  authorizeUrl.searchParams.set('scope', OAUTH_SCOPES);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('state', pendingOAuthState);

  res.redirect(authorizeUrl.toString());
});

app.get(OAUTH_CALLBACK_PATH, async (req, res) => {
  const { shop, code, state, hmac } = req.query;

  if (
    typeof shop !== 'string' ||
    typeof code !== 'string' ||
    typeof state !== 'string' ||
    typeof hmac !== 'string'
  ) {
    res.status(400).send('Missing required OAuth query parameters.');
    return;
  }

  if (!pendingOAuthState || state !== pendingOAuthState) {
    res.status(403).send('OAuth state mismatch. Restart the flow at /auth/shopify.');
    return;
  }
  pendingOAuthState = null;

  let cleanShop: string;
  try {
    cleanShop = shopify.utils.sanitizeShop(shop, true)!;
    const validHmac = await shopify.utils.validateHmac(req.query as Record<string, string>);
    if (!validHmac) {
      res.status(403).send('Invalid HMAC signature.');
      return;
    }
  } catch {
    res.status(403).send('OAuth validation failed.');
    return;
  }

  try {
    const { access_token: accessToken, scope } = await fetchShopifyAccessToken(cleanShop, code);
    await saveAccessToken(normalizeShopDomain(cleanShop), accessToken);

    console.log('\n=== Shopify OAuth handshake complete ===');
    console.log(`Shop: ${cleanShop}`);
    console.log(`Scopes granted: ${scope}`);
    console.log('Access token saved to the database (shopify_installations table).\n');

    res.type('html').send(
      `<h1>Shopify OAuth complete</h1>` +
        `<p>Access token minted for <strong>${cleanShop}</strong> and saved to the database — ` +
        `nothing to copy into <code>.env</code>.</p>`
    );
  } catch (err) {
    console.error('Shopify token exchange failed:', err);
    res.status(502).send('Failed to exchange authorization code for an access token. Check server logs.');
  }
});

// --- Shopify webhook receiver (CLAUDE.md step 3) ---
app.use('/webhooks/shopify', shopifyWebhookRouter);

// --- Sync-status log (CLAUDE.md step 6) ---
// Gated behind a static API key (CLAUDE.md step 7) since entries can
// include customer emails and order numbers, and this is now a publicly
// reachable server. Left off /health (deploy platform's own uptime checks
// need it unauthenticated) and the webhook routes (already HMAC-verified).
function requireAdminApiKey(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const provided = Buffer.from(req.header('Authorization')?.replace(/^Bearer\s+/i, '') ?? '');
  const expected = Buffer.from(config.server.adminApiKey);

  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    res.status(401).send('Unauthorized.');
    return;
  }
  next();
}

app.get('/sync-status', requireAdminApiKey, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  try {
    const entries = await getRecentSyncLog(limit);
    res.json({ entries });
  } catch (err) {
    console.error('Failed to fetch sync log:', err);
    res.status(500).send('Failed to fetch sync log.');
  }
});

app.listen(config.server.port, () => {
  console.log(`Server listening on http://localhost:${config.server.port}`);
  console.log(`Health check: http://localhost:${config.server.port}/health`);
});
