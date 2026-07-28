import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretGraphqlResponse, ShopifyAdminApiError, collectPages, Connection } from './admin-graphql';

test('interpretGraphqlResponse returns data on a clean response', () => {
  const data = interpretGraphqlResponse({ data: { ok: true } }, 'test');
  assert.deepEqual(data, { ok: true });
});

test('interpretGraphqlResponse throws a retryable error on a 5xx network status', () => {
  assert.throws(
    () => interpretGraphqlResponse({ errors: { networkStatusCode: 503, message: 'unavailable' } }, 'test'),
    (err: unknown) => err instanceof ShopifyAdminApiError && err.code === 503
  );
});

test('interpretGraphqlResponse throws a synthesized 429 on THROTTLED', () => {
  assert.throws(
    () =>
      interpretGraphqlResponse(
        { errors: { graphQLErrors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] } },
        'test'
      ),
    (err: unknown) => err instanceof ShopifyAdminApiError && err.code === 429
  );
});

test('interpretGraphqlResponse throws a plain (non-retryable) Error on a non-throttle GraphQL error', () => {
  assert.throws(
    () =>
      interpretGraphqlResponse(
        { errors: { graphQLErrors: [{ message: 'Field does not exist', extensions: { code: 'undefinedField' } }] } },
        'test'
      ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!(err instanceof ShopifyAdminApiError));
      assert.equal((err as { code?: unknown }).code, undefined);
      return true;
    }
  );
});

test('interpretGraphqlResponse throws when there is no data and no errors', () => {
  assert.throws(() => interpretGraphqlResponse({}, 'test'), /no data and no errors/);
});

test('collectPages aggregates every page in order using each endCursor', async () => {
  const pages: Array<Connection<string>> = [
    { edges: [{ node: 'a', cursor: 'c1' }, { node: 'b', cursor: 'c2' }], pageInfo: { hasNextPage: true, endCursor: 'c2' } },
    { edges: [{ node: 'c', cursor: 'c3' }], pageInfo: { hasNextPage: true, endCursor: 'c3' } },
    { edges: [{ node: 'd', cursor: 'c4' }], pageInfo: { hasNextPage: false, endCursor: null } },
  ];

  const seenCursors: Array<string | null> = [];
  const requestPage = async (after: string | null) => {
    seenCursors.push(after);
    const page = pages.shift();
    if (!page) throw new Error('requested more pages than expected');
    return page;
  };

  const nodes = await collectPages(requestPage);
  assert.deepEqual(nodes, ['a', 'b', 'c', 'd']);
  assert.deepEqual(seenCursors, [null, 'c2', 'c3']);
});

test('collectPages stops after a single page when hasNextPage is false', async () => {
  const requestPage = async () => ({
    edges: [{ node: 'only', cursor: 'c1' }],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  const nodes = await collectPages(requestPage);
  assert.deepEqual(nodes, ['only']);
});
