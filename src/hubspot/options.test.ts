import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeOptionsFetchError } from './options';

test('describeOptionsFetchError gives a plain-English message for a missing-scopes 403', () => {
  const err = { code: 403, body: { category: 'MISSING_SCOPES' } };
  const message = describeOptionsFetchError(err, 'the owner list');
  assert.match(message, /Reconnect HubSpot/);
  assert.match(message, /the owner list/);
});

test('describeOptionsFetchError falls back to the sanitized raw message for other errors', () => {
  const err = new Error('HTTP-Code: 500\nMessage: boom\nHeaders: {"set-cookie":"secret"}');
  const message = describeOptionsFetchError(err, 'pipeline/stage names');
  assert.equal(message, 'HTTP-Code: 500\nMessage: boom');
});

test('describeOptionsFetchError does not treat a non-403 with MISSING_SCOPES-shaped body as a scope error', () => {
  const err = { code: 400, body: { category: 'MISSING_SCOPES' } };
  const message = describeOptionsFetchError(err, 'the owner list');
  assert.doesNotMatch(message, /Reconnect HubSpot/);
});

test('describeOptionsFetchError handles non-Error, non-object input', () => {
  assert.equal(describeOptionsFetchError('plain string failure', 'pipelines'), 'plain string failure');
});
