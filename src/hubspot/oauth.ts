import crypto from 'crypto';
import { Router } from 'express';
import { config } from '../config';
import { getMerchant, saveHubSpotConnection, saveAdminApiKeyHash } from '../db/merchants';
import { normalizeShopDomain } from '../shopify/token';
import { shopify } from '../shopify/oauth';
import { createOAuthState, verifyOAuthState } from '../oauthState';
import { exchangeHubSpotToken, fetchHubSpotPortalId, resolveMerchantContext } from './tokens';
import { registerWebhooksForShop } from '../shopify/webhookRegistration';
import { backfillMerchant } from '../backfillMerchant';
import { renderPage, renderErrorPage } from '../htmlPage';
import { oauthRateLimiter } from '../rateLimit';

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

// Mints a fresh per-merchant admin key and persists only its hash — shared
// by the OAuth callback below (first-connect or ?regenerate_key=1 recovery)
// and the dashboard's POST /merchants/:shop/admin-key/regenerate
// (src/server.ts), which is the *other* rotation path: for a merchant who
// still has a valid key and wants a new one, authenticated by that existing
// key rather than a full HubSpot reconnect.
export async function generateAndStoreAdminApiKey(shopDomain: string): Promise<string> {
  const key = crypto.randomBytes(24).toString('hex');
  await saveAdminApiKeyHash(shopDomain, hashAdminApiKey(key));
  return key;
}

// A merchant reaches this only after finishing the Shopify install (linked
// from that callback's success page) — requiring the merchants row to
// already exist here is what lets /auth/hubspot/callback trust the shop
// domain carried in its signed state without a second lookup race.
hubspotOAuthRouter.get('/auth/hubspot', oauthRateLimiter, async (req, res) => {
  const shopParam = req.query.shop;
  if (typeof shopParam !== 'string' || !shopParam) {
    res.status(400).type('html').send(renderErrorPage('Missing "shop" query parameter.'));
    return;
  }

  // Validated the same way src/shopify/oauth.ts validates its own `shop`
  // param (a real allowlist, not just protocol-stripping) — found missing
  // here in the pre-launch security audit: an invalid shop previously fell
  // through to a generic error page that reflected the raw query value
  // back into the response (reflected XSS, independent of htmlPage.ts's own
  // output-escaping fix). Rejecting anything that isn't a genuine
  // *.myshopify.com domain before it's ever used closes that off at the
  // input side too.
  let shop: string;
  try {
    shop = shopify.utils.sanitizeShop(normalizeShopDomain(shopParam), true)!;
  } catch {
    res.status(400).type('html').send(renderErrorPage('That doesn\'t look like a valid Shopify store domain.'));
    return;
  }

  const merchant = await getMerchant(shop);
  if (!merchant) {
    res
      .status(400)
      .type('html')
      .send(renderErrorPage(`No Shopify installation found for ${shop}. Install via /auth/shopify first.`));
    return;
  }

  // ?regenerate_key=1 is the recovery path for a merchant who lost their
  // admin API key (src/oauthState.ts) — completing this real HubSpot login
  // is the only proof of identity this app has for them, since there's no
  // separate account/password system to gate a dedicated reset endpoint on.
  const regenerateAdminKey = req.query.regenerate_key === '1';
  const state = createOAuthState(shop, { regenerateAdminKey });
  const redirectUri = `${config.server.appUrl}${OAUTH_CALLBACK_PATH}`;

  const authorizeUrl = new URL('https://app.hubspot.com/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', config.hubspot.clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', OAUTH_SCOPES);
  authorizeUrl.searchParams.set('state', state);

  res.redirect(authorizeUrl.toString());
});

hubspotOAuthRouter.get(OAUTH_CALLBACK_PATH, oauthRateLimiter, async (req, res) => {
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
  let regenerateAdminKey: boolean;
  try {
    ({ shop, regenerateAdminKey } = verifyOAuthState(state));
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

    // Generated on first-ever HubSpot connect for this shop, or again on a
    // reconnect with ?regenerate_key=1 (the recovery path for a merchant who
    // lost theirs — there's no other way back in, since only the hash is
    // ever stored). Shown exactly once here, never retrievable again.
    const dashboardUrl = `/dashboard?shop=${encodeURIComponent(shop)}`;
    const fullDashboardUrl = `${config.server.appUrl}${dashboardUrl}`;

    // This app isn't embedded in Shopify Admin (deliberate, see CLAUDE.md) —
    // there's no persistent nav entry pointing back here, no email, nothing.
    // This page is the ONLY place this URL is ever shown, on every render
    // (first connect and every reconnect alike), unconditionally — losing it
    // means losing the only way back into the dashboard (pre-launch audit,
    // 2026-07-29: found via live-testing that both the bare app URL and a
    // bare /dashboard with no ?shop= are genuine dead ends). Deliberately
    // blunt rather than buried under "optional, for later" framing, which is
    // what this said before this fix — that undersold exactly the one thing
    // most worth a merchant's attention on this page.
    const saveLinkHtml = `
      <div class="warning">
        <p><strong>⚠️ Save this link now — bookmark it, or copy it somewhere safe:</strong></p>
        <pre>${fullDashboardUrl}</pre>
        <p>This is the only way back to your dashboard — there's no menu, email, or reminder that will show it to you
        again. It's where you check sync status, see what's synced so far, and change which HubSpot pipeline orders
        land in.</p>
      </div>`;

    let advancedHtml = '';
    if (!merchant.adminApiKeyHash || regenerateAdminKey) {
      const key = await generateAndStoreAdminApiKey(shop);
      const regeneratedNote = regenerateAdminKey
        ? '<p>This replaces your previous key — that one no longer works.</p>'
        : '';
      advancedHtml = `
        <hr>
        <div class="warning">
          <p><strong>Also save this key now — it will not be shown again:</strong></p>
          <pre>${key}</pre>
          ${regeneratedNote}
          <p>Paste it into the dashboard above once, and this browser will remember it from then on.</p>
        </div>
        <p class="muted">Check sync status any time with:</p>
        <pre>curl -H "Authorization: Bearer ${key}" "${config.server.appUrl}/sync-status?shop=${encodeURIComponent(shop)}"</pre>
        <p class="muted">Lost this key later? Reconnect HubSpot at
        <code>${config.server.appUrl}/auth/hubspot?shop=${encodeURIComponent(shop)}&amp;regenerate_key=1</code> to get a new one.</p>`;
    }

    const webhookChecklistItem = webhooksRegistered
      ? '<li>✅ Webhooks registered — new orders and customers will sync automatically</li>'
      : '<li>⚠️ Webhook registration failed — see warning below</li>';

    const webhookWarningHtml = webhooksRegistered
      ? ''
      : `<div class="warning"><strong>Heads up:</strong> automatic webhook registration failed, so new orders
        won't sync yet. Retry it from your <a href="${dashboardUrl}">dashboard</a> once you've signed in with the key below.</div>`;

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
        order history this store has — check your <a href="${dashboardUrl}">dashboard</a> any time to see exactly
        when it's finished, or if anything went wrong.</p>
        <a class="btn" href="${dashboardUrl}">View your dashboard &rarr;</a>
        ${saveLinkHtml}
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
