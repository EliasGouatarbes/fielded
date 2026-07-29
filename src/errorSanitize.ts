const MAX_ERROR_MESSAGE_LENGTH = 2000;

// HubSpot's SDK stringifies its ApiException's `.message` to include a raw
// dump of the HTTP response — including headers like rate-limit counters,
// correlation ids, and even a third-party Set-Cookie value (confirmed live
// during the pre-launch audit, 2026-07-29). That full string is what
// `logSyncResult` stores in sync_log and what /sync-status returns to any
// per-merchant key holder — more than a merchant needs to see. Strips the
// headers section; caps length as a general safety net against any other
// verbose error shape reaching a stored log row.
export function sanitizeErrorMessage(message: string): string {
  const withoutHeaders = message.split(/\r?\n\s*Headers:/)[0];
  return withoutHeaders.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${withoutHeaders.slice(0, MAX_ERROR_MESSAGE_LENGTH)}… (truncated)`
    : withoutHeaders;
}
