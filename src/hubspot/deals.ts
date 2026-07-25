import { AssociationTypes } from '@hubspot/api-client';
import { hubspotClient } from './client';
import { config } from '../config';
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
}

// Search-before-create by dealname (the order number): a retried
// orders/create or an orders/updated webhook must update the existing deal,
// not create a duplicate.
export async function upsertDealByName(deal: DealProperties, contactId?: string): Promise<string> {
  return withKeyedLock(`deal:${deal.dealname}`, () => upsertDealByNameLocked(deal, contactId));
}

async function upsertDealByNameLocked(deal: DealProperties, contactId?: string): Promise<string> {
  const cacheKey = `deal:${deal.dealname}`;

  const properties: Record<string, string> = { dealname: deal.dealname };
  if (deal.amount !== undefined) {
    properties.amount = deal.amount;
  }
  if (config.hubspot.dealPipeline) {
    properties.pipeline = config.hubspot.dealPipeline;
  }
  if (config.hubspot.dealStage) {
    properties.dealstage = config.hubspot.dealStage;
  }

  const cachedId = getCachedId(cacheKey);
  if (cachedId) {
    await withRetry(() => hubspotClient.crm.deals.basicApi.update(cachedId, { properties }), {
      label: `HubSpot deal update (${cachedId})`,
    });
    return cachedId;
  }

  const searchResult = await withRetry(
    () =>
      hubspotClient.crm.deals.searchApi.doSearch({
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
    await withRetry(() => hubspotClient.crm.deals.basicApi.update(existing.id, { properties }), {
      label: `HubSpot deal update (${existing.id})`,
    });
    setCachedId(cacheKey, existing.id);
    return existing.id;
  }

  try {
    const created = await withRetry(
      () =>
        hubspotClient.crm.deals.basicApi.create({
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

    await withRetry(() => hubspotClient.crm.deals.basicApi.update(conflictId, { properties }), {
      label: `HubSpot deal update after conflict (${conflictId})`,
    });
    setCachedId(cacheKey, conflictId);
    return conflictId;
  }
}
