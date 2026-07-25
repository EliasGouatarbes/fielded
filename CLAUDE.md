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
8. [CODE DONE, LOCALLY VERIFIED — fix not yet redeployed] Real-world test.
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
   afterward. `tsc`/`npm run build` clean, local server healthy.
   Remaining before this step is actually done: commit, push, let Render
   redeploy, then re-verify against the live deployment (ideally with
   another real order, now that webhook subscriptions exist) that the fix
   holds in production too.
9. Business steps: Shopify App Store review (needs a privacy policy — touches
   customer PII), billing/pricing setup. Also, before any real merchant's
   token lands in it: encrypt `shopify_installations.access_token` at rest
   (e.g. AES-256-GCM with a key held outside Postgres itself — a secrets
   manager, not another env var next to `DATABASE_URL`) rather than relying
   solely on Supabase's disk-level encryption and DB access controls. Fine
   as plaintext for now (own token, own database) — flagged here so it
   doesn't get dropped once this goes multi-merchant.
