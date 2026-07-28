import { upsertContactByEmail } from './hubspot/contacts';
import { upsertDealByName } from './hubspot/deals';
import { evaluateDealRules } from './hubspot/dealRules';
import { MerchantContext } from './hubspot/tokens';
import { logSyncResult } from './db/syncLog';
import { markHubSpotConnectionBroken } from './db/merchants';
import { isAuthError } from './retry';

// Shared between the webhook receiver (src/shopify/webhooks.ts) and the
// historical backfill script (src/scripts/backfill.ts) — both need the exact
// same Shopify-payload-to-HubSpot mapping, whether the payload arrives via
// webhook or via a REST Admin API listing. `merchant` (multi-merchant step)
// carries which HubSpot portal to write into and that merchant's own
// deal-mapping rules — every call site resolves it once per shop, never a
// shared global.

export interface ShopifyAddress {
  address1?: string | null;
  city?: string | null;
  province?: string | null;
  zip?: string | null;
  country?: string | null;
}

export interface ShopifyCustomer {
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  default_address?: ShopifyAddress | null;
}

export interface ShopifyLineItem {
  title: string;
  quantity: number;
  price?: string | null;
  sku?: string | null;
  // Distinguishes product variants (e.g. size/color) sharing the same
  // product title — folded into the HubSpot line item's name below since
  // line items have no separate variant property.
  variant_title?: string | null;
}

export interface ShopifyOrder {
  name: string; // e.g. "#1001" — the human-facing order number
  total_price?: string | null;
  customer?: ShopifyCustomer | null;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  // Shopify's real Order resource has no boolean `cancelled` field, only
  // this nullable timestamp — evaluateDealRules derives the boolean itself.
  cancelled_at?: string | null;
  line_items?: ShopifyLineItem[] | null;
}

// `lifecycleStage` is only ever passed by syncOrder below — a plain
// customers/create webhook (see webhooks.ts) fires on account creation
// alone, which isn't evidence of a completed purchase. Reviewers of
// HubSpot's own Shopify integration specifically flagged the opposite bug:
// contacts staying "leads" forever even after buying.
export async function syncCustomer(
  customer: ShopifyCustomer,
  merchant: MerchantContext,
  lifecycleStage?: string
): Promise<string | undefined> {
  if (!customer.email) return undefined;

  try {
    const hubspotId = await upsertContactByEmail(merchant.hubspotClient, merchant.shopDomain, {
      email: customer.email,
      firstname: customer.first_name ?? undefined,
      lastname: customer.last_name ?? undefined,
      phone: customer.phone ?? undefined,
      address: customer.default_address?.address1 ?? undefined,
      city: customer.default_address?.city ?? undefined,
      state: customer.default_address?.province ?? undefined,
      zip: customer.default_address?.zip ?? undefined,
      country: customer.default_address?.country ?? undefined,
      lifecyclestage: lifecycleStage,
    });
    await logSyncResult({
      entityType: 'customer',
      shopifyId: customer.email,
      hubspotId,
      status: 'success',
      shopDomain: merchant.shopDomain,
    });
    return hubspotId;
  } catch (err) {
    await logSyncResult({
      entityType: 'customer',
      shopifyId: customer.email,
      status: 'error',
      errorMessage: err instanceof Error ? err.message : String(err),
      shopDomain: merchant.shopDomain,
    });
    if (isAuthError(err)) await markHubSpotConnectionBroken(merchant.shopDomain);
    throw err;
  }
}

export async function syncOrder(order: ShopifyOrder, merchant: MerchantContext): Promise<void> {
  try {
    const contactId = order.customer ? await syncCustomer(order.customer, merchant, 'customer') : undefined;

    const target = evaluateDealRules(
      merchant.dealRules,
      {
        financial_status: order.financial_status,
        fulfillment_status: order.fulfillment_status,
        cancelled: Boolean(order.cancelled_at),
      },
      merchant.dealPipeline,
      merchant.dealStage
    );

    const hubspotId = await upsertDealByName(
      merchant.hubspotClient,
      merchant.shopDomain,
      {
        dealname: order.name,
        amount: order.total_price ?? undefined,
        pipeline: target.pipeline,
        stage: target.stage,
        owner: target.owner,
        lineItems: order.line_items?.map((item) => ({
          name: item.variant_title ? `${item.title} - ${item.variant_title}` : item.title,
          quantity: item.quantity,
          price: item.price ?? undefined,
          sku: item.sku ?? undefined,
        })),
      },
      contactId
    );
    await logSyncResult({
      entityType: 'order',
      shopifyId: order.name,
      hubspotId,
      status: 'success',
      shopDomain: merchant.shopDomain,
    });
  } catch (err) {
    await logSyncResult({
      entityType: 'order',
      shopifyId: order.name,
      status: 'error',
      errorMessage: err instanceof Error ? err.message : String(err),
      shopDomain: merchant.shopDomain,
    });
    if (isAuthError(err)) await markHubSpotConnectionBroken(merchant.shopDomain);
    throw err;
  }
}
