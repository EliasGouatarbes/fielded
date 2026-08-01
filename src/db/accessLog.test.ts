import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAdminAccessAnomalous } from './accessLog';

test('isAdminAccessAnomalous is false at and below the threshold', () => {
  assert.equal(isAdminAccessAnomalous(0), false);
  assert.equal(isAdminAccessAnomalous(30), false);
});

test('isAdminAccessAnomalous is true above the threshold', () => {
  assert.equal(isAdminAccessAnomalous(31), true);
  assert.equal(isAdminAccessAnomalous(1000), true);
});
