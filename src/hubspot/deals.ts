import { Client as HubSpotClient, AssociationTypes } from '@hubspot/api-client';
import { withRetry } from '../retry';
import { extractConflictingId } from './conflict';
import { withKeyedLock } from '../mutex';
import { getCachedId, setCachedId } from './idCache';

export interface DealLineItem {
  name: string;
  quantity: number;
  price?: string;
  sku?: string;
}

export interface DealProperties {
  // The Shopify order number (e.g. Shopify's `order.name`, "#1001") goes
  // straight into dealname — that's the property HubSpot's search actually
  // indexes, and the whole reason orders synced via HubSpot's own Shopify
  // integration become unsearchable by order number.
  dealname: string;
  amount?: string;
  // Shopify's order currency (ISO 4217, e.g. "EUR") — 12e, functional
  // audit: `amount` alone is a bare number, silently wrong-looking for any
  // merchant whose store currency differs from their HubSpot portal's
  // default. Best-effort: HubSpot rejects `deal_currency_code` outright
  // (400 VALIDATION_ERROR) if that currency isn't one of the portal's
  // configured currencies, so `upsertDealByName` below falls back to
  // writing without it rather than failing the whole sync over a currency
  // the merchant never added to their portal.
  currencyCode?: string;
  // Resolved per-order by src/hubspot/dealRules.ts against the merchant's
  // own rules (multi-merchant step) — this function just persists whatever
  // it's given, it makes no pipeline/stage/owner decisions itself.
  pipeline?: string;
  stage?: string;
  owner?: string;
  // Only applied when this call creates a brand-new deal (see
  // createLineItems below) — Shopify order line items don't change after
  // an order is placed, so there's no need to reconcile them on every
  // orders/updated delivery (which fires for financial/fulfillment status
  // changes, not product edits).
  lineItems?: DealLineItem[];
}

// HubSpot rejects `deal_currency_code` with a 400 VALIDATION_ERROR if the
// currency isn't one of the portal's configured currencies (enforced since
// July 2023) — e.g. a Shopify store selling in a currency the merchant's
// HubSpot portal was never configured for. Pure/exported so the detection
// is independently testable without a live API call.
export function isCurrencyValidationError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ((err as { code?: unknown }).code !== 400) return false;
  const message = (err as { body?: { message?: unknown } }).body?.message;
  return typeof message === 'string' && /effective currency codes/i.test(message);
}

// Tries `write` with the full properties first; if HubSpot rejects it
// specifically for an unconfigured currency, retries once with
// `deal_currency_code` stripped — a merchant whose HubSpot portal was never
// set up for their store's currency still gets the deal synced, just
// without the currency tag, rather than the whole sync failing.
async function writeDealProperties<T>(
  write: (properties: Record<string, string>) => Promise<T>,
  properties: Record<string, string>,
  dealname: string
): Promise<T> {
  try {
    return await write(properties);
  } catch (err) {
    if (!isCurrencyValidationError(err) || !properties.deal_currency_code) throw err;
    console.warn(
      `Deal currency "${properties.deal_currency_code}" isn't configured in this HubSpot portal — syncing "${dealname}" without a currency code.`
    );
    const { deal_currency_code: _currency, ...withoutCurrency } = properties;
    return write(withoutCurrency);
  }
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
  if (deal.currencyCode) {
    properties.deal_currency_code = deal.currencyCode;
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
    await writeDealProperties(
      (props) =>
        withRetry(() => client.crm.deals.basicApi.update(cachedId, { properties: props }), {
          label: `HubSpot deal update (${cachedId})`,
        }),
      properties,
      deal.dealname
    );
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
    await writeDealProperties(
      (props) =>
        withRetry(() => client.crm.deals.basicApi.update(existing.id, { properties: props }), {
          label: `HubSpot deal update (${existing.id})`,
        }),
      properties,
      deal.dealname
    );
    setCachedId(cacheKey, existing.id);
    return existing.id;
  }

  try {
    const created = await writeDealProperties(
      (props) =>
        withRetry(
          () =>
            client.crm.deals.basicApi.create({
              properties: props,
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
        ),
      properties,
      deal.dealname
    );
    setCachedId(cacheKey, created.id);
    if (deal.lineItems?.length) {
      await createLineItems(client, created.id, deal.lineItems);
    }
    return created.id;
  } catch (err) {
    // Belt-and-suspenders: unlike contacts' email, HubSpot doesn't actually
    // enforce dealname uniqueness, so this 409 path is not known to trigger
    // in practice (the idCache above is what actually prevents duplicate
    // deals) — kept in case that ever changes.
    const conflictId = extractConflictingId(err);
    if (!conflictId) throw err;

    await writeDealProperties(
      (props) =>
        withRetry(() => client.crm.deals.basicApi.update(conflictId, { properties: props }), {
          label: `HubSpot deal update after conflict (${conflictId})`,
        }),
      properties,
      deal.dealname
    );
    setCachedId(cacheKey, conflictId);
    return conflictId;
  }
}

// Attaches Shopify's order line items to a newly-created deal, product-level
// data (SKU, quantity, price) HubSpot's own Shopify integration reviewers
// repeatedly flag as missing/unusable ("no SKUs", "can't build lists by
// product bought"). No search-before-create here: this only ever runs right
// after this deal's own create call, so there's nothing to search for yet.
async function createLineItems(client: HubSpotClient, dealId: string, lineItems: DealLineItem[]): Promise<void> {
  for (const item of lineItems) {
    const properties: Record<string, string> = {
      name: item.name,
      quantity: String(item.quantity),
    };
    if (item.price !== undefined) properties.price = item.price;
    if (item.sku !== undefined) properties.hs_sku = item.sku;

    await withRetry(
      () =>
        client.crm.lineItems.basicApi.create({
          properties,
          associations: [
            {
              to: { id: dealId },
              types: [
                {
                  associationCategory: 'HUBSPOT_DEFINED' as any,
                  associationTypeId: AssociationTypes.lineItemToDeal,
                },
              ],
            },
          ],
        }),
      { label: `HubSpot line item create (${item.name})` }
    );
  }
}
