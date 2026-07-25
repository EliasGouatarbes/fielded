// Per-merchant mapping from Shopify order conditions to a HubSpot deal
// pipeline/stage/owner (CLAUDE.md multi-merchant step) — replaces the old
// single global HUBSPOT_DEAL_PIPELINE/HUBSPOT_DEAL_STAGE pair that applied
// to every merchant's every order unconditionally. Rules are stored as
// merchants.deal_rules (JSONB) and edited via PUT /merchants/:shop/deal-rules.

export interface DealRuleCondition {
  financial_status?: string;
  fulfillment_status?: string;
  cancelled?: boolean;
}

export interface DealRule {
  when: DealRuleCondition;
  pipeline: string;
  stage: string;
  owner?: string;
}

export interface OrderConditions {
  financial_status?: string | null;
  fulfillment_status?: string | null;
  cancelled: boolean;
}

export interface DealTarget {
  pipeline?: string;
  stage?: string;
  owner?: string;
}

// First rule whose every present `when` key matches the order wins — absent
// keys are wildcards. No match falls back to the merchant's own default
// pipeline/stage (no default owner: there's no per-merchant "default owner"
// concept in scope, only per-rule).
export function evaluateDealRules(
  rules: DealRule[],
  order: OrderConditions,
  defaultPipeline: string,
  defaultStage: string
): DealTarget {
  for (const rule of rules) {
    const { when } = rule;
    if (when.financial_status !== undefined && when.financial_status !== order.financial_status) continue;
    if (when.fulfillment_status !== undefined && when.fulfillment_status !== order.fulfillment_status) continue;
    if (when.cancelled !== undefined && when.cancelled !== order.cancelled) continue;

    return { pipeline: rule.pipeline, stage: rule.stage, owner: rule.owner };
  }

  return {
    pipeline: defaultPipeline || undefined,
    stage: defaultStage || undefined,
  };
}

class DealRuleValidationError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateCondition(value: unknown, index: number): DealRuleCondition {
  if (!isPlainObject(value)) {
    throw new DealRuleValidationError(`Rule ${index}: "when" must be an object.`);
  }

  const condition: DealRuleCondition = {};
  for (const key of ['financial_status', 'fulfillment_status'] as const) {
    if (key in value) {
      if (typeof value[key] !== 'string') {
        throw new DealRuleValidationError(`Rule ${index}: "when.${key}" must be a string.`);
      }
      condition[key] = value[key] as string;
    }
  }
  if ('cancelled' in value) {
    if (typeof value.cancelled !== 'boolean') {
      throw new DealRuleValidationError(`Rule ${index}: "when.cancelled" must be a boolean.`);
    }
    condition.cancelled = value.cancelled;
  }
  return condition;
}

// Sole editing surface for deal-mapping rules — a bad write here silently
// breaks every future deal sync for the merchant until caught, so reject
// anything malformed before it's persisted.
export function validateDealRules(input: unknown): DealRule[] {
  if (!Array.isArray(input)) {
    throw new DealRuleValidationError('Rules must be an array.');
  }

  return input.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new DealRuleValidationError(`Rule ${index}: must be an object.`);
    }
    if (typeof entry.pipeline !== 'string' || !entry.pipeline) {
      throw new DealRuleValidationError(`Rule ${index}: "pipeline" is required and must be a non-empty string.`);
    }
    if (typeof entry.stage !== 'string' || !entry.stage) {
      throw new DealRuleValidationError(`Rule ${index}: "stage" is required and must be a non-empty string.`);
    }
    if ('owner' in entry && typeof entry.owner !== 'string') {
      throw new DealRuleValidationError(`Rule ${index}: "owner" must be a string.`);
    }

    return {
      when: validateCondition(entry.when, index),
      pipeline: entry.pipeline,
      stage: entry.stage,
      owner: entry.owner as string | undefined,
    };
  });
}

export { DealRuleValidationError };
