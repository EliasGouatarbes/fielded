import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTokenExchangeFailure, HubSpotRefreshTokenRevokedError } from './tokens';

test('classifyTokenExchangeFailure recognizes a BAD_REFRESH_TOKEN status', () => {
  const body = JSON.stringify({
    status: 'BAD_REFRESH_TOKEN',
    error: 'invalid_grant',
    message: 'refresh token is invalid, expired or revoked',
  });
  const err = classifyTokenExchangeFailure(400, body);
  assert.ok(err instanceof HubSpotRefreshTokenRevokedError);
});

test('classifyTokenExchangeFailure recognizes a bare invalid_grant error', () => {
  const body = JSON.stringify({ error: 'invalid_grant' });
  const err = classifyTokenExchangeFailure(400, body);
  assert.ok(err instanceof HubSpotRefreshTokenRevokedError);
});

test('classifyTokenExchangeFailure treats other 400s as a plain (non-revoked) Error', () => {
  const body = JSON.stringify({ status: 'BAD_CLIENT_SECRET', error: 'invalid_client' });
  const err = classifyTokenExchangeFailure(400, body);
  assert.ok(err instanceof Error);
  assert.ok(!(err instanceof HubSpotRefreshTokenRevokedError));
});

test('classifyTokenExchangeFailure handles a non-JSON body without throwing', () => {
  const err = classifyTokenExchangeFailure(502, 'Bad Gateway');
  assert.ok(err instanceof Error);
  assert.ok(!(err instanceof HubSpotRefreshTokenRevokedError));
});
