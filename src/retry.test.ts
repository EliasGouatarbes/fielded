import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, isAuthError } from './retry';

test('isAuthError recognizes 401 and 403', () => {
  assert.equal(isAuthError({ code: 401 }), true);
  assert.equal(isAuthError({ statusCode: 403 }), true);
});

test('isAuthError rejects other status codes and non-error values', () => {
  assert.equal(isAuthError({ code: 400 }), false);
  assert.equal(isAuthError({ code: 429 }), false);
  assert.equal(isAuthError({ code: 500 }), false);
  assert.equal(isAuthError(new Error('plain')), false);
  assert.equal(isAuthError(undefined), false);
});

test('withRetry succeeds immediately without retrying', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    return 'ok';
  }, { label: 'test' });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry retries a 429 honoring Retry-After, then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) {
        const err: any = new Error('rate limited');
        err.code = 429;
        err.headers = { 'retry-after': '0' };
        throw err;
      }
      return 'ok';
    },
    { label: 'test', maxAttempts: 5 }
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withRetry fails immediately on a non-retryable 400, no retry attempted', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        const err: any = new Error('bad request');
        err.code = 400;
        throw err;
      },
      { label: 'test', maxAttempts: 5 }
    )
  );
  assert.equal(calls, 1);
});

test('withRetry retries a transient network error code, then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 2) {
        const err: any = new Error('reset');
        err.code = 'ECONNRESET';
        throw err;
      }
      return 'ok';
    },
    { label: 'test', maxAttempts: 5 }
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('withRetry exhausts maxAttempts on a persistent 5xx and throws', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        const err: any = new Error('server error');
        err.code = 503;
        err.headers = { 'retry-after': '0' };
        throw err;
      },
      { label: 'test', maxAttempts: 3 }
    )
  );
  assert.equal(calls, 3);
});
