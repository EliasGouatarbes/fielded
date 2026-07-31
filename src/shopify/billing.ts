import { shopifyGraphqlRequest } from './admin-graphql';
import { config } from '../config';
import { saveBillingSubscription, updateBillingStatus, BillingStatus } from '../db/merchants';

// $29/month, single flat plan, no tiers — this app's whole positioning is a
// narrow target band (too big for competitors' free tiers, too small to
// need enterprise-scale tools), which is naturally a single-plan market.
// Deliberately undercuts the closest real competitor (Unific, ~$99/month)
// since this app doesn't bundle their marketing-automation suite, just a
// correct, reliable sync. A one-line change if the price ever needs to move
// — nothing else in the billing flow depends on the exact number.
export const BILLING_PLAN_NAME = 'Fielded Monthly';
export const BILLING_PRICE_AMOUNT = 29;
export const BILLING_TRIAL_DAYS = 30;

interface ShopBillingPreferencesResponse {
  shopBillingPreferences: { currency: string };
}

const SHOP_BILLING_PREFERENCES_QUERY = `#graphql
  query ShopBillingPreferences {
    shopBillingPreferences {
      currency
    }
  }
`;

interface AppSubscriptionCreateResponse {
  appSubscriptionCreate: {
    appSubscription: { id: string } | null;
    confirmationUrl: string | null;
    userErrors: Array<{ field?: string[]; message: string }>;
  };
}

const APP_SUBSCRIPTION_CREATE_MUTATION = `#graphql
  mutation AppSubscriptionCreate(
    $name: String!
    $returnUrl: URL!
    $trialDays: Int!
    $test: Boolean!
    $amount: Decimal!
    $currencyCode: CurrencyCode!
  ) {
    appSubscriptionCreate(
      name: $name
      returnUrl: $returnUrl
      trialDays: $trialDays
      test: $test
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: $amount, currencyCode: $currencyCode }
              interval: EVERY_30_DAYS
            }
          }
        }
      ]
    ) {
      appSubscription {
        id
      }
      confirmationUrl
      userErrors {
        field
        message
      }
    }
  }
`;

export interface CreatedSubscription {
  subscriptionId: string;
  confirmationUrl: string;
  trialEndsAt: Date;
}

// Discriminated so the caller (src/shopify/oauth.ts's /auth/shopify/billing)
// can skip redirecting into Shopify's confirmation page entirely when
// there's nothing left to confirm — added after Shopify's own AI Toolkit
// review flagged that every hit of that route (including a merchant simply
// reconnecting, not just a fresh install) called appSubscriptionCreate
// unconditionally, with no check for an already-active subscription.
export type CreateSubscriptionResult =
  | ({ status: 'created' } & CreatedSubscription)
  | { status: 'already_active'; subscriptionId: string };

interface ExistingSubscription {
  id: string;
  status: string;
}

// Shared by createSubscription's guard below and refreshBillingStatus.
async function findLiveSubscription(shopDomain: string): Promise<ExistingSubscription | undefined> {
  const data = await shopifyGraphqlRequest<AllSubscriptionsResponse>(
    shopDomain,
    ALL_SUBSCRIPTIONS_QUERY,
    undefined,
    'Shopify existing-subscription lookup'
  );
  return data.currentAppInstallation.allSubscriptions.edges
    .map((edge) => edge.node)
    .find((node) => node.status === 'ACTIVE' || node.status === 'PENDING');
}

interface AppSubscriptionCancelResponse {
  appSubscriptionCancel: {
    appSubscription: { id: string } | null;
    userErrors: Array<{ field?: string[]; message: string }>;
  };
}

const APP_SUBSCRIPTION_CANCEL_MUTATION = `#graphql
  mutation AppSubscriptionCancel($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription { id }
      userErrors { field message }
    }
  }
`;

async function cancelSubscription(shopDomain: string, subscriptionId: string): Promise<void> {
  const result = await shopifyGraphqlRequest<AppSubscriptionCancelResponse>(
    shopDomain,
    APP_SUBSCRIPTION_CANCEL_MUTATION,
    { id: subscriptionId },
    'Shopify app subscription cancel'
  );
  if (result.appSubscriptionCancel.userErrors.length > 0) {
    throw new Error(`Shopify rejected cancellation: ${result.appSubscriptionCancel.userErrors.map((e) => e.message).join('; ')}`);
  }
}

// Kicks off Shopify's own billing flow for a newly-connected Shopify
// merchant — called from the Shopify OAuth callback (src/shopify/oauth.ts)
// *before* HubSpot is ever connected, so nobody reaches full use of the app
// without at least approving a subscription (even a $0-due-today trial
// one). Denominates the charge in the merchant's own local billing currency
// — queried fresh via shopBillingPreferences, a real mechanism the Billing
// API provides, not an approximation — rather than a single fixed currency.
//
// Guards against duplicate subscriptions first: this route is also reached
// by a merchant simply reconnecting (not just a fresh install), which
// previously called appSubscriptionCreate every time with no check for an
// existing one. An already-ACTIVE subscription is reused as-is (nothing to
// re-approve). A still-PENDING one has no recoverable confirmationUrl —
// Shopify only returns that once, at creation — so a merchant who lost that
// tab would otherwise be stuck; it's cancelled and replaced with a fresh one
// rather than left to pile up indefinitely. Best-effort: a failed cancel is
// logged and swallowed rather than blocking the new subscription attempt.
export async function createSubscription(shopDomain: string, returnUrl: string): Promise<CreateSubscriptionResult> {
  const existing = await findLiveSubscription(shopDomain);
  if (existing?.status === 'ACTIVE') {
    await updateBillingStatus(shopDomain, 'ACTIVE');
    return { status: 'already_active', subscriptionId: existing.id };
  }
  if (existing?.status === 'PENDING') {
    try {
      await cancelSubscription(shopDomain, existing.id);
    } catch (err) {
      console.warn(`Could not cancel stale pending subscription ${existing.id} for ${shopDomain} (continuing anyway):`, err);
    }
  }

  const prefs = await shopifyGraphqlRequest<ShopBillingPreferencesResponse>(
    shopDomain,
    SHOP_BILLING_PREFERENCES_QUERY,
    undefined,
    'Shopify billing preferences lookup'
  );

  const result = await shopifyGraphqlRequest<AppSubscriptionCreateResponse>(
    shopDomain,
    APP_SUBSCRIPTION_CREATE_MUTATION,
    {
      name: BILLING_PLAN_NAME,
      returnUrl,
      trialDays: BILLING_TRIAL_DAYS,
      test: config.billing.testMode,
      amount: BILLING_PRICE_AMOUNT,
      currencyCode: prefs.shopBillingPreferences.currency,
    },
    'Shopify app subscription create'
  );

  const { appSubscription, confirmationUrl, userErrors } = result.appSubscriptionCreate;
  if (userErrors.length > 0) {
    throw new Error(`Shopify rejected the subscription: ${userErrors.map((e) => e.message).join('; ')}`);
  }
  if (!appSubscription || !confirmationUrl) {
    throw new Error('Shopify did not return a subscription id or confirmation URL.');
  }

  // Shopify's AppSubscription object has no direct "trial end" field —
  // computed once here, at the moment of creation, rather than re-derived
  // from trialDays + an approval timestamp we'd have to track separately.
  const trialEndsAt = new Date(Date.now() + BILLING_TRIAL_DAYS * 24 * 60 * 60 * 1000);

  await saveBillingSubscription(shopDomain, {
    subscriptionId: appSubscription.id,
    status: 'PENDING',
    trialEndsAt,
  });

  return { status: 'created', subscriptionId: appSubscription.id, confirmationUrl, trialEndsAt };
}

interface AllSubscriptionsResponse {
  currentAppInstallation: {
    allSubscriptions: { edges: Array<{ node: { id: string; status: string } }> };
  };
}

const ALL_SUBSCRIPTIONS_QUERY = `#graphql
  query AllSubscriptions {
    currentAppInstallation {
      allSubscriptions(first: 10) {
        edges {
          node {
            id
            status
          }
        }
      }
    }
  }
`;

const KNOWN_BILLING_STATUSES: BillingStatus[] = ['PENDING', 'ACTIVE', 'CANCELLED', 'DECLINED', 'EXPIRED', 'FROZEN'];

// Called from the billing return-URL callback (src/shopify/oauth.ts) once
// the merchant is redirected back after approving or declining on
// Shopify's own confirmation page. Deliberately re-checks the real status
// via Shopify's API rather than trusting anything in the return URL's own
// query params (nothing there is signed or otherwise verifiable) — fetches
// every one of this shop's subscriptions and finds the one just created by
// id, rather than inferring approval from presence in `activeSubscriptions`
// alone (which wouldn't distinguish "declined" from any other non-active
// status).
export async function refreshBillingStatus(shopDomain: string, subscriptionId: string): Promise<BillingStatus> {
  const data = await shopifyGraphqlRequest<AllSubscriptionsResponse>(
    shopDomain,
    ALL_SUBSCRIPTIONS_QUERY,
    undefined,
    'Shopify subscription status lookup'
  );

  const match = data.currentAppInstallation.allSubscriptions.edges.find((e) => e.node.id === subscriptionId);
  if (!match) {
    throw new Error(`Subscription ${subscriptionId} not found on ${shopDomain} after billing confirmation.`);
  }
  if (!KNOWN_BILLING_STATUSES.includes(match.node.status as BillingStatus)) {
    throw new Error(`Unrecognized Shopify subscription status "${match.node.status}" for ${shopDomain}.`);
  }

  const status = match.node.status as BillingStatus;
  await updateBillingStatus(shopDomain, status);
  return status;
}
