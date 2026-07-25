import { AssociationTypes } from '@hubspot/api-client';
import { hubspotClient } from './client';
import { config } from '../config';
import { withRetry } from '../retry';

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
export async function upsertDealByName(
  deal: DealProperties,
  contactId?: string
): Promise<string> {
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
    return existing.id;
  }

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
  return created.id;
}
