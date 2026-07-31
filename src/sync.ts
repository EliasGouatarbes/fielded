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
  first_name?: string | null;
  last_name?: string | null;
  address1?: string | null;
  city?: string | null;
  province?: string | null;
  zip?: string | null;
  country?: string | null;
}

export interface ShopifyCustomer {
  // Only ever used as a fallback identifier for the sync_log entry when
  // there's no email to key off (12d, functional audit) — everything else
  // in this app still upserts HubSpot contacts by email, unchanged.
  id?: number | string | null;
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
  // ISO 4217 (e.g. "EUR") — matches Shopify's own REST field name (12e,
  // functional audit). `total_price` alone is a bare number; without this,
  // a merchant whose store currency differs from their HubSpot portal's
  // default gets a silently wrong-looking Deal amount.
  currency?: string | null;
  customer?: ShopifyCustomer | null;
  // The name and address typed into checkout's Delivery/Payment steps for
  // *this specific order* — distinct from `customer.first_name`/`last_name`/
  // `default_address`, which is the linked Shopify Customer profile's own
  // stored details and, for a returning email, doesn't change just because
  // a later order's checkout form was filled in differently (Shopify keeps
  // the original profile info). syncOrder below prefers these over the
  // customer profile's details for exactly that reason.
  billing_address?: ShopifyAddress | null;
  shipping_address?: ShopifyAddress | null;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  // Shopify's real Order resource has no boolean `cancelled` field, only
  // this nullable timestamp — evaluateDealRules derives the boolean itself.
  cancelled_at?: string | null;
  line_items?: ShopifyLineItem[] | null;
}

// Prefers the name and address actually entered on this order's checkout
// (billing, then shipping) over the linked Shopify Customer profile's own
// stored details — a repeat email keeps its original Customer profile info
// regardless of what's typed at checkout on a later order, which is
// surprising when that later order's info is what a merchant actually
// expects to see synced (both the name and, e.g., a different shipping
// address for a gift order). Pure/exported so this precedence is
// independently testable without a live order.
export function resolveOrderContact(order: ShopifyOrder): Pick<ShopifyCustomer, 'first_name' | 'last_name' | 'default_address'> {
  const address = [order.billing_address, order.shipping_address].find(
    (candidate) =>
      candidate?.first_name || candidate?.last_name || candidate?.address1 || candidate?.city || candidate?.zip || candidate?.country
  );
  if (!address) {
    return { first_name: order.customer?.first_name, last_name: order.customer?.last_name };
  }
  return {
    first_name: address.first_name ?? order.customer?.first_name,
    last_name: address.last_name ?? order.customer?.last_name,
    default_address: {
      address1: address.address1,
      city: address.city,
      province: address.province,
      zip: address.zip,
      country: address.country,
    },
  };
}

// `lifecycleStage` is only ever passed by syncOrder below — a plain
// customers/create webhook (see webhooks.ts) fires on account creation
// alone, which isn't evidence of a completed purchase. Reviewers of
// HubSpot's own Shopify integration specifically flagged the opposite bug:
// contacts staying "leads" forever even after buying.
// The single choke point for billing enforcement (src/shopify/billing.ts) —
// syncCustomer/syncOrder below are the one place both the live webhook
// receiver (src/shopify/webhooks.ts) *and* the historical backfill
// (src/backfillMerchant.ts) actually funnel through, so checking here
// covers both rather than needing the same check duplicated at every call
// site. Retrying a webhook delivery can't fix a lapsed subscription, only
// the merchant renewing/approving billing can — same "ack success, don't
// error" reasoning as an already-broken HubSpot connection elsewhere in
// this file.
function billingBlocked(merchant: MerchantContext): boolean {
  return merchant.billingStatus !== 'ACTIVE';
}

export async function syncCustomer(
  customer: ShopifyCustomer,
  merchant: MerchantContext,
  lifecycleStage?: string
): Promise<string | undefined> {
  if (billingBlocked(merchant)) {
    await logSyncResult({
      entityType: 'customer',
      shopifyId: customer.email ?? (customer.id != null ? String(customer.id) : 'unknown'),
      status: 'skipped',
      errorMessage: `Billing is not active for this shop (status: ${merchant.billingStatus ?? 'none'}) — sync paused until it is.`,
      shopDomain: merchant.shopDomain,
    });
    return undefined;
  }

  // Previously a silent no-op — a guest checkout, POS sale, or any other
  // email-less customer vanished with zero trace: no HubSpot contact, no
  // sync_log row, nothing (12d, functional audit). Now logged as its own
  // 'skipped' status (neither success nor error — this is expected,
  // legitimate Shopify data, not a failure) so it's at least visible.
  if (!customer.email) {
    await logSyncResult({
      entityType: 'customer',
      shopifyId: customer.id != null ? String(customer.id) : 'unknown',
      status: 'skipped',
      errorMessage: 'No email on this customer — nothing to sync to HubSpot.',
      shopDomain: merchant.shopDomain,
    });
    return undefined;
  }

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
  if (billingBlocked(merchant)) {
    await logSyncResult({
      entityType: 'order',
      shopifyId: order.name,
      status: 'skipped',
      errorMessage: `Billing is not active for this shop (status: ${merchant.billingStatus ?? 'none'}) — sync paused until it is.`,
      shopDomain: merchant.shopDomain,
    });
    return;
  }

  try {
    const contactId = order.customer
      ? await syncCustomer({ ...order.customer, ...resolveOrderContact(order) }, merchant, 'customer')
      : undefined;

    const target = evaluateDealRules(
      merchant.dealRules,
      {
        financial_status: order.financial_status,
        // Shopify's REST/webhook payloads represent "no fulfillment yet" as
        // `null`, not a string — which a `when.fulfillment_status` rule
        // condition (always a string, see hubspot/dealRules.ts) could never
        // match. Normalized to the literal string 'unfulfilled' so the
        // dashboard's rule editor can offer it as a real, working option.
        // Note this only covers the webhook path: the GraphQL backfill path
        // (src/shopify/graphqlMapping.ts) sources this from Shopify's
        // `displayFulfillmentStatus` enum, which is both differently-cased
        // and a wider vocabulary (e.g. IN_PROGRESS, ON_HOLD) than this
        // REST-shaped value — a pre-existing gap (flagged in CLAUDE.md step
        // 11) this fix doesn't close.
        fulfillment_status: order.fulfillment_status ?? 'unfulfilled',
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
        currencyCode: order.currency ?? undefined,
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
