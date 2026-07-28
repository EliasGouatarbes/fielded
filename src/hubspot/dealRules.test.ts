import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDealRules, validateDealRules, DealRuleValidationError } from './dealRules';

test('evaluateDealRules: first matching rule wins', () => {
  const rules = [
    { when: { cancelled: true }, pipeline: 'p-cancelled', stage: 's-cancelled' },
    { when: { financial_status: 'paid' }, pipeline: 'p-paid', stage: 's-paid' },
  ];
  const target = evaluateDealRules(
    rules,
    { financial_status: 'paid', fulfillment_status: null, cancelled: false },
    'default-p',
    'default-s'
  );
  assert.deepEqual(target, { pipeline: 'p-paid', stage: 's-paid', owner: undefined });
});

test('evaluateDealRules: absent "when" keys act as wildcards', () => {
  const rules = [{ when: {}, pipeline: 'catch-all', stage: 'stage-x' }];
  const target = evaluateDealRules(
    rules,
    { financial_status: 'refunded', fulfillment_status: null, cancelled: true },
    'default-p',
    'default-s'
  );
  assert.deepEqual(target, { pipeline: 'catch-all', stage: 'stage-x', owner: undefined });
});

test('evaluateDealRules: falls back to merchant defaults when nothing matches', () => {
  const rules = [{ when: { financial_status: 'paid' }, pipeline: 'p1', stage: 's1' }];
  const target = evaluateDealRules(
    rules,
    { financial_status: 'pending', fulfillment_status: null, cancelled: false },
    'default-p',
    'default-s'
  );
  assert.deepEqual(target, { pipeline: 'default-p', stage: 'default-s' });
});

test('evaluateDealRules: blank merchant defaults become undefined, not empty strings', () => {
  const target = evaluateDealRules([], { financial_status: null, fulfillment_status: null, cancelled: false }, '', '');
  assert.deepEqual(target, { pipeline: undefined, stage: undefined });
});

test('validateDealRules: accepts a well-formed rule set', () => {
  const rules = validateDealRules([{ when: { financial_status: 'paid' }, pipeline: 'p1', stage: 's1', owner: 'u1' }]);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].pipeline, 'p1');
  assert.equal(rules[0].owner, 'u1');
});

test('validateDealRules: rejects a non-array input', () => {
  assert.throws(() => validateDealRules({ not: 'an array' }), DealRuleValidationError);
});

test('validateDealRules: rejects a rule missing pipeline', () => {
  assert.throws(() => validateDealRules([{ when: {}, stage: 's1' }]), DealRuleValidationError);
});

test('validateDealRules: rejects a non-string when.financial_status', () => {
  assert.throws(
    () => validateDealRules([{ when: { financial_status: 123 }, pipeline: 'p1', stage: 's1' }]),
    DealRuleValidationError
  );
});

test('validateDealRules: rejects a non-boolean when.cancelled', () => {
  assert.throws(
    () => validateDealRules([{ when: { cancelled: 'yes' }, pipeline: 'p1', stage: 's1' }]),
    DealRuleValidationError
  );
});
