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
    - 10g. Backfill/sync is fully sequential, no batching — fine at target
      scale (tens–hundreds of orders/month), would be slow for a merchant
      with a large historical order count.

    Security findings, not yet fixed:
    - 10h. Postgres connection disables TLS certificate verification
      (`ssl: { rejectUnauthorized: false }` in `src/db/client.ts`). Traffic
      is still encrypted, but the client never verifies it's actually
      talking to Supabase — a network-positioned attacker could MITM with a
      self-signed cert undetected. Fix: fetch Supabase's real CA cert, use
      `ssl: { ca: ... }` instead.
    - 10i. Credential hygiene: several real secrets (DB password, Shopify/
      HubSpot client secrets, the admin key, the encryption key) were
      displayed in plaintext in chat multiple times this session while
      debugging live. Not a public leak, but worth rotating the cheap ones
      (`ADMIN_API_KEY`, `OAUTH_STATE_SECRET`) before onboarding real
      merchants; `ENCRYPTION_KEY`/DB password are harder to rotate
      (need coordinated re-encryption/reconnect) so lower urgency.
    - 10j. No rate limiting anywhere (OAuth routes, webhook receiver,
      `/sync-status`) — acceptable at current scale, worth knowing it's
      absent.
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
