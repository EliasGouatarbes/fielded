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
