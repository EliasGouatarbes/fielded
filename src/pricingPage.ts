import { renderPage } from './htmlPage';

// A real hosted URL here is what Shopify's "pricing information" listing
// field (Partner Dashboard > Pricing > Manual pricing) points at — same
// "real hosted page required for submission" reasoning as
// src/privacyPolicyPage.ts/termsPage.ts/dpaPage.ts. Content mirrors the
// single flat plan actually configured in the Partner Dashboard and
// actually charged via src/shopify/billing.ts's createSubscription
// ($29/month, 30-day trialDays) — kept in sync with that on purpose, since
// this page is exactly what a reviewer or merchant would cross-check
// against the real Shopify billing confirmation screen.
export function renderPricingPage(): string {
  const body = `
<h1>Pricing</h1>

<h2>Standard &mdash; $29/month</h2>
<p>One flat plan, no tiers. Includes a 30-day free trial &mdash; you're not charged anything until the trial ends,
and you can cancel anytime from Shopify's own billing settings.</p>

<ul class="checklist">
  <li>Unlimited order and customer syncing &mdash; no per-order or per-contact limits</li>
  <li>Real, searchable Shopify order numbers on every synced Deal</li>
  <li>Correctly mapped addresses, hand-mapped field by field</li>
  <li>SKU-level line items on every Deal</li>
  <li>Automatic HubSpot lifecycle stage updates on purchase</li>
  <li>Refund-aware syncing &mdash; a refunded order updates its Deal automatically</li>
  <li>A dashboard to review sync activity and configure deal routing rules</li>
</ul>

<h2>Billing</h2>
<p>Billing runs entirely through Shopify's own Billing API &mdash; charged in your store's own local currency, on
your existing Shopify invoice. We never collect payment details directly, and there's no separate account or
invoice to manage.</p>

<h2>Questions</h2>
<p>Get in touch below and we're happy to help before you install.</p>
`;

  return renderPage('Pricing — Fielded', body);
}
