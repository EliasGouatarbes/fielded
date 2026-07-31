# HubSpot <-> Shopify Sync

## What this is
A small paid app fixing HubSpot's own official Shopify integration, which sits at
a 1.0/5 rating on the Shopify App Store (verified directly, not assumed).
Target customer: merchants doing ~25 to a few hundred orders/month — too big for
Unific's free tier (25 orders/month cap), too small to need Unific's full
marketing suite or Stacksync's enterprise-scale sync.

## The three bugs this fixes (verified against live App Store reviews + HubSpot
## community threads spanning 2022-2026, not a one-off)
1. Orders synced into HubSpot become unsearchable by Shopify order number.
   Fix: put the order number in the Deal's `dealname` property specifically —
   that's what HubSpot's search actually indexes.
2. Address fields (state/province) sync as garbage "enabled/disabled" values.
   Fix: explicit, hand-written field-by-field mapping — never auto-map by
   matching field names. HubSpot address fields must be plain single-line text
   properties, not dropdowns.
3. HubSpot forced a migration (May 2025) from Orders-as-Deals to a new native
   Orders object, breaking existing workflows/lists/reports with zero migration
   tooling. Fix: sync Orders to Deals (the old model) deliberately, not the new
   native Orders object.

## v1 scope
- Shopify Customers -> HubSpot Contacts
- Shopify Orders -> HubSpot Deals (NOT HubSpot's native Orders object)
- Products/line items attached to the Deal
- Historical backfill script on install, via Shopify's Admin API

## Tech stack & conventions
- TypeScript on Node.js, strict mode. Deliberate choice over Python — the type
  system directly guards against the field-mismatch bug class that caused bug #2.
- `@shopify/shopify-api` and `@hubspot/api-client` — official SDKs for both.
  Don't substitute community wrapper packages.
- All required env vars are validated up front in `src/config.ts`, which throws
  listing every missing var at once. Add new required vars there, not scattered
  `process.env` reads elsewhere in the codebase.
- Any create/upsert logic must search-before-create, so retried webhooks update
  existing records instead of duplicating them.
- Auth: Shopify requires OAuth2 (see below). HubSpot does NOT — it uses a
  static Private App access token (`HUBSPOT_ACCESS_TOKEN`), which only works
  for one portal but needs zero OAuth code. Found under Development -> Legacy
  apps (HubSpot renamed "Private Apps" to this) -> Scopes tab -> Auth tab ->
  Show token. Full HubSpot OAuth only becomes necessary later, when this needs
  to install into *other* merchants' portals (step 9 concern, same as
  Shopify's multi-merchant install flow) — don't build it before then.
- Shopify: there is no static Admin API access token available — this app was
  created through the Partner Dashboard (OAuth-based app type), not the
  legacy per-store "Develop apps" admin page (which would have given a static
  token). For now, since there is
  only one dev store, a full multi-merchant install flow is NOT needed yet
  (that's a step-9 concern, for real App Store installs). Instead: do a
  one-time manual OAuth handshake to mint a single access token for the dev
  store, then treat that token as static in `.env` under
  `SHOPIFY_ADMIN_ACCESS_TOKEN` — `config.ts` doesn't need to change, only how
  the value is obtained. The redirect URL used in that handshake (e.g.
  `http://localhost:3000/auth/shopify/callback`) must be added to the app's
  "Allowed redirection URL(s)" in the Partner Dashboard first, or the OAuth
  callback will fail with an "unwhitelisted redirect_uri" error. Concretely,
  in the Partner Dashboard's app version config: "Embed app in Shopify admin"
  is UNCHECKED (this is a headless service, no embedded UI), "Use legacy
  install flow" is CHECKED (gives the classic authorization-code OAuth
  flow instead of the managed-installation/session-token flow meant for
  embedded apps), required scopes are `read_orders,read_customers,read_products`,
  and the redirect URL registered is `http://localhost:3000/auth/shopify/callback`.
  Shopify API version in use: 2026-07.

## Commands
- `npm install`
- `npm run dev` — starts the server with auto-reload
- `npm run build` / `npm start` — production build/run
- Health check once running: `GET http://localhost:3000/health`

## Current status
1. [DONE, VERIFIED] Project scaffolding — Express + TypeScript, both SDKs,
   typed config loader, `/health` route. `npm install` and `npm run dev` run
   clean; `/health` returns 200. Also fixed `tsconfig.json`: `moduleResolution:
   "node"` ignores package.json `exports` maps, which made `tsc`/`npm run
   build` type-check `@shopify/shopify-api`'s raw internal source instead of
   its published `.d.ts` files and fail. Switched `module`/`moduleResolution`
   to `"node16"` (also added `"DOM"` to `lib`, needed for the SDK's crypto
   adapter types) — `npm run build` now compiles cleanly.
2. [DONE, VERIFIED] One-time Shopify OAuth handshake — `GET /auth/shopify`
   (install redirect) and `GET /auth/shopify/callback` in `src/server.ts`.
   Hand-rolled the token exchange (state nonce kept in memory, HMAC verified
   via `shopify.utils.validateHmac`) rather than using the SDK's
   `shopify.auth.begin`/`callback`, since those set the OAuth state cookie
   `Secure`, which browsers drop on the plain `http://localhost` redirect URI
   this app has registered. Ran it against the dev store;
   `SHOPIFY_ADMIN_ACCESS_TOKEN` in `.env` is a real token, confirmed working
   with a live `GET /admin/api/2026-07/shop.json` call (200).
3. [DONE, VERIFIED] HubSpot upsert-by-search wrappers (`src/hubspot/contacts.ts`,
   `src/hubspot/deals.ts`) plus the Shopify webhook receiver
   (`src/shopify/webhooks.ts`, mounted at `/webhooks/shopify`): HMAC
   verification against the raw request body using `SHOPIFY_API_SECRET_KEY`
   (raw bytes captured via `express.json({ verify })` in `server.ts`, since a
   re-serialized JSON body isn't guaranteed to match what Shopify signed),
   then routes for `orders/create`, `orders/updated`, `customers/create`.
   Contacts upsert by email; Deals upsert by `dealname` (the Shopify order
   number — bug #1's fix) and associate to the contact. Deal
   pipeline/dealstage are optional env vars (`HUBSPOT_DEAL_PIPELINE`,
   `HUBSPOT_DEAL_STAGE`) — blank uses the portal's default. Verified end to
   end with signed test webhooks against the real dev store's HubSpot
   portal: contact + deal created with correct field mapping and
   association, retried webhook updated the same records rather than
   duplicating (test records deleted after verifying).
4. [DONE, VERIFIED] Historical backfill script — `npm run backfill`
   (`src/scripts/backfill.ts`). Pulls every existing customer and order via
   Shopify's REST Admin API (`src/shopify/admin-rest.ts`, cursor pagination
   following the `Link` response header — offset pagination is gone
   API-wide) and syncs each through the same upsert wrappers the webhook
   receiver uses. Extracted that shared Shopify-payload-to-HubSpot mapping
   out of `src/shopify/webhooks.ts` into `src/sync.ts` so both call sites
   stay identical. No retry/backoff yet (deliberately deferred to step 6).
   Verified against the real dev store: backfilled its 3 sample customers
   into HubSpot with correct field mapping, confirmed a second run updated
   the same 3 contacts rather than duplicating (store has 0 orders, so the
   order path is exercised by step 3's webhook test instead; `Link`-header
   pagination logic checked separately against synthetic multi-page headers
   since the store doesn't have enough records to page for real).
5. [DONE, VERIFIED] Real persistence layer — Supabase free-tier Postgres via
   the `pg` driver (`src/db/client.ts`: pool + idempotent `CREATE TABLE IF
   NOT EXISTS`, run lazily on first query rather than a separate migration
   step, since there's only the one table so far). `shopify_installations`
   (`shop_domain` primary key, `access_token`) replaces the manual
   .env-copy-paste from step 2 as the real source of truth for the Shopify
   token; `src/shopify/token.ts`'s `resolveShopifyAccessToken` reads the DB
   first, falling back to (and seeding the DB from) the legacy
   `SHOPIFY_ADMIN_ACCESS_TOKEN` env var so a store that already ran the
   step-2 handshake doesn't need to redo it. The OAuth callback route now
   saves directly to the DB instead of printing the token for manual
   copy-paste. `DATABASE_URL` is a new required config var; `/health` gained
   a `database.connected` check.
   Note for Supabase specifically: its direct-connection host
   (`db.<ref>.supabase.co`) is IPv6-only without the paid IPv4 add-on and
   was unreachable (DNS `ENOTFOUND`) from this network — had to switch to
   the **Session pooler** connection string (`aws-0-<region>.pooler.
   supabase.com`, username becomes `postgres.<project-ref>`).
   Verified against the real Supabase project: `/health` confirms a live DB
   connection, `npm run backfill` seeded the token from `.env` into
   `shopify_installations` (confirmed via direct query), then re-verified
   with `.env`'s `SHOPIFY_ADMIN_ACCESS_TOKEN` blanked that the backfill
   still runs correctly purely off the DB-stored token, and that repeated
   runs still don't duplicate HubSpot contacts.
6. [DONE, VERIFIED] Reliability pass. `src/retry.ts`: shared retry/backoff
   for both APIs — duck-typed error detection (numeric `.code`/`.statusCode`
   plus a `.headers` check for `Retry-After`) rather than `instanceof`,
   since HubSpot's `ApiException` isn't exported from the SDK's package root
   and is actually a distinct class per codegen'd object type (contacts vs
   deals) — every real error shape here exposes its HTTP status as a plain
   number regardless. Retries on 429 (honoring `Retry-After` if present) and
   5xx, plus a short list of transient Node network error codes
   (`ECONNRESET` etc.); exponential backoff with jitter otherwise; non-
   retryable errors (4xx validation, auth) fail fast. Wired into every
   HubSpot API call in `src/hubspot/contacts.ts`/`deals.ts` and every
   Shopify Admin REST call in `src/shopify/admin-rest.ts`.
   Sync-status logging: new `sync_log` table (`src/db/syncLog.ts`) records
   every customer/order sync attempt — entity type, Shopify id, resulting
   HubSpot id or error message — written from inside `src/sync.ts` so both
   the webhook receiver and the backfill script log identically. New
   `GET /sync-status` route surfaces recent entries (no auth yet — fine
   pre-launch on a single dev store, but flagged as a step-7 concern since
   error messages can contain emails/order numbers).
   Verified: unit-tested `withRetry` in isolation (429 + Retry-After header
   → retries then succeeds; 400 → fails immediately, no wasted retry; a
   transient network error code → retries then succeeds; persistent 5xx →
   exhausts `maxAttempts` and throws) rather than trying to induce real rate
   limits against live APIs. Separately sent a real signed webhook that
   succeeds (confirmed in `/sync-status` with its HubSpot id) and one with a
   deliberately invalid `amount` that HubSpot rejects with 400 (confirmed
   logged as `status: error` with the actual HubSpot validation message,
   and the route correctly still returns 500 so Shopify would retry the
   delivery). Test contact/deal deleted afterward.
7. [DONE, VERIFIED] Deployment — Render free tier, live at
   `https://hubshop.onrender.com`. Repo pushed to
   `github.com/EliasGouatarbes/hubshop` (wasn't a git repo before this —
   initialized at the project root, i.e. `hubspot-shopify-sync/` where
   `package.json` lives, not the wrapping folder). `render.yaml` Blueprint
   defines the service (build: `npm install && npm run build`, start:
   `npm start`, health check `/health`, `plan: free`); secrets marked
   `sync: false` so they're prompted for in Render's dashboard, never
   committed. `package.json` got an `engines.node: ">=20"` field.
   Fixed a real bug this surfaced: the OAuth redirect URI and the SDK's
   `hostName`/`hostScheme` were hardcoded to `http://localhost:<port>` —
   harmless locally, wrong once there's a real public URL. Now driven by a
   new `APP_URL` config var (optional, falls back to localhost so nothing
   breaks in dev; only matters for re-running the OAuth handshake, since
   the token itself already lives in the DB from step 5).
   `/sync-status` gate landed as planned: a static `ADMIN_API_KEY`, checked
   with `crypto.timingSafeEqual`, applied only to that route — not
   `/health` (Render's own health check needs it unauthenticated) and not
   the webhook routes (already HMAC-verified). Chose this over Basic Auth
   (unneeded extra username for a single operator) or an IP allowlist (bad
   fit for a dynamic home IP). It was live before the service was ever
   publicly reachable, not bolted on after.
   One real deploy hiccup, noted here in case it recurs: the first deploy
   ran only `npm install` as the build command (skipping `npm run build`),
   crashing on `Cannot find module '.../dist/server.js'` — Render had
   created the service via its own auto-detected commands rather than
   reading `render.yaml`. Fixed by manually setting Build Command to
   `npm install && npm run build` in the service's Settings tab; a fresh
   Blueprint-flow service (New → Blueprint, not New → Web Service) should
   read `render.yaml` correctly from the start.
   Verified against the live deployment: `/health` returns 200 with
   `database.connected: true` and `hubspot.authenticated: true`;
   `/sync-status` returns 401 with no key and 200 with the correct one;
   `/auth/shopify`'s redirect now carries
   `redirect_uri=https://hubshop.onrender.com/auth/shopify/callback`
   instead of localhost, confirming `APP_URL` took effect after being set
   in Render's Environment tab (added alongside the Partner Dashboard's
   allowed-redirect-URLs update, keeping the localhost entry for local dev).
8. [DONE, VERIFIED] Real-world test.
   First registered the actual Shopify webhook subscriptions (verified
   2026-07-24 this had never happened — `GET /admin/api/2026-07/webhooks.json`
   returned `{"webhooks":[]}`; every prior test was a hand-signed payload
   curled directly at `/webhooks/shopify/*`, Shopify itself never told to
   call it). New `src/scripts/register-webhooks.ts` (`npm run
   register-webhooks`, same shape as `backfill.ts`) registers `orders/create`,
   `orders/updated`, `customers/create` against `APP_URL`; generalized
   `admin-rest.ts`'s HTTP helper to support POST rather than duplicating it.
   Confirmed idempotent (re-running finds the existing subscriptions by
   topic+address, doesn't duplicate) and confirmed live via Shopify's API.
   Then placed a real order through the dev store's storefront. Final state
   was correct — one contact, one deal, right field mapping, right
   association — but `/sync-status` showed real 409 errors along the way
   that self-healed only because Shopify happened to retry the failed
   delivery. Root cause: Shopify fired `customers/create` and
   `orders/create`'s embedded customer sync close enough together that both
   searched HubSpot before either create had landed in the search index,
   so both attempted create.
   Reproduced deliberately (concurrent calls for a brand-new email/dealname)
   and fixed in two layers:
   - `src/mutex.ts` (`withKeyedLock`): serializes calls sharing a natural
     key (email, dealname) within this process, closing the true-concurrency
     case.
   - That alone wasn't sufficient for deals: unlike contacts, where email
     has a real server-side uniqueness constraint (the 409 our recovery
     path in `src/hubspot/conflict.ts` catches), **HubSpot enforces no
     uniqueness on `dealname`** — a search-index-lag race there doesn't
     error, it silently creates a duplicate deal. Confirmed with a
     5-concurrent-call test: 5 distinct deal ids, zero errors. Fixed with
     `src/hubspot/idCache.ts`, an in-process memo of natural-key -> HubSpot
     id — once a key resolves once, later calls for it skip search
     entirely and update the cached id directly, sidestepping the lag.
   Re-ran the 5-concurrent-call stress test for both contacts and deals
   after the fix: both now converge on exactly one id. Test records deleted
   afterward. `tsc`/`npm run build` clean.
   Committed, pushed, Render redeployed. Re-verified against the live
   deployment itself (not just locally): fired 5 concurrent signed webhook
   requests at `https://hubshop.onrender.com/webhooks/shopify/*` for a
   brand-new email and a brand-new dealname — exactly the pattern that
   produced duplicates pre-fix. Both converged on exactly one record in
   HubSpot. Test records deleted afterward.
   One more real-order finding, from three actual test orders placed
   through the storefront (`#1001`/`#1002`/`#1003`): deals landed with no
   pipeline or stage at all ("Select a pipeline"/"Select a stage" in the
   UI) — correcting a wrong assumption from step 5. `HUBSPOT_DEAL_PIPELINE`/
   `HUBSPOT_DEAL_STAGE` being blank does NOT make HubSpot fall back to a
   default pipeline/stage; it just omits them entirely. (Also worth
   knowing: HubSpot's activity feed shows "created from Floppy-Australia"
   on these deals — that's not a second integration, it's `hs_object_source
   _detail_1`, i.e. this app's own Private App display name in the portal,
   never renamed from whatever it defaulted to at creation. Harmless.) Set
   `HUBSPOT_DEAL_PIPELINE=default`/`HUBSPOT_DEAL_STAGE=closedwon` (this
   portal's only pipeline; Closed Won because a synced Shopify order is
   already a completed transaction, not an open opportunity moving through
   a sales process) and re-synced all three existing test deals through the
   real `orders/updated` webhook path (not a manual patch) — confirmed all
   three now carry `pipeline: default, dealstage: closedwon`. Needs the
   same two env vars added on Render to take effect there too.
9b. [CODE DONE, BLOCKED ON MANUAL HUBSPOT SCOPE CHANGE, 2026-07-28] Line
   items on the Deal. Prompted by reading 55 real reviews of HubSpot's own
   Shopify integration (user-supplied): repeated, specific complaints about
   no SKU/product-level data reaching HubSpot ("disappointing integration
   that provides neither SKUs nor usable order data", "can't build lists
   based off what products customers bought"). Checked this app's own code
   against its v1 scope claim ("Products/line items attached to the Deal")
   and found it was never actually implemented — `sync.ts`/`deals.ts` only
   ever set `dealname`/`amount`/`pipeline`/`stage`/`owner`, no line items at
   all. Fixed: `ShopifyOrder.line_items` (src/sync.ts) maps each Shopify
   line item (title + variant_title folded into one `name`, quantity,
   price, sku) into a `DealLineItem`; `src/hubspot/deals.ts`'s new
   `createLineItems()` creates each as its own HubSpot line item object,
   associated to the deal via `AssociationTypes.lineItemToDeal`.
   Deliberately only runs on the deal's initial create, not on every
   `orders/updated` — Shopify order line items don't change after an order
   is placed (unlike financial_status/fulfillment_status, which is what
   orders/updated actually fires for), so there's nothing to reconcile on
   later deliveries; kept simple rather than adding a fetch-existing/
   diff/archive-and-recreate step for a case that doesn't occur in
   practice.
   `npm run build` compiles clean. Tried to verify live end-to-end (signed
   `orders/create` webhook with two line items, against the real dev store)
   and hit a real blocker: HubSpot rejected the line-item create with 403
   `MISSING_SCOPES`, requiring `crm.objects.line_items.write` (or the
   broader `e-commerce` scope) — neither is in this OAuth app's current
   scope list (only contacts/deals read+write from when this was built).
   **Not yet usable until:**
   1. Add `crm.objects.line_items.write` (narrowest fit — avoid the
      broader `e-commerce` scope) to this app's OAuth scopes. Since this is
      a CLI-managed public app (see step 9's June-2026 HubSpot CLI note),
      that means editing `requiredScopes` in the project's
      `app-hsmeta.json` and running `hs project upload` again — not a
      dashboard toggle. (This repo doesn't contain that HubSpot CLI
      project directory — it lives wherever `hs project create` was
      originally run.)
   2. Every already-connected merchant (currently just the one dev store)
      must redo the HubSpot OAuth handshake
      (`/auth/hubspot?shop=<domain>`) — a merchant's granted scopes are
      fixed at authorization time and don't retroactively pick up new
      scopes added to the app later. Until reconnected, `syncOrder` will
      keep hitting this same 403 for every order with line items.
   Test deal/contact created during the (failed) live test were cleaned up
   via direct HubSpot API calls afterward; no line items were left behind
   since the create call itself is what failed.
   **[RESOLVED, VERIFIED, 2026-07-28]** User added
   `crm.objects.line_items.read`/`write` to the HubSpot project's
   `app-hsmeta.json` `requiredScopes` and ran `hs project upload`. That
   surfaced two more real gaps before this actually worked, both fixed:
   - First reconnect attempt failed with "redirect URL doesn't match the
     app's registered redirect URL" — turned out to be a red herring order
     of operations, not an actual redirectUrls problem (screenshot
     confirmed `app-hsmeta.json` already listed both the localhost and
     Render callback URLs correctly).
   - Real blocker: HubSpot then rejected the authorize request with
     "provided scopes are missing crm.objects.line_items.read/write, which
     are required for the app to function." Root cause was in this repo,
     not HubSpot's config: `src/hubspot/oauth.ts`'s hardcoded
     `OAUTH_SCOPES` list (used to build the `/auth/hubspot` authorize URL)
     still only requested the original contacts/deals scopes — once the
     HubSpot app's `requiredScopes` grew, every install's authorize request
     had to request the new scopes too, or HubSpot rejects it outright.
     Fixed by adding both line-item scopes to `OAUTH_SCOPES`.
   After that fix: reconnected the dev store via
   `/auth/hubspot?shop=hubspottest-retveu6u.myshopify.com`; directly
   queried HubSpot's access-token introspection endpoint and confirmed the
   stored token now carries both `crm.objects.line_items.read` and
   `.write`. Re-ran the same signed `orders/create` webhook test (two line
   items, one with a variant) against the live dev store and confirmed via
   direct HubSpot API calls: both line items created, correctly associated
   to the deal (`AssociationTypes.lineItemToDeal`), and carrying the right
   `name` (title + variant folded together), `price`, `hs_sku`, and
   `quantity` — HubSpot's own `amount` on each line item is a computed
   `price × quantity` value, not something this app sets directly. Deal's
   own `amount` still reflects the full order total, unaffected. Test
   deal/line items/contact deleted afterward.
   Still needed: this scope change plus the `OAUTH_SCOPES` fix haven't
   reached Render yet — the production HubSpot app config was already
   updated (shared across environments, it's the same HubSpot app), but
   this repo's code fix needs a normal deploy, and Render's own connected
   merchants (currently none beyond the dev store) would need the same
   reconnect step once real merchants exist.

9c. [DONE, VERIFIED, 2026-07-28] Lifecycle stage on purchase. Second item
   from the same 55-review pass (see 9b): reviewers of HubSpot's own
   Shopify integration specifically complained contacts stay stuck as
   "leads" forever even after completing a purchase, and that the old
   integration used to move them to "Customer" automatically. Fixed:
   `src/hubspot/contacts.ts`'s `ContactProperties` gained an optional
   `lifecyclestage`; `src/sync.ts`'s `syncCustomer()` takes an optional
   `lifecycleStage` param, and `syncOrder()` is the only caller that passes
   `'customer'` — the plain `customers/create` webhook path (account
   creation alone, not evidence of a purchase) leaves it unset so it
   doesn't wrongly promote someone who hasn't bought anything.
   Verified live against the real dev store/HubSpot portal: a bare
   `customers/create` webhook left the contact at the portal's default
   (`lead`); a following `orders/create` webhook for the same email moved
   it to `customer`. Test contact/deal deleted afterward.

9d. [DONE, VERIFIED, 2026-07-28] Automatic onboarding — closed a real
   launch-blocker, not a cosmetic one, found by walking through "what does
   a merchant actually see after installing?" end to end. Webhook
   registration (`npm run register-webhooks`) and historical backfill
   (`npm run backfill`) were both CLI-only scripts, never invoked by the
   OAuth flow itself — meaning a real merchant self-installing from the
   App Store would complete both OAuth handshakes successfully and then
   have literally nothing sync, silently, forever, unless the developer
   personally SSH'd in and ran both scripts by hand for that shop. Fine
   for a single dev store operated by hand; not workable for real
   self-serve installs.
   Fixed by extracting the reusable core out of each script so both the
   CLI and the OAuth callback can call it:
   - `src/shopify/webhookRegistration.ts`'s `registerWebhooksForShop()` —
     `src/scripts/register-webhooks.ts` is now a thin wrapper around it.
   - `src/backfillMerchant.ts`'s `backfillMerchant()` —
     `src/scripts/backfill.ts` is now a thin wrapper around it.
   `src/hubspot/oauth.ts`'s OAuth callback (the point at which both
   Shopify and HubSpot are fully connected) now calls
   `registerWebhooksForShop()` itself — awaited, since it's a handful of
   fast API calls and its success/failure is worth showing on the success
   page immediately, not just in server logs — then kicks off
   `backfillMerchant()` in the background (NOT awaited: blocking the HTTP
   response on however long a merchant's full order history takes to
   import would leave them staring at a blank tab). Both are already
   idempotent (search-before-create throughout), so this is also safe to
   fire again on a merchant reconnecting HubSpot later for new scopes
   (exactly what happened earlier this session for the line-items scope).
   Registration is expected to fail in local dev (`APP_URL` isn't
   `https://`) — caught and shown as a warning on the success page rather
   than treated as a broken connection; the callback still explains how to
   retry it (`npm run register-webhooks -- <shop>`) if it ever fails for
   a real reason in production.
   Verified: `npm run build` clean. Couldn't fully exercise the actual
   OAuth-callback code path without a second real Shopify dev store (a
   fresh browser install is the only way to hit `/auth/hubspot/callback`
   for real) — instead verified the two extracted functions directly
   against the live dev store/HubSpot portal: `registerWebhooksForShop`
   found all three topics already registered (idempotent, no errors);
   `backfillMerchant` re-synced the existing 7 customers/4 orders with no
   duplicates created. The callback's own glue around them (try/catch,
   `.then/.catch`) is a thin, low-risk wrapper around those two proven
   functions — full proof of the wiring itself will come from the next
   real merchant install.
   **Still not solved by this**: there's still no way for a merchant to
   regenerate their admin API key if they lose it (minted once, shown
   once, only its hash stored) — no rotate/reset endpoint exists.
   Flagged, not built this pass.

9e. [DONE, VERIFIED, 2026-07-28] Onboarding page redesign. Both OAuth
   callback pages (`src/shopify/oauth.ts`, `src/hubspot/oauth.ts`) were
   bare unstyled `<h1>` text — the only UI a merchant ever sees, and the
   thing most directly responsible for whether they trust the app enough
   to keep going. New `src/htmlPage.ts`: dependency-free `renderPage()`/
   `renderErrorPage()` (inline CSS, light+dark via
   `prefers-color-scheme`, no client JS/external assets — this renders a
   handful of times per merchant, so a build step or framework would be
   pure overhead). Applied to every user-facing response in both OAuth
   routers, success and error paths alike (webhook/backfill errors, which
   merchants never see, were left as-is).
   Content changes, not just styling: the Shopify-connected page is now
   explicitly labeled "Step 1 of 2" with a clear next action; the
   HubSpot-connected page (the real "you're done" moment) is a checklist —
   Shopify ✅, HubSpot ✅, webhooks ✅/⚠️, historical import ⏳ — plus a
   plain-English "what happens now, you don't need to do anything else"
   paragraph that also states the Deals-not-Orders distinction (the whole
   premise of this app) so a merchant immediately sees why this isn't just
   HubSpot's own broken integration again. The one-time admin-key block is
   now explicitly framed "optional, for later" with a ready-to-copy `curl`
   command instead of just a bare key + prose explanation. When webhook
   registration fails, the headline itself changes ("Almost there" instead
   of "You're all set") rather than claiming success next to a warning box.
   Verified visually, not just by reading the HTML: rendered the actual
   `renderPage`/`renderErrorPage` output for all four states (Shopify
   connected, HubSpot connected success, HubSpot connected with a webhook
   warning, a generic error page) to static files and screenshotted them
   with Playwright driving the system's installed Chrome (no browser
   binary download needed) — checked both light and dark rendering.
   Caught and fixed one real issue this way: the warning-state page
   originally still read "You're all set 🎉" right above the warning box,
   undercutting it — text-only review wouldn't have surfaced how off that
   looked next to the actual warning styling.
   **Deliberately still out of scope**: an ongoing settings/status
   dashboard. Per the multi-merchant design doc (step 9), that needs a
   real auth model beyond a bearer key and was already deferred once for
   that reason — these onboarding pages are the "first impression," not a
   replacement for that decision.

9. Business steps: Shopify App Store review (needs a privacy policy — touches
   customer PII), billing/pricing setup.
   [DONE — multi-merchant + configurable deal mapping, 2026-07-25] Per
   explicit user instruction ("we only go to step 9 once everything is
   perfect" — a go-live gate, not a someday-maybe) plus a follow-up
   clarification that merchants' data must land in *their own* HubSpot
   portal, never the developer's: replaced the single static
   `HUBSPOT_ACCESS_TOKEN`/`HUBSPOT_DEAL_PIPELINE`/`HUBSPOT_DEAL_STAGE`
   globals with real per-merchant HubSpot OAuth and per-merchant
   configurable deal-mapping rules. Design doc:
   `C:\Users\elias\.claude\plans\federated-knitting-rabbit.md`. Summary:
   - `shopify_installations` renamed to `merchants` (one-time migration via
     `npm run migrate-merchants`, run by hand against the live DB before
     deploying this code) — now holds both the Shopify token and the
     HubSpot OAuth token/refresh token/portal id/expiry, plus per-merchant
     `deal_pipeline`/`deal_stage` defaults, an ordered `deal_rules` JSONB
     array, and a hashed per-merchant admin API key.
   - New `/auth/hubspot?shop=...` + `/auth/hubspot/callback` (src/hubspot/
     oauth.ts), mirroring the existing Shopify handshake (now extracted to
     src/shopify/oauth.ts) — linked from the Shopify callback's success
     page so a real install chains Shopify-connect -> HubSpot-connect in
     one browser session. Both flows' `state` param is now a signed,
     stateless HMAC (src/oauthState.ts) instead of the old single in-memory
     variable, which broke under concurrent installs.
   - `src/hubspot/tokens.ts` resolves + auto-refreshes a merchant's HubSpot
     access token (30-minute lifetime) and builds a per-request HubSpot
     client — replaces the old module-level `hubspotClient` singleton
     (`src/hubspot/client.ts`, deleted). `contacts.ts`/`deals.ts` now take
     `(client, shopDomain, ...)` instead of importing a shared client; their
     in-process mutex/id-cache keys are shop-scoped so two merchants can't
     collide.
   - `src/hubspot/dealRules.ts`: chose design (b) from the three discussed
     below — an ordered JSON rules list (`{when: {financial_status?,
     fulfillment_status?, cancelled?}, pipeline, stage, owner?}`, first
     match wins, falling back to the merchant's own `deal_pipeline`/
     `deal_stage`). Edited via `GET`/`PUT /merchants/:shop/deal-rules`
     (key-authenticated, REST only — no settings UI this pass, per explicit
     user decision). Design (a), named env vars, didn't generalize to
     per-merchant or to owner routing; design (c), a full settings UI, was
     ruled out for this pass since it needs real auth beyond a bearer key.
   - `/sync-status` and the deal-rules endpoints accept either the global
     `ADMIN_API_KEY` (operator key, cross-merchant) or a merchant's own
     per-merchant key (shown once at HubSpot-connect time, stored hashed).
   - Webhook receiver now resolves "which merchant" from Shopify's
     `X-Shopify-Shop-Domain` header per request; HMAC verification itself
     stays on the single shared `SHOPIFY_API_SECRET_KEY` since every
     merchant installs the same Partner-Dashboard app.
   - Backfill/register-webhooks scripts take a shop domain as a CLI arg now
     (`npm run backfill -- <shop>`), falling back to `SHOPIFY_STORE_DOMAIN`
     for single-merchant local dev.
   - New required env vars: `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`
     (from a HubSpot Developer account public app — Auth tab), and
     `OAUTH_STATE_SECRET` (random, signs both OAuth flows' state param).
   - **[DONE — all manual steps completed and verified live, 2026-07-25]**
     Ran `npm run migrate-merchants` against Supabase (had to stop it
     importing `src/config.ts`, which now hard-requires the HubSpot OAuth
     vars this migration runs *before* they exist — rewrote it to open its
     own `pg.Pool` directly off `DATABASE_URL` instead). Two real-world
     surprises creating the HubSpot app, worth knowing for next time:
     (1) HubSpot disabled the old "click Create app -> Public" wizard as of
     June 2026 — new public/OAuth apps now require their CLI (`npm install
     -g @hubspot/cli`, `hs account auth`, `hs project create` with
     Distribution: marketplace + Authentication: oauth, then set
     `redirectUrls`/`requiredScopes` in the generated `app-hsmeta.json` and
     `hs project upload`); (2) even for an unlisted/private-use OAuth app,
     the developer account must sign HubSpot's Acceptable Use Policy (on
     the app's Marketplace-listing tab) before any install/OAuth callback
     will complete — otherwise it fails with "the app developer has not
     signed the acceptable use policy" before ever reaching this app's
     code. `HUBSPOT_CLIENT_ID`/`HUBSPOT_CLIENT_SECRET`/`OAUTH_STATE_SECRET`
     set in both `.env` and Render (Render's `OAUTH_STATE_SECRET` is its
     own separately-generated value, not copied from local — each
     environment signs its own state independently, no reason they need to
     match). Connected the existing store at `/auth/hubspot?shop=
     hubspottest-retveu6u.myshopify.com`, logged into the same HubSpot
     portal (148962866) the old static token pointed at — confirmed via
     `merchants.hubspot_portal_id`. End-to-end smoke test: replayed a real
     signed `orders/updated` webhook for `#1001` against the live Render
     deployment; `sync_log` shows it resolved to the *same* existing deal
     id (`512948276440`) and contact id (`830121312472`) rather than
     creating new ones — proves the full chain (webhook -> merchant lookup
     by shop domain -> HubSpot OAuth token -> existing-record upsert) works
     against a real HubSpot portal, not just against the dev/local setup.
     Old `HUBSPOT_ACCESS_TOKEN`/`HUBSPOT_DEAL_PIPELINE`/`HUBSPOT_DEAL_STAGE`
     already removed from Render's env vars.
   - **Known gap, flagged not built this pass**: if a merchant revokes
     HubSpot access from inside their portal, their refresh token dies and
     every sync for that shop starts failing (visible in `sync_log`, no
     proactive alert/reconnect prompt yet). Decide before real merchants
     are live.
   Before any real merchant's token lands in the database: encrypt
   `merchants.shopify_access_token`/`hubspot_access_token`/
   `hubspot_refresh_token` at rest (e.g. AES-256-GCM with a key held outside
   Postgres itself — a secrets manager, not another env var next to
   `DATABASE_URL`) rather than relying solely on Supabase's disk-level
   encryption and DB access controls. Fine as plaintext for now (dev-only
   data) — flagged here so it doesn't get dropped now that this is actually
   multi-merchant.
   [DONE, VERIFIED, 2026-07-28] Encryption at rest for the three token
   columns above. `src/crypto.ts`: AES-256-GCM, stores `iv:authTag:
   ciphertext` (each base64) in the existing TEXT columns — no schema
   change. Key is a new required `ENCRYPTION_KEY` env var (config.ts),
   consciously choosing "env var, separate from DATABASE_URL" over a real
   secrets-manager integration (AWS KMS/Vault) — explicit user call, given
   this is a single-operator app on Render's free tier and a full KMS was
   judged disproportionate infra for the stage this app is at. Revisit if
   that calculus changes (e.g. a compliance requirement, or Render access
   ceases to be single-operator).
   `src/db/merchants.ts` encrypts on every write (`saveShopifyToken`,
   `saveHubSpotConnection`) and decrypts on every read (`toMerchant`) —
   callers elsewhere (hubspot/tokens.ts, shopify/token.ts, webhooks.ts) never
   see ciphertext, so no other file changed.
   One-time migration for the row(s) that predate this:
   `npm run encrypt-existing-tokens` (`src/scripts/encrypt-existing-tokens.ts`,
   same "own pg.Pool, don't import src/config.ts" shape as
   migrate-merchants.ts, since it must run with `ENCRYPTION_KEY` set but
   before the app's other required vars necessarily are). Idempotent —
   `looksEncrypted()` skips rows already in `iv:authTag:ciphertext` form —
   so safe to re-run. Must run against the live DB *before* deploying this
   code, same ordering as the migrate-merchants step.
   **Sharp edge, unlike `OAUTH_STATE_SECRET`**: local `.env` and Render share
   the *same* Supabase database (no separate staging DB), so `ENCRYPTION_KEY`
   must be set to the identical value in both places — whichever side reads
   a row the other encrypted needs the same key, or decryption throws.
   Verified locally against the live Supabase DB: `npm run build` compiles
   clean; `npm run encrypt-existing-tokens` encrypted the one existing
   dev-store row and printed `encrypted`; re-running it printed `already
   encrypted, skipping` (idempotency confirmed); started the server and hit
   `/health` (`database.connected: true`) and the key-gated `/sync-status`
   (returned real historical entries, proving `ADMIN_API_KEY` auth plus the
   DB read path both still work); then directly called `getMerchant()` and
   confirmed the decrypted `shopifyAccessToken` comes back as a real
   `shpat_...` token (not ciphertext or garbage) and that the HubSpot token
   fields decrypt too. `ENCRYPTION_KEY` still needs adding to Render's
   Environment tab (same value as local `.env`, per the sharp edge above)
   before the next deploy — the running production instance is still
   reading plaintext until that env var lands there and it redeploys.

10. [IN PROGRESS] Pre-launch audit (2026-07-28). Full functional +
    security review of the entire codebase, done at explicit user request
    ("go through everything thoroughly... report back once you are
    absolutely sure") before preparing to go live. Confirmed the three
    original bugs (order searchability, address field mapping, Deals not
    Orders) are genuinely fixed in code, `npm audit` shows 0 vulnerabilities,
    and `.env` was never committed (checked full git history, not just the
    current `.gitignore`). Working through the findings below one at a time,
    starting with 10a.

    Functional gaps found:
    - **10a. [DONE, VERIFIED, 2026-07-28] Blocking for Shopify App Store
      approval**: none of Shopify's three mandatory GDPR compliance
      webhooks (`customers/data_request`, `customers/redact`,
      `shop/redact`) were implemented. Every public Shopify app must handle
      these regardless of what data it stores; app review checks for them.
      Fixed in `src/shopify/webhooks.ts`, bypassing `resolveMerchantOrRespond`
      (these must keep working even for a shop with no live HubSpot
      connection, or already fully uninstalled):
      - `customers/data_request`: this app holds no customer data beyond
        `sync_log` rows and whatever's already synced into the merchant's
        own HubSpot portal (that merchant's data as controller there, not
        this app's to hand over directly) — logs the request so it isn't
        silently lost; fulfilling it is a manual step.
      - `customers/redact`: deletes this customer's own `sync_log` rows
        (new `deleteSyncLogForCustomer` in `src/db/syncLog.ts`). Does NOT
        touch order-entity `sync_log` rows (keyed by Shopify's order
        *name*, e.g. "#1001" — not the numeric order ids this payload's
        `orders_to_redact` provides, so they can't be reliably correlated)
        or the HubSpot Contact itself (unilaterally deleting a merchant's
        CRM record on a customer's request to Shopify is a bigger call
        than this webhook should make) — both logged as needing manual
        follow-up rather than silently skipped.
      - `shop/redact`: the one fully-automatable case — deletes the
        `merchants` row (encrypted tokens included) and every `sync_log`
        row for that shop (new `deleteMerchant` in `src/db/merchants.ts`,
        `deleteSyncLogForShop` in `src/db/syncLog.ts`). Also resolves 10b
        below within Shopify's guaranteed 48-hour post-uninstall window.
      Verified with fake merchant/sync_log rows (`gdpr-test-fake-store-a/b
      .myshopify.com`) seeded directly via SQL — deliberately never
      touched the real dev store, confirmed both during and after the test
      that `hubspottest-retveu6u.myshopify.com`'s merchant row (portal id,
      Shopify token) was untouched. Confirmed: `data_request` deletes
      nothing; `customers/redact` deleted only the matching customer log
      row, left the order log row and merchant row alone; `shop/redact`
      deleted the merchant row and all of that shop's log rows.
      **Still needed, external to this repo**: these three URLs
      (`<APP_URL>/webhooks/shopify/customers/data_request`, `/customers/
      redact`, `/shop/redact`) must be configured in the Shopify Partner
      Dashboard's compliance/mandatory-webhooks section — unlike
      orders/create etc., these aren't registered per-shop via the Admin
      API (`registerWebhooksForShop`), since they need to reach the app
      even for shops with no active installation.
    - 10b. No `app/uninstalled` handling — an uninstalled merchant's
      (encrypted) tokens sit in the DB indefinitely and sync attempts fail
      silently into `sync_log` forever. Downgraded from "separate fix
      needed" to "bounded by 10a": implementing `shop/redact` properly
      deletes the merchant row within Shopify's guaranteed 48-hour window,
      which resolves the practical impact even without a dedicated
      `app/uninstalled` handler.
    - **10c. [DONE, VERIFIED, 2026-07-28]** No automated test suite —
      every guarantee in this app (retry/backoff, concurrent-webhook dedup,
      deal-rule evaluation, encryption round-tripping) was proven only by
      manual live testing against the one real dev store, not by anything
      that would catch a future regression.
      Fixed with Node's built-in test runner (`node:test` + `node:assert`)
      — zero new dependencies, matching this app's existing minimal-deps
      philosophy. `npm test` runs
      `node --require ts-node/register/transpile-only --test "src/**/*.test.ts"`;
      confirmed Node's test runner does its own glob matching (quoted the
      pattern and it still worked), not relying on shell expansion — matters
      since `npm run test` may execute under `cmd.exe` on this Windows
      machine, which doesn't glob-expand `*` the way bash does.
      34 tests across `src/crypto.test.ts`, `src/oauthState.test.ts`,
      `src/mutex.test.ts`, `src/retry.test.ts`,
      `src/hubspot/dealRules.test.ts`, `src/hubspot/conflict.test.ts` — the
      pure, dependency-free logic, not anything needing a live HubSpot/
      Shopify/DB connection (that's what this session's extensive live
      testing already covers, and mocking those SDKs is a much bigger,
      lower-value undertaking than this pass called for). All 34 pass,
      ~1.7s total. Added `src/**/*.test.ts` to `tsconfig.json`'s `exclude`
      and confirmed a clean `npm run build` produces zero `.test.js` files
      in `dist/`.
    - **10d. [DONE, VERIFIED, 2026-07-28]** No way to regenerate a lost admin
      API key (minted once, shown once, no reset endpoint) — flagged
      originally in step 9.
      Fixed without adding a new auth system: a merchant can now reconnect
      HubSpot with `?regenerate_key=1` (e.g. `/auth/hubspot?shop=<domain>
      &regenerate_key=1`) to force a fresh key, since completing that real
      HubSpot OAuth login is already the strongest proof of identity this
      app has for a merchant — no separate account/password exists to gate
      a dedicated reset endpoint on.
      `src/oauthState.ts`'s `createOAuthState`/`verifyOAuthState` now
      carry/return a `regenerateAdminKey` flag as a 4th colon-delimited
      field in the signed state payload (harmless to the Shopify OAuth flow,
      which also uses this shared module but ignores the flag — updated its
      call site in `src/shopify/oauth.ts` for the new `{shop, ...}` return
      shape). `src/hubspot/oauth.ts`'s `/auth/hubspot` route reads
      `?regenerate_key=1` and threads it into the state; the callback now
      mints and overwrites the stored key hash whenever
      `!merchant.adminApiKeyHash || regenerateAdminKey`, not just on first
      connect, and the onboarding page's "optional, for later" block now
      documents this recovery path inline so it isn't only discoverable by
      reading source.
      Verified: `npm run build` clean; extended `src/oauthState.test.ts`
      with a case asserting the flag round-trips through
      create/verifyOAuthState, plus updated the existing cases for the new
      `{shop, regenerateAdminKey}` return shape (was a bare string) — all
      35 tests pass (34 prior + 1 new). Not re-tested against the live dev
      store this pass (would mint a real replacement key for the one
      already-connected merchant, invalidating whatever key is currently in
      use there) — logic covered by the unit tests above instead.
      **Follow-up caught by user review**: the "save this key now" notice
      was the only channel a merchant ever sees it through (no email, no
      other delivery), yet was styled `class="muted"` — small gray text,
      the same de-emphasized style used for throwaway asides like "optional,
      for later." Meanwhile this same page already had a `.warning` class
      (bordered, amber) reserved for the webhook-registration-failure case —
      so a failed webhook was visually louder than a one-time secret that
      (pre-this-fix) was unrecoverable if missed. Fixed by wrapping the key
      + regenerated-key note in `.warning` instead of `.muted` in
      `src/hubspot/oauth.ts`; left the surrounding "optional, for later"
      framing and the curl-example/regenerate-instructions paragraphs as
      `.muted`, since those genuinely are lower-priority. `npm run build`
      and all 35 tests still pass. Not re-verified with an actual browser
      screenshot this pass (no Playwright dependency in this repo, per step
      9e's one-off use of the system's installed Chrome) — low risk since
      this reuses the `.warning` component as-is, already visually verified
      in step 9e for the webhook-warning state.
    - **10e. [DONE, VERIFIED, 2026-07-28]** Refunds aren't synced
      (`refunds/create` isn't a subscribed webhook topic) — a refunded
      order's Deal kept its original amount/stage unless a merchant
      hand-wrote deal-rules via raw REST calls. Researching this led
      straight into step 11 (the REST→GraphQL migration) — GraphQL's
      `currentTotalPriceSet` field reflects the *current*, post-refund total,
      unlike REST's `total_price` (the original) — so once
      `src/backfillMerchant.ts` started sourcing orders via GraphQL, a
      backfill re-run alone already picks up any refund. This closed the
      remaining gap: the *live webhook path* still only reacted to
      `orders/create`/`orders/updated`, neither of which fires on a refund,
      so a refunded Deal would otherwise sit wrong indefinitely between
      backfills.
      Added `refunds/create` as a fourth subscribed topic (`REFUNDS_CREATE`
      in `src/shopify/webhookRegistration.ts`'s topic list). The Refund
      resource's webhook payload only carries a numeric `order_id` — no
      order name, total, or status — so `src/shopify/webhooks.ts`'s new
      `POST /refunds/create` handler re-fetches that order's current state
      via a new single-order GraphQL query
      (`src/shopify/graphqlMapping.ts`'s `fetchOrderById`, addressed by
      `orderGid()` converting the REST numeric id into GraphQL's
      `gid://shopify/Order/<id>` global-id format) and re-runs it through
      the exact same `syncOrder` path `orders/create`/`orders/updated`
      already use — deliberately not trying to hand-compute the new total
      from the refund payload's own line items/transactions, since
      refund/shipping/tax adjustment math is exactly what Shopify's own
      `currentTotalPriceSet` already does correctly. Acks with 200 rather
      than erroring if the order no longer exists (e.g. since deleted).
      One schema wrinkle only caught by checking Shopify's actual docs
      rather than trusting the first search result: `WebhookSubscriptionInput`'s
      callback-URL field is `uri` (a same-named `callbackUrl` field also
      exists but is deprecated) — this also fixed an inconsistency in the
      original step-11 implementation, which had used `uri` for reading
      existing subscriptions but `callbackUrl` for creating new ones.
      New tests: `orderGid` (`graphqlMapping.test.ts`), and
      `webhookRegistration.test.ts`'s `topicsNeedingRegistration` cases
      extended to a 4th topic. All 51 tests pass (50 prior + 1 new); clean
      build.
      Live-verified in two steps, deliberately avoiding an actual refund
      transaction against the real dev store (a genuine store mutation, not
      something to trigger casually): (1) re-ran
      `npm run register-webhooks -- <shop>` (with `APP_URL` pointed at the
      real Render URL) — confirmed the 3 existing subscriptions still
      matched as already-registered and a 4th (`refunds/create`) was newly
      created, live on the shop. (2) Started the local dev server and
      POSTed a hand-signed synthetic `refunds/create` payload (real HMAC
      over `{order_id: 7912996077907}`, order #1001's real numeric id,
      looked up via a one-off GraphQL query) at
      `/webhooks/shopify/refunds/create` — mirrors this project's existing
      testing pattern (steps 3/6) of hand-signing synthetic webhook bodies
      rather than needing a real Shopify-triggered event. Got a 200, and
      `sync_log` showed a fresh `order #1001 -> hubspotId 512948276440`
      entry at the exact request timestamp — the same existing deal, not a
      new one, proving the whole path (HMAC verify → merchant resolve →
      GraphQL re-fetch by id → syncOrder → existing-record update) works
      end to end against the real Shopify GraphQL API and real HubSpot API.
      **Still needed**: this hasn't reached Render yet (needs the normal
      deploy this repo already uses); the `refunds/create` subscription
      just registered points at the production URL, so real refunds won't
      actually reach a working handler until that deploy lands.
    - **10f. [DONE, VERIFIED, 2026-07-28]** No proactive alert if a merchant
      revokes HubSpot access from inside their portal — flagged originally
      in step 9. Explicitly scoped down before building: this app has zero
      email/Slack infrastructure today (no dependency, no provider chosen),
      and standing up real transactional email is a separate infra decision
      — user chose the contained fix (detect + flag + stop pointless
      retries, surfaced through what already exists) over adding a new
      notification channel this pass.
      Two distinct ways revocation actually surfaces, both now handled:
      1. **Delayed** (up to ~30 min later): the next time this app tries to
         refresh the HubSpot access token, HubSpot's refresh endpoint
         rejects it with a real, verified response shape —
         `{status: "BAD_REFRESH_TOKEN", error: "invalid_grant", ...}` —
         confirmed by actually calling HubSpot's live token endpoint with a
         garbage refresh token (safe: doesn't touch the real merchant's
         actual stored token). New `HubSpotRefreshTokenRevokedError`
         (`src/hubspot/tokens.ts`) is thrown instead of a plain Error in
         this specific case; `classifyTokenExchangeFailure` is the pure,
         extracted classification logic (unit-tested without a live HTTPS
         call). `getHubSpotAccessToken` catches it and calls the new
         `markHubSpotConnectionBroken(shopDomain)` (`src/db/merchants.ts`)
         before rethrowing — the webhook receiver's existing
         `resolveMerchantOrRespond` already acks any such failure with 200
         (no code change needed there), it just wasn't flagged anywhere
         distinct before.
      2. **Immediate** (the far more common real-world case): a merchant
         revokes access, but this app's currently-cached access token
         hasn't hit its stated 30-minute expiry yet, so `resolveMerchant
         Context` still succeeds — the failure actually happens on the very
         next live HubSpot API call (contacts/deals), as an ordinary 401/403
         from the SDK. New `isAuthError` (`src/retry.ts`, alongside the
         existing `getStatusCode` it reuses — exported for this) recognizes
         401/403 specifically (as opposed to 400 validation errors, or the
         429/5xx `withRetry` already retries). `src/sync.ts`'s
         `syncCustomer`/`syncOrder` catch blocks call
         `markHubSpotConnectionBroken` on this condition; `src/shopify/
         webhooks.ts` gained a shared `respondToSyncFailure` helper (used by
         all four sync routes, including the new refunds/create from 10e)
         that acks 200 instead of the usual 500 when `isAuthError` is true —
         deliberately, since Shopify would otherwise keep redelivering the
         same webhook for up to 48 hours for a problem only the merchant
         reconnecting HubSpot can fix.
      New `merchants.hubspot_connection_broken_at` column (nullable
      TIMESTAMPTZ) — added to `ensureSchema`'s `CREATE TABLE IF NOT EXISTS`
      for fresh environments, plus a companion `ALTER TABLE ... ADD COLUMN
      IF NOT EXISTS` (idempotent, runs on every process start same as the
      rest of `ensureSchema`) so it reaches the already-live Supabase table
      without a manual one-time migration script this time. Cleared
      automatically the moment a merchant successfully reconnects
      (`saveHubSpotConnection` now sets it back to `NULL`).
      Surfaced through the existing `/sync-status` endpoint rather than a
      new one: a merchant-scoped request (`?shop=`) now returns
      `hubspotConnectionBrokenAt`; the operator-wide view (global admin key,
      no `?shop=`) returns a new `brokenConnections: string[]` — every
      currently-broken shop in one call, since regularly checking that is
      the realistic "proactive" mechanism available to a single-operator
      app with no notification channel.
      Verified: `npm run build` clean; new tests
      `src/hubspot/tokens.test.ts` (`classifyTokenExchangeFailure` against
      the real BAD_REFRESH_TOKEN shape, a different 400, and an unparseable
      body) and `retry.test.ts` additions for `isAuthError` — 57 tests pass
      (51 prior + 6 new). Live-verified against the real dev store without
      ever actually touching its real HubSpot connection (revoking it for
      real would require redoing the full OAuth handshake to undo): (1)
      confirmed the schema change reached the live Supabase table cleanly
      (`ensureSchema`'s `ALTER TABLE` ran with no error) and `/sync-status`
      returns the new fields correctly (`hubspotConnectionBrokenAt: null`
      per-shop, `brokenConnections: []` globally — the real store is
      healthy); (2) called HubSpot's real token-refresh endpoint with a
      garbage refresh token and confirmed `classifyTokenExchangeFailure`
      correctly identifies HubSpot's actual live error response as
      revoked; (3) seeded a throwaway fake merchant row (same pattern as
      step 10a's GDPR test), confirmed `markHubSpotConnectionBroken` +
      `getShopsWithBrokenHubSpotConnection` correctly flag and list it, then
      confirmed `saveHubSpotConnection` (simulating a successful reconnect)
      clears the flag and drops it from the broken list — then deleted the
      fake row and confirmed the real dev store's row was untouched
      throughout.
      **Still not built, by explicit choice this pass**: an actual
      email/Slack alert. The DB flag + `/sync-status` field are the
      "proactive" mechanism for now; revisit if/when this app gets real
      notification infrastructure for other reasons.
    - **10g. [DONE, VERIFIED, 2026-07-28]** Backfill/sync was fully
      sequential, no batching — fine at target scale (tens–hundreds of
      orders/month), would be slow for a merchant with a large historical
      order count. Scoped deliberately before building: "batching" could
      mean HubSpot's actual batch create/update endpoints, but those don't
      support the search-then-create pattern this app's whole upsert
      architecture is built on (`upsertContactByEmail`/`upsertDealByName`)
      — reworking that would be a much larger refactor for a scale problem
      this app doesn't actually have yet. User chose the smaller, safe fix:
      bounded concurrency instead of true batching.
      New `src/concurrency.ts`'s `mapWithConcurrency(items, concurrency, fn)`
      — a generic worker-pool helper, order-preserving, independently
      testable without touching HubSpot/DB. `src/backfillMerchant.ts` now
      runs both the customer and order sync loops through it at
      `BACKFILL_CONCURRENCY = 5` — not an arbitrary number: it matches the
      exact concurrency level this app's contact/deal upsert path was
      already stress-tested against in step 8 (5 simultaneous webhook
      deliveries converging on one record each, zero duplicates). Safe by
      construction: `src/mutex.ts`'s `withKeyedLock` only serializes calls
      sharing the same natural key (email/dealname) — distinct
      customers/orders in the same concurrent batch never contend with
      each other, so running them in parallel doesn't reintroduce the
      search-index-lag race step 8 fixed.
      New `src/concurrency.test.ts`: order preservation, the concurrency
      cap is actually respected (tracked via an in-flight counter), empty
      input, concurrency higher than item count, and that one item's
      rejection still propagates (matching the previous sequential loop's
      failure behavior) rather than being silently swallowed. All 62 tests
      pass (57 prior + 5 new); clean build.
      Live-verified against the real dev store: re-ran `npm run backfill --
      hubspottest-retveu6u.myshopify.com` and confirmed via `sync_log`
      timestamps that orders/customers now land in tight concurrent bursts
      (5 orders within ~28ms of each other, vs. the previous ~300–600ms
      sequential gaps) — genuine parallelism, not just faster sequential
      calls. Every repeat customer/order still resolved to its exact same
      existing HubSpot id (e.g. `#1001` → `512948276440`,
      `boss@gmail.com` → `830220497120`) — update-not-duplicate held under
      concurrency, all entries `status: success`.
      **Not done, by explicit scope choice**: real HubSpot Batch API
      integration. Revisit only if a merchant's actual historical order
      count grows large enough that 5x-parallel sequential calls are still
      too slow — nothing this pass forecloses that later.

    Security findings, not yet fixed:
    - **10h. [DONE, VERIFIED, 2026-07-28]** Postgres connection disabled
      TLS certificate verification (`ssl: { rejectUnauthorized: false }` in
      `src/db/client.ts`). Traffic was still encrypted, but the client never
      verified it was actually talking to Supabase — a network-positioned
      attacker could MITM with a self-signed cert undetected.
      Fixed with Supabase's real root CA (`Supabase Root 2021 CA`, valid
      2021–2031) — user downloaded it from their project's Database ->
      Settings -> SSL Configuration page (this isn't fetchable from any
      stable public URL, and public GitHub copies floating around aren't a
      trustworthy source for a security fix) and pasted it in; parsed and
      confirmed well-formed (self-signed, correct subject/issuer) with
      Node's `crypto.X509Certificate` before using it. Committed directly
      as `src/db/supabase-ca.crt` rather than a multi-line env var — it's
      not a secret, it only lets this app verify the server's identity,
      same as any CA in a normal trust store. `src/db/client.ts` now does
      `ssl: { ca: <cert contents>, rejectUnauthorized: true }` instead of
      `rejectUnauthorized: false`.
      One build wrinkle: `tsc` doesn't copy non-`.ts` files, and
      `path.join(__dirname, 'supabase-ca.crt')` resolves relative to
      wherever the *running* file lives — `dist/db/` after a build, `src/db/`
      under `ts-node`/`ts-node-dev` (which run the source in place, so the
      other scripts and `npm run dev` needed no changes). Fixed by
      appending a copy step to the `build` script itself
      (`tsc && node -e "...copyFileSync(...)..."`) rather than a separate
      shell command, since this needs to run identically in `package.json`
      regardless of the host shell (PowerShell locally vs. Render's Linux
      build).
      Verified: `npm run build` produces `dist/db/supabase-ca.crt`; all 62
      tests still pass. Live-verified against the real Supabase Session
      Pooler connection (`aws-0-<region>.pooler.supabase.com`, per step 5)
      — confirming the same CA that signs the direct-connection cert also
      signs the pooler's, which wasn't guaranteed by the docs alone: a
      direct query with the new `ssl: {ca, rejectUnauthorized: true}` config
      succeeded (`SELECT 1` returned normally), and `/health` on the live
      running dev server (auto-reloaded via `ts-node-dev`) still reported
      `database.connected: true`. Negative control, to prove verification
      is actually enforced and not silently bypassed: the same connection
      attempt with a deliberately wrong/garbage CA correctly failed with
      `self-signed certificate in certificate chain` rather than connecting
      anyway.
      Nothing needed on Render's side — the cert travels with the repo, no
      new env var.
    - **10i. [DONE, VERIFIED, 2026-07-28]** Credential hygiene: several real
      secrets (DB password, Shopify/HubSpot client secrets, the admin key,
      the encryption key) were displayed in plaintext in chat multiple
      times this session while debugging live. Not a public leak, but
      worth rotating the cheap ones (`ADMIN_API_KEY`, `OAUTH_STATE_SECRET`)
      before onboarding real merchants.
      Generated fresh random values for both — deliberately *different*
      values for local `.env` vs. Render, matching the existing precedent
      for `OAUTH_STATE_SECRET` (step 9: "each environment signs its own
      state independently, no reason they need to match"), which extends
      naturally to `ADMIN_API_KEY` too (operator-only, no cross-environment
      dependency). Local `.env` updated directly; user updated Render's
      Environment tab by hand (outside this repo, no code change).
      Verified live against the real Render deployment: `GET /sync-status`
      with the new `ADMIN_API_KEY` returns 200; the same request with the
      *old* key now returns 401 — confirms the rotation actually replaced
      the old value in production rather than the new one merely being
      added alongside it. `OAUTH_STATE_SECRET`'s rotation has no equivalent
      external check (by design — its value isn't observable from outside
      a live OAuth handshake), so it's taken on the user's confirmation
      that Render's Environment tab was updated and saved (which restarts
      the service automatically, no redeploy needed).
      **Still lower priority, not rotated this pass** (per the original
      finding's own reasoning): `ENCRYPTION_KEY` and the DB password are
      harder to rotate (`ENCRYPTION_KEY` needs coordinated re-encryption of
      every already-encrypted row; the DB password needs a coordinated
      Supabase-side change plus updating `DATABASE_URL` everywhere
      simultaneously) — revisit if this ever stops being a single-operator
      app, or if either secret is suspected actually compromised rather
      than just shown on-screen during debugging.
    - **10j. [DONE, VERIFIED, 2026-07-28]** No rate limiting anywhere
      (OAuth routes, webhook receiver, `/sync-status`) — acceptable at
      current scale, worth knowing it's absent.
      Added `express-rate-limit` (official-ish, actively maintained,
      minimal single dependency — rate limiting's sliding-window/IP
      handling is exactly the kind of thing better done by a vetted
      library than hand-rolled). New `src/rateLimit.ts` exports three
      generous, deliberately non-strict limiters (anti-abuse/DoS
      mitigation, not a per-user quota — legitimate traffic at this app's
      target scale should never approach these): `oauthRateLimiter` (30 /
      15 min), `webhookRateLimiter` (120/min), `apiRateLimiter` (60/min,
      `/sync-status` + deal-rules CRUD).
      `app.set('trust proxy', 1)` added to `server.ts` — required for the
      limiter to key off real client IPs instead of Render's own proxy
      address. Deliberately conservative on the exact hop count: community
      reports on Render's proxy chain disagree (1 vs. 3), so this trusts
      only the first hop — under-trusting fails safe (coarser IP grouping,
      a usability wrinkle) where over-trusting would let a client forge
      its own `X-Forwarded-For` to dodge the limit entirely (a real
      bypass). Documented as a judgment call in `src/rateLimit.ts` in case
      it needs revisiting once real multi-merchant traffic makes IP
      granularity matter more.
      **Real bug caught by live testing, not just code review**: the first
      pass wired `oauthRateLimiter` via `shopifyOAuthRouter.use(...)`/
      `hubspotOAuthRouter.use(...)` (router-level, unconditional). Since
      both routers are mounted in `server.ts` via plain `app.use(router)`
      with no path prefix (they "register their own absolute paths," per
      the existing comment there), that unconditional `router.use()`
      middleware actually ran for *every* request reaching the app —
      including `/sync-status` — not just `/auth/*`. Worse, since both
      files imported the same shared `oauthRateLimiter` instance, a single
      request traversing both routers incremented its counter twice. This
      wasn't caught by `npm run build`/`npm test` (routing behavior like
      this has no type-level signal) — only surfaced by actually hammering
      `/sync-status` locally and noticing the `RateLimit-Policy` response
      header reported the *OAuth* limiter's config (30;w=900), not the API
      one. `src/shopify/webhookRouter` didn't have this problem, because
      it's mounted with an explicit `/webhooks/shopify` path prefix in
      `server.ts`, correctly scoping its own router-level `.use()`.
      Fixed by moving `oauthRateLimiter` off the router and onto each
      individual route (`shopifyOAuthRouter.get('/auth/shopify',
      oauthRateLimiter, ...)`, etc.) in both `src/shopify/oauth.ts` and
      `src/hubspot/oauth.ts` — scopes it precisely regardless of how the
      router itself is mounted upstream.
      Verified live against the local dev server (this is inherently HTTP
      routing behavior, not pure logic — matches how `webhooks.ts`'s own
      routes have zero unit tests either, verified live instead): `/health`
      unaffected by rate-limited traffic elsewhere; hammering `/sync-status`
      65 times straight through the (buggy) first pass reproduced the bug
      exactly (15 successes then 429, `RateLimit-Limit: 30` in the
      response — the OAuth limiter's config leaking onto an unrelated
      route); after the fix, 20 straight `/sync-status` calls all
      succeeded; hammering `/auth/shopify` 35 times produced exactly 30
      successes then 429 (matching the configured limit precisely), with
      `/sync-status` and `/health` immediately confirmed still unaffected
      afterward; 5 unsigned POSTs to `/webhooks/shopify/orders/create`
      correctly 401'd on the (unrelated) HMAC check with no rate-limiting
      interference either way. `npm run build` and all 62 tests pass.
    - **10k. [FOUND, 2026-07-28, not this app's code]** `npm audit` now
      reports 5 high-severity findings (`brace-expansion` DoS via unbounded
      expansion, no fix available), all via `ts-node-dev` → `rimraf` →
      `glob` → `minimatch` → `brace-expansion`. `ts-node-dev` is a
      `devDependency` used only by `npm run dev` (local hot-reload) — never
      in the `npm run build`/`npm start` production path this app actually
      ships, so real exposure is low, but flagging rather than letting a
      newly-red `npm audit` go unexplained. Unrelated to step 11's
      `@shopify/admin-api-client` addition (confirmed via `npm ls` — that
      package's tree is clean); revisit if `ts-node-dev` ships a fix or a
      replacement dev-reload tool becomes worth adopting.

    Checked and confirmed NOT vulnerable (documented so this isn't
    re-litigated later): SQL injection (parameterized queries throughout),
    XSS (no user-controlled Shopify/HubSpot content ever reflected into the
    onboarding HTML pages), SSRF via the `shop` param (Shopify SDK's
    `sanitizeShop` enforces a real `*.myshopify.com` domain, verified
    directly in its source), webhook HMAC and OAuth state CSRF protection
    (both timing-safe, state additionally expires after 10 minutes).

11. [DONE, VERIFIED, 2026-07-28] Migrated the Shopify integration from the
    REST Admin API to the GraphQL Admin API. Discovered mid-audit while
    researching 10e (refunds): Shopify's own changelog states "starting
    April 1, 2025, new public apps submitted to the App Store after this
    date must only use GraphQL" — REST Admin API is legacy for this
    purpose. This app hasn't been submitted for App Store review yet (see
    step 9's still-open business step), so it counts as "new" and had to
    migrate before submission or risk automatic rejection at review.
    Scope (confirmed by grep — only two files imported the REST transport):
    `src/shopify/webhookRegistration.ts` (per-shop webhook subscription
    list/create) and `src/backfillMerchant.ts` (historical customer/order
    listing). Deliberately untouched: `src/shopify/oauth.ts` (the OAuth
    token-exchange/HMAC-validation layer isn't Admin API resource access),
    `src/shopify/webhooks.ts` (the inbound webhook receiver — Shopify
    delivers webhook payloads in the same shape regardless of how the
    subscription was registered), `shopify.app.toml`'s
    `[webhooks.privacy_compliance]` block (confirmed via Shopify docs that
    the `webhookSubscriptions` GraphQL query only returns shop-scoped
    subscriptions, not this app-level config — no interaction), and
    `src/sync.ts` (`syncCustomer`/`syncOrder` and their REST-shaped
    snake_case interfaces — also used by the unchanged webhook receiver, so
    a mapping layer translates GraphQL responses into these same shapes
    rather than changing them). Verified both files are byte-identical via
    `git diff` after the migration.
    Added `@shopify/admin-api-client` as a direct dependency (was already
    present transitively via `@shopify/shopify-api` — it's what that SDK's
    own `GraphqlClient` wraps internally, and its
    `createAdminApiClient({storeDomain, apiVersion, accessToken})` factory
    matches this app's per-merchant-token model — `src/shopify/token.ts`'s
    `resolveShopifyAccessToken` — with no SDK session/`shopifyApi()`
    ceremony needed, unlike the SDK's own `GraphqlClient`). Set `retries: 0`
    on the client deliberately so `src/retry.ts` stays the single source of
    retry/backoff truth.
    The core design problem: GraphQL throttling is NOT an HTTP 429 — a
    throttled request returns HTTP 200 with a body-level
    `errors.graphQLErrors[].extensions.code === "THROTTLED"`. `src/retry.ts`
    only ever inspects a thrown error's numeric `.code`/`.statusCode`, with
    no visibility into a successful response's body. Rather than modifying
    `retry.ts` (shared with HubSpot calls, has its own passing tests), new
    `src/shopify/admin-graphql.ts` translates body-level conditions into the
    same `ShopifyAdminApiError {message, code, headers}` shape retry.ts
    already expects: a `networkStatusCode >= 500` or a `THROTTLED`
    `graphQLErrors` entry both become a thrown `ShopifyAdminApiError` (the
    latter synthesized as `code: 429`, since no `Retry-After` header exists
    at this layer — falls through to retry.ts's existing exponential
    backoff); any other GraphQL error becomes a plain `Error` (no `.code` →
    correctly non-retryable, fails fast, matching how REST 4xx validation
    errors were already treated). `withRetry` itself needed zero changes —
    only its top comment was updated for accuracy.
    New files: `src/shopify/admin-graphql.ts` (`shopifyGraphqlRequest` — the
    single choke point wrapping every call in `withRetry`;
    `interpretGraphqlResponse` — the error-translation logic above, exported
    standalone for testing; `collectPages`/`fetchAllPages` — cursor-based
    pagination via `pageInfo.hasNextPage`/`endCursor`, replacing REST's
    `Link`-header-following `nextPath`) and `src/shopify/graphqlMapping.ts`
    (the `CUSTOMERS_QUERY`/`ORDERS_QUERY` GraphQL query strings and
    `mapGraphqlCustomer`/`mapGraphqlOrder`, co-located deliberately so field
    selection and the mapper can't drift apart). Notable field mappings:
    customer email/phone come from `defaultEmailAddress.emailAddress`/
    `defaultPhoneNumber.phoneNumber`, not the deprecated flat `email`/`phone`
    fields (this app targets API version 2026-07, past the 2025-04 version
    where the replacement became available); order amount comes from
    `currentTotalPriceSet` (current, post-refund total) rather than
    `totalPriceSet` (original) — see 10e above.
    `src/shopify/webhookRegistration.ts` rewritten around
    `webhookSubscriptions`/`webhookSubscriptionCreate` — one wrinkle caught
    only by checking Shopify's actual schema docs rather than the first
    search result: `WebhookSubscriptionInput`'s callback-URL field is named
    `uri` (a same-named `callbackUrl` field also exists but is deprecated).
    Extracted the idempotency check (matching existing subscriptions by
    topic + uri before creating) into a standalone `topicsNeedingRegistration`
    function purely so it's unit-testable. `src/backfillMerchant.ts` swapped
    its two REST `fetchAllPages` calls for the GraphQL versions plus
    mapping; its exported signature is unchanged, so
    `src/scripts/backfill.ts` and `src/hubspot/oauth.ts`'s callback needed
    no changes. Deleted `src/shopify/admin-rest.ts` once both call sites
    were migrated (confirmed by grep it was the only importer of either).
    Added new unit tests (this trio previously had zero coverage):
    `admin-graphql.test.ts` (the THROTTLED/5xx/plain-error branches of
    `interpretGraphqlResponse`, and `collectPages`'s cursor-following against
    a fake multi-page sequence), `graphqlMapping.test.ts`
    (`mapGraphqlCustomer`/`mapGraphqlOrder` against full and sparse nodes),
    `webhookRegistration.test.ts` (`topicsNeedingRegistration` against
    none/all/partial-overlap existing-subscription scenarios). All 50 tests
    pass (39 prior + 11 new); `npm run build` clean; a clean `rm -rf dist &&
    npm run build` confirmed no stray `admin-rest.js` or `.test.js` output.
    Live-verified against the real dev store
    (`hubspottest-retveu6u.myshopify.com`), the riskiest assumption first:
    `npm run register-webhooks -- <shop>` (run with `APP_URL` pointed at the
    real Render URL, since local `.env` leaves it blank for local dev)
    correctly recognized all 3 REST-era subscriptions as already registered
    through the new GraphQL query — logged "already registered" for all
    three, created none. Independently confirmed via a direct
    `webhookSubscriptions` query (no topic filter) that exactly 3
    subscriptions exist afterward, matching by id. Then `npm run backfill --
    <shop>` reported the same 7 customers / 4 orders as every prior backfill
    (step 9d), and `sync_log` showed all entries `status: success` with the
    *same* HubSpot contact/deal ids as before (e.g. order `#1001` still
    resolved to deal `512948276440`) — proving update-not-duplicate held
    through the new data source. Spot-checked that deal directly via the
    HubSpot API: `pipeline: "default"`, `dealstage: "closedwon"`, matching
    its pre-migration state exactly — confirming the
    `displayFinancialStatus`/`displayFulfillmentStatus` casing risk flagged
    during planning didn't silently break deal-rule routing.
    `npm audit`: unrelated to this change (see 10k above) — confirmed via
    `npm ls @shopify/admin-api-client` that its dependency tree is clean.

12. [IN PROGRESS] Functional audit (2026-07-29), at explicit user request:
    "did we fix every bug we set out to fix... walk the UX/UI from first
    download to ongoing use... is this a complete product." Re-verified the
    three original bugs (order searchability via `dealname`, address field
    mapping, Deals-not-Orders) directly against current code — all three
    still genuinely fixed, no regressions from the GraphQL migration (step
    11) or later work. Then walked the actual merchant journey end to end
    (install → OAuth → onboarding pages → ongoing sync → error states →
    uninstall) and produced a punch list. Billing/monetization and the
    missing privacy policy were explicitly deferred by the user to be
    handled together, later, right before going live — everything else is
    being worked one at a time:
    - **12a. [DONE, VERIFIED, 2026-07-29]** No merchant-facing UI at all
      after the two onboarding pages — the single biggest gap. Checking
      sync status or changing deal-routing rules required hand-crafting
      `curl` requests with a bearer key, completely inaccessible to this
      app's actual target customer (small, non-technical merchants).
      Built a full control panel per explicit user decision (view status +
      edit deal rules + retry webhook registration + regenerate admin key),
      reusing the existing per-merchant bearer-key auth rather than
      building a new session system — deliberately deferred before, for
      good reason, and still not warranted here.
      New `GET /dashboard?shop=...` (`src/dashboardPage.ts`): a static page
      with vanilla inline JS (no framework/bundler/new dependency — the
      one page in this app that genuinely needs client-side interactivity,
      unlike the two onboarding pages which render once server-side and
      are done). Auth is a "paste your key" form; the key is held in
      `localStorage` per shop from then on and attached as a Bearer token
      to every API call. A single `authedFetch` choke point handles a key
      going bad *mid-session* (not just on first load) by clearing storage
      and re-showing the form. This is also the first page in the app
      where merchant/server-controlled content (sync-log errors, HubSpot
      portal ids, merchant-typed rule text) is ever reflected into the
      DOM — every render path uses `createElement`/`textContent`, never
      `innerHTML` with interpolated data, to keep the zero-XSS-surface
      guarantee the rest of the app already had.
      Three new endpoints in `src/server.ts` (same `requireAdminOrMerchantAuth`
      + `apiRateLimiter` stack as the existing deal-rules routes):
      `GET /merchants/:shop/status` (connection info + per-topic webhook
      registration status — new `deriveWebhookStatus`/
      `getWebhookRegistrationStatus` in `src/shopify/webhookRegistration.ts`,
      reusing the existing `topicsNeedingRegistration` match logic so the
      two can't drift apart), `POST .../retry-webhooks` (thin wrapper
      around the existing `registerWebhooksForShop`), and
      `POST .../admin-key/regenerate` — a *new* rotation path, distinct
      from the existing `?regenerate_key=1` HubSpot-reconnect recovery
      flow (`src/hubspot/oauth.ts`): that one is for a merchant who lost
      their key entirely; this one is for a merchant who still has a
      valid key and wants to rotate it, authenticated by that existing key
      rather than a full OAuth round-trip (`generateAndStoreAdminApiKey`
      extracted out of the OAuth callback so both paths share it, no
      behavior change to the callback itself). The deal-rules editor and
      activity feed reuse the existing `GET`/`PUT /merchants/:shop/deal-rules`
      and `GET /sync-status` endpoints as-is. Also added a "View your
      dashboard →" link to the HubSpot-connected success page, and
      changed the webhook-registration-failure message from "run
      `npm run register-webhooks`" (only the developer can do that) to
      "retry it from your dashboard" — closing that UX gap as a direct
      side effect of this work, not a separate pass.
      `src/htmlPage.ts` gained a `{wide: true}` option (a wider card, 820px
      vs. the onboarding pages' 560px) and shared form/table/badge CSS,
      reused by the dashboard rather than it carrying its own stylesheet.
      New tests (`src/shopify/webhookRegistration.test.ts`):
      `deriveWebhookStatus` against none/all/partial-registered and a
      stale-uri case — mirrors the existing `topicsNeedingRegistration`
      tests almost 1:1. 66 tests pass (62 prior + 4 new); clean build.
      Not unit tested, by explicit, documented scope boundary matching
      this project's established precedent: the three new route handlers
      (thin glue over already-tested functions, same category as
      `webhooks.ts`'s untested routes — 10j's own finding is the concrete
      precedent that routing bugs need live verification, not `tsc`, to
      catch) and the dashboard's inline `<script>` (no jsdom/browser test
      runner in this repo; adding one for a single admin page would be
      disproportionate — covered by live verification instead).
      Live-verified against the real dev store and the deployed Render
      instance (temporarily installed Playwright locally via
      `npm install --no-save` for real browser screenshots, removed
      afterward — confirmed `package.json`/lockfile untouched):
      - `GET /merchants/:shop/status` returns real data (portal id
        `148962866`, all 4 webhook topics `registered:true`) with the
        correct per-merchant key; 401 on a bad key; 404 on an unknown
        shop; the operator's global key works too.
      - `POST /merchants/:shop/retry-webhooks` against Render returns
        `{ok:true}` idempotently (already-registered case); locally
        (no `https://` `APP_URL`) surfaces the existing guard's message
        unchanged through the new JSON envelope.
      - Deal-rules round-trip via raw `curl` against Render: PUT a
        throwaway rule, confirmed it persisted via GET, reverted to the
        original empty rules so nothing was left mutated on the real
        merchant.
      - Full Playwright pass against the live Render dashboard: key-entry
        state and populated state (real connection status, webhook
        badges, recent activity, deal-rules editor) in both light and
        dark; exercised the rule editor itself (add row, fill fields,
        confirm no layout overflow in the wider card).
      - Rate limiting: hammered `GET /merchants/:shop/status` past
        `apiRateLimiter`'s 60/min — exactly 60 successes then 429,
        matching the configured limit precisely (no repeat of 10j's
        router-scoping bug; these routes apply the limiter per-route
        directly, not via a router-level `.use()`).
      - **401-mid-session recovery, the one path that genuinely needed a
        real (not simulated) test**: first attempt corrupted `localStorage`
        directly and found the dashboard didn't react — turned out to be a
        flaw in the *test*, not the app: the already-loaded page holds the
        key in an in-memory JS variable, populated once at sign-in, so
        patching `localStorage` alone doesn't affect what's actually sent.
        Redid it correctly — regenerated the admin key server-side via a
        separate `curl` call (a real, not simulated, invalidation) while
        the dashboard tab remained open with the old key in memory, then
        clicked "Retry webhook registration" in that same tab: got a real
        401, watched the UI clear `localStorage`, hide the dashboard
        content, and re-show the key form with a clear, correct message,
        then confirmed the newly-generated key signs back in successfully
        in the same tab. This exercise also completed the previously-planned
        regenerate-key live verification in the same pass — the dev
        store's admin key has been rotated as a result; current value
        recorded outside this file, not printed in chat per 10i's
        credential-hygiene finding.
      **Everything from this audit's punch list is now done** (12a-12g).
      Explicitly re-confirmed as still-accepted, not re-opened by this
      audit: no `app/uninstalled` handler (bounded by `shop/redact`'s 48h
      window, 10b), no real email/Slack alert for a broken HubSpot
      connection (10f), and the `ts-node-dev` `npm audit` finding (10k,
      dev-only, no fix available). Billing/monetization and the privacy
      policy were deliberately deferred by the user, to be handled together
      right before going live — not part of this punch list.
    - **12g. [DONE, VERIFIED, 2026-07-29]** No `orders/delete`/
      `customers/delete` webhook handling — deleting an order/customer
      directly in Shopify left the corresponding HubSpot Deal/Contact
      orphaned with zero indication anything had changed.
      Explicit design choice confirmed with the user first, since it cuts
      both ways and is hard to reverse either way: log the deletion for
      visibility, but never auto-touch the HubSpot record — matching this
      app's own existing precedent in the `customers/redact` GDPR handler,
      where the same call was already made ("deleting a merchant's CRM
      record... is a bigger call than this webhook should make
      unilaterally"). The alternative (auto-archiving the Deal/Contact)
      was explicitly considered and rejected — a merchant's CRM data
      (notes, activity history) could vanish for what they thought was a
      routine Shopify-side cleanup.
      Added `orders/delete`/`customers/delete` to
      `src/shopify/webhookRegistration.ts`'s subscribed topics (verified
      the exact `WebhookSubscriptionTopic` GraphQL enum values —
      `ORDERS_DELETE`/`CUSTOMERS_DELETE` — against Shopify's docs before
      wiring them in, since a wrong enum value in the shared `$topics`
      array would have broken registration for all 6 topics at once, not
      just these two; both only require scopes this app already has,
      `read_orders`/`read_customers`, no new OAuth scope changes needed).
      New routes in `src/shopify/webhooks.ts` log a new `SyncStatus` value,
      `'deleted'` (`src/db/syncLog.ts`), keyed by whatever numeric id
      Shopify's delete payload provides — deliberately not trying to
      resolve it back to a dealname/email, since nothing in this app
      stores a mapping from a Shopify numeric order/customer id to its
      HubSpot record (the order/customer is already gone by the time the
      webhook arrives, so it can't be re-fetched either, unlike
      `refunds/create`'s re-fetch approach). Dashboard (12a) renders
      `'deleted'` with the same neutral badge as `'skipped'` — informational,
      not a failure.
      Updated `src/shopify/webhookRegistration.test.ts`'s fixtures from 4
      to 6 topics throughout, matching the established pattern from 10e's
      similar update. 72 tests pass (unchanged — no new pure logic here
      beyond what the existing `topicsNeedingRegistration`/
      `deriveWebhookStatus` tests already cover generically); clean build.
      Live-verified against the real dev store: re-ran
      `npm run register-webhooks` — the 4 existing topics stayed
      untouched, both new ones registered fresh, confirmed via a direct
      status check that all 6 now show `registered: true`. Hand-signed
      synthetic `orders/delete`/`customers/delete` webhooks (same low-risk
      pattern as 12d/12e) both returned 200 and produced the expected
      `sync_log` entries — `status: 'deleted'`, correct numeric id, the
      right explanatory message — confirmed via a direct query that
      neither call touched HubSpot at all (no API calls in that code path
      to begin with). Playwright screenshot of the dashboard's activity
      feed confirms both render with the neutral badge, consistent with
      `'skipped'`.
    - **12f. [DONE, VERIFIED, 2026-07-29]** No `.env.example` existed
      despite `config.ts`'s own missing-required-var error message pointing
      new setups at one ("Copy .env.example to .env and fill these in
      before starting the server.").
      Added `.env.example` at the project root, mirroring the real `.env`'s
      structure and its genuinely useful comments (generation commands for
      `ADMIN_API_KEY`/`OAUTH_STATE_SECRET`/`ENCRYPTION_KEY`, where to find
      each Shopify/HubSpot credential, which vars are required vs.
      optional-with-a-default) — every value itself is a generic placeholder
      (e.g. `postgresql://user:password@host:5432/dbname`,
      `your-dev-store.myshopify.com`), never a real secret or real
      infrastructure identifier (no real Supabase host/project ref, no real
      store domain, no real client IDs). Confirmed `.gitignore` only
      excludes the literal `.env` filename, not a `.env*` glob, so this new
      file is tracked normally rather than accidentally ignored too.
      Pure documentation — no code changed, so no build/test/live
      verification needed beyond confirming every var name matches
      `config.ts`'s actual `REQUIRED_VARS` list and optional-var defaults
      exactly (cross-checked directly against the file).
    - **12e. [DONE, VERIFIED, 2026-07-29]** Currency was discarded — Deal
      `amount` was a bare number with no currency code, risky for any
      merchant whose store currency differs from their HubSpot portal's
      default.
      Real constraint discovered before implementing (not assumed): HubSpot
      enforces `deal_currency_code` validation since July 2023 — setting it
      to a currency that isn't one of the portal's configured currencies
      returns a hard 400 `VALIDATION_ERROR`, not a warning. Naively always
      sending the Shopify order's currency would have made things *worse*
      for a currency-mismatched merchant: trading a wrong-looking amount
      for the entire sync failing outright.
      Designed around it in `src/hubspot/deals.ts`: new
      `DealProperties.currencyCode`, and a `writeDealProperties` wrapper
      around all 4 deal-write call sites (cache-hit update, search-hit
      update, create, post-conflict update) that tries with
      `deal_currency_code` set first, and on the specific validation error
      (new pure, exported `isCurrencyValidationError`, matching
      `conflict.ts`'s existing `err.code`/`err.body.message` duck-typing
      pattern) retries once with it stripped — the deal still syncs with
      its amount, just without the currency tag, rather than failing.
      `ShopifyOrder` gained `currency` (matching Shopify's own REST field
      name, ISO 4217) in `src/sync.ts`, passed through to `upsertDealByName`.
      GraphQL backfill path (`src/shopify/graphqlMapping.ts`): added
      `currencyCode` to `currentTotalPriceSet`'s selection and mapped it —
      wasn't being fetched at all before.
      New `src/hubspot/deals.test.ts` (this file didn't exist before):
      `isCurrencyValidationError` against the real documented HubSpot error
      message, a non-400 error, an unrelated 400, and non-object input.
      Extended the existing `mapGraphqlOrder` test to assert `currency`
      mapping. 72 tests pass (68 prior + 4 new); clean build.
      Live-verified against the real dev store with hand-signed synthetic
      webhooks (same low-risk pattern as 12d, rather than needing multi-
      currency configured for real): an order with `currency: "USD"` (the
      portal's actual configured currency) produced a deal with
      `deal_currency_code: "USD"` set correctly, confirmed via a direct
      HubSpot API read. An order with `currency: "ISK"` (a real ISO code
      almost certainly not configured in this portal) still synced
      successfully (`status: success` in `sync_log`, not an error) — and
      the resulting deal's `amount` was set correctly while
      `deal_currency_code` came back `null`, proving the fallback engaged
      exactly as designed rather than either failing the sync or writing a
      currency the portal doesn't recognize. Both test deals archived
      afterward.
    - **12d. [DONE, VERIFIED, 2026-07-29]** Orders/customers with no email
      were silently skipped — a guest checkout, POS sale, or any other
      email-less Shopify customer vanished with zero trace: no HubSpot
      contact, no `sync_log` row, nothing. `src/sync.ts`'s `syncCustomer`
      just did `if (!customer.email) return undefined;` with no logging at
      all.
      New `SyncStatus` value `'skipped'` (`src/db/syncLog.ts`) — distinct
      from `'error'` deliberately, since this is expected, legitimate
      Shopify data, not a failure. `syncCustomer` now logs a `'skipped'`
      entry with a clear explanation before returning, keyed by the
      customer's own Shopify id as a fallback identifier (there's no email
      to key off, the usual natural key throughout this app).
      That fallback identifier didn't exist before this fix: `ShopifyCustomer`
      never carried an `id` field (email was always the only key anything
      needed). Added it, and — since the GraphQL backfill path didn't
      request `id` on customer nodes either — added `id` to both
      `CUSTOMERS_QUERY` and the order's embedded `customer` selection in
      `ORDER_NODE_FIELDS` (`src/shopify/graphqlMapping.ts`), plus a new
      pure `numericIdFromGid()` (the inverse of the existing `orderGid()`)
      to convert GraphQL's `gid://shopify/Customer/<id>` back to the plain
      numeric id the REST-shaped webhook payloads already carry natively —
      keeps the fallback identifier consistent regardless of which path a
      given sync came through.
      Dashboard (12a) gained a neutral `.badge-neutral` style
      (`src/htmlPage.ts`) so a skipped entry reads as "nothing to do here,"
      not a failure, in the activity feed — a plain `success`-vs-`error`
      binary would have painted every legitimate no-email customer red.
      New tests (`src/shopify/graphqlMapping.test.ts`): `numericIdFromGid`
      against a real gid, and against missing/malformed input; extended
      the existing `mapGraphqlCustomer` test to assert `id` mapping too.
      68 tests pass (66 prior + 2 new); clean build.
      Live-verified against the local dev server with hand-signed synthetic
      webhooks (same pattern as prior refund-webhook testing — no need to
      create real no-email data in the live store): a bare
      `customers/create` with no email correctly logged
      `{status:'skipped', shopifyId:'999888777', errorMessage:'No email on
      this customer — nothing to sync to HubSpot.'}`; an `orders/create`
      whose embedded customer had no email correctly produced *two*
      entries — the order itself `status:'success'` (a real Deal was
      created, `513762902245`) and the customer `status:'skipped'` — proving
      an order still syncs correctly even when its customer can't. Test
      deal archived afterward. Playwright screenshot of the dashboard's
      activity feed confirms the neutral gray badge renders distinctly
      from the green "success" ones, with the explanation shown inline.
    - **12c. [DONE, VERIFIED, 2026-07-29]** No actual support contact
      anywhere in the app — "contact support" was mentioned on the error
      page and (pre-12a) the webhook-failure warning, but pointed nowhere.
      User chose a plain support-email mailto link (their own address) over
      a contact form or help doc.
      Rather than patching just the one error-page sentence, added a
      persistent `.page-footer` ("Need help? &lt;email&gt;", a subtle
      bordered-top line) directly into `src/htmlPage.ts`'s shared
      `renderPage()` shell — every page in this app renders through it
      (both onboarding pages, every error page, and the 12a dashboard), so
      a merchant has this before something goes wrong, not only after.
      Removed the old vague "If this keeps happening, get in touch..."
      line from `renderErrorPage` since the shared footer now covers it on
      every error page already, without the duplication.
      Verified: `npm run build` clean, all 66 tests pass (no logic changed,
      pure markup). Confirmed via `curl` that the footer's exact mailto
      markup appears on both a live error page (`GET /auth/hubspot` with no
      `?shop=`) and the dashboard. Playwright screenshots of the error page
      in light and dark confirm it renders cleanly — a plain divider line
      above a centered, small, muted mailto link, consistent with the rest
      of the page's existing visual language.
    - **12b. [DONE, VERIFIED, 2026-07-29]** Backfill progress on the
      onboarding page never updated or confirmed completion — a merchant
      had no way to know a historical import actually finished (or
      failed) short of reading server logs.
      New `merchants.backfill_status` (JSONB, same precedent as
      `deal_rules`) — added to `ensureSchema`'s `CREATE TABLE` for fresh
      environments plus the usual companion `ALTER TABLE ... ADD COLUMN IF
      NOT EXISTS` for the already-live Supabase table. New
      `BackfillStatus` type + `saveBackfillStatus` in `src/db/merchants.ts`:
      `{status: 'running'|'complete'|'failed', startedAt, completedAt?,
      customerCount?, orderCount?, error?}`, written as a full replacement
      object at each transition (not a partial JSONB patch) so there's no
      read-modify-write race between concurrent callers.
      `src/backfillMerchant.ts` now writes `'running'` at the start and
      `'complete'`/`'failed'` (with counts or the error message) at the
      end, wrapped in a try/catch that still rethrows unchanged — this
      only adds visibility, it doesn't change the existing failure
      propagation behavior any caller already depends on. Both callers
      (the OAuth callback's backgrounded trigger and the CLI
      `npm run backfill` script) get this for free since the tracking
      lives inside `backfillMerchant` itself, not duplicated per caller.
      Extended the dashboard (12a) rather than building a separate
      mechanism: `GET /merchants/:shop/status` gained a `backfillStatus`
      field; new `POST /merchants/:shop/retry-backfill` (same
      auth/rate-limit stack as every other dashboard action) starts
      another run in the background — mirrors the OAuth callback's own
      backgrounding, since a large store's import can take a while and the
      caller just wants confirmation it started, not to block on it. New
      "Historical import" section in `src/dashboardPage.ts` shows the
      current status (badge + detail line — start time while running,
      counts and finish time when complete, the error message when
      failed) and a "Retry historical import" button. Also updated the
      onboarding success page's copy to point at the dashboard for
      checking completion, now that there's somewhere real to check.
      Verified live against the local dev server (no `APP_URL`-must-be-
      `https://` dependency here, unlike webhook registration, so local
      testing is representative): ran a real `npm run backfill`, confirmed
      `backfillStatus` correctly showed `{status:'complete', customerCount:
      8, orderCount:5, ...}` matching the console output exactly; called
      `POST .../retry-backfill` and confirmed it returned
      `{ok:true,status:'running'}` immediately while the DB showed
      `status:'running'`, then polled again after a few seconds and
      confirmed it had transitioned to `'complete'` with matching counts —
      proving the endpoint is genuinely backgrounded, not just fast.
      Playwright screenshot of the dashboard's new section shows the real
      data rendering correctly. `npm run build` and all 66 tests
      (unchanged — this is DB-touching orchestration + client JS, out of
      scope for unit tests per the same precedent established in 12a)
      still pass.

13. [DONE, VERIFIED, 2026-07-29] Full security audit, at explicit user
    request ("Audit time... do it fully and perfectly, be thorough. Check
    all connected apps etc. Supabase is telling me there are
    vulnerabilities. Check everything.") — the security counterpart to
    step 12's functional audit, covering every source file plus the app's
    connected services (Shopify, HubSpot, Supabase/Postgres, Render), not
    a diff. Read every file in `src/`, cross-checked claims already
    documented in this file's step 10 (10h TLS pinning, 10i credential
    rotation, 10j rate limiting) against the *current* code rather than
    re-trusting them, ran `npm audit`, scanned the full git history (not
    just current `.gitignore`) for committed secrets, and live-tested every
    suspected issue against a locally running instance before calling
    anything confirmed.

    Two real vulnerabilities found in code, both fixed and re-verified live
    against the actual endpoints, not just read:

    - **13a. Reflected XSS**, `src/hubspot/oauth.ts` via `src/htmlPage.ts`.
      Two sinks: `GET /auth/hubspot/callback?error=<payload>` (reflects the
      `error`/`error_description` query params into `renderErrorPage`
      *before* any OAuth state check runs — no valid session or prior step
      needed at all) and `GET /auth/hubspot?shop=<payload>` (the `shop`
      param was only ever passed through `normalizeShopDomain`, which just
      strips a protocol prefix — unlike the Shopify OAuth flow, which
      already validated via `shopify.utils.sanitizeShop`). Root cause:
      `htmlPage.ts`'s `renderPage`/`renderErrorPage` never HTML-escaped
      their interpolated strings — true everywhere else in the app only by
      convention (every other reflected value happened to already be
      HMAC/state-validated, a HubSpot-supplied numeric id, or
      `crypto.randomBytes` hex), not by anything the function itself
      enforced.
      Confirmed exploitable before fixing: ran the dev server locally and
      curled
      `/auth/hubspot/callback?error=%3Cscript%3Ealert(document.domain)%3C%2Fscript%3E`
      — got back `200`/`400` `text/html` with the raw, unescaped `<script>`
      tag in the body. Since this is the same origin the dashboard
      (`src/dashboardPage.ts`) stores each merchant's admin API key in
      `localStorage` under, a real attack would be a crafted link stealing
      that key on click, not just an `alert()`.
      Fixed at both ends: `htmlPage.ts` gained an `escapeHtml()` helper,
      applied unconditionally to `renderPage`'s `title` and
      `renderErrorPage`'s `message` (every current call site of the latter
      is plain text, never markup, confirmed by checking all call sites
      first); and `/auth/hubspot`'s `shop` param is now run through
      `shopify.utils.sanitizeShop` (imported from `src/shopify/oauth.ts`)
      the same way the Shopify flow already validated its own `shop` —
      rejecting a malformed value outright rather than only escaping it on
      the way out.
      Re-verified live after the fix: the same `error=` payload now comes
      back HTML-entity-escaped (`&lt;script&gt;...`); the same `shop=`
      payload is now rejected with a generic "That doesn't look like a
      valid Shopify store domain." before ever reaching a template; a
      legitimate well-formed shop domain with no merchant row still
      correctly reaches "No Shopify installation found for
      some-nonexistent-store.myshopify.com." — confirming the new
      validation doesn't over-block real traffic.

    - **13b. TLS certificate verification bypass in two migration
      scripts.** `src/scripts/migrate-merchants.ts` and
      `src/scripts/encrypt-existing-tokens.ts` each open their own
      `pg.Pool` (deliberately not importing `src/config.ts`, since both
      must run before every required env var necessarily exists yet — see
      their own file comments) and had hardcoded
      `ssl: { rejectUnauthorized: false }` — the exact MITM exposure
      `src/db/client.ts` fixed for the running app back in 10h, never
      applied to these two one-time scripts since they predate that fix
      and open their own connection independently.
      Fixed by having both read the same committed `src/db/supabase-ca.crt`
      `src/db/client.ts` already uses and setting
      `ssl: { ca, rejectUnauthorized: true }`. Re-ran both live against the
      real Supabase database afterward to confirm they still connect under
      real certificate verification, not just that they compile:
      `npm run migrate-merchants` completed normally ("merchants table
      already exists, skipping rename" — idempotent, matching its
      documented behavior); `npm run encrypt-existing-tokens` reported the
      one existing row "already encrypted, skipping" (also idempotent, per
      10i's original verification of this same script).

    Also found, fixed directly in the database rather than in code: the
    user's own report that "Supabase is telling me there are
    vulnerabilities" turned out to be Supabase's Security Advisor flagging
    exactly this. Checked directly against the live database rather than
    guessing from the app's connection style alone (this app never uses
    Supabase's PostgREST/Data API, only a direct `pg` connection, which
    made it tempting to assume RLS wasn't the actual mechanism) — first
    hypothesis (RLS disabled entirely on `merchants`/`sync_log`) turned out
    to be wrong on inspection: the user had already manually enabled RLS on
    both tables before this was checked. What was still live: RLS enabled
    with zero policies defined, but `anon` and `authenticated` still held
    full SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER grants on
    both tables (Supabase's default at table-creation time) — currently
    inert only because Postgres's RLS-enabled-with-no-policy default-denies
    every non-owner role, meaning a single future policy added by anyone
    (including Supabase's own tooling) would have made all of those grants
    live instantly. `REVOKE ALL PRIVILEGES ON TABLE merchants, sync_log
    FROM anon, authenticated` run directly against the live database,
    confirmed empty via `information_schema.role_table_grants` afterward.
    Verified the app itself is unaffected (connects as the `postgres` table
    owner, whose access doesn't depend on these grants or on RLS at all):
    `/health` still reports `database.connected: true` after the revoke.

    `npm audit` reconfirmed unchanged from 10k/12's prior runs: 5 high
    findings, all transitively through `ts-node-dev` -> `rimraf` -> `glob`
    -> `minimatch` -> `brace-expansion`, no fix available upstream,
    dev-only (`npm run dev`), never in the `build`/`start` production path.
    Full git history (not just current `.gitignore`) scanned for
    committed secrets — clean, matching 10i's original finding.

    `npm run build` clean; all 72 tests still pass (unchanged — none of
    this pass's fixes touched anything with existing pure-logic coverage;
    the XSS fix's own correctness was proven live per above, matching this
    project's established precedent for routing/output-rendering changes
    over unit tests, e.g. 10j, 12a).

    Checked and confirmed NOT vulnerable, beyond what step 10 already
    documented: every SQL query across `src/db/`, `src/scripts/
    migrate-merchants.ts`, and `src/scripts/encrypt-existing-tokens.ts` is
    parameterized, no exceptions; the dashboard's client-side JS
    (`src/dashboardPage.ts`) really does use exclusively
    `createElement`/`textContent` with zero `innerHTML` given dynamic data,
    confirmed by grep across the whole `src/` tree (the one `innerHTML`
    hit found is `keyFormEl.innerHTML = ''`, a clear-only assignment, not
    an injection point); no `eval`/`child_process`/`dangerouslySetInnerHTML`
    anywhere in the codebase; no CORS headers set anywhere (correct default
    for this app — nothing here needs cross-origin reads); HubSpot/Shopify
    OAuth state signing, webhook HMAC verification, and every admin/merchant
    key comparison in `src/server.ts` all still timing-safe, re-confirmed
    directly against current code rather than assumed from step 10's
    original write-up.

    Committed as `ef1aee2` ("Fix reflected XSS in HubSpot OAuth error
    pages, pin TLS on migration scripts") and pushed to `main` — Render
    redeploys automatically from there per the existing Blueprint setup;
    the Supabase grants fix needed no deploy, already live directly against
    the database.

14. [DONE, VERIFIED, 2026-07-29] Second independent pre-launch audit (fresh
    session, no memory of steps 10/12/13 beyond reading this file), at
    explicit user request to re-verify everything against actual current
    code/live behavior rather than trust prior write-ups. Re-confirmed the
    three original bugs, idempotency (sent the same signed webhook twice —
    same HubSpot ids both times), a battery of edge cases (no-province
    guest checkout, Finland address, unicode/accented names, 12 line items,
    0 line items, no `customer` object at all, a deliberately-invalid
    `amount` correctly producing a 500 + real logged HubSpot error), git
    history (still clean), `npm audit` (unchanged, 5 high, dev-only,
    matches 10k), and — via a direct Shopify GraphQL query independent of
    this app's own code — that all 6 webhook topics really are registered
    against the live production URL. All test/verification records created
    were archived afterward via direct HubSpot API calls. Found two new
    issues neither of the prior three passes caught, both fixed:
    - **14a. Unhandled `pg.Pool` 'error' listener.** `src/db/client.ts`
      constructed the pool but never called `pool.on('error', ...)`.
      Confirmed directly in `pg-pool`'s own source
      (`pool.emit('error', err, client)` on an idle client fault, with the
      library's own inline `TODO` warning about this) that an unhandled
      `EventEmitter` error crashes the whole Node process — not
      hypothetical: Supabase's pooler proactively recycles idle
      connections, so this was a realistic, not rare, crash trigger. Fixed
      with a listener that logs and lets the pool recover, matching how it
      already behaves for any other idle-client replacement.
    - **14b. No `sync_log` retention.** Live-queried the real table: 200
      rows of real customer emails/order numbers with no expiry path other
      than the GDPR redact webhooks — an actively-connected merchant who
      never uninstalls accumulates that PII forever. Fixed with
      `deleteOldSyncLog` (`src/db/syncLog.ts`, age-based `DELETE`, not a
      row-count cap) scheduled from `server.ts` to run once ~10s after boot
      and then daily — matching `ensureSchema`'s own "lazy, idempotent,
      runs in every process" style rather than needing a paid-tier Render
      Cron Job. New optional `SYNC_LOG_RETENTION_DAYS` (default 90),
      documented in `.env.example`.
    Also fixed three Medium/Low findings from the same pass:
    - **14c.** `src/shopify/webhookRegistration.ts`'s `registerWebhooksForShop`
      always called `webhookSubscriptionCreate` for a "missing" topic, even
      when Shopify already had a *stale* subscription for that topic at a
      different `uri` (e.g. after an `APP_URL` change) — Shopify allows
      multiple subscriptions per topic, so this silently left a second,
      correct one alongside the first, now-dead one, rather than fixing it.
      New `UPDATE_MUTATION`/`findStaleSubscription` (the latter exported and
      unit-tested) updates the existing subscription's `uri` in place
      instead. `deriveWebhookStatus`/`topicsNeedingRegistration` themselves
      needed no change — this only affects *which* mutation
      `registerWebhooksForShop` calls for an already-registered-but-stale
      topic.
    - **14d.** HubSpot SDK errors stringify their `.message` to include a
      raw dump of the HTTP response headers (confirmed live: a Cloudflare
      `__cf_bm` cookie, rate-limit counters, a correlation id) — that full
      string was going straight into `sync_log.error_message` and back out
      through the authenticated `/sync-status` API. New
      `sanitizeErrorMessage` (`src/errorSanitize.ts`, unit-tested) strips
      everything from a `Headers:` marker onward and caps length; applied
      once, inside `logSyncResult` itself, so every existing caller is
      covered without touching them individually. Live-verified: re-ran the
      invalid-amount test, confirmed the stored message keeps the real
      HubSpot validation detail but no longer contains the headers section.
    - **14e.** No graceful shutdown (`server.ts` now handles
      `SIGTERM`/`SIGINT`: closes the HTTP server and DB pool, force-exits
      after 10s if that hangs) and no mobile horizontal-scroll wrapper
      around the dashboard's three tables (`.table-scroll` in
      `src/htmlPage.ts`, applied in `src/dashboardPage.ts`) — bounded, low-
      severity findings, fixed alongside the rest of this pass rather than
      separately. Graceful shutdown could not be live-verified on this
      Windows dev machine (`taskkill` without `/F` refuses to signal a
      console process at all — "can only be terminated forcefully"; Windows
      has no real POSIX signal delivery to another process either way) —
      production runs on Render (Linux), where `SIGTERM` is a real signal
      and this code path applies as written. Flagged rather than claimed
      as verified.
    Also flagged, not a code fix: confirm directly in the Shopify Partner
    Dashboard that the GDPR compliance webhook URLs from step 10a actually
    reached Shopify — a `.shopify/deploy-bundle/manifest.json` next to this
    repo (in the wrapping folder) shows them staged with the correct
    production URLs, which is reasonable evidence but not proof the deploy
    was accepted; that state lives on Shopify's side, not verifiable from
    local files.
    **[RESOLVED, 2026-07-30]** Two config files exist at the wrapping-folder
    level — `shopify.app.testapp.toml` (`client_id: e8a932a8...`, name
    "testAPP") and `shopify.app.testhubspot.toml` (`client_id: cbedd873...`)
    — the latter belongs to an unrelated app ("Oma Kauppa"), not this
    project; confirmed `testapp` is the real one by cross-checking its
    `client_id` against `.env`'s `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET_KEY`
    (the values the running server actually authenticates OAuth and
    verifies webhook HMACs with) — exact match. `.shopify/project.json`'s
    only entry being keyed under `testhubspot`'s client_id was a red
    herring, not evidence of a misconfigured deploy. User ran
    `shopify app deploy` against the `testapp` config to confirm; compliance
    webhook URLs are now confirmed live on the correct app in the Partner
    Dashboard.
    `npm run build` clean; 77 tests pass (72 prior + 5 new: 2 for
    `findStaleSubscription`, 3 for `sanitizeErrorMessage`). Every live test
    this pass ran against the real dev store/shared Supabase database (no
    separate staging environment exists) — all created test
    contacts/deals/records archived afterward, confirmed the one real
    merchant row and its data were untouched throughout.
    - **14f. [DONE, VERIFIED, 2026-07-29]** Dead ends for a merchant who
      loses the onboarding success page. Not embedded in Shopify Admin, no
      email delivery of the dashboard link, and both the bare app URL and
      a bare `/dashboard` with no `?shop=` led nowhere useful (the former a
      raw, unbranded Express "Cannot GET /" crash). Fixed: the
      HubSpot-connected success page's dashboard link is now its own
      always-shown "save this now" callout with the full copyable URL, no
      longer buried under "optional, for later" framing
      (`src/hubspot/oauth.ts`); `GET /` now renders a branded page
      explaining what the app is and pointing merchants back to their
      saved dashboard link instead of crashing (`src/server.ts`);
      `src/dashboardPage.ts` clarified its own missing-`?shop=` messaging.
      Deliberately not building a self-service recovery flow (e.g. asking
      for their shop domain to look up the link) — just making the
      failure states honest and branded rather than silent dead ends. 77
      tests pass (unchanged, pure markup); clean build.
    - **14g. [DONE, VERIFIED, 2026-07-29]** Unescaped `&` in the
      onboarding success page mangled the copyable regenerate-key URL.
      Caught by actually rendering and screenshotting the page rather than
      just reading the template: a bare `&` before `regenerate_key=1` gets
      parsed by browsers as the legacy HTML entity `&reg` (recognized
      without a trailing semicolon), silently turning the visible recovery
      URL into `...myshopify.com®enerate_key=1` — a link a merchant could
      easily copy-paste broken. Pre-existing bug, unrelated to 14f's
      changes to the same file. Fixed with `&amp;` in `src/hubspot/oauth.ts`.

15. [DONE, VERIFIED, 2026-07-30] Dashboard redesign, at explicit user
    request ("it looks clunky and feels clunky... not clear. Fix at least
    the customization area"). Scoped with the user upfront: a pure visual
    pass on the deal-rules editor (12a) vs. also wiring real HubSpot
    pipeline/stage/owner dropdowns instead of raw-id text entry — user
    chose the latter, since blind internal-id entry was judged the actual
    root cause of "not clear," not just the layout.
    - Deal-rules editor (`src/dashboardPage.ts`) rebuilt from a cramped
      6-column/1-row table into one bordered "rule card" per rule: a
      numbered badge, labeled "If order has" / "Then route to" rows, and
      clearer icon-button actions (move up/down/remove, each with a real
      `title`/`aria-label`) instead of unlabeled table-cell buttons.
      Financial/fulfillment status and "cancelled" became real `<select>`s
      with plain-English labels ("Partially refunded", "Cancelled orders
      only") over an editor that previously only accepted hand-typed raw
      strings with no hint of the valid vocabulary.
    - Pipeline/stage/owner are now real dropdowns too, populated live from
      HubSpot: new `src/hubspot/options.ts` (`fetchDealPipelineOptions` via
      `crm.pipelines.pipelinesApi.getAll('deals')`, `fetchOwnerOptions` via
      paginated `crm.owners.ownersApi.getPage`) and a new
      `GET /merchants/:shop/hubspot-options` route (`src/server.ts`,
      same auth/rate-limit stack as the rest of the dashboard's endpoints).
      Stage options are derived from whichever pipeline is currently
      selected on that rule (re-rendered on pipeline change, resetting the
      stage since a stage id from one pipeline essentially never applies to
      another). A value already saved but not present in the live list
      (an archived pipeline, or a raw id typed by hand before this pass)
      is kept visible and selected via a synthetic "(not in current list)"
      option rather than silently dropped.
      New scope required: `crm.objects.owners.read` (added to
      `OAUTH_SCOPES`, `src/hubspot/oauth.ts`) — confirmed live against the
      real dev store's portal that pipelines already worked under the
      *existing* deals scopes (no new scope needed there) but owners
      genuinely 403s (`MISSING_SCOPES`, naming `crm.objects.owners.read`)
      until reconnected, matching this project's established "verify
      empirically, not from docs" precedent for HubSpot scopes (9b's line-
      items scope hit the same pattern).
      Graceful degradation, not a hard dependency: pipelines/owners are
      fetched independently (`Promise.allSettled`) so one failing doesn't
      block the other, and any field without live options falls back to
      its old plain-text input rather than the editor breaking — confirmed
      live pre-reconnect (owners 403, pipelines succeed): pipeline/stage
      rendered as real dropdowns with actual portal data ("Sales
      Pipeline" / "Closed Won"), owner still a text input, with a
      `.banner-info` box explaining why plus a direct "Reconnect HubSpot
      →" link.
      **Real bug caught only by looking at the live response, not by
      reading the code**: the fallback banner's message was, at first, a
      raw dump of HubSpot's `ApiException` — the same "Headers:" leak class
      already fixed once for `sync_log`/`/sync-status` (14d), reintroduced
      here because this is a new call site `sanitizeErrorMessage` wasn't
      wired into. Fixed with a purpose-built `describeOptionsFetchError`
      (`src/hubspot/options.ts`): a clean, plain-English message for the
      one failure mode expected to actually happen (a missing-scope 403,
      detected via `err.code === 403 && err.body.category ===
      'MISSING_SCOPES'`, not string-matching), falling back to the same
      header-stripped/length-capped text as everywhere else for anything
      unexpected. New `src/hubspot/options.test.ts` (4 tests: the friendly
      path, the sanitized-fallback path, that a non-403 with a
      superficially similar body isn't misclassified, non-Error input).
      Re-verified live after the fix: the banner now reads "Reconnect
      HubSpot to enable the owner list — this app's permissions were
      updated since you last connected." with no technical dump.
    - Save now gives feedback: a "✓ Saved" confirmation next to the Save
      button (auto-clears after 3s) — previously a successful save was
      visually indistinguishable from doing nothing. Also added a
      pipeline/stage-required client-side check before the request even
      fires (matching the server's own existing validation in
      `hubspot/dealRules.ts`, just surfaced earlier).
    - Empty state: an explicit dashed-border message ("No custom rules
      yet... Add a rule to handle specific cases differently, e.g. routing
      refunded orders to a separate pipeline") instead of a bare empty
      table, plus rewritten intro copy explaining "first rule that matches
      wins" and pointing at the default pipeline/stage shown in Connection
      status above, closing a real disconnect between the two sections.
    - **Real pre-existing bug fixed as a side effect of building the
      dropdowns, not scope creep** — needed for the new fulfillment-status
      dropdown to actually work: Shopify's REST/webhook payloads represent
      "not yet fulfilled" as `fulfillment_status: null`, but
      `DealRuleCondition.fulfillment_status` (`hubspot/dealRules.ts`) is
      always a string, so no rule could ever have matched an unfulfilled
      order — the condition literally couldn't express it. Fixed by
      normalizing `null` to the literal string `'unfulfilled'` right where
      `sync.ts` builds the order-conditions object passed to
      `evaluateDealRules`. **Deliberately not fixed, flagged instead**: this
      only closes the gap for the webhook path. The GraphQL backfill path
      (`shopify/graphqlMapping.ts`) sources the same concept from Shopify's
      `displayFulfillmentStatus` enum, which is both differently-cased
      (`UNFULFILLED` vs `unfulfilled`) and a *wider* vocabulary (e.g.
      `IN_PROGRESS`, `ON_HOLD`, `PENDING_FULFILLMENT` have no REST
      equivalent) — collapsing that into this app's 4-value REST-shaped
      vocabulary is a real, separate fix (already flagged once, step 11)
      that needs its own deliberate mapping decision, not a one-line
      normalization.
      Also flagged, not fixed this pass: `webhooksError` on the existing
      `GET /merchants/:shop/status` route (12a) returns a raw
      `err.message` the same way `hubspot-options` did before this fix —
      same leak class, pre-existing, outside what was asked.
    - CSS (`src/htmlPage.ts`): new `.rule-card`/`.rule-card-header`/
      `.rule-number-badge`/`.icon-btn`/`.rule-row`/`.rule-fields`/
      `.empty-state`/`.banner-info`/`.save-confirmation`, light + dark
      variants, reusing the existing card/badge/button visual language
      rather than introducing a new style.
    `npm run build` clean; 81 tests pass (77 prior + 4 new, all in
    `options.test.ts` — the new dashboard interactivity itself follows this
    project's established precedent of live-verification over unit tests
    for client-side JS/route glue, e.g. 12a).
    Live-verified against the real dev store end to end, including the
    parts that can't be inferred from reading the code: curled
    `/merchants/:shop/hubspot-options` directly before and after the
    `describeOptionsFetchError` fix to confirm the raw-dump leak and then
    its fix; used Playwright (installed via `npm install --no-save`,
    removed afterward — confirmed `package.json`/lockfile untouched) driving
    the system's installed Chrome to screenshot the empty state, a filled
    rule card with real "Sales Pipeline"/"Closed Won" values selected from
    the live dropdown, and the post-save "✓ Saved" confirmation, in both
    light and dark; confirmed the pipeline→stage dependent-dropdown
    behavior with real portal data (7 real stage names); did a full
    save → reload → verify-persisted round trip (`financial_status:
    'refunded'` survived a hard reload reading from the live DB, not just
    in-memory state) then explicitly reverted the dev store's rules back to
    `[]`, confirming via a direct API call afterward that its real
    deal-rules state was left exactly as found.
    **[UPDATE, 2026-07-30]** `crm.objects.owners.read` was already present
    in `app-hsmeta.json`'s `requiredScopes` (found at
    `C:\Users\elias\OneDrive\Desktop\hubspot-oauth-app\src\app\app-hsmeta.json`,
    a sibling location to this repo per 9b's precedent) but had never been
    pushed — `hs project upload` run from that directory, build #5
    succeeded and deployed to the `hubshop` account (148962866). This
    repo's dashboard/deal-rules changes were also committed and pushed to
    `main` (`eaf8ffb`), confirmed live on Render (`/health` shows the
    matching commit). Still outstanding: the dev store itself needs to
    redo `/auth/hubspot` against the production URL to actually pick up
    the new scope — until then the dashboard keeps degrading gracefully
    exactly as verified above.

16. [DONE, VERIFIED, 2026-07-30] Final stress test, at explicit user
    request ("run one final stress test for the whole app. Be as thorough
    as you can, think of everything") — load/concurrency/adversarial-input
    testing specifically, distinct from steps 10/12/13/14's functional and
    security audits (which reviewed code and tested happy-path + known
    edge cases, not deliberate abuse or scale). Found and fixed two real
    bugs, both live-verified before and after the fix; confirmed several
    other properties hold under real pressure rather than assuming they
    still did after this session's dashboard changes.

    **16a. Critical: an ordinary error could crash the entire process, not
    just fail one request.** Found while testing the new
    `/merchants/:shop/hubspot-options` route (step 15) against a merchant
    with no working HubSpot connection: `resolveMerchantContext` throws
    for that case (by design, `hubspot/tokens.ts`), and that call wasn't
    wrapped in try/catch. Confirmed live: one such request killed the
    entire local dev server (`curl` got `Connection refused` on every
    subsequent request, including `/health`, until manually restarted) —
    the crash log showed `[ERROR] ... Error: No HubSpot connection for
    stress-hangtest-fake.myshopify.com...` right before the process died.
    Root cause, general not specific to this route: Express 4 does not
    route a rejected promise from an async handler to error-handling
    middleware (only Express 5 does), so an unguarded `await` that throws
    becomes an unhandled promise rejection — which terminates the whole
    Node process on this Node version (v24), not just the request.
    Checking further found this was systemic, not confined to the one new
    route: `requireAdminOrMerchantAuth` itself — the auth middleware every
    merchant-scoped route runs through — does `await getMerchant(shopDomain)`
    with no try/catch, meaning an ordinary transient DB hiccup (this app's
    own `pool.on('error')` fix, 14a, already establishes Supabase's pooler
    recycles idle connections routinely) hitting mid-query during *any*
    authenticated request could take the whole service down for every
    merchant, not just error the one request. Nearly every route in
    `server.ts` had the same unwrapped-`await getMerchant(...)` pattern
    (the one exception, `/sync-status`, already wrapped its own body in
    try/catch).
    Fixed systemically rather than patching each call site: new
    `asyncHandler()` wrapper (`server.ts`) that catches any rejection from
    an async handler/middleware and forwards it to `next(err)`, landing on
    the error-handling middleware from 16b below instead of crashing.
    Applied to `requireAdminOrMerchantAuth` and every async route handler
    in the file (harmless on ones that already have their own try/catch —
    it only engages if something throws past that).
    Verified: rebuilt the exact crash scenario after the fix (same fake
    merchant, no HubSpot connection) — now a clean `200` with
    `{pipelines: null, pipelinesError: "No HubSpot connection for...",
    ...}`, confirmed via `/health` immediately after that the process
    stayed up, then fired it 10x concurrently for good measure (still all
    `200`, still up). Full regression sweep across every route afterward
    (valid key, invalid key, missing key, unknown shop, webhook route) —
    all returned their expected status codes, no behavior change on the
    happy path. `npm run build` clean, all 81 tests pass (this is
    routing/process-lifecycle behavior, not pure logic — verified live per
    this project's established precedent, e.g. 10j, rather than unit
    tested). Seeded/deleted the fake merchant row via direct DB calls, same
    pattern as prior GDPR/hang tests — real dev store's row untouched
    throughout.

    **16b. Real functional bug: a large real order would silently,
    permanently fail to sync.** `express.json()`'s default body-size limit
    is 100kb, never overridden. Built a realistic synthetic order (400
    line items with properties/tax-lines/SKUs — the shape a genuine
    wholesale/bulk order has) that came to 140kb and confirmed live: `413
    Payload Too Large`, rejected by body-parser before this app's webhook
    handler ever runs — meaning no `sync_log` row (nothing to see in the
    dashboard), and Shopify would retry the identical oversized payload
    for up to 48 hours, failing identically every time. That order would
    never sync, with zero visibility to the merchant.
    Also found in the same test: with no custom error-handling middleware
    at all, Express's default error handler served the raw error straight
    to the client — confirmed live locally: a full stack trace with real
    local filesystem paths and dependency internals in the 413 response
    body. Checked whether production was equally exposed: it wasn't (an
    undocumented Render behavior masked it), but the app shouldn't depend
    on that staying true.
    Fixed both: raised the body limit to `5mb` (generous for any real
    order; `webhookRateLimiter`, 120/min, is the complementary bound on
    total volume — same layering this app already uses elsewhere), and
    added a global error-handling middleware (last `app.use`, correct
    4-arg arity) that logs full detail server-side and returns a short,
    accurate, non-leaking message keyed off status (413/400/other-4xx/5xx)
    to the client — this is also what 16a's `asyncHandler` rejections now
    land on.
    Verified: the same 140kb order now passes body-parsing and correctly
    reaches the HMAC check (`401`, since the test used a fake signature) —
    confirming a real large order would now actually reach the sync logic.
    A genuinely huge 6mb payload still cleanly `413`s with the new short
    message, no stack trace. A malformed-JSON body cleanly `400`s
    ("Malformed request body.", not "Internal server error" — caught and
    fixed a wording bug where the first pass mislabeled a client error as
    a server one). Server stayed healthy throughout every case.

    **Confirmed still holding, not just assumed, after this session's
    dashboard changes:**
    - Concurrent-webhook dedup (the original step-8 fix): 25 fully
      concurrent, byte-identical signed `orders/create` webhooks for a
      brand-new email/order name converged on exactly one contact and one
      deal (previously only tested at 5-concurrent) — confirmed via
      `sync_log` (50 entries, 2 distinct HubSpot ids) and live HubSpot
      lookups; both test records archived afterward.
    - Rate limiting: `apiRateLimiter` (60/min) hammered on the new
      `hubspot-options` route — exactly 60 successes then `429`, and
      confirmed the budget is correctly *shared* across all
      `apiRateLimiter`-protected routes (a fresh `/sync-status` call was
      also `429` immediately after), while `/health`, `/auth/hubspot`, and
      the webhook receiver (separate limiters) were unaffected — no repeat
      of 10j's router-scoping bug.
      DB pool under pressure: 40 concurrent `/sync-status` calls (pure DB
      reads, no HubSpot calls) against `pg`'s default pool size of 10 all
      succeeded in under a second — confirms the pool queues excess
      demand rather than erroring, at a load meaningfully above this app's
      actual target scale.
    - Adversarial deal-rules input, all against the live local server: a
      2000-rule payload (156kb) saved and validated in under a second; a
      SQL-injection string (`x'; DROP TABLE merchants;--`) and an XSS
      payload (`<script>alert(document.cookie)</script>`) in
      pipeline/owner fields were both stored as inert literal text
      (parameterized queries; the merchants table was confirmed intact
      afterward) and, checked with a real headless browser
      (`page.on('dialog')` listening for an `alert()`), rendered as
      escaped plain text in the dashboard's "not in current list" fallback
      option — no dialog fired, no live `<script>` element in the DOM.
      Malformed shapes (rules as a string, wrong field types, non-object
      `when`, a `__proto__` key) were all cleanly rejected with clear `400`
      messages by the existing validator, or — for `__proto__` — silently
      and safely stripped, since `validateDealRules` builds a fresh object
      from known fields rather than spreading user input.
    - In-process caches (`idCache.ts`, `mutex.ts`): re-read, still exactly
      as documented — grow one entry per distinct key for the life of the
      process, no eviction. Pre-existing, deliberately accepted risk at
      this app's target scale (not re-litigated, still correct).

    Committed as part of this session's work; not yet pushed/deployed —
    the crash fix (16a) in particular should ship before any real
    merchant traffic depends on the dashboard.

17. [DONE, VERIFIED, 2026-07-30] Legal pages, rebrand, and support contact.
    User's own legal exposure was a real open question (solo kevytyrittäjä
    in Finland, no limited company yet) — resolved by: switching to a
    kevytyrittäjyys invoicing provider that includes free liability
    insurance (the one practical lever available without an Oy); adding
    real, hosted `/privacy-policy`, `/terms`, and `/data-processing-agreement`
    pages (`src/privacyPolicyPage.ts`/`termsPage.ts`/`dpaPage.ts`, same
    `renderPage` shell as everywhere else) grounded in this app's actual
    data flows and infrastructure (not generic template text) rather than
    a free policy generator, which wouldn't have covered the
    processor/controller relationship or produced a DPA at all; and linking
    all three from the shared page footer (`src/htmlPage.ts`) so they're on
    every page, not just directly-linked URLs nobody would find. All three
    are explicitly drafts pending real legal review, not a substitute for
    one. Product renamed **Hubshop → Fielded** throughout both the legal
    pages and this file's own references (the live domain
    `hubshop.onrender.com`, GitHub repo, and support email
    `hubshop.support@gmail.com` were deliberately left unchanged — renaming
    those touches live OAuth redirect URLs and a real email account,
    out of scope for a docs/branding pass).

18. [DONE, VERIFIED, 2026-07-30] Shopify billing — the single biggest gap
    behind "go live" once the legal pages existed. User confirmed Shopify's
    own Billing API (not a separate payment processor) both handles the
    infrastructure and is close to *required* for an App Store app that
    charges a subscription. Pricing: **$29/month, single flat plan, no
    tiers, 30-day free trial**, undercutting the closest real competitor
    (Unific, ~$99/month once a merchant outgrows their free tier) since
    this app doesn't bundle a marketing suite, just the sync. Billed in each
    merchant's own local currency via `shopBillingPreferences`, not a fixed
    currency — a real mechanism the Billing API provides.
    New `src/shopify/billing.ts`: `createSubscription` (queries local
    currency, calls `appSubscriptionCreate` with `trialDays: 30`, saves
    `PENDING` status + a computed trial-end date) and
    `refreshBillingStatus` (re-fetches the real status from
    `currentAppInstallation.allSubscriptions` by id — deliberately not
    inferred from presence/absence in `activeSubscriptions` alone, which
    wouldn't distinguish declined from any other non-active state).
    New `merchants` columns: `billing_subscription_id`, `billing_status`
    (mirrors Shopify's own `AppSubscriptionStatus` enum values directly —
    PENDING/ACTIVE/CANCELLED/DECLINED/EXPIRED/FROZEN — rather than
    inventing a parallel one), `billing_trial_ends_at`.
    Onboarding order changed deliberately: Shopify connect → **billing
    confirmation (new)** → HubSpot connect, so nobody reaches full use of
    the app without at least approving a subscription (even a
    $0-due-today trial one). Three routes in `src/shopify/oauth.ts`: the
    existing OAuth callback now just redirects into `/auth/shopify/billing`
    (creates/re-creates the subscription and redirects to Shopify's own
    hosted confirmation page — reused as-is for a merchant retrying after
    declining) and the new `/auth/shopify/billing-callback` (where Shopify
    sends the merchant back; re-verifies the real status via API rather
    than trusting anything in the unsigned return-URL query params, then
    shows either the existing "Step 1 of 2" success page or a "billing
    wasn't approved" page with a retry link).
    A merchant can cancel from *inside Shopify's own billing settings*,
    entirely outside this app — new `app_subscriptions/update` webhook
    topic (registered like every other topic in
    `webhookRegistration.ts`) keeps `billing_status` in sync with that.
    Enforcement lives in exactly one place, `src/sync.ts`'s
    `syncCustomer`/`syncOrder` (checked and rejected an earlier draft that
    put it in the webhook receiver's `resolveMerchantOrRespond` instead —
    that would have missed the historical backfill path entirely, which
    calls `syncCustomer`/`syncOrder` directly and would have kept running
    for free indefinitely regardless of billing status). A blocked sync
    logs a new `'skipped'` entry with a clear reason and ack's 200 — same
    "retrying can't fix this" reasoning as an already-broken HubSpot
    connection elsewhere in this file. Surfaced on the dashboard
    (`GET /merchants/:shop/status` + `dashboardPage.ts`): a Billing row
    (showing trial end date while trialing) and a warning banner with a
    direct link to fix it when not active.
    **Found and fixed while building this, not before**: `webhooks.ts` and
    `hubspot/oauth.ts` had the identical unguarded-async-handler crash risk
    16a fixed in `server.ts` — e.g. `orders/delete`'s `logSyncResult` call,
    and both `hubspot/oauth.ts` routes' initial `getMerchant` calls, none
    wrapped in try/catch. Extracted the fix into a shared
    `src/asyncHandler.ts` (was a local function in `server.ts`) and applied
    it to every async handler in both files — this was a live, exploitable
    gap in the exact routers a real merchant's HubSpot connect and every
    Shopify webhook already runs through, not a new one introduced by this
    step.
    **Two real platform-level blockers hit live, neither documented
    anywhere obvious, both required an external action the user had to
    take by hand:**
    - `appSubscriptionCreate` failed outright: *"Apps without a public
      distribution cannot use the Billing API"* — this app's Shopify app
      (`testAPP`) was still legacy/custom-install distribution. Fixed by
      the user switching it to **Public distribution** in the Partner
      Dashboard (Distribution → Public → Select) — no submission or review
      needed to unlock billing, just the distribution declaration itself.
      **Worth flagging: Shopify's own UI states this can't be switched
      back to Custom once made** — a real one-way door, confirmed with the
      user before they made it rather than treated as a routine toggle.
      Since this app is headed for public App Store distribution anyway,
      this is the correct end-state, not a workaround.
    - After that, even a trivial `{ shop { name } }` query 403'd. The real
      cause, found via the REST API's more informative error (the GraphQL
      client's own error body was empty): *"Non-expiring access tokens are
      no longer accepted for the Admin API."* Shopify requires publicly
      distributed apps to use **expiring offline access tokens** (rolled
      out December 2025, mandatory for new public apps as of April 1,
      2026) — this app's original hand-rolled OAuth flow requested the
      legacy non-expiring shape, which had been silently grandfathered in
      under Custom distribution and stopped being accepted the moment
      distribution flipped to Public. A same-scope reconnect alone did NOT
      fix this (confirmed live) — reconnecting without also requesting the
      new shape just issues another legacy token. Fixed by rebuilding
      Shopify's token layer to match `hubspot/tokens.ts`'s already-proven
      refresh pattern: `exchangeShopifyToken` (moved out of
      `shopify/oauth.ts` into `shopify/token.ts`, now shared by both the
      initial exchange and the new refresh path) requests `expiring: 1`;
      the response now carries `expires_in` (1 hour), `refresh_token`, and
      `refresh_token_expires_in` (90 days, rotated on every use — the old
      refresh token stops working the instant a new one is issued, so the
      new one must be persisted immediately or the *next* refresh breaks);
      new `merchants.shopify_refresh_token`/`shopify_token_expires_at`
      columns (encrypted, same as every other stored token); and
      `resolveShopifyAccessToken` (`shopify/token.ts`) now transparently
      refreshes near expiry, wrapped in the same keyed-lock pattern as
      HubSpot's equivalent so a burst of near-simultaneous calls triggers
      one refresh, not one per call. A merchant connected before this fix
      (or seeded from the legacy static `SHOPIFY_ADMIN_ACCESS_TOKEN` env
      var) has no refresh token on file and simply keeps using its
      existing token as-is until it reconnects — nothing crashes, it just
      doesn't benefit from refresh until then.
      **Known gap, flagged not built this pass**: unlike HubSpot's
      `hubspotConnectionBrokenAt`, there's no equivalent proactive
      "Shopify connection broken" tracking yet if a refresh token itself
      expires (90 days of inactivity) or is revoked — a failure here
      currently just surfaces as an ordinary logged sync error, not a
      dashboard-flagged broken-connection state. Revisit if this is ever
      observed for real, same threshold this app has applied to similar
      gaps elsewhere.
    `npm run build` clean; all 81 tests pass (thin SDK wrappers and
    route/OAuth-flow glue, consistent with this project's established
    precedent of live-verifying that category over unit testing it).
    **Fully live-verified end to end against the real dev store, in
    Shopify's test-charge mode (`test: true`, so no real money moved)**:
    reconnected Shopify (twice — once to confirm the public-distribution
    fix, again after the expiring-token fix, both times by the user
    clicking through Shopify's real screens, since Playwright hit a
    Cloudflare human-verification wall attempting this headlessly);
    screenshotted Shopify's own real confirmation page (correct plan name,
    correct price converted to the store's real local currency — €29.00
    EUR — correct 30-day trial date, explicit "you will not be billed for
    this test charge" notice); approved it for real and confirmed via
    direct DB query that `billing_status` became `ACTIVE`, a real
    `billing_subscription_id` was stored, and `shopify_refresh_token`/
    `shopify_token_expires_at` were populated correctly; fired a real
    signed `orders/create` webhook afterward and confirmed via `sync_log`
    that it now actually syncs (a real contact + deal created — billing
    enforcement doesn't false-positive-block a genuinely active merchant);
    confirmed a live Shopify GraphQL call succeeds cleanly post-fix via the
    dashboard's own webhook-status check. Test HubSpot contact/deal
    archived afterward.
    **Still needed, external to this repo, before this is live in
    production**: none of this has been deployed yet — Render is still
    running pre-billing code. Once it is, the real dev store's `merchants`
    row will have `billing_status = NULL` (new column) until it goes
    through this same real (test-mode) approval flow against the
    production URL — meaning live syncing for that store pauses at deploy
    time until that's done, by design, not a bug. Real (non-test) billing
    requires flipping `SHOPIFY_BILLING_TEST_MODE=false` in Render's
    environment once ready to actually charge merchants — defaults to
    `true` (safe) if never set.

19. [DONE, VERIFIED, 2026-07-30] Two small
    pre-launch fixes from user questions about what happens once real
    merchants exist, both deliberately scoped down to "cheapest thing that
    helps" rather than real infrastructure — explicit user call to go live
    first and see if there are even any customers before building anything
    heavier.
    - **Merchant contact email, for future manual outreach.** The
      underlying question: if a future update needs existing merchants to
      reauthorize (e.g. a new required OAuth scope, same pattern as
      `crm.objects.owners.read` in step 15), how would they ever be told,
      given this app has zero email/Slack notification infrastructure
      (10f)? Answer for now: it doesn't get automated — `billing_status`
      already tells you *which* shops are paying customers, but nothing
      captured *how to reach them*. Fixed minimally: new
      `merchants.shop_contact_email` column (lazy `ALTER TABLE IF NOT
      EXISTS`, same pattern as every other column added this way); right
      after the Shopify OAuth token exchange
      (`src/shopify/oauth.ts`), a new best-effort GraphQL call
      (`fetchShopContactEmail`, `src/shopify/graphqlMapping.ts` — `shop {
      contactEmail }`, no new scope needed) fetches the store's own
      contact address and saves it via `saveShopifyContactEmail`
      (`src/db/merchants.ts`). Wrapped in try/catch and never awaited into
      a failure path that could break onboarding — if the fetch fails for
      any reason, the merchant still connects normally, just without a
      contact email on file; only a `console.warn`, nothing merchant-
      facing. Stored as plaintext, not run through `src/crypto.ts` —
      consistent with `shop_domain` itself already being plaintext in the
      same table; this app's encryption bar is reserved for actual
      access-granting secrets (OAuth tokens), not general account
      metadata. This is *only* a data-retention move, not a notification
      system — there's still no code anywhere that sends anything to this
      address. The plan, per the user, is to query
      `SELECT shop_domain, shop_contact_email FROM merchants WHERE
      billing_status = 'ACTIVE'` and email affected merchants by hand from
      the personal address set up in step 17, until/unless real customer
      volume ever makes that not scale.
      Privacy Policy updated to disclose this (Section 3's "what we hold
      about the merchant's connection" list gained a bullet, and Section 4
      gained a distinct legal basis — legitimate interest — for this one
      field, kept separate from the "performance of contract" basis
      covering everything else). Terms of Service and the DPA deliberately
      **not** touched: the ToS only incorporates the Privacy Policy by
      reference rather than itemizing data categories itself, and the DPA
      is explicitly scoped to the merchant's own *customers'* data (its
      own Section 3: "your own customers who place orders") where this app
      is the Processor — a merchant's own business contact email is a
      direct Fielded-merchant relationship (Fielded as its own controller
      of that one field), which the Privacy Policy update already covers,
      not something processed on the merchant's instructions.
      Live-verified against the real dev store without going through a full
      Shopify reconnect (which would also re-trigger a new billing
      subscription — `billing.ts`'s `createSubscription` has no
      already-active check, so a real reconnect creates a redundant
      Shopify subscription object each time): wrote a throwaway script
      (`ts-node --transpile-only`, deleted immediately after, never
      committed) that called `fetchShopContactEmail` directly against the
      dev store's already-stored access token, then `saveShopifyContactEmail`,
      then re-read via `getMerchant`. Confirmed live: the GraphQL field
      returned a real address with the existing OAuth scopes (no new scope
      needed, as expected), and it round-tripped through the DB correctly.
      **Known gap, not fixed this pass**: the existing dev-store merchant
      row still only picked up a contact email via this one-off script,
      not the real OAuth path (that only fires on a fresh reconnect,
      which the billing side effect above makes undesirable to trigger
      just for this) — a real reconnect will exercise it end-to-end
      naturally whenever one next happens for another reason.
    - **Backfill duplicate-deal risk, onboarding disclosure only.** The
      underlying question: `upsertDealByName` (`src/hubspot/deals.ts`)
      de-duplicates by an *exact* string match on `dealname` against
      Shopify's `order.name` (e.g. `"#1001"`) — safe against
      re-running this app's own sync, but not against a merchant who
      already had orders synced into HubSpot Deals by HubSpot's own old
      native Shopify integration or a different third-party app, if that
      other tool's dealname format doesn't happen to match Shopify's raw
      order name exactly. HubSpot enforces no uniqueness on dealname
      server-side, so a mismatch there silently creates a second deal for
      the same order, with nothing in this app today that detects or warns
      about it. Contacts have no equivalent risk (`upsertContactByEmail`
      is keyed on email, robust regardless of source).
      Considered three options: (1) a plain onboarding disclosure, zero
      engineering; (2) a pre-backfill scan that pauses and asks the
      merchant to confirm before proceeding, a real fix but a real build
      (new merchant state, a review UI); (3) fuzzy dealname matching to
      widen detection, rejected outright as unsafe on its own (real
      false-positive-match risk) — only useful as an input to option 2.
      Explicit user choice: option 1 only, hold 2/3 until this is an
      actual reported problem rather than a hypothetical one.
      Initial version: added a `.muted` paragraph to the HubSpot-connected
      success page, low-key by design to match "cheapest disclosure."
      **[REVISED same day, 2026-07-30]** User feedback on that first pass,
      both points correct: (1) `.muted` styling under a "You're all set 🎉"
      headline was too easy to skim past for something that can cause real
      CRM cleanup work; (2) more fundamentally, the disclosure was
      structurally too late to matter — historical backfill was triggered
      automatically, in the background, the moment HubSpot connected,
      *before* this page (carrying the warning) even rendered. A merchant
      reading the warning attentively could still already have duplicates
      by the time they finished the sentence.
      Fixed by making historical import **opt-in** rather than automatic,
      not just re-styling the same warning. Removed the background
      `backfillMerchant()` trigger entirely from the HubSpot OAuth callback
      (`src/hubspot/oauth.ts`) — live sync of *new* orders via webhook is
      unaffected, only the retroactive import of existing order history
      changed. The onboarding success page's checklist/copy now says
      historical import "not started yet, you start this yourself" and
      points at the dashboard instead of claiming it's already running.
      The warning itself moved to the dashboard's existing "Historical
      import" section (`src/dashboardPage.ts`), upgraded to the same
      `.warning` (bordered, amber) style already used for the failed-
      webhook and one-time-admin-key notices, positioned directly above
      the actual trigger — so the warning and the button that starts the
      risk are now the same place, not separated across two pages and a
      background job. The existing `POST /merchants/:shop/retry-backfill`
      endpoint (12b) needed no changes — it already worked correctly for a
      never-run merchant, "retry" was just the wrong label for a first run.
      Relabeled/moved the button itself (was under "Actions", now lives in
      the "Historical import" section next to its own status display) and
      added `updateBackfillButton()` so its label/enabled-state reflects
      current status: "Start historical import" (never run), "Import
      running..." (disabled, prevents a double-trigger), or "Run import
      again" (already run at least once).
    `npm run build` clean; all 81 tests pass unchanged (no new pure logic
    — this is DB/OAuth-flow glue and static onboarding/dashboard copy,
    consistent with this project's established precedent of live-verifying
    that category over unit testing it, e.g. 12a). Live-verified: the
    contact-email capture via a throwaway script against the real dev
    store's existing token (see above); the dashboard change by starting
    the local dev server against the same live Supabase database, curling
    the actual rendered `/dashboard?shop=...` HTML and confirming the new
    warning box and single, correctly-relocated button render (no leftover
    duplicate in the Actions section), and extracting + `node --check`-ing
    the page's inline `<script>` block to confirm the new
    `updateBackfillButton` logic is syntactically valid (tsc doesn't check
    inside a template-literal string, so this was worth confirming
    directly rather than trusting the build alone). Did not click the
    button for a real end-to-end trigger this pass, since the underlying
    `retry-backfill` endpoint's own logic wasn't touched — only where the
    button lives and what it's labeled.

20. [DONE, VERIFIED, 2026-07-30] Two real UX issues, found by the user
    walking through the entire real merchant workflow themselves for the
    first time — a fresh Shopify dev store, the real `/auth/shopify`
    entry point, real Shopify billing confirmation, real HubSpot connect —
    rather than anything caught by code review. Both on the pages step 19
    had just touched.
    - **The dashboard link and admin key were still easy to miss**, even
      after 19's dashboard/backfill work — they're the last thing on the
      "Step 2 of 2" page, under the checklist, the explanatory paragraphs,
      and the "View your dashboard" button, for what is the single most
      unrecoverable thing on that page (the admin key is shown exactly
      once, ever). Fixed by adding a `.warning` banner directly under the
      `<h1>` headline — the first thing on the page, before anything
      else — with an anchor link (`#save-info`, wrapping the existing
      `saveLinkHtml`/`advancedHtml` blocks) that jumps straight down to
      them. Text adapts to whether an admin key will actually render this
      time (`keyWillShow` — a reconnect without `?regenerate_key=1` and an
      existing key on file doesn't show one), so it doesn't tell a
      reconnecting merchant to go save a key they won't be shown.
      Deliberately a pointer-plus-anchor rather than reordering the whole
      page (moving the warning block itself to the top) — keeps the
      existing narrative (what happened → what's next → save this)
      intact while still guaranteeing the critical info isn't the first
      thing skipped past.
    - **The "Start historical import" button, introduced in step 19,
      looked like a secondary/throwaway action** (it used `.btn-secondary`,
      shared with things like "Retry webhook registration") for what's
      actually the primary action of that whole section, and gave no
      feedback between clicking it and the page eventually re-rendering —
      a merchant had no way to tell the click registered at all. Fixed
      three ways:
      - Switched the button to `.btn` (the same primary orange used for
        "View your dashboard"/"Save rules"), and added a `.spinner`
        (pure-CSS rotating-border keyframe, no new dependency, matching
        this app's established no-external-assets approach) plus a subtle
        press animation (`transform: scale(0.96)` on `:active`) shared by
        both button classes — immediate visual feedback on click, not just
        eventually-different button text.
      - `setBackfillButtonStarting()` fires the instant the button is
        clicked, showing the spinner + "Starting..." before the network
        request even resolves — `updateBackfillButton()` alone only fires
        once `loadDashboard()` re-fetches real status afterward, which
        left the button looking unresponsive for that round trip.
        Restored correctly even on failure: both the success and error
        paths of the click handler now call `loadDashboard()` (previously
        only success did), so a failed request doesn't leave the button
        stuck showing "Starting..." forever.
      - The "page won't update itself, reload to check again" message —
        previously plain `.muted` text, the same easy-to-skim-past problem
        19's own warning had before its own fix — is now a `.banner-info`
        box (same treatment as the HubSpot-scope-degradation notice, step
        15) with an actual **"Refresh status" button** inline, rather than
        relying on a merchant to remember to reload the browser tab
        themselves.
    `npm run build` clean; all 81 tests pass unchanged (pure markup/CSS and
    dashboard JS glue, same established live-verification-over-unit-testing
    precedent as 19). Live-verified: started the local dev server against
    the same live Supabase database, curled the real rendered
    `/dashboard?shop=...` HTML to confirm the button now renders with
    `class="btn"` and the new spinner/banner-info CSS and JS are present,
    and re-ran the same `node --check` pass on the extracted inline
    `<script>` block to confirm the new button-state functions are
    syntactically valid. The onboarding-page banner (`src/hubspot/oauth.ts`)
    was reviewed directly against the diff rather than live-rendered this
    pass — triggering it for real would mean either reusing the connected
    dev store (which re-creates a billing subscription, per step 19's own
    documented reason for avoiding that) or standing up another fresh
    store; low risk regardless, since it's static string interpolation
    with no new logic branches beyond the already-reviewed `keyWillShow`
    condition.

21. [DONE, 2026-07-31] Synced Contacts showed the wrong name, found by the
    user placing a real test order and comparing Shopify's checkout screen
    (customer typed "Test Test") against the resulting HubSpot Contact
    (showed "Elias Gouatarbes" instead) — first suspected to be the deal
    card's owner avatar (a different field, `hubspot_owner_id`, confirmed
    correctly unset — "No owner"), then traced to the actual Contact record
    itself once the user pointed out the Contact panel, not the deal card,
    had the wrong name.
    Root cause: `syncOrder`/`syncCustomer` (`src/sync.ts`) only ever read a
    customer's name from `order.customer.first_name`/`last_name` — the
    linked Shopify **Customer profile** — never from the order's own
    billing/shipping address. Shopify's checkout doesn't rename an
    already-existing Customer profile just because a later order's checkout
    form was filled in with a different name; it only sets that order's
    address block. So a repeat email (this dev store's own `test@gmail.com`,
    used across many manual test orders) keeps reporting its original
    profile name via every subsequent order's webhook, no matter what's
    typed at checkout — and since `upsertContactByEmail`
    (`src/hubspot/contacts.ts`) always overwrites `firstname`/`lastname`
    when a value is present, every order sync actively re-wrote the Contact
    back to the stale name rather than merely failing to update it.
    Fixed by adding `resolveOrderContactName` (`src/sync.ts`, pure/exported/
    tested) — prefers `order.billing_address`'s name, then
    `order.shipping_address`'s, falling back to the Customer profile's name
    only when neither address has one — and using it in `syncOrder` when
    building the contact passed to `syncCustomer`. Extended `ShopifyAddress`
    with `first_name`/`last_name` and `ShopifyOrder` with
    `billing_address`/`shipping_address` (both already present on Shopify's
    real webhook payload, just not typed/read before). Applied to both sync
    paths that funnel through `syncOrder`: the live webhook receiver
    (`orders/create`/`orders/updated`/`refunds/create` in
    `src/shopify/webhooks.ts`) picks this up for free since it already casts
    the raw webhook body; the GraphQL historical backfill
    (`src/shopify/graphqlMapping.ts`) needed `billingAddress { firstName
    lastName }`/`shippingAddress { firstName lastName }` added to the shared
    `ORDER_NODE_FIELDS` query and `mapGraphqlOrder` updated to map them
    through — same field selection used by `ORDERS_QUERY` and
    `ORDER_BY_ID_QUERY`, so both the paginated backfill and the single-order
    refund re-fetch pick it up identically. A bare `customers/create`
    webhook (no order context) is unaffected by design — there's no
    order-specific address to prefer there, so it still uses the Customer
    profile's own name, which is the only name that exists for that case.
    `npm run build` clean; all 84 tests pass (81 previous + 3 new for
    `resolveOrderContactName`'s billing/shipping/fallback precedence,
    `src/sync.test.ts`; `graphqlMapping.test.ts` extended to cover the new
    query fields).
    **Not live-verified this pass** — unlike most entries above, this
    shipped on unit tests + a clean build alone, no real Shopify
    order/webhook round-trip against the dev store. Existing HubSpot
    Contacts synced before this fix (e.g. the "Elias Gouatarbes" one from
    order #1009) are not retroactively corrected — either place a new test
    order under the same email and confirm the Contact updates to the newly
    typed name, or re-run backfill for that order, to close the loop.
    **[REVISED same day, 2026-07-31]** The exact same bug, one field wider:
    the user's next test order (#1013) synced the corrected name ("Test
    Test") but still carried the stale street address ("Fredrikinkatu 24"
    on file from the earlier `test@gmail.com` Customer profile) instead of
    what was actually typed at that checkout ("Testing street", 00300
    Helsinki). The first pass only special-cased `first_name`/`last_name`;
    `default_address` (address1/city/province/zip/country) still came
    exclusively from the Customer profile.
    Generalized the fix rather than bolting on a second special case:
    `resolveOrderContactName` became `resolveOrderContact`, now resolving
    the *whole* contact snapshot — name and address together, as one unit
    — from whichever of `order.billing_address`/`shipping_address` has any
    content (checked across all of first/last name, address1, city, zip,
    country, not just name), falling back per-field to the Customer profile
    only when neither order address has anything at all. `syncOrder` spreads
    this over `order.customer` in place of the old name-only override, so
    `default_address` gets replaced along with the name in one pass.
    `graphqlMapping.ts`'s `billingAddress`/`shippingAddress` query fields
    widened to also select `address1 city province zip country` (previously
    name-only), and `mapGraphqlOrderAddress` now maps the full address
    through — same shared `ORDER_NODE_FIELDS` selection, so this covers the
    webhook, backfill, and refund-refetch paths identically, same as the
    first pass.
    `npm run build` clean; all 85 tests pass (`sync.test.ts` rewritten
    around `resolveOrderContact` — billing-wins, shipping-fallback,
    customer-fallback, and a mixed case where the winning address block has
    no name but the customer profile does; `graphqlMapping.test.ts`'s
    billing/shipping fixtures widened to a full address). Still not
    live-verified against a real order — same follow-up as the first pass
    (a fresh test order or a backfill re-run) would confirm both the name
    and address land correctly together this time.
    **[REVISED again same day, 2026-07-31]** Same bug, third field: phone
    had the identical problem — `resolveOrderContact` only ever resolved
    name and address, so `ContactProperties.phone` (`src/sync.ts`'s
    `syncCustomer` call, reading `customer.phone`) still fell through to
    the stale Customer profile's phone number untouched. Rather than wait
    for a third bug report against the same root cause, folded phone into
    the same resolution pass instead of leaving it as a known gap: `phone`
    added to `ShopifyAddress`, included in the address-block "does this
    order address have anything at all" check alongside name/address1/
    city/zip/country, and returned with the same per-field fallback
    (`address.phone ?? order.customer?.phone`) as name. `graphqlMapping.ts`
    widened the same way as the address fields before it — `phone` added to
    both `billingAddress`/`shippingAddress` in `ORDER_NODE_FIELDS` and
    mapped through `mapGraphqlOrderAddress` — so this again covers the
    webhook, backfill, and refund-refetch paths in one place, no
    per-path special-casing.
    `npm run build` clean; all 86 tests pass (`sync.test.ts` gained two
    phone-specific cases — billing phone wins over the customer profile,
    and an address block with *only* a phone, no name or street, still gets
    picked over the customer profile; `graphqlMapping.test.ts`'s billing/
    shipping fixtures gained a phone value). Not live-verified against a
    real order, same as the two passes above — this has now gone three
    rounds on unit tests alone, so a real end-to-end order (or a backfill
    re-run against an existing order) confirming name, address, *and* phone
    together is the next real check, rather than trusting a fourth field
    won't surface the same way.
