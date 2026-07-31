import { Router } from 'express';
import '@shopify/shopify-api/adapters/node';
import { shopifyApi, ApiVersion } from '@shopify/shopify-api';
import { config } from '../config';
import { getMerchant, saveShopifyToken, saveShopifyContactEmail } from '../db/merchants';
import { normalizeShopDomain, exchangeShopifyToken } from './token';
import { fetchShopContactEmail } from './graphqlMapping';
import { createOAuthState, verifyOAuthState } from '../oauthState';
import { renderPage, renderErrorPage } from '../htmlPage';
import { oauthRateLimiter } from '../rateLimit';
import { asyncHandler } from '../asyncHandler';
import { createSubscription, refreshBillingStatus, BILLING_TRIAL_DAYS } from './billing';

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

shopifyOAuthRouter.get('/auth/shopify', oauthRateLimiter, (req, res) => {
  const requestedShop =
    typeof req.query.shop === 'string'
      ? req.query.shop
      : config.shopify.storeDomain.replace(/^https?:\/\//, '');

  let shop: string;
  try {
    shop = shopify.utils.sanitizeShop(requestedShop, true)!;
  } catch {
    res.status(400).type('html').send(renderErrorPage('That doesn\'t look like a valid Shopify store domain.'));
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

shopifyOAuthRouter.get(OAUTH_CALLBACK_PATH, oauthRateLimiter, asyncHandler(async (req, res) => {
  const { shop, code, state, hmac } = req.query;

  if (
    typeof shop !== 'string' ||
    typeof code !== 'string' ||
    typeof state !== 'string' ||
    typeof hmac !== 'string'
  ) {
    res.status(400).type('html').send(renderErrorPage('Missing required OAuth query parameters.'));
    return;
  }

  let stateShop: string;
  try {
    stateShop = verifyOAuthState(state).shop;
  } catch (err) {
    res
      .status(403)
      .type('html')
      .send(renderErrorPage(`OAuth state invalid: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }
  if (normalizeShopDomain(stateShop) !== normalizeShopDomain(shop)) {
    res.status(403).type('html').send(renderErrorPage('OAuth state shop mismatch.'));
    return;
  }

  let cleanShop: string;
  try {
    cleanShop = shopify.utils.sanitizeShop(shop, true)!;
    const validHmac = await shopify.utils.validateHmac(req.query as Record<string, string>);
    if (!validHmac) {
      res.status(403).type('html').send(renderErrorPage('Invalid HMAC signature.'));
      return;
    }
  } catch {
    res.status(403).type('html').send(renderErrorPage('OAuth validation failed.'));
    return;
  }

  try {
    // `expiring: 1` requests an *expiring* offline token — mandatory for a
    // publicly-distributed app as of April 2026 (found live: Shopify
    // outright rejects this app's old non-expiring tokens the moment it's
    // public, even on a brand-new exchange — see CLAUDE.md). Without this
    // flag the response has no refresh_token/expires_in at all, silently
    // falling back to the legacy non-expiring shape.
    const tokenResponse = await exchangeShopifyToken(cleanShop, {
      client_id: config.shopify.apiKey,
      client_secret: config.shopify.apiSecretKey,
      code,
      expiring: 1,
    });
    await saveShopifyToken(normalizeShopDomain(cleanShop), {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      expiresAt: tokenResponse.expires_in ? new Date(Date.now() + tokenResponse.expires_in * 1000) : undefined,
    });

    // Best-effort: this app has no other way to reach a merchant directly
    // (e.g. "please reconnect HubSpot after this update") without real
    // notification infrastructure, which doesn't exist yet. A failure here
    // must never break onboarding itself — caught and logged, not rethrown.
    try {
      const contactEmail = await fetchShopContactEmail(normalizeShopDomain(cleanShop));
      if (contactEmail) {
        await saveShopifyContactEmail(normalizeShopDomain(cleanShop), contactEmail);
      }
    } catch (err) {
      console.warn(`Could not fetch shop contact email for ${cleanShop} (non-fatal):`, err);
    }

    console.log('\n=== Shopify OAuth handshake complete ===');
    console.log(`Shop: ${cleanShop}`);
    console.log(`Scopes granted: ${tokenResponse.scope}`);
    console.log(
      tokenResponse.refresh_token
        ? 'Expiring access token + refresh token saved to the database (merchants table).\n'
        : 'Access token saved to the database (merchants table) — Shopify returned a non-expiring token; refresh will not be available.\n'
    );

    // Billing is a separate hop (Shopify's own hosted confirmation page,
    // not something rendered here) — handing off to the dedicated billing
    // route below rather than inlining subscription creation in this
    // already-large try block, and so the exact same code path is reusable
    // for a merchant retrying after declining (see /auth/shopify/billing).
    res.redirect(`/auth/shopify/billing?shop=${encodeURIComponent(normalizeShopDomain(cleanShop))}`);
  } catch (err) {
    console.error('Shopify token exchange failed:', err);
    res
      .status(502)
      .type('html')
      .send(renderErrorPage('Failed to exchange the authorization code for an access token. Check server logs.'));
  }
}));

// Creates (or re-creates, for a merchant retrying after declining) a
// subscription charge and sends the merchant to Shopify's own hosted
// confirmation page to approve it — reached both as step 2 of first-time
// onboarding (redirected here straight from the OAuth callback above) and
// directly, as the "try again" link on the declined-billing page below.
// Deliberately sits *before* the HubSpot connect step in the onboarding
// order: nobody reaches full use of the app without at least approving a
// subscription (even a $0-due-today trial one).
shopifyOAuthRouter.get('/auth/shopify/billing', oauthRateLimiter, asyncHandler(async (req, res) => {
  const shopParam = req.query.shop;
  if (typeof shopParam !== 'string' || !shopParam) {
    res.status(400).type('html').send(renderErrorPage('Missing "shop" query parameter.'));
    return;
  }

  let shopDomain: string;
  try {
    shopDomain = normalizeShopDomain(shopify.utils.sanitizeShop(shopParam, true)!);
  } catch {
    res.status(400).type('html').send(renderErrorPage('That doesn\'t look like a valid Shopify store domain.'));
    return;
  }

  const merchant = await getMerchant(shopDomain);
  if (!merchant) {
    res.status(400).type('html').send(renderErrorPage(`No Shopify installation found for ${shopDomain}. Install via /auth/shopify first.`));
    return;
  }

  const returnUrl = `${config.server.appUrl}/auth/shopify/billing-callback?shop=${encodeURIComponent(shopDomain)}`;
  try {
    const result = await createSubscription(shopDomain, returnUrl);
    if (result.status === 'already_active') {
      // Nothing to confirm — skip Shopify's confirmation page entirely and
      // go straight to the same "Shopify connected" success page a fresh
      // approval would land on (billing-callback re-confirms ACTIVE, which
      // it already is).
      res.redirect(`/auth/shopify/billing-callback?shop=${encodeURIComponent(shopDomain)}`);
      return;
    }
    res.redirect(result.confirmationUrl);
  } catch (err) {
    console.error(`Failed to create Shopify subscription for ${shopDomain}:`, err);
    res.status(502).type('html').send(renderErrorPage('Failed to start billing setup with Shopify. Check server logs.'));
  }
}));

// Where Shopify sends the merchant's browser back after they approve or
// decline on the confirmation page above. Nothing in this URL's own query
// params is signed or otherwise trustworthy (unlike the real OAuth
// callback's HMAC+state) — safe regardless, since all this does is ask
// Shopify's own API for the subscription's real current status and store
// exactly that, rather than trusting anything the redirect itself claims.
shopifyOAuthRouter.get('/auth/shopify/billing-callback', oauthRateLimiter, asyncHandler(async (req, res) => {
  const shopParam = req.query.shop;
  if (typeof shopParam !== 'string' || !shopParam) {
    res.status(400).type('html').send(renderErrorPage('Missing "shop" query parameter.'));
    return;
  }
  const shopDomain = normalizeShopDomain(shopParam);

  const merchant = await getMerchant(shopDomain);
  if (!merchant || !merchant.billingSubscriptionId) {
    res.status(400).type('html').send(renderErrorPage(`No pending subscription found for ${shopDomain}.`));
    return;
  }

  let status: string;
  try {
    status = await refreshBillingStatus(shopDomain, merchant.billingSubscriptionId);
  } catch (err) {
    console.error(`Failed to confirm billing status for ${shopDomain}:`, err);
    res.status(502).type('html').send(renderErrorPage('Failed to confirm billing status with Shopify. Check server logs.'));
    return;
  }

  if (status !== 'ACTIVE') {
    const retryUrl = `/auth/shopify/billing?shop=${encodeURIComponent(shopDomain)}`;
    res.type('html').send(
      renderPage(
        'Billing not approved',
        `<h1>Billing wasn't approved</h1>
        <p>Shopify reports this subscription as <strong>${status.toLowerCase()}</strong> — Fielded can't sync
        <strong>${shopDomain}</strong> until a subscription is approved (it starts with a ${BILLING_TRIAL_DAYS}-day
        free trial, nothing is charged today).</p>
        <a class="btn" href="${retryUrl}">Try again &rarr;</a>`
      )
    );
    return;
  }

  const hubspotConnectUrl = `/auth/hubspot?shop=${encodeURIComponent(shopDomain)}`;
  res.type('html').send(
    renderPage(
      'Shopify connected',
      `<h1>Step 1 of 2 &mdash; Shopify connected ✅</h1>
      <p><strong>${shopDomain}</strong> is linked and billing is set up (${BILLING_TRIAL_DAYS}-day free trial,
      nothing charged today). Nothing to copy into any config file — everything's saved automatically.</p>
      <p>One step left before anything syncs: tell us which HubSpot account this store's contacts and orders should land in.</p>
      <a class="btn" href="${hubspotConnectUrl}">Connect HubSpot &rarr;</a>`
    )
  );
}));
