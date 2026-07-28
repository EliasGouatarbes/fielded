import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractConflictingId } from './conflict';

test('extractConflictingId parses the winning id out of a 409 message', () => {
  const err = { code: 409, body: { message: 'Contact already exists. Existing ID: 830220497120' } };
  assert.equal(extractConflictingId(err), '830220497120');
});

test('extractConflictingId returns undefined for a non-409 error', () => {
  const err = { code: 400, body: { message: 'Existing ID: 123' } };
  assert.equal(extractConflictingId(err), undefined);
});

test('extractConflictingId returns undefined when the message has no id', () => {
  const err = { code: 409, body: { message: 'Conflict, no id here' } };
  assert.equal(extractConflictingId(err), undefined);
});

test('extractConflictingId returns undefined for non-object input', () => {
  assert.equal(extractConflictingId(null), undefined);
  assert.equal(extractConflictingId('error string'), undefined);
});
