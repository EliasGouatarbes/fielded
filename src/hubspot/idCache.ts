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
const cache = new Map<string, string>();

export function getCachedId(key: string): string | undefined {
  return cache.get(key);
}

export function setCachedId(key: string, id: string): void {
  cache.set(key, id);
}
