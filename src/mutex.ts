// Serializes calls sharing the same key so a search-then-create sequence
// for one natural key (email, dealname) can't interleave with another call
// for that same key racing against HubSpot's own eventually-consistent
// search index (see src/hubspot/conflict.ts for the fuller story — found
// via a real test order in step 8, where two nearly-simultaneous webhook
// deliveries for the same customer both missed the search and both
// attempted create). Only serializes within this process — doesn't help
// across a restart or multiple instances, which is what the 409-recovery
// fallback in conflict.ts is for.
//
// Entries are never removed, so this grows one entry per distinct key ever
// seen — fine at this app's target volume (tens to hundreds of orders a
// month), worth revisiting if that changes.
const locks = new Map<string, Promise<unknown>>();

export function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  locks.set(
    key,
    run.catch(() => undefined)
  );
  return run;
}
