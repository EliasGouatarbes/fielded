import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency } from './concurrency';

test('mapWithConcurrency preserves input order in the results', async () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const results = await mapWithConcurrency(items, 3, async (n) => {
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
    return n * 10;
  });
  assert.deepEqual(results, [10, 20, 30, 40, 50, 60, 70, 80]);
});

test('mapWithConcurrency never runs more than `concurrency` items at once', async () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  let inFlight = 0;
  let maxInFlight = 0;

  await mapWithConcurrency(items, 3, async (n) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return n;
  });

  assert.ok(maxInFlight <= 3, `expected max 3 in flight, saw ${maxInFlight}`);
});

test('mapWithConcurrency handles an empty array', async () => {
  const results = await mapWithConcurrency([], 5, async (n: number) => n);
  assert.deepEqual(results, []);
});

test('mapWithConcurrency handles concurrency higher than item count', async () => {
  const results = await mapWithConcurrency([1, 2], 10, async (n) => n * 2);
  assert.deepEqual(results, [2, 4]);
});

test('mapWithConcurrency propagates a rejection from any item', async () => {
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    }),
    /boom/
  );
});
