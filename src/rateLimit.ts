import rateLimit from 'express-rate-limit';

// Render sits behind its own proxy (with Cloudflare in front of that), so
// `req.ip` reflects the proxy's address, not the real client, unless
// Express is told to trust the X-Forwarded-For header it sets. Community
// reports on the exact hop count disagree (1 vs. 3), and Render's own
// X-Forwarded-For behavior has reportedly changed over time — rather than
// assert a specific number I can't verify from outside Render's
// infrastructure, this trusts only the first hop: the standard, documented
// guidance for "one PaaS proxy in front," and the conservative direction to
// get wrong. Under-trusting just means coarser IP grouping (multiple real
// clients sharing a bucket) — a usability annoyance, not a vulnerability.
// Over-trusting would let a client forge its own X-Forwarded-For to dodge
// the limit entirely, which is the actually dangerous failure mode. Revisit
// by checking real `req.ip` values in production logs if per-client
// granularity ever matters more than it does at this app's current
// single-merchant scale.
export const TRUST_PROXY_HOPS = 1;

// Deliberately generous: this is anti-abuse/DoS mitigation, not a strict
// per-user quota. Legitimate traffic — a merchant's rare OAuth handshake,
// or Shopify's real webhook volume at this app's target scale (tens to a
// few hundred orders/month) — should never realistically approach these.
// A single shared limiter per route group, keyed by IP, is proportionate
// at this app's current single-merchant scale; revisit (e.g. per-shop
// keying for the webhook receiver) if multiple real merchants start
// sharing Shopify's outbound IP ranges in a way that causes cross-merchant
// throttling.

export const oauthRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

export const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
