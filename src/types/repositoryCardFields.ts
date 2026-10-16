/**
 * Repository card visible fields (Development Guidelines §14).
 *
 * Stores only the declarative data specifying which fields to display; when rendering
 * the card, this determines whether corresponding elements are rendered, without
 * involving any injection of HTML / JS / React components.
 */

export type RepositoryCardFieldId =
  | 'description'
  | 'tags'
  | 'language'
  | 'stars'
  | 'license'
  | 'lastUpdated';

export const REPOSITORY_CARD_FIELD_IDS: readonly RepositoryCardFieldId[] = [
  'description',
  'tags',
  'language',
  'stars',
  'license',
  'lastUpdated',
];

export type RepositoryCardFields = Record<RepositoryCardFieldId, boolean>;

/** Enabled by default: upgraded users should see no changes to existing display. */
export const DEFAULT_REPOSITORY_CARD_FIELDS: RepositoryCardFields = {
  description: true,
  tags: true,
  language: true,
  stars: true,
  license: true,
  lastUpdated: true,
};
