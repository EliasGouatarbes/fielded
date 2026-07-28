import { Client as HubSpotClient } from '@hubspot/api-client';
import { withRetry } from '../retry';
import { extractConflictingId } from './conflict';
import { withKeyedLock } from '../mutex';
import { getCachedId, setCachedId } from './idCache';

// Hand-mapped, never auto-mapped: HubSpot's own Shopify integration
// auto-maps address fields by name match, which is what sends state/province
// into the wrong (dropdown) property type as garbage "enabled/disabled"
// values. These are HubSpot's standard single-line-text contact properties.
export interface ContactProperties {
  email: string;
  firstname?: string;
  lastname?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  // Only ever set to 'customer', and only by an order sync (see
  // src/sync.ts) — a plain customers/create webhook fires on account
  // creation alone, which doesn't mean they've bought anything yet.
  lifecyclestage?: string;
}

// Search-before-create: a retried Shopify webhook must update the existing
// contact, not create a duplicate. Email is the natural unique key here.
// `client`/`shopDomain` are per-merchant (multi-merchant step): the client
// is resolved per-request against that merchant's own HubSpot portal, and
// shopDomain scopes the lock/cache keys so two merchants sharing an email
// address can't collide in the shared in-process cache.
export async function upsertContactByEmail(
  client: HubSpotClient,
  shopDomain: string,
  contact: ContactProperties
): Promise<string> {
  return withKeyedLock(`${shopDomain}:contact:${contact.email}`, () =>
    upsertContactByEmailLocked(client, shopDomain, contact)
  );
}

async function upsertContactByEmailLocked(
  client: HubSpotClient,
  shopDomain: string,
  contact: ContactProperties
): Promise<string> {
  const { email, ...rest } = contact;
  const cacheKey = `${shopDomain}:contact:${email}`;

  const properties: Record<string, string> = { email };
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined && value !== '') {
      properties[key] = value;
    }
  }

  const cachedId = getCachedId(cacheKey);
  if (cachedId) {
    await withRetry(() => client.crm.contacts.basicApi.update(cachedId, { properties }), {
      label: `HubSpot contact update (${cachedId})`,
    });
    return cachedId;
  }

  const searchResult = await withRetry(
    () =>
      client.crm.contacts.searchApi.doSearch({
        filterGroups: [
          {
            // 'as any': FilterOperatorEnum is a nominal string enum internal to
            // the SDK's codegen and isn't exported from its package root; 'EQ'
            // is the correct wire value regardless.
            filters: [{ propertyName: 'email', operator: 'EQ' as any, value: email }],
          },
        ],
        properties: ['email'],
        limit: 1,
      }),
    { label: `HubSpot contact search (${email})` }
  );

  const existing = searchResult.results[0];
  if (existing) {
    await withRetry(() => client.crm.contacts.basicApi.update(existing.id, { properties }), {
      label: `HubSpot contact update (${existing.id})`,
    });
    setCachedId(cacheKey, existing.id);
    return existing.id;
  }

  try {
    const created = await withRetry(() => client.crm.contacts.basicApi.create({ properties }), {
      label: `HubSpot contact create (${email})`,
    });
    setCachedId(cacheKey, created.id);
    return created.id;
  } catch (err) {
    // Search-index lag: another concurrent sync for this email won the
    // create between our search and this create call. HubSpot's error
    // hands back the winner's id — update it rather than failing.
    const conflictId = extractConflictingId(err);
    if (!conflictId) throw err;

    await withRetry(() => client.crm.contacts.basicApi.update(conflictId, { properties }), {
      label: `HubSpot contact update after conflict (${conflictId})`,
    });
    setCachedId(cacheKey, conflictId);
    return conflictId;
  }
}
