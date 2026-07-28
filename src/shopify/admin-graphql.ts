import { createAdminApiClient } from '@shopify/admin-api-client';
import { config } from '../config';
import { resolveShopifyAccessToken } from './token';
import { withRetry } from '../retry';

// Carries the HTTP status and headers so src/retry.ts can recognize a
// retryable condition, exactly like the REST-era ShopifyAdminApiError this
// replaces — kept as the same shape deliberately so retry.ts needed zero
// changes for this migration.
export class ShopifyAdminApiError extends Error {
  code: number;
  headers: Record<string, string | string[] | undefined>;

  constructor(message: string, statusCode: number, headers: Record<string, string | string[] | undefined> = {}) {
    super(message);
    this.code = statusCode;
    this.headers = headers;
  }
}

interface GraphqlErrorLike {
  networkStatusCode?: number;
  message?: string;
  graphQLErrors?: Array<{ message?: string; extensions?: { code?: string } }>;
}

interface GraphqlResponseLike<TData> {
  data?: TData;
  errors?: GraphqlErrorLike;
}

// The core translation this migration needed: GraphQL throttling is NOT an
// HTTP 429 — a throttled request returns HTTP 200 with a body-level
// `errors.graphQLErrors[].extensions.code === "THROTTLED"`. retry.ts only
// ever inspects a thrown error's numeric `.code`/`.statusCode`, so this
// function is what turns that body-level condition (and real 5xx network
// failures) into a `ShopifyAdminApiError` retry.ts already knows how to
// handle — no changes to retry.ts itself. Non-throttle GraphQL errors (real
// schema/query bugs) become a plain `Error`, which retry.ts already treats
// as non-retryable (no numeric `.code`), matching how REST 4xx validation
// errors are treated elsewhere in this app.
export function interpretGraphqlResponse<TData>(response: GraphqlResponseLike<TData>, context: string): TData {
  const errors = response.errors;
  if (errors) {
    if (typeof errors.networkStatusCode === 'number' && errors.networkStatusCode >= 500) {
      throw new ShopifyAdminApiError(
        `${context}: Shopify GraphQL request failed (network ${errors.networkStatusCode})${
          errors.message ? `: ${errors.message}` : ''
        }`,
        errors.networkStatusCode
      );
    }

    const throttled = errors.graphQLErrors?.find((e) => e.extensions?.code === 'THROTTLED');
    if (throttled) {
      throw new ShopifyAdminApiError(
        `${context}: Shopify GraphQL request throttled${throttled.message ? `: ${throttled.message}` : ''}`,
        429
      );
    }

    if (errors.graphQLErrors?.length || errors.message) {
      const detail = errors.graphQLErrors?.map((e) => e.message).filter(Boolean).join('; ') || errors.message;
      throw new Error(`${context}: Shopify GraphQL request failed: ${detail}`);
    }
  }

  if (response.data === undefined) {
    throw new Error(`${context}: Shopify GraphQL response had no data and no errors.`);
  }

  return response.data;
}

// Single choke point for every outbound Shopify GraphQL call — resolves the
// merchant's token the same way the old REST transport did
// (resolveShopifyAccessToken, src/shopify/token.ts), builds a client scoped
// to just this request (no SDK session/shopifyApi() ceremony), and wraps it
// in the same withRetry every other API call in this app already uses.
export async function shopifyGraphqlRequest<TData>(
  shop: string,
  query: string,
  variables?: Record<string, unknown>,
  context = 'Shopify GraphQL request'
): Promise<TData> {
  const accessToken = await resolveShopifyAccessToken(shop);
  const client = createAdminApiClient({
    storeDomain: shop,
    apiVersion: config.shopify.apiVersion,
    accessToken,
    retries: 0, // retry.ts is the single source of retry/backoff truth
  });

  return withRetry(
    async () => {
      const response = await client.request<TData>(query, { variables });
      return interpretGraphqlResponse(response, context);
    },
    { label: context }
  );
}

export interface Connection<TNode> {
  edges: Array<{ node: TNode; cursor: string }>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

// Pure cursor-pagination loop, independently testable with a fake
// `requestPage` sequence — no live client needed. Replaces admin-rest.ts's
// Link-header-following `nextPath`, since GraphQL connections paginate via
// `pageInfo.hasNextPage`/`endCursor` instead.
export async function collectPages<TNode>(
  requestPage: (after: string | null) => Promise<Connection<TNode>>
): Promise<TNode[]> {
  const items: TNode[] = [];
  let after: string | null = null;

  for (;;) {
    const page = await requestPage(after);
    items.push(...page.edges.map((edge) => edge.node));
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }

  return items;
}

// Fetches every page of a GraphQL Admin API connection. `getConnection`
// pulls the paginated field out of the query's response shape (e.g.
// `(data) => data.customers`) — kept generic since customers/orders/webhook
// subscriptions all paginate the same way.
export async function fetchAllPages<TNode, TData>(
  shop: string,
  query: string,
  getConnection: (data: TData) => Connection<TNode>,
  baseVariables: Record<string, unknown> = {},
  pageSize = 250,
  context = 'Shopify GraphQL pagination'
): Promise<TNode[]> {
  return collectPages<TNode>(async (after) => {
    const data = await shopifyGraphqlRequest<TData>(shop, query, { ...baseVariables, first: pageSize, after }, context);
    return getConnection(data);
  });
}
