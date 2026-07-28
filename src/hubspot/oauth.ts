import crypto from 'crypto';
import { Router } from 'express';
import { config } from '../config';
import { getMerchant, saveHubSpotConnection, saveAdminApiKeyHash } from '../db/merchants';
import { normalizeShopDomain } from '../shopify/token';
import { createOAuthState, verifyOAuthState } from '../oauthState';
import { exchangeHubSpotToken, fetchHubSpotPortalId, resolveMerchantContext } from './tokens';
import { registerWebhooksForShop } from '../shopify/webhookRegistration';
import { backfillMerchant } from '../backfillMerchant';
import { renderPage, renderErrorPage } from '../htmlPage';

export const hubspotOAuthRouter = Router();

const OAUTH_CALLBACK_PATH = '/auth/hubspot/callback';
const OAUTH_SCOPES = [
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.objects.deals.read',
  'crm.objects.deals.write',
  'crm.objects.line_items.read',
  'crm.objects.line_items.write',
].join(' ');

export function hashAdminApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// A merchant reaches this only after finishing the Shopify install (linked
// from that callback's success page) — requiring the merchants row to
// already exist here is what lets /auth/hubspot/callback trust the shop
// domain carried in its signed state without a second lookup race.
hubspotOAuthRouter.get('/auth/hubspot', async (req, res) => {
  const shopParam = req.query.shop;
  if (typeof shopParam !== 'string' || !shopParam) {
    res.status(400).type('html').send(renderErrorPage('Missing "shop" query parameter.'));
    return;
  }
  const shop = normalizeShopDomain(shopParam);

  const merchant = await getMerchant(shop);
  if (!merchant) {
    res
      .status(400)
      .type('html')
      .send(renderErrorPage(`No Shopify installation found for ${shop}. Install via /auth/shopify first.`));
    return;
  }

  const state = createOAuthState(shop);
  const redirectUri = `${config.server.appUrl}${OAUTH_CALLBACK_PATH}`;

  const authorizeUrl = new URL('https://app.hubspot.com/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', config.hubspot.clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', OAUTH_SCOPES);
  authorizeUrl.searchParams.set('state', state);

  res.redirect(authorizeUrl.toString());
});

hubspotOAuthRouter.get(OAUTH_CALLBACK_PATH, async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  // HubSpot redirects here with `error`/`error_description` instead of
  // `code` when it rejects the request itself (denied consent, app
  // misconfiguration, etc.) — surface that directly rather than the
  // generic "missing parameters" message below, which was indistinguishable
  // from an actual client bug.
  if (typeof error === 'string') {
    res
      .status(400)
      .type('html')
      .send(
        renderErrorPage(`HubSpot rejected the connection: ${error}${errorDescription ? ` — ${errorDescription}` : ''}`)
      );
    return;
  }

  if (typeof code !== 'string' || typeof state !== 'string') {
    res.status(400).type('html').send(renderErrorPage('Missing required OAuth query parameters.'));
    return;
  }

  let shop: string;
  try {
    shop = verifyOAuthState(state);
  } catch (err) {
    res
      .status(403)
      .type('html')
      .send(renderErrorPage(`OAuth state invalid: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }

  const merchant = await getMerchant(shop);
  if (!merchant) {
    res.status(400).type('html').send(renderErrorPage(`No Shopify installation found for ${shop}.`));
    return;
  }

  try {
    const redirectUri = `${config.server.appUrl}${OAUTH_CALLBACK_PATH}`;
    const tokenResponse = await exchangeHubSpotToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: config.hubspot.clientId,
      client_secret: config.hubspot.clientSecret,
    });

    const portalId = await fetchHubSpotPortalId(tokenResponse.access_token);

    await saveHubSpotConnection(shop, {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000),
      portalId,
    });

    console.log('\n=== HubSpot OAuth handshake complete ===');
    console.log(`Shop: ${shop}`);
    console.log(`HubSpot portal: ${portalId}`);
    console.log('Tokens saved to the database (merchants table).\n');

    // Previously a CLI-only step (`npm run register-webhooks`) nobody but
    // the developer could run — a real merchant self-installing from the
    // App Store would connect successfully and then never actually sync
    // anything, silently. Awaited (not backgrounded): it's a handful of
    // fast API calls, and its success/failure is worth surfacing on this
    // page immediately rather than only in server logs. Expected to fail
    // in local dev (APP_URL isn't https://) — caught rather than treated
    // as a broken connection.
    let webhooksRegistered = true;
    try {
      await registerWebhooksForShop(shop);
    } catch (err) {
      webhooksRegistered = false;
      console.error(`Failed to auto-register webhooks for ${shop}:`, err);
    }

    // Historical import runs in the background, not awaited — blocking
    // this response on it would leave the merchant staring at a blank
    // browser tab for however long their order history takes to import.
    // Errors are only logged/visible via /sync-status, same as any other
    // sync failure; re-running `npm run backfill` is safe if needed.
    resolveMerchantContext(shop)
      .then((ctx) => (ctx ? backfillMerchant(shop, ctx) : undefined))
      .catch((err) => console.error(`Background historical backfill failed for ${shop}:`, err));

    // Generated once, on first-ever HubSpot connect for this shop — shown
    // exactly once here, never retrievable again (only its hash is stored).
    let advancedHtml = '';
    if (!merchant.adminApiKeyHash) {
      const key = crypto.randomBytes(24).toString('hex');
      await saveAdminApiKeyHash(shop, hashAdminApiKey(key));
      advancedHtml = `
        <hr>
        <p class="muted"><strong>Optional, for later:</strong> nothing below is required to make syncing work — it's only
        needed if you ever want to check sync status yourself or customize which HubSpot pipeline/stage orders land in.</p>
        <p class="muted">Save this key now — it's shown only this once:</p>
        <pre>${key}</pre>
        <p class="muted">Check sync status any time with:</p>
        <pre>curl -H "Authorization: Bearer ${key}" "${config.server.appUrl}/sync-status?shop=${encodeURIComponent(shop)}"</pre>`;
    }

    const webhookChecklistItem = webhooksRegistered
      ? '<li>✅ Webhooks registered — new orders and customers will sync automatically</li>'
      : '<li>⚠️ Webhook registration failed — see warning below</li>';

    const webhookWarningHtml = webhooksRegistered
      ? ''
      : `<div class="warning"><strong>Heads up:</strong> automatic webhook registration failed, so new orders
        won't sync yet. Retry with <code>npm run register-webhooks -- ${shop}</code>, or contact support.</div>`;

    const headline = webhooksRegistered ? "Step 2 of 2 &mdash; You're all set 🎉" : 'Step 2 of 2 &mdash; Almost there';

    res.type('html').send(
      renderPage(
        'HubSpot connected',
        `<h1>${headline}</h1>
        <p><strong>${shop}</strong> is connected to HubSpot portal <strong>${portalId}</strong>.</p>
        <ul class="checklist">
          <li>✅ Shopify connected</li>
          <li>✅ HubSpot connected</li>
          ${webhookChecklistItem}
          <li>⏳ Importing your existing customers and orders (running now, in the background)</li>
        </ul>
        ${webhookWarningHtml}
        <p>From here, nothing else is required. New Shopify orders and customers will appear in HubSpot automatically
        as <strong>Contacts</strong> and <strong>Deals</strong> — not HubSpot's native Orders object, so your existing
        pipelines, lists, and reports keep working. Historical import can take a few minutes depending on how much
        order history this store has.</p>
        ${advancedHtml}`
      )
    );
  } catch (err) {
    console.error('HubSpot token exchange failed:', err);
    res
      .status(502)
      .type('html')
      .send(renderErrorPage('Failed to exchange the authorization code for a HubSpot access token. Check server logs.'));
  }
});
