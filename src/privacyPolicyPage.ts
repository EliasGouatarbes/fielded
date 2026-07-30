import { renderPage } from './htmlPage';

// A real, hosted URL is a hard requirement for Shopify App Store submission
// (step 9) — not just body copy, an actual page. Static, server-rendered,
// no user input involved anywhere on this page, so (unlike dashboardPage.ts)
// it needs none of htmlPage.ts's escaping concerns.
//
// DRAFT: written from the actual data flows in this codebase (which fields
// sync, what's stored where, real retention periods, real sub-processors),
// not a generic template — but it is still a draft. It needs a lawyer's
// review (per CLAUDE.md's legal-risk discussion, 2026-07-30) before this
// URL is submitted to Shopify or linked from the live app.
// No Finnish Business ID or home address is published here, by explicit
// operator choice (2026-07-30) — contact is email-only. The operator has
// since switched kevytyrittäjyys invoicing providers specifically to one
// that includes liability insurance (vastuuvakuutus) at no extra cost,
// which matters given there's still no limited-liability entity behind
// this business — see Section 8 of the Terms of Service.
export function renderPrivacyPolicyPage(): string {
  const body = `
<h1>Privacy Policy</h1>
<p class="muted">Last updated: 30 July 2026</p>

<p>This policy covers <strong>Fielded</strong> (&ldquo;the app,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;), a Shopify app that
syncs order and customer data from a merchant's Shopify store into that merchant's own HubSpot account. It's operated by
<strong>Elias Gouatarbès</strong>, a Finland-based light entrepreneur (kevytyrittäjä) trading as Fielded. You can reach
us at <a href="mailto:elias.gouatarbes@gmail.com">elias.gouatarbes@gmail.com</a>.</p>

<p>If you're a <strong>merchant</strong> using Fielded, this policy explains what we do with your store's data and your
own account details. If you're a <strong>customer of a store that uses Fielded</strong>, this policy explains what
happens to your personal data when it passes through our systems on its way from that store to the merchant's CRM.</p>

<h2>1. What we do, in one paragraph</h2>
<p>When a customer places an order in a merchant's Shopify store, Fielded reads that order (and the customer's contact
details) and creates or updates a matching record in the merchant's own HubSpot account. That's the entire function of
the service. We don't operate a shared database of shoppers across different stores, we don't use this data for
advertising, we don't sell it, and we don't use it to train any model or for any purpose beyond performing this sync.</p>

<h2>2. Our role: who controls this data, and who processes it</h2>
<p>For any merchant using Fielded, <strong>the merchant is the data controller</strong> of their own customers'
information &mdash; they decide to collect it (via their Shopify store) and they decide to install Fielded to move it
into HubSpot. <strong>We act as a data processor</strong>, handling that data only on the merchant's instructions and
only to perform the sync. Our <a href="/data-processing-agreement">Data Processing Agreement</a> governs this
relationship in more detail.</p>

<h2>3. What data we handle</h2>
<p>Sourced from a merchant's Shopify store, for each order or customer that syncs:</p>
<ul>
  <li>Name, email address, and phone number</li>
  <li>Shipping and billing address</li>
  <li>Order details: products purchased, quantities, prices, currency, payment and fulfillment status</li>
</ul>
<p>This data is written into the merchant's own HubSpot account as Contacts and Deals. We also separately hold, about
the merchant's <em>connection</em> to the service (not their customers):</p>
<ul>
  <li>Their Shopify store domain</li>
  <li>Encrypted access tokens for their Shopify store and HubSpot account (see Section 6)</li>
  <li>Their chosen HubSpot pipeline, stage, and routing preferences</li>
  <li>A one-way cryptographic hash of their dashboard access key &mdash; the key itself is shown to them once and is
  never stored in a form we can read back</li>
  <li>Their store's contact email address, used only to reach the merchant directly about their account (e.g. a
  required reconnection or a service issue) &mdash; never for marketing</li>
</ul>

<h2>4. Why we process this data</h2>
<p>Primarily to perform the service the merchant installed Fielded for: syncing their store's orders and customers into
their HubSpot account, and letting them monitor and configure that sync. We also use the merchant's own contact email
(Section 3) for operational communication about their account &mdash; the legal basis for that is our legitimate
interest in being able to reach a merchant about their own service. The legal basis for the rest is performance of our
contract with the merchant (and, in turn, the merchant's own basis for processing their customers' data under their store's
terms and privacy policy).</p>

<h2>5. Who else sees this data</h2>
<p>We use a small number of infrastructure providers to run the service. None of them can use this data for their own
purposes &mdash; they process it only to provide hosting/infrastructure to us.</p>
<div class="table-scroll">
<table>
<thead><tr><th>Provider</th><th>Purpose</th><th>Location</th></tr></thead>
<tbody>
<tr><td>Render</td><td>Hosts the running application</td><td>EU (Frankfurt)</td></tr>
<tr><td>Supabase</td><td>Hosts our database</td><td>EU (Ireland)</td></tr>
<tr><td>Shopify</td><td>The merchant's own store platform</td><td>Per Shopify's own policies</td></tr>
<tr><td>HubSpot</td><td>The merchant's own CRM &mdash; the destination of the sync</td><td>Per HubSpot's own policies</td></tr>
</tbody>
</table>
</div>
<p>We do not sell personal data, share it with data brokers, or share it across different merchants' accounts. Each
merchant's data goes only into that merchant's own HubSpot account.</p>

<h2>6. How we protect this data</h2>
<ul>
  <li>Shopify and HubSpot access tokens are encrypted at rest (AES-256-GCM); the encryption key is held separately
  from the database itself.</li>
  <li>All connections to our database are encrypted in transit and verified against a pinned certificate.</li>
  <li>Every inbound webhook is cryptographically verified before we act on it, so we only ever process data that
  genuinely originated from Shopify.</li>
  <li>Dashboard access keys are stored only as one-way hashes &mdash; not even we can recover a lost key; a merchant
  who loses theirs has to reconnect their HubSpot account to get a new one.</li>
</ul>

<h2>7. How long we keep it</h2>
<ul>
  <li><strong>Connection details</strong> (Section 3's second list) are kept for as long as the merchant has Fielded
  installed, and deleted automatically within 48 hours of the app being uninstalled.</li>
  <li><strong>Sync activity logs</strong> (a record of what synced and whether it succeeded, not full order contents)
  are kept for 90 days and then automatically and permanently deleted.</li>
  <li>Beyond that, this app does not retain customer order/contact data itself &mdash; once synced, that data lives in
  the merchant's own HubSpot account, governed by their own retention choices there.</li>
</ul>

<h2>8. Your rights, and how to exercise them</h2>
<p><strong>If you're a merchant:</strong> contact us at
<a href="mailto:elias.gouatarbes@gmail.com">elias.gouatarbes@gmail.com</a> to access, correct, export, or delete the
connection data described in Section 3. Uninstalling the app also deletes it automatically.</p>
<p><strong>If you're a customer of a store using Fielded:</strong> because the merchant controls this data, requests
about your personal information should generally go to that merchant first. We also support Shopify's own
data-request and data-deletion mechanisms directly: a request routed to us through Shopify to delete your data
removes our records of it; a merchant's own uninstall removes everything we hold for that store within 48 hours.
Depending on where you live, you may also have rights under laws such as the GDPR (EU/UK), including access,
correction, deletion, restriction, portability, and objection.</p>

<h2>9. Children's data</h2>
<p>Fielded is a business tool used by merchants and is not directed at children. We don't knowingly process data
belonging to children beyond whatever incidental data a merchant's own customers may include in an order.</p>

<h2>10. International transfers</h2>
<p>Our infrastructure runs entirely within the EU (application hosting in Frankfurt, Germany; database hosting in
Ireland). Shopify and HubSpot are independent controllers/processors of their own and may process data in other
locations under their own respective privacy policies.</p>

<h2>11. Changes to this policy</h2>
<p>If this policy changes in a material way, we'll update the date at the top of this page. Continued use of Fielded
after a change means you accept the update.</p>

<h2>12. Contact</h2>
<p>Questions about this policy, or about your data: <a href="mailto:elias.gouatarbes@gmail.com">elias.gouatarbes@gmail.com</a></p>

<p class="muted">See also our <a href="/terms">Terms of Service</a>.</p>
`;

  return renderPage('Privacy Policy', body, { wide: true });
}
