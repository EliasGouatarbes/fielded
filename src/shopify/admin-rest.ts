import https from 'https';
import { resolveShopifyAccessToken } from './token';
import { withRetry } from '../retry';

interface AdminRestResponse {
  body: string;
  linkHeader?: string;
}

// Carries the HTTP status and headers so src/retry.ts can recognize a 429
// (with Shopify's Retry-After header) or a transient 5xx.
export class ShopifyAdminApiError extends Error {
  code: number;
  headers: Record<string, string | string[] | undefined>;

  constructor(message: string, statusCode: number, headers: Record<string, string | string[] | undefined>) {
    super(message);
    this.code = statusCode;
    this.headers = headers;
  }
}

// Shared low-level request: used for GET (fetchAllPages, below) and for POST
// (src/scripts/register-webhooks.ts) — same auth header, same error/retry
// shape either way.
export function shopifyAdminRequest(
  shop: string,
  path: string,
  accessToken: string,
  method: 'GET' | 'POST',
  requestBody?: unknown
): Promise<AdminRestResponse> {
  return new Promise((resolve, reject) => {
    const payload = requestBody !== undefined ? JSON.stringify(requestBody) : undefined;

    const req = https.request(
      {
        hostname: shop,
        path,
        method,
        headers: {
          'X-Shopify-Access-Token': accessToken,
          Accept: 'application/json',
          ...(payload !== undefined
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0;
          if (statusCode >= 200 && statusCode < 300) {
            resolve({ body, linkHeader: res.headers.link as string | undefined });
          } else {
            reject(
              new ShopifyAdminApiError(
                `Shopify Admin API ${method} ${path} failed (${statusCode}): ${body}`,
                statusCode,
                res.headers
              )
            );
          }
        });
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// Shopify's REST Admin API paginates via an RFC 5988 `Link` header rather
// than an offset/page param (offset pagination was removed API-wide) — the
// header's `rel="next"` URL already carries the opaque `page_info` cursor,
// so we just follow it rather than reconstructing query params ourselves.
function nextPath(linkHeader?: string): string | undefined {
  if (!linkHeader) return undefined;

  const nextLink = linkHeader
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.endsWith('rel="next"'));
  if (!nextLink) return undefined;

  const match = nextLink.match(/^<([^>]+)>/);
  if (!match) return undefined;

  const url = new URL(match[1]);
  return `${url.pathname}${url.search}`;
}

// Fetches every page of a Shopify Admin REST list endpoint. `initialPath`
// should include the query string for the first page (filters, limit);
// subsequent pages are driven entirely by the Link header. `shop` is the
// merchant to fetch for (multi-merchant step).
export async function fetchAllPages<T>(shop: string, initialPath: string, resourceKey: string): Promise<T[]> {
  const accessToken = await resolveShopifyAccessToken(shop);
  const items: T[] = [];
  let path: string | undefined = initialPath;

  while (path) {
    const currentPath = path;
    const { body, linkHeader } = await withRetry(
      () => shopifyAdminRequest(shop, currentPath, accessToken, 'GET'),
      { label: `Shopify Admin API GET ${currentPath}` }
    );

    const parsed = JSON.parse(body) as Record<string, T[]>;
    items.push(...(parsed[resourceKey] ?? []));
    path = nextPath(linkHeader);
  }

  return items;
}
