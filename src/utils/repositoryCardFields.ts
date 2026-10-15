import type { RepositoryCardFieldId, RepositoryCardFields } from '../types/repositoryCardFields';
import {
  DEFAULT_REPOSITORY_CARD_FIELDS,
  REPOSITORY_CARD_FIELD_IDS,
} from '../types/repositoryCardFields';

/**
 * Normalizes user preferences into a complete field visibility map.
 *
 * Missing or non-boolean values fall back to defaults (visible). This ensures older snapshots,
 * manually edited localStorage entries, and future new fields follow the same path without
 * requiring dedicated migration logic for each field.
 */
export const normalizeRepositoryCardFields = (value: unknown): RepositoryCardFields => {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const normalized = { ...DEFAULT_REPOSITORY_CARD_FIELDS };
  for (const id of REPOSITORY_CARD_FIELD_IDS) {
    if (typeof record[id] === 'boolean') normalized[id] = record[id] as boolean;
  }
  return normalized;
};

/** Checks whether an individual field is visible; defaults to the preset map if omitted. */
export const isRepositoryCardFieldVisible = (
  fields: RepositoryCardFields | undefined,
  id: RepositoryCardFieldId,
): boolean => (fields ? fields[id] !== false : DEFAULT_REPOSITORY_CARD_FIELDS[id]);
