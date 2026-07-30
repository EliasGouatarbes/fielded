import { renderPage } from './htmlPage';

// Companion to privacyPolicyPage.ts/termsPage.ts — same DRAFT status pending
// legal review. This is the document GDPR Article 28(3) actually requires
// between a controller (the merchant) and processor (us) — the Privacy
// Policy and ToS describe our practices, but Article 28 specifically
// requires a contract with this content, not just public disclosure of it.
// Structured as a self-service addendum incorporated by reference from the
// ToS (Section 10) rather than something requiring a separate signature —
// standard for small-scale SaaS, and consistent with how the ToS itself is
// accepted (by installing/using the service, not by countersigning).
//
// One deliberate distinction worth preserving if this gets edited: Shopify
// and HubSpot are NOT listed as sub-processors here. They're the merchant's
// own independently-contracted platforms — the merchant has (or should
// have) their own direct agreements with Shopify and HubSpot covering that
// processing. The sub-processors listed below are only the infrastructure
// *we* engage to run Fielded itself (Render, Supabase). Conflating the two
// would misstate who's actually accountable for what.
export function renderDpaPage(): string {
  const body = `
<h1>Data Processing Agreement</h1>
<p class="muted">Last updated: 30 July 2026</p>

<p>This Data Processing Agreement (&ldquo;DPA&rdquo;) forms part of the <a href="/terms">Terms of Service</a> between
<strong>Elias Gouatarbès</strong>, trading as <strong>Fielded</strong> (&ldquo;Processor,&rdquo; &ldquo;we&rdquo;), and
the merchant using Fielded (&ldquo;Controller,&rdquo; &ldquo;you&rdquo;). It applies automatically once you connect
your Shopify store and HubSpot account &mdash; no separate signature is required, in the same way the Terms of
Service themselves are accepted by installing and using Fielded. It reflects Article 28 of the GDPR.</p>

<h2>1. Roles</h2>
<p>You are the <strong>Controller</strong> of your own customers' personal data &mdash; you decide to collect it and
you decide to use Fielded to sync it into your HubSpot account. We are the <strong>Processor</strong>, acting only on
your instructions as described below.</p>

<h2>2. Subject matter, duration, nature, and purpose</h2>
<p>We process personal data for as long as you have Fielded connected, for the sole purpose of syncing your Shopify
orders and customers into your own HubSpot account as Contacts and Deals, and letting you configure how that sync is
routed. Processing ends when you uninstall Fielded or otherwise disconnect it.</p>

<h2>3. Categories of data subjects and personal data</h2>
<p><strong>Data subjects:</strong> your own customers who place orders through your Shopify store.</p>
<p><strong>Personal data:</strong> name, email address, phone number, shipping/billing address, and order details
(products, quantities, prices, payment and fulfillment status) &mdash; the same categories described in our
<a href="/privacy-policy">Privacy Policy</a>.</p>

<h2>4. Your instructions</h2>
<p>We process personal data only on your documented instructions &mdash; which consist of: the configuration you set
in your Fielded dashboard (routing rules, default pipeline/stage), and the ordinary operation of syncing orders and
customers as they occur in your store. We'll tell you if we believe an instruction you've given conflicts with GDPR
or another data protection law, rather than simply carrying it out.</p>

<h2>5. Confidentiality</h2>
<p>Anyone we authorize to process personal data on our behalf (including any future employee or contractor) is bound
by an obligation of confidentiality, whether contractual or statutory.</p>

<h2>6. Security measures</h2>
<p>We maintain the technical and organizational measures described in Section 6 of our Privacy Policy, specifically:</p>
<ul>
  <li>Encryption of Shopify and HubSpot access tokens at rest (AES-256-GCM), with the encryption key held separately
  from the data it protects;</li>
  <li>Encrypted, certificate-pinned connections to our database;</li>
  <li>Cryptographic verification of every inbound webhook before it's acted on;</li>
  <li>One-way hashing of dashboard access credentials &mdash; never stored in recoverable form;</li>
  <li>Automatic, time-bounded retention limits rather than indefinite storage (Section 8 below).</li>
</ul>

<h2>7. Sub-processors</h2>
<p>You authorize our use of the following sub-processors, engaged to provide the infrastructure Fielded itself runs
on:</p>
<div class="table-scroll">
<table>
<thead><tr><th>Sub-processor</th><th>Function</th><th>Location</th></tr></thead>
<tbody>
<tr><td>Render</td><td>Application hosting</td><td>EU (Frankfurt)</td></tr>
<tr><td>Supabase</td><td>Database hosting</td><td>EU (Ireland)</td></tr>
</tbody>
</table>
</div>
<p>Shopify and HubSpot are <strong>not</strong> our sub-processors under this DPA &mdash; they're your own
independently-contracted platforms, and your processing relationship with each of them is governed directly by your
own agreements with Shopify and HubSpot respectively. We'll give you reasonable advance notice before adding or
replacing any sub-processor listed above, and you may object on reasonable data-protection grounds.</p>

<h2>8. Deletion or return of data</h2>
<p>Because Fielded doesn't retain your customers' order or contact data itself &mdash; it lives in your own HubSpot
account once synced &mdash; there's little for us to return at the end of processing. What we do hold (your
connection tokens, routing configuration, and sync activity logs) is deleted automatically: connection data within
48 hours of uninstalling Fielded, and activity logs no later than 90 days after they're created regardless.</p>

<h2>9. Assistance with data subject rights</h2>
<p>We support your obligation to respond to your customers' GDPR requests directly: Shopify's data-deletion request
for a specific customer removes our log records of them; a full uninstall removes everything we hold for your store.
For a data-access request routed to us, we'll log it and notify you promptly so you can fulfil it &mdash; as the
Controller, you're best placed to compile a complete answer across all your systems, not just ours.</p>

<h2>10. Assistance with security and breach obligations</h2>
<p>If we become aware of a personal data breach affecting your data, we'll notify you without undue delay, with
whatever information is available to us at the time, so you can meet your own notification obligations under
Article 33/34 GDPR.</p>

<h2>11. Audits and information</h2>
<p>We'll provide you with the information reasonably necessary to demonstrate compliance with this DPA on request.
Given the scale of this operation, we ask that on-site audits be a last resort after a written information request
&mdash; but we won't unreasonably refuse one.</p>

<h2>12. Liability</h2>
<p>Liability under this DPA is subject to the limitations set out in Section 8 of our <a href="/terms">Terms of
Service</a>, which this DPA does not expand.</p>

<h2>13. Governing law</h2>
<p>This DPA is governed by the laws of Finland, consistent with Section 13 of our Terms of Service.</p>

<h2>14. Contact</h2>
<p>Questions about this DPA: <a href="mailto:hubshop.support@gmail.com">hubshop.support@gmail.com</a></p>

<p class="muted">See also our <a href="/privacy-policy">Privacy Policy</a> and <a href="/terms">Terms of Service</a>.</p>
`;

  return renderPage('Data Processing Agreement', body, { wide: true });
}
