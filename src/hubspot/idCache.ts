// In-process memo of natural-key (email, dealname) -> HubSpot object id.
// The mutex in src/mutex.ts only prevents true overlap; it doesn't stop a
// later, fully-serialized call from re-searching and re-missing due to
// HubSpot's search-index lag. That's harmless for contacts, where email
// has a real server-side uniqueness constraint and conflict.ts's 409
// recovery catches the race — but HubSpot deals have NO uniqueness
// constraint on dealname, so the same race there doesn't error, it
// silently creates a duplicate deal (confirmed with a 5-concurrent-call
// test during step 8: 5 distinct deal ids, zero errors). Once this process
// has resolved a key to an id, every later call for that same key reuses
// it directly instead of searching again.
//
// Accepted residual risk (pre-launch audit, 2026-07-29): this map — and
// src/mutex.ts's lock map — are wiped on every process restart (a deploy, a
// crash, Render's free-tier behavior). A restart landing in the exact window
// of a concurrent burst of webhooks for a *brand-new* dealname briefly
// reopens the pre-fix duplicate-deal race, since there's no cached id yet to
// short-circuit the search. Judged low-probability (HubSpot's search-index
// lag is sub-second, and restarts are infrequent relative to order volume at
// this app's target scale) and not worth a DB-backed distributed lock today
// — revisit if real duplicate deals are ever observed, or if this scales
// beyond a single Render instance (multiple instances would reopen the same
// race even without a restart, since this cache is also not shared across
// processes).
const cache = new Map<string, string>();

export function getCachedId(key: string): string | undefined {
  return cache.get(key);
}

export function setCachedId(key: string, id: string): void {
  cache.set(key, id);
}
