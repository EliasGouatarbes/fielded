import { Client as HubSpotClient, AssociationTypes } from '@hubspot/api-client';
import { withRetry } from '../retry';
import { extractConflictingId } from './conflict';
import { withKeyedLock } from '../mutex';
import { getCachedId, setCachedId } from './idCache';

export interface DealProperties {
  // The Shopify order number (e.g. Shopify's `order.name`, "#1001") goes
  // straight into dealname — that's the property HubSpot's search actually
  // indexes, and the whole reason orders synced via HubSpot's own Shopify
  // integration become unsearchable by order number.
  dealname: string;
  amount?: string;
  // Resolved per-order by src/hubspot/dealRules.ts against the merchant's
  // own rules (multi-merchant step) — this function just persists whatever
  // it's given, it makes no pipeline/stage/owner decisions itself.
  pipeline?: string;
  stage?: string;
  owner?: string;
}

// Search-before-create by dealname (the order number): a retried
// orders/create or an orders/updated webhook must update the existing deal,
// not create a duplicate. `client`/`shopDomain` are per-merchant: the
// client is resolved against that merchant's own HubSpot portal, and
// shopDomain scopes the lock/cache keys so two merchants sharing an order
// number format can't collide in the shared in-process cache.
export async function upsertDealByName(
  client: HubSpotClient,
  shopDomain: string,
  deal: DealProperties,
  contactId?: string
): Promise<string> {
  return withKeyedLock(`${shopDomain}:deal:${deal.dealname}`, () =>
    upsertDealByNameLocked(client, shopDomain, deal, contactId)
  );
}

async function upsertDealByNameLocked(
  client: HubSpotClient,
  shopDomain: string,
  deal: DealProperties,
  contactId?: string
): Promise<string> {
  const cacheKey = `${shopDomain}:deal:${deal.dealname}`;

  const properties: Record<string, string> = { dealname: deal.dealname };
  if (deal.amount !== undefined) {
    properties.amount = deal.amount;
  }
  if (deal.pipeline) {
    properties.pipeline = deal.pipeline;
  }
  if (deal.stage) {
    properties.dealstage = deal.stage;
  }
  if (deal.owner) {
    properties.hubspot_owner_id = deal.owner;
  }

  const cachedId = getCachedId(cacheKey);
  if (cachedId) {
    await withRetry(() => client.crm.deals.basicApi.update(cachedId, { properties }), {
      label: `HubSpot deal update (${cachedId})`,
    });
    return cachedId;
  }

  const searchResult = await withRetry(
    () =>
      client.crm.deals.searchApi.doSearch({
        filterGroups: [
          {
            // 'as any': see contacts.ts — same nominal-enum-from-codegen situation.
            filters: [{ propertyName: 'dealname', operator: 'EQ' as any, value: deal.dealname }],
          },
        ],
        properties: ['dealname'],
        limit: 1,
      }),
    { label: `HubSpot deal search (${deal.dealname})` }
  );

  const existing = searchResult.results[0];
  if (existing) {
    await withRetry(() => client.crm.deals.basicApi.update(existing.id, { properties }), {
      label: `HubSpot deal update (${existing.id})`,
    });
    setCachedId(cacheKey, existing.id);
    return existing.id;
  }

  try {
    const created = await withRetry(
      () =>
        client.crm.deals.basicApi.create({
          properties,
          associations: contactId
            ? [
                {
                  to: { id: contactId },
                  types: [
                    {
                      associationCategory: 'HUBSPOT_DEFINED' as any,
                      associationTypeId: AssociationTypes.dealToContact,
                    },
                  ],
                },
              ]
            : undefined,
        }),
      { label: `HubSpot deal create (${deal.dealname})` }
    );
    setCachedId(cacheKey, created.id);
    return created.id;
  } catch (err) {
    // Belt-and-suspenders: unlike contacts' email, HubSpot doesn't actually
    // enforce dealname uniqueness, so this 409 path is not known to trigger
    // in practice (the idCache above is what actually prevents duplicate
    // deals) — kept in case that ever changes.
    const conflictId = extractConflictingId(err);
    if (!conflictId) throw err;

    await withRetry(() => client.crm.deals.basicApi.update(conflictId, { properties }), {
      label: `HubSpot deal update after conflict (${conflictId})`,
    });
    setCachedId(cacheKey, conflictId);
    return conflictId;
  }
}
