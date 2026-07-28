// Bounded-concurrency worker pool — used by src/backfillMerchant.ts (10g,
// CLAUDE.md pre-launch audit) so a merchant with a large historical order
// count doesn't wait through hundreds of fully sequential HubSpot round
// trips. Safe to run orders/customers concurrently: src/mutex.ts's
// withKeyedLock only serializes calls sharing the same natural key
// (email/dealname) — different customers/orders in the same batch don't
// share a key, so they don't contend with each other, and the same
// concurrent-write path (contacts + deals) was already stress-tested up to
// 5-at-once in this app's own step 8.
//
// Preserves input order in the returned array. If an item's `fn` rejects,
// that rejection propagates (matching the previous sequential loop's
// behavior — one bad record still surfaces as a failure), but unlike the
// sequential version, other items already in flight within the same batch
// keep running rather than stopping immediately.
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
