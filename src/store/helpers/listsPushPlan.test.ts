import { describe, expect, it } from 'vitest';
import type { Category } from '../../types';
import {
  buildListsPushPlan,
  validateListsPushPlan,
  listNameLength,
  GITHUB_LISTS_MAX_COUNT,
  GITHUB_LISTS_NAME_MAX_LENGTH,
  type ListsPushPlanEntry,
} from './listsPushPlan';

const makeCategory = (overrides: Partial<Category> = {}): Category => ({
  id: 'web',
  name: 'Web应用',
  icon: '🌐',
  keywords: [],
  ...overrides,
});

describe('listNameLength', () => {
  it('counts BMP characters such as Chinese as 1', () => {
    expect(listNameLength('AI/机器学习')).toBe(7);
  });

  it('counts supplementary plane characters such as emoji as 2 UTF-16 code units (conservative approach, ensuring neither server definition is exceeded)', () => {
    expect(listNameLength('🚀🚀')).toBe(4);
  });
});

describe('buildListsPushPlan', () => {
  const overrides = {};

  it('marks as persisted when persistedId matches a remote list', () => {
    const plan = buildListsPushPlan(
      [makeCategory()],
      [{ id: 'L_web', name: 'Web应用' }],
      { web: 'L_web' },
      overrides
    );
    expect(plan).toEqual([
      { kind: 'persisted', categoryId: 'web', listId: 'L_web', remoteName: 'Web应用', targetName: 'Web应用' },
    ]);
  });

  it('marks as matched when there is no mapping but name variants match across languages', () => {
    const plan = buildListsPushPlan(
      [makeCategory({ name: 'Web Apps' })],
      [{ id: 'L_legacy', name: 'Web应用' }],
      {},
      overrides
    );
    expect(plan).toEqual([
      { kind: 'matched', categoryId: 'web', listId: 'L_legacy', remoteName: 'Web应用', targetName: 'Web Apps' },
    ]);
  });

  it('marks as create when the remote list does not exist (using current language category name)', () => {
    const plan = buildListsPushPlan(
      [makeCategory({ name: 'Web Apps' })],
      [],
      {},
      overrides
    );
    expect(plan).toEqual([
      { kind: 'create', categoryId: 'web', name: 'Web Apps' },
    ]);
  });

  it('falls back to name match or create when the remote list pointed by persistedId no longer exists', () => {
    const plan = buildListsPushPlan(
      [makeCategory()],
      [{ id: 'L_other', name: '别的' }],
      { web: 'L_gone' },
      overrides
    );
    expect(plan[0].kind).toBe('create');
  });
});

describe('validateListsPushPlan', () => {
  it('returns null when limits are not triggered', () => {
    const plan: ListsPushPlanEntry[] = [
      { kind: 'create', categoryId: 'web', name: 'Web应用' },
    ];
    expect(validateListsPushPlan(plan, 10)).toBeNull();
  });

  it('reports name issue when new name exceeds 32 characters (deduplicated by name)', () => {
    const longName = 'a'.repeat(GITHUB_LISTS_NAME_MAX_LENGTH + 1);
    const plan: ListsPushPlanEntry[] = [
      { kind: 'create', categoryId: 'a', name: longName },
      { kind: 'create', categoryId: 'b', name: longName },
    ];
    const issue = validateListsPushPlan(plan, 0)!;
    expect(issue.tooLongNames).toEqual([{ name: longName, length: GITHUB_LISTS_NAME_MAX_LENGTH + 1 }]);
  });

  it('skips length check for reused items with matching names (no write performed)', () => {
    const longName = 'a'.repeat(GITHUB_LISTS_NAME_MAX_LENGTH + 1);
    const plan: ListsPushPlanEntry[] = [
      { kind: 'persisted', categoryId: 'a', listId: 'L_a', remoteName: longName, targetName: longName },
    ];
    expect(validateListsPushPlan(plan, 1)).toBeNull();
  });

  it('checks length against target name for reused items needing rename', () => {
    const longName = 'a'.repeat(GITHUB_LISTS_NAME_MAX_LENGTH + 1);
    const plan: ListsPushPlanEntry[] = [
      { kind: 'matched', categoryId: 'a', listId: 'L_a', remoteName: 'old', targetName: longName },
    ];
    const issue = validateListsPushPlan(plan, 1)!;
    expect(issue.tooLongNames).toHaveLength(1);
  });

  it('reports count issue when number of creations exceeds remaining quota', () => {
    const plan: ListsPushPlanEntry[] = [
      { kind: 'create', categoryId: 'a', name: 'A' },
      { kind: 'create', categoryId: 'b', name: 'B' },
    ];
    const issue = validateListsPushPlan(plan, GITHUB_LISTS_MAX_COUNT - 1)!;
    expect(issue.countExceeded).toEqual({ existing: GITHUB_LISTS_MAX_COUNT - 1, needed: 2, available: 1 });
  });

  it('does not consume creation quota for reused and renamed items', () => {
    const plan: ListsPushPlanEntry[] = [
      { kind: 'persisted', categoryId: 'a', listId: 'L_a', remoteName: 'A', targetName: 'A' },
      { kind: 'matched', categoryId: 'b', listId: 'L_b', remoteName: '旧名', targetName: 'B' },
    ];
    expect(validateListsPushPlan(plan, GITHUB_LISTS_MAX_COUNT)).toBeNull();
  });

  it('reports both name and count issues simultaneously', () => {
    const longName = 'a'.repeat(GITHUB_LISTS_NAME_MAX_LENGTH + 1);
    const plan: ListsPushPlanEntry[] = [
      { kind: 'create', categoryId: 'a', name: longName },
    ];
    const issue = validateListsPushPlan(plan, GITHUB_LISTS_MAX_COUNT)!;
    expect(issue.tooLongNames).toHaveLength(1);
    expect(issue.countExceeded).not.toBeNull();
  });
});
