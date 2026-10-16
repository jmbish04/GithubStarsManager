import type { Category } from '../../types';
import { defaultCategories } from '../schema';
import { getCategoryNameVariants } from './categoryHelpers';

/**
 * Server-side hard limits for GitHub User Lists. Not documented officially, confirmed by
 * community empirical testing (github.com/dead-claudia/github-limits, orgs/community discussions #8633 / #113251).
 * Pre-validate locally before pushing back to avoid midway server rejection and half-finished state.
 */
export const GITHUB_LISTS_MAX_COUNT = 32;
export const GITHUB_LISTS_NAME_MAX_LENGTH = 32;

/** Remote list summary used for matching during pushback (excluding members) */
export interface RemoteListSummary {
  id: string;
  name: string;
}

/**
 * Pushback plan entry: resolves "which list each category ends up in" as a purely local calculation,
 * and only executes item by item (rename / create) after validation passes, guaranteeing zero writes if hard limits are hit.
 * - persisted: existing remote list referenced by categoryListIdMap
 * - matched: existing remote list matched by canonical name / language variants
 * - create: does not exist remotely, needs to be created
 * targetName is always the category name under the current language (final name written to GitHub).
 */
export type ListsPushPlanEntry =
  | { kind: 'persisted'; categoryId: string; listId: string; remoteName: string; targetName: string }
  | { kind: 'matched'; categoryId: string; listId: string; remoteName: string; targetName: string }
  | { kind: 'create'; categoryId: string; name: string };

/**
 * Builds pushback plan (sends no requests). Matching semantics match existing push flow:
 * prioritize persisted map, then case-insensitive matching on canonical name / language variants, finally create.
 */
export function buildListsPushPlan(
  categories: Category[],
  currentLists: RemoteListSummary[],
  categoryListIdMap: Record<string, string>,
  defaultCategoryOverrides: Record<string, Partial<Category>>
): ListsPushPlanEntry[] {
  const plan: ListsPushPlanEntry[] = [];
  for (const cat of categories) {
    const persistedId = categoryListIdMap[cat.id];
    const existing = persistedId ? currentLists.find(l => l.id === persistedId) : undefined;
    if (persistedId && existing) {
      plan.push({ kind: 'persisted', categoryId: cat.id, listId: persistedId, remoteName: existing.name, targetName: cat.name });
      continue;
    }
    // Canonical name: default categories use their stable Chinese name (unless overridden by user); custom categories use their own name
    const defaultCat = defaultCategories.find(d => d.id === cat.id);
    const canonicalName = defaultCat ? defaultCat.name : cat.name;
    const overrideName = defaultCategoryOverrides[cat.id]?.name;
    const nameVariants = getCategoryNameVariants(canonicalName, overrideName);
    const matchedList = currentLists.find(l =>
      nameVariants.some(v => v.toLowerCase() === l.name.toLowerCase())
    );
    if (matchedList) {
      plan.push({ kind: 'matched', categoryId: cat.id, listId: matchedList.id, remoteName: matchedList.name, targetName: cat.name });
      continue;
    }
    plan.push({ kind: 'create', categoryId: cat.id, name: cat.name });
  }
  return plan;
}

export interface ListsPushPlanIssue {
  /** Category names to be written to GitHub exceeding maximum length (deduplicated) */
  tooLongNames: Array<{ name: string; length: number }>;
  /** Total list count will exceed limit after creation */
  countExceeded: { existing: number; needed: number; available: number } | null;
}

/**
 * Name length is counted by UTF-16 code units (JS string.length, matching GitHub web UI
 * list creation form maxlength). Server-side "character" validation rules are undocumented:
 * UTF-16 <= 32 strictly implies code points <= 32, so it will not be rejected by the server
 * under either "by code point" or "by code unit" definitions; counting by code point could
 * miss errors on supplementary plane characters like emoji.
 */
export const listNameLength = (name: string): number => name.length;

/**
 * Validates whether the pushback plan triggers GitHub Lists hard limits. Only inspects names to be written:
 * creates are always written; renames are only written when different from the remote name; reused identical names are skipped.
 * Returns null if no limits are hit.
 */
export function validateListsPushPlan(plan: ListsPushPlanEntry[], remoteListCount: number): ListsPushPlanIssue | null {
  const tooLongByName = new Map<string, number>();
  for (const entry of plan) {
    if (entry.kind !== 'create' && entry.remoteName === entry.targetName) continue;
    const writtenName = entry.kind === 'create' ? entry.name : entry.targetName;
    const length = listNameLength(writtenName);
    if (length > GITHUB_LISTS_NAME_MAX_LENGTH) {
      tooLongByName.set(writtenName, length);
    }
  }

  const needed = plan.filter(entry => entry.kind === 'create').length;
  const available = Math.max(0, GITHUB_LISTS_MAX_COUNT - remoteListCount);
  const countExceeded = needed > available
    ? { existing: remoteListCount, needed, available }
    : null;

  if (tooLongByName.size === 0 && !countExceeded) return null;
  return {
    tooLongNames: [...tooLongByName].map(([name, length]) => ({ name, length })),
    countExceeded,
  };
}
