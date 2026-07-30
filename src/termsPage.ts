import { renderPage } from './htmlPage';

// Companion to src/privacyPolicyPage.ts — same rationale (real hosted URL
// required for Shopify App Store submission, static/no user input so no
// escaping concerns), same DRAFT status pending legal review. The one
// clause that matters most here (Section 8, limitation of liability) is
// written for a B2B relationship deliberately: every direct counterparty
// under these terms is a merchant (a business), never an individual
// consumer, which is what makes an aggressive liability cap realistically
// enforceable under Finnish law — a consumer-facing version of this
// document would need materially different (weaker) limitation language.
export function renderTermsPage(): string {
  const body = `
<h1>Terms of Service</h1>
<p class="muted">Last updated: 30 July 2026</p>

<p>These terms are a contract between <strong>Elias Gouatarbès</strong>, a Finland-based light entrepreneur
(kevytyrittäjä) trading as <strong>Fielded</strong> (&ldquo;we,&rdquo; &ldquo;us&rdquo;), and the merchant business
installing or using Fielded (&ldquo;you,&rdquo; &ldquo;the merchant&rdquo;). By installing Fielded from the Shopify
App Store or otherwise using the service, you agree to these terms.</p>

<h2>1. The service</h2>
<p>Fielded connects your Shopify store to your own HubSpot account and syncs your orders and customers into it as
Deals and Contacts, on an ongoing basis, plus a one-time historical import when you first connect. That's the entire
service. How we handle the personal data involved is described in our <a href="/privacy-policy">Privacy Policy</a>,
which these terms incorporate by reference.</p>

<h2>2. Who this is for</h2>
<p>Fielded is a business-to-business service. It's offered only to businesses acting in a commercial capacity, not to
individual consumers. If you're installing Fielded, you're confirming you're doing so on behalf of a business.</p>

<h2>3. Your account and access</h2>
<ul>
  <li>Using Fielded requires connecting your own Shopify store and your own HubSpot account &mdash; we never ask for
  or hold your Shopify or HubSpot login credentials directly, only the access tokens those platforms issue once you
  approve the connection.</li>
  <li>You're given a single access key to your Fielded dashboard when you connect. You're responsible for keeping it
  confidential. It's shown once and can't be recovered if lost &mdash; only regenerated, by reconnecting HubSpot.</li>
  <li>You're responsible for the accuracy of any routing rules or configuration you set inside your dashboard.</li>
</ul>

<h2>4. Fees</h2>
<p>Any fees for using Fielded, and how they're billed, will be presented to you at the time you subscribe. We'll give
reasonable advance notice of any pricing change before it applies to you.</p>

<h2>5. Your responsibilities</h2>
<p>You're responsible for:</p>
<ul>
  <li>Having a lawful basis to collect and process your own customers' personal data, and for your own store's
  privacy policy disclosing that data is synced to a CRM via an app like this one;</li>
  <li>The accuracy of the data in your Shopify store &mdash; Fielded syncs what it's given;</li>
  <li>Complying with Shopify's and HubSpot's own terms of service, independently of this agreement;</li>
  <li>Not using Fielded for any unlawful purpose, or in a way that places excessive, abusive load on the service.</li>
</ul>

<h2>6. What we don't promise</h2>
<p>We aim to keep Fielded running reliably and to sync your data promptly, but the service is provided
<strong>&ldquo;as is&rdquo; and &ldquo;as available,&rdquo;</strong> without warranty of any kind, express or implied
&mdash; including any warranty of uninterrupted operation, error-free performance, or fitness for a particular
purpose. We don't guarantee any specific uptime. Shopify and HubSpot are independent platforms outside our control;
an outage, API change, or policy change on either of their ends can affect Fielded, and we aren't responsible for
their availability or behavior.</p>

<h2>7. Intellectual property</h2>
<p>We own Fielded's software and infrastructure. You own your own store data. Nothing in these terms transfers
ownership of either to the other party.</p>

<h2>8. Limitation of liability</h2>
<p>To the maximum extent permitted by law:</p>
<ul>
  <li>Neither party is liable to the other for any indirect, incidental, special, consequential, or punitive damages,
  or for any loss of profits, revenue, data, or business opportunity, arising out of or related to these terms or
  the service, even if advised of the possibility of such damages.</li>
  <li>Our total aggregate liability to you for any claim arising from or related to Fielded is limited to the total
  fees you paid us in the 12 months preceding the event giving rise to the claim, or &euro;100 if you've paid us
  nothing.</li>
  <li>Nothing in these terms excludes or limits liability that cannot lawfully be excluded or limited, including
  liability for gross negligence, willful misconduct, or death or personal injury caused by negligence.</li>
</ul>
<p class="muted">This section is the one most worth a lawyer's specific attention &mdash; how far a liability cap
like this actually holds depends on the law of whatever jurisdiction a dispute ends up in, not just what's written
here.</p>

<h2>9. Indemnification</h2>
<p>You agree to indemnify and hold us harmless from any claim, loss, or expense (including reasonable legal fees)
arising from your use of Fielded in violation of these terms, applicable law, or a third party's rights &mdash; for
example, a claim from one of your own customers arising from how you disclosed (or failed to disclose) your use of
Fielded to them.</p>

<h2>10. Data processing</h2>
<p>In providing Fielded, we act as a data processor on your behalf with respect to your customers' personal data,
as described in our <a href="/privacy-policy">Privacy Policy</a>. Our <a href="/data-processing-agreement">Data
Processing Agreement</a> forms part of these terms and applies automatically to every merchant.</p>

<h2>11. Term and termination</h2>
<ul>
  <li>These terms apply for as long as you have Fielded installed and connected.</li>
  <li>You can stop using Fielded at any time by uninstalling it from your Shopify admin, which also triggers deletion
  of your connection data as described in our Privacy Policy.</li>
  <li>We may suspend or terminate access if you materially breach these terms, misuse the service, or if required to
  do so by Shopify or HubSpot's own policies.</li>
</ul>

<h2>12. Changes to these terms</h2>
<p>We may update these terms from time to time. If a change is material, we'll update the date at the top of this
page. Continuing to use Fielded after a change takes effect means you accept the updated terms.</p>

<h2>13. Governing law</h2>
<p>These terms are governed by the laws of Finland, without regard to its conflict-of-law principles, and any dispute
not otherwise resolved will be subject to the exclusive jurisdiction of the courts of Finland.</p>

<h2>14. Contact</h2>
<p>Questions about these terms: <a href="mailto:hubshop.support@gmail.com">hubshop.support@gmail.com</a></p>
`;

  return renderPage('Terms of Service', body, { wide: true });
}
