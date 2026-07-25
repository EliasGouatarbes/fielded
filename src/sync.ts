import { upsertContactByEmail } from './hubspot/contacts';
import { upsertDealByName } from './hubspot/deals';
import { logSyncResult } from './db/syncLog';

// Shared between the webhook receiver (src/shopify/webhooks.ts) and the
// historical backfill script (src/scripts/backfill.ts) — both need the exact
// same Shopify-payload-to-HubSpot mapping, whether the payload arrives via
// webhook or via a REST Admin API listing.

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

export interface ShopifyOrder {
  name: string; // e.g. "#1001" — the human-facing order number
  total_price?: string | null;
  customer?: ShopifyCustomer | null;
}

export async function syncCustomer(customer: ShopifyCustomer): Promise<string | undefined> {
  if (!customer.email) return undefined;

  try {
    const hubspotId = await upsertContactByEmail({
      email: customer.email,
      firstname: customer.first_name ?? undefined,
      lastname: customer.last_name ?? undefined,
      phone: customer.phone ?? undefined,
      address: customer.default_address?.address1 ?? undefined,
      city: customer.default_address?.city ?? undefined,
      state: customer.default_address?.province ?? undefined,
      zip: customer.default_address?.zip ?? undefined,
      country: customer.default_address?.country ?? undefined,
    });
    await logSyncResult({ entityType: 'customer', shopifyId: customer.email, hubspotId, status: 'success' });
    return hubspotId;
  } catch (err) {
    await logSyncResult({
      entityType: 'customer',
      shopifyId: customer.email,
      status: 'error',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function syncOrder(order: ShopifyOrder): Promise<void> {
  try {
    const contactId = order.customer ? await syncCustomer(order.customer) : undefined;

    const hubspotId = await upsertDealByName(
      {
        dealname: order.name,
        amount: order.total_price ?? undefined,
      },
      contactId
    );
    await logSyncResult({ entityType: 'order', shopifyId: order.name, hubspotId, status: 'success' });
  } catch (err) {
    await logSyncResult({
      entityType: 'order',
      shopifyId: order.name,
      status: 'error',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
