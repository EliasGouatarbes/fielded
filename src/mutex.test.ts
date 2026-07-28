import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withKeyedLock } from './mutex';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('withKeyedLock serializes calls sharing the same key', async () => {
  const order: string[] = [];
  const first = withKeyedLock('key-a', async () => {
    order.push('first-start');
    await delay(20);
    order.push('first-end');
    return 'first';
  });
  const second = withKeyedLock('key-a', async () => {
    order.push('second-start');
    return 'second';
  });

  const results = await Promise.all([first, second]);
  assert.deepEqual(results, ['first', 'second']);
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start']);
});

test('withKeyedLock does not serialize calls with different keys', async () => {
  const order: string[] = [];
  const a = withKeyedLock('key-b', async () => {
    order.push('a-start');
    await delay(20);
    order.push('a-end');
  });
  const b = withKeyedLock('key-c', async () => {
    order.push('b-start');
  });
  await Promise.all([a, b]);
  assert.ok(order.indexOf('b-start') < order.indexOf('a-end'), 'b should not wait for a to finish');
});

test('withKeyedLock still unblocks the next call after a failure', async () => {
  const first = withKeyedLock('key-d', async () => {
    throw new Error('boom');
  });
  await assert.rejects(first);

  const second = withKeyedLock('key-d', async () => 'recovered');
  assert.equal(await second, 'recovered');
});
