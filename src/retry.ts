// Shared retry/backoff for the two APIs this app calls (HubSpot's SDK,
// Shopify's GraphQL Admin API) — both end up signaling rate limits as a
// numeric `.code`/`.statusCode` of 429, optionally with a Retry-After
// header, so one generic wrapper covers both rather than each call site
// rolling its own. For Shopify specifically, a throttled GraphQL request
// isn't actually an HTTP 429 (it's HTTP 200 with a body-level
// `errors.graphQLErrors[].extensions.code === "THROTTLED"`) —
// src/shopify/admin-graphql.ts's `interpretGraphqlResponse` is what
// translates that into this shape before it ever reaches here, so this
// file itself only ever deals with the normalized numeric-code form. Duck-
// typed rather than `instanceof` checked: HubSpot's `ApiException` class
// isn't exported from the SDK's package root, and is in fact a distinct
// class per codegen'd object type (contacts vs deals), so nominal checks
// would need a separate import per object type for no real benefit — every
// error shape we care about exposes its HTTP status as a numeric `.code`
// or `.statusCode`.

const RETRYABLE_NODE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EPIPE',
]);

export function getStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const withCode = err as { code?: unknown; statusCode?: unknown };
  if (typeof withCode.code === 'number') return withCode.code;
  if (typeof withCode.statusCode === 'number') return withCode.statusCode;
  return undefined;
}

// A 401/403 from HubSpot's API (as opposed to a 400 validation error, or a
// 429/5xx retry.ts already retries) means this merchant's connection itself
// is bad — almost always because they revoked this app's access from
// inside their HubSpot portal. Used by src/sync.ts to flag that
// (src/db/merchants.ts's markHubSpotConnectionBroken) and by
// src/shopify/webhooks.ts to stop retrying a webhook delivery that
// retrying can't fix.
export function isAuthError(err: unknown): boolean {
  const status = getStatusCode(err);
  return status === 401 || status === 403;
}

function getRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const headers = (err as { headers?: Record<string, unknown> }).headers;
  const value = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (value === undefined) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

function isRetryable(err: unknown): boolean {
  const status = getStatusCode(err);
  if (status !== undefined) return status === 429 || status >= 500;

  const nodeCode = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return typeof nodeCode === 'string' && RETRYABLE_NODE_ERROR_CODES.has(nodeCode);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  label: string;
  maxAttempts?: number;
}

export async function withRetry<T>(fn: () => Promise<T>, { label, maxAttempts = 5 }: RetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryable(err)) throw err;

      const delayMs =
        getRetryAfterMs(err) ?? Math.min(1000 * 2 ** (attempt - 1), 30_000) + Math.floor(Math.random() * 250);
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`${label}: attempt ${attempt}/${maxAttempts} failed, retrying in ${delayMs}ms — ${reason}`);
      await sleep(delayMs);
    }
  }
}
