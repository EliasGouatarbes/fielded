import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import { encrypt, decrypt, parseEncryptionKey, looksEncrypted } from './crypto';

test('parseEncryptionKey accepts a valid 32-byte base64 key', () => {
  const key = parseEncryptionKey(randomBytes(32).toString('base64'));
  assert.equal(key.length, 32);
});

test('parseEncryptionKey rejects a key of the wrong length', () => {
  assert.throws(() => parseEncryptionKey(randomBytes(16).toString('base64')), /must decode/);
});

test('encrypt/decrypt round-trips arbitrary plaintext', () => {
  const key = randomBytes(32);
  const plaintext = 'shpat_super-secret-token-123';
  const ciphertext = encrypt(plaintext, key);
  assert.notEqual(ciphertext, plaintext);
  assert.equal(decrypt(ciphertext, key), plaintext);
});

test('encrypt produces different ciphertext for the same plaintext (random IV)', () => {
  const key = randomBytes(32);
  assert.notEqual(encrypt('same-plaintext', key), encrypt('same-plaintext', key));
});

test('decrypt rejects a payload tampered with after encryption', () => {
  const key = randomBytes(32);
  const [iv, tag, body] = encrypt('sensitive-value', key).split(':');
  const tamperedBody = Buffer.from(body, 'base64');
  tamperedBody[0] ^= 0xff;
  assert.throws(() => decrypt(`${iv}:${tag}:${tamperedBody.toString('base64')}`, key));
});

test('decrypt rejects the wrong key', () => {
  const ciphertext = encrypt('sensitive-value', randomBytes(32));
  assert.throws(() => decrypt(ciphertext, randomBytes(32)));
});

test('decrypt rejects a malformed payload', () => {
  assert.throws(() => decrypt('not-a-valid-payload', randomBytes(32)), /Malformed/);
});

test('looksEncrypted recognizes the iv:authTag:ciphertext shape', () => {
  assert.equal(looksEncrypted(encrypt('x', randomBytes(32))), true);
  assert.equal(looksEncrypted('shpat_plaintext_token'), false);
});
