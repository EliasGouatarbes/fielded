import { Client as HubSpotClient } from '@hubspot/api-client';
import { withRetry } from '../retry';
import { sanitizeErrorMessage } from '../errorSanitize';

// Powers the dashboard's deal-rules editor (src/dashboardPage.ts): real
// dropdowns for pipeline/stage/owner instead of asking a merchant to type
// HubSpot's raw internal ids from memory. Thin, read-only wrappers around
// the SDK, same category as the rest of src/hubspot/ — not unit-tested,
// live-verified instead (see CLAUDE.md's established precedent for this).

export interface PipelineStageOption {
  id: string;
  label: string;
}

export interface PipelineOption {
  id: string;
  label: string;
  stages: PipelineStageOption[];
}

export interface OwnerOption {
  id: string;
  label: string;
}

// Archived pipelines/stages still exist (so old deals referencing them
// don't break) but shouldn't be offered for *new* rules.
export async function fetchDealPipelineOptions(client: HubSpotClient): Promise<PipelineOption[]> {
  const result = await withRetry(() => client.crm.pipelines.pipelinesApi.getAll('deals'), {
    label: 'HubSpot deal pipelines list',
  });

  return result.results
    .filter((pipeline) => !pipeline.archived)
    .map((pipeline) => ({
      id: pipeline.id,
      label: pipeline.label,
      stages: pipeline.stages
        .filter((stage) => !stage.archived)
        .sort((a, b) => a.displayOrder - b.displayOrder)
        .map((stage) => ({ id: stage.id, label: stage.label })),
    }));
}

const OWNERS_PAGE_LIMIT = 100;
// A single-operator/small-merchant app has no realistic need for more than
// a handful of pages of portal users — this bounds a pathological loop
// (e.g. a paging cursor that never terminates) rather than reflecting any
// real expected owner count.
const OWNERS_MAX_PAGES = 20;

export async function fetchOwnerOptions(client: HubSpotClient): Promise<OwnerOption[]> {
  const owners: OwnerOption[] = [];
  let after: string | undefined;
  let pages = 0;

  do {
    const page = await withRetry(
      () => client.crm.owners.ownersApi.getPage(undefined, after, OWNERS_PAGE_LIMIT, false),
      { label: 'HubSpot owners list' }
    );

    for (const owner of page.results) {
      const name = [owner.firstName, owner.lastName].filter(Boolean).join(' ').trim();
      owners.push({ id: owner.id, label: name ? `${name} (${owner.email})` : owner.email ?? owner.id });
    }

    after = page.paging?.next?.after;
    pages += 1;
  } while (after && pages < OWNERS_MAX_PAGES);

  return owners.sort((a, b) => a.label.localeCompare(b.label));
}

// The dashboard shows this error text directly to a merchant (in a banner,
// not a log) — a raw HubSpot ApiException's `.message` is a technical
// dump ("HTTP-Code: 403 Message: ... Body: {\"status\":\"error\"...}",
// confirmed live against the real dev store before its owners scope was
// granted), exactly the kind of unclear text this editor was rebuilt to
// get away from. Missing-scope 403s are the one failure mode expected to
// actually happen in practice (an already-connected merchant hasn't
// reconnected since a new scope was added) and get a plain-English
// explanation with a fix; anything else falls back to the same
// header-stripped, length-capped text already used for sync_log (14d).
function isMissingScopesError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  const category = (err as { body?: { category?: unknown } }).body?.category;
  return code === 403 && category === 'MISSING_SCOPES';
}

export function describeOptionsFetchError(err: unknown, whatFailed: string): string {
  if (isMissingScopesError(err)) {
    return `Reconnect HubSpot to enable ${whatFailed} — this app's permissions were updated since you last connected.`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return sanitizeErrorMessage(message);
}
