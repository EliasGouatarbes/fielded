// HubSpot's search index lags slightly behind writes: two upserts for the
// same natural key (email, dealname) landing close together — as happens
// for real, e.g. Shopify firing customers/create and orders/create's
// embedded customer sync within milliseconds of each other — can both miss
// each other in search and both attempt create. The loser gets a 409 with
// the winner's id embedded only in the message text, not a structured
// field. Recovering by updating that id is more robust than relying on
// Shopify's webhook retry to eventually outlast the index lag (found via a
// real test order in step 8 — synthetic sequential curl tests never landed
// close enough together to hit this).
export function extractConflictingId(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  if ((err as { code?: unknown }).code !== 409) return undefined;

  const message = (err as { body?: { message?: unknown } }).body?.message;
  if (typeof message !== 'string') return undefined;

  return message.match(/Existing ID:\s*(\d+)/i)?.[1];
}
