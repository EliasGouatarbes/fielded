import crypto from 'crypto';
import { config } from './config';

// Stateless, signed `state` param shared by both OAuth handshakes
// (src/shopify/oauth.ts, src/hubspot/oauth.ts). Replaces the old single
// in-memory `pendingOAuthState` variable, which broke the moment two
// installs happened concurrently and didn't survive a process restart
// mid-handshake. Signing (not just encoding) the shop domain into the state
// itself means a captured state value can't be replayed to hijack a
// different merchant's connection — the shop is inside the signed payload,
// not a separate trusted query param.
const STATE_TTL_MS = 10 * 60 * 1000;

export function createOAuthState(shop: string): string {
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = `${shop}:${nonce}:${Date.now()}`;
  const signature = crypto.createHmac('sha256', config.oauthStateSecret).update(payload).digest('hex');
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${signature}`;
}

// Returns the shop domain the state was signed for, or throws if the
// signature is invalid or the state has expired.
export function verifyOAuthState(state: string): string {
  const [encodedPayload, signature] = state.split('.');
  if (!encodedPayload || !signature) {
    throw new Error('Malformed OAuth state.');
  }

  const payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  const expected = crypto.createHmac('sha256', config.oauthStateSecret).update(payload).digest('hex');

  const provided = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length || !crypto.timingSafeEqual(provided, expectedBuf)) {
    throw new Error('Invalid OAuth state signature.');
  }

  const [shop, , timestampStr] = payload.split(':');
  const timestamp = Number(timestampStr);
  if (!shop || !timestamp || Date.now() - timestamp > STATE_TTL_MS) {
    throw new Error('OAuth state expired. Restart the flow.');
  }

  return shop;
}
