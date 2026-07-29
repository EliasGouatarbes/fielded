import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCurrencyValidationError } from './deals';

test('isCurrencyValidationError recognizes the real HubSpot currency-not-configured message', () => {
  const err = {
    code: 400,
    body: { message: '"EUR" is not a part of the current effective currency codes for portal 12345' },
  };
  assert.equal(isCurrencyValidationError(err), true);
});

test('isCurrencyValidationError returns false for a non-400 error', () => {
  const err = { code: 409, body: { message: 'effective currency codes' } };
  assert.equal(isCurrencyValidationError(err), false);
});

test('isCurrencyValidationError returns false for an unrelated 400 validation error', () => {
  const err = { code: 400, body: { message: 'Property "amount" must be a number' } };
  assert.equal(isCurrencyValidationError(err), false);
});

test('isCurrencyValidationError returns false for non-object input', () => {
  assert.equal(isCurrencyValidationError(null), false);
  assert.equal(isCurrencyValidationError('error string'), false);
});
