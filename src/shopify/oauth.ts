import https from 'https';
import { Router } from 'express';
import '@shopify/shopify-api/adapters/node';
import { shopifyApi, ApiVersion } from '@shopify/shopify-api';
import { config } from '../config';
import { saveShopifyToken } from '../db/merchants';
import { normalizeShopDomain } from './token';
import { createOAuthState, verifyOAuthState } from '../oauthState';

// Also used by server.ts's /health check (sdkLoaded) and by the utils
// helpers below during the handshake.
export const shopify = shopifyApi({
  apiKey: config.shopify.apiKey,
  apiSecretKey: config.shopify.apiSecretKey,
  scopes: ['read_orders', 'read_customers', 'read_products'],
  hostName: new URL(config.server.appUrl).host,
  hostScheme: new URL(config.server.appUrl).protocol === 'https:' ? 'https' : 'http',
  apiVersion: config.shopify.apiVersion as ApiVersion,
  isEmbeddedApp: false,
});

export const shopifyOAuthRouter = Router();

// Classic authorization-code flow ("legacy install flow" in the Partner
// Dashboard), driven by hand (rather than shopify.auth.begin/callback)
// because those helpers set the state cookie with `Secure`, which browsers
// silently drop on a plain http://localhost redirect URI.
const OAUTH_SCOPES = 'read_orders,read_customers,read_products';
const OAUTH_CALLBACK_PATH = '/auth/shopify/callback';

function fetchShopifyAccessToken(shop: string, code: string): Promise<{ access_token: string; scope: string }> {
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

shopifyOAuthRouter.get('/auth/shopify', (req, res) => {
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

  const state = createOAuthState(shop);
  const redirectUri = `${config.server.appUrl}${OAUTH_CALLBACK_PATH}`;

  const authorizeUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authorizeUrl.searchParams.set('client_id', config.shopify.apiKey);
  authorizeUrl.searchParams.set('scope', OAUTH_SCOPES);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('state', state);

  res.redirect(authorizeUrl.toString());
});

shopifyOAuthRouter.get(OAUTH_CALLBACK_PATH, async (req, res) => {
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

  let stateShop: string;
  try {
    stateShop = verifyOAuthState(state);
  } catch (err) {
    res.status(403).send(`OAuth state invalid: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (normalizeShopDomain(stateShop) !== normalizeShopDomain(shop)) {
    res.status(403).send('OAuth state shop mismatch.');
    return;
  }

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
    await saveShopifyToken(normalizeShopDomain(cleanShop), accessToken);

    console.log('\n=== Shopify OAuth handshake complete ===');
    console.log(`Shop: ${cleanShop}`);
    console.log(`Scopes granted: ${scope}`);
    console.log('Access token saved to the database (merchants table).\n');

    res.type('html').send(
      `<h1>Shopify OAuth complete</h1>` +
        `<p>Access token minted for <strong>${cleanShop}</strong> and saved to the database — ` +
        `nothing to copy into <code>.env</code>.</p>` +
        `<p><a href="/auth/hubspot?shop=${encodeURIComponent(normalizeShopDomain(cleanShop))}">Connect HubSpot &rarr;</a></p>`
    );
  } catch (err) {
    console.error('Shopify token exchange failed:', err);
    res.status(502).send('Failed to exchange authorization code for an access token. Check server logs.');
  }
});
