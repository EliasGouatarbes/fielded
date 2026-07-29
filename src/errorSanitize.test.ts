import { test } from 'node:test';
import assert from 'node:assert';
import { sanitizeErrorMessage } from './errorSanitize';

test('sanitizeErrorMessage leaves a plain message unchanged', () => {
  assert.equal(sanitizeErrorMessage('No HubSpot connection for shop.myshopify.com.'), 'No HubSpot connection for shop.myshopify.com.');
});

test('sanitizeErrorMessage strips the HubSpot SDK Headers dump', () => {
  const raw =
    'HTTP-Code: 400\nMessage: An error occurred.\nBody: {"status":"error"}\n' +
    'Headers: {"set-cookie":"__cf_bm=secret; HttpOnly","x-hubspot-ratelimit-remaining":"85"}';
  const result = sanitizeErrorMessage(raw);
  assert.equal(result, 'HTTP-Code: 400\nMessage: An error occurred.\nBody: {"status":"error"}');
  assert.ok(!result.includes('set-cookie'));
});

test('sanitizeErrorMessage truncates very long messages', () => {
  const long = 'x'.repeat(3000);
  const result = sanitizeErrorMessage(long);
  assert.ok(result.length < 2100);
  assert.ok(result.endsWith('… (truncated)'));
});
