/**
 * Batch Repository Intake — Candidate models for batch import.
 *
 * Processing flow (roadmap §6 / Development Guidelines §6):
 * ```
 * Paste → Extract → Normalize → Deduplicate → Resolve GitHub metadata
 *       → Enrich with local/Core data → Review → Batch actions
 * ```
 * This file describes the output of the first four steps: a candidate normalized to `owner/repo`,
 * deduplicated, but not yet verified over the network.
 * "Resolve GitHub metadata" (exists, private, renamed/transferred, rate-limited) and
 * "Enrich with local/Core data" (already starred, already in My Apps) are populated by subsequent stages;
 * therefore, the domains of `status` and `reason` are fully defined here upfront to avoid model churn later.
 */
/** Candidate source. Version 1 only implements `text` and `json`; `clipboard` / `file` are reserved for future reuse of the same model. */
export type ImportSource = 'text' | 'json' | 'clipboard' | 'file';

/**
 * Candidate status.
 * - `pending`: Successfully normalized, not yet verified over the network (normal result of the Extract/Deduplicate stage).
 * - `resolved`: Successfully resolved GitHub metadata (populated in Resolve stage).
 * - `duplicate`: Duplicate occurrence of the same repository (or same invalid snippet) within the current input.
 * - `invalid`: Resembles a GitHub repository but cannot be normalized (reserved path, malformed format, etc.), determined in this stage.
 * - `unavailable`: Normalized but resolution failed (not found / private / renamed / rate-limited, etc.), populated in Resolve stage.
 */
export type ImportCandidateStatus =
  | 'pending'
  | 'resolved'
  | 'duplicate'
  | 'invalid'
  | 'unavailable';

/** How the candidate was matched, used by the preview UI to differentiate confidence. */
export type ImportCandidateMatchedBy = 'github-url' | 'bare-slug';

/**
 * Recognition confidence.
 * - `high`: Originates from a URL explicitly containing `github.com` (including release/issue/tree/blob subpaths).
 * - `low`: Originates from a bare `owner/repo` snippet in prose. Bare pairs in text are naturally ambiguous
 *   (`src/utils`, `and/or`, `TCP/IP`, etc.), so they are demoted for user confirmation in preview.
 */
export type ImportCandidateConfidence = 'high' | 'low';

/**
 * Failure reason.
 *
 * Values annotated with their respective stage are emitted by that stage; this stage emits only `not-a-repository-url` / `malformed-slug`:
 * - Extract stage: `not-a-repository-url`, `malformed-slug`
 * - Resolve stage: `not-found`, `private-or-inaccessible`, `renamed`, `rate-limited`
 * - Enrich stage: `already-exists`
 */
export type ImportFailureReason =
  | 'not-a-repository-url'
  | 'malformed-slug'
  | 'not-found'
  | 'private-or-inaccessible'
  | 'renamed'
  | 'rate-limited'
  | 'already-exists';

/**
 * An import candidate.
 *
 * `originalValue` always retains the raw snippet — every step in batch import must be traceable
 * so users can see which text segment produced this candidate.
 */
export interface ImportedRepositoryCandidate {
  /** Normalized `owner/repo`; empty string when `invalid`. */
  repositoryFullName: string;
  source: ImportSource;
  /** Raw, unmodified snippet in the input that triggered this candidate. */
  originalValue: string;
  status: ImportCandidateStatus;
  /** Whether already starred locally (populated in Enrich stage; also filled here if caller supplies a local set). */
  alreadyStarred?: boolean;
  /** Present for `invalid` / `unavailable`, or when Enrich stage identifies an existing repository. */
  reason?: ImportFailureReason;
  /** Matched source; supplementary field (outside guideline model) used in preview UI to distinguish URLs from bare slugs. */
  matchedBy?: ImportCandidateMatchedBy;
  /** Recognition confidence; supplementary field (outside guideline model). */
  confidence?: ImportCandidateConfidence;
  /**
   * Original `owner/repo` when the Resolve stage discovers a renamed or transferred repository.
   * Guidelines require displaying `old-owner/repo → new-owner/repo` WITHOUT silent changes,
   * so the old name is preserved here until confirmed by the user.
   */
  previousFullName?: string;
}

/** Input-level issues (independent of individual candidates). */
export interface RepositoryImportInputError {
  /**
   * `json-parse-failed` and `input-too-large` are fatal: `candidates` is empty.
   * `too-many-values` and `depth-limit-exceeded` indicate truncation: `candidates` still contains results scanned so far.
   */
  code: 'json-parse-failed' | 'input-too-large' | 'too-many-values' | 'depth-limit-exceeded';
  message: string;
}

/** Result of Extract + Normalize + Deduplicate. */
export interface RepositoryImportExtractionResult {
  /** Candidates ordered by first occurrence (including `invalid` and `duplicate`). */
  candidates: ImportedRepositoryCandidate[];
  /** List of issues when input is wholly invalid or truncated; for fatal errors (see {@link RepositoryImportInputError}), `candidates` is empty. */
  inputErrors: RepositoryImportInputError[];
  stats: {
    /** Total number of strings actually scanned (sum of string values across all levels in JSON recursion). */
    scanned: number;
    /** Number of successfully normalized candidates (excluding duplicates / invalid). */
    valid: number;
    duplicates: number;
    invalid: number;
  };
}

/** Extraction options. */
export interface RepositoryImportExtractionOptions {
  /** Input type; `json` parses JSON first before recursively scanning string values. Default `text`. */
  source?: ImportSource;
  /**
   * Set of lowercased `owner/repo` strings for existing local repositories; used to populate `alreadyStarred`.
   * Pure function input with no I/O.
   */
  localRepositoryFullNames?: ReadonlySet<string>;
  /** Maximum input length (JavaScript string length); exceeds trigger `input-too-large` and aborts scanning. Default 524288. */
  maxInputLength?: number;
  /** Maximum number of string values processed during JSON recursion to guard against pathological inputs. Default 20000. */
  maxValues?: number;
  /** JSON recursion maximum depth. Default 32. */
  maxDepth?: number;
}
