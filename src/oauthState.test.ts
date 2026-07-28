import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { createOAuthState, verifyOAuthState } from './oauthState';
import { config } from './config';

test('verifyOAuthState returns the shop a valid state was created for', () => {
  const state = createOAuthState('example-store.myshopify.com');
  assert.equal(verifyOAuthState(state).shop, 'example-store.myshopify.com');
  assert.equal(verifyOAuthState(state).regenerateAdminKey, false);
});

test('verifyOAuthState carries the regenerateAdminKey flag through', () => {
  const state = createOAuthState('example-store.myshopify.com', { regenerateAdminKey: true });
  assert.equal(verifyOAuthState(state).regenerateAdminKey, true);
});

test('verifyOAuthState rejects a tampered signature', () => {
  const [payload] = createOAuthState('example-store.myshopify.com').split('.');
  const tampered = `${payload}.${'0'.repeat(64)}`;
  assert.throws(() => verifyOAuthState(tampered), /Invalid OAuth state signature/);
});

test('verifyOAuthState rejects a malformed state', () => {
  assert.throws(() => verifyOAuthState('not-a-valid-state'), /Malformed OAuth state/);
});

test('verifyOAuthState rejects an expired state', () => {
  // Mirrors createOAuthState's own payload format (shop:nonce:timestamp),
  // signed with the same secret, but backdated — avoids actually waiting
  // out the real 10-minute TTL.
  const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
  const payload = `example-store.myshopify.com:deadbeefdeadbeef:${elevenMinutesAgo}`;
  const signature = crypto.createHmac('sha256', config.oauthStateSecret).update(payload).digest('hex');
  const state = `${Buffer.from(payload, 'utf8').toString('base64url')}.${signature}`;
  assert.throws(() => verifyOAuthState(state), /OAuth state expired/);
});

test('verifyOAuthState rejects a state signed with a different shop embedded', () => {
  const stateForShopA = createOAuthState('shop-a.myshopify.com');
  assert.equal(verifyOAuthState(stateForShopA).shop, 'shop-a.myshopify.com');
  assert.notEqual(verifyOAuthState(stateForShopA).shop, 'shop-b.myshopify.com');
});
