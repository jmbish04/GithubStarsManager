import type { Release, ReleaseAsset, Repository } from '../types';
import type { ToolEvidence } from '../types/repositoryChat';
import { detectAssetPlatform } from '../utils/releaseAssets';

/**
 * "Meta info sources" tool layer for repository chat: Release assets and Issue search.
 *
 * Unlike repository files, these sources do not have fixed SHA line numbers. They are represented
 * using "virtual path + line numbers within digest": each Release / Issue generates a Markdown
 * digest with known line structure as a ToolEvidence. The path uses virtual paths like
 * release-v1.2.3.md / issue-1234.md, while url points to the actual GitHub page. The citation
 * format (/path - a-b) and verification ladder are thus completely reused, with the only difference
 * being that the evidence has no refSha.
 *
 * Digests are generated deterministically (without invoking models). This module is shared by
 * both the orchestration loop and the tool loop.
 */

/** Virtual meta target paths in retrieval planning (scope: 'meta'). */
export const META_RELEASES_TARGET = '@meta/releases';
export const META_ISSUES_TARGET = '@meta/issues';
export const META_TARGETS = [META_RELEASES_TARGET, META_ISSUES_TARGET] as const;

export type MetaInfoKind = 'releases' | 'issues';

const MAX_RELEASES = 5;
const MAX_RELEASE_NOTES_CHARS = 4_000;
const MAX_ASSET_LINES = 24;
const MAX_ISSUE_RESULTS = 8;
const MAX_ISSUE_BODY_CHARS = 2_500;
const MAX_ISSUE_COMMENT_CHARS = 1_200;
const MAX_ISSUE_COMMENT_LINES = 8;

const createId = (prefix: string): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

// eslint-disable-next-line no-control-regex -- Control character stripping follows the same rules as aiService.sanitizeForPrompt
const sanitize = (value: string): string => value.replace(/\r\n?/g, '\n').replace(/[\0-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

const truncate = (value: string, maxChars: number): string => {
  const text = sanitize(value);
  return text.length > maxChars ? `${text.slice(0, maxChars)}…[truncated]` : text;
};

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
};

const formatDate = (value: string): string => {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? value : new Date(time).toISOString().slice(0, 10);
};

const contentHash = (content: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const makeMetaEvidence = (repository: Repository, virtualPath: string, url: string, digest: string): ToolEvidence => ({
  id: createId('evidence'),
  source: 'github',
  repoFullName: repository.full_name,
  path: virtualPath,
  lineStart: 1,
  lineEnd: Math.max(1, digest.split('\n').length),
  url,
  contentHash: contentHash(digest),
  excerpt: digest,
  retrievedAt: new Date().toISOString(),
});

const virtualReleasePath = (tag: string): string => `release-${tag.replace(/[^\w.-]+/g, '-')}.md`;
const virtualIssuePath = (number: number): string => `issue-${number}.md`;

/** Digest for a single Release: publication info, release notes, and platform-labeled assets. */
export const buildReleaseDigest = (release: Pick<Release, 'tag_name' | 'name' | 'body' | 'published_at' | 'html_url' | 'prerelease' | 'assets'>): string => {
  const lines = [
    `# Release ${release.tag_name}${release.name && release.name !== release.tag_name ? ` — ${release.name}` : ''}`,
    `Published: ${formatDate(release.published_at)} | Prerelease: ${release.prerelease ? 'yes' : 'no'}`,
    `URL: ${release.html_url}`,
    '',
    '## Release notes',
    '',
  ];
  const notes = truncate(release.body ?? '(no release notes)', MAX_RELEASE_NOTES_CHARS);
  if (notes.trim()) lines.push(notes, '');
  const assets = (release.assets ?? []) as ReleaseAsset[];
  if (assets.length > 0) {
    lines.push(`## Assets (${assets.length})`, '');
    for (const asset of assets.slice(0, MAX_ASSET_LINES)) {
      const platform = detectAssetPlatform(asset.name, asset.content_type);
      lines.push(`- ${asset.name} (${formatBytes(asset.size)})${platform ? ` [platform: ${platform}]` : ''} — ${asset.download_count} downloads`);
    }
    if (assets.length > MAX_ASSET_LINES) lines.push(`- …and ${assets.length - MAX_ASSET_LINES} more assets`);
  } else {
    lines.push('## Assets', '', '(no build assets attached)');
  }
  return lines.join('\n');
};

export interface IssueSearchHit {
  number: number;
  title: string;
  state: 'open' | 'closed';
  html_url: string;
  body: string;
  comments: number;
  updated_at: string;
  labels: string[];
}

export interface IssueComment {
  user: string;
  createdAt: string;
  body: string;
}

/** Digest for a single Issue: status, body, and (optional) comment thread excerpts. */
export const buildIssueDigest = (issue: IssueSearchHit, comments: IssueComment[] = []): string => {
  const lines = [
    `# Issue #${issue.number}: ${issue.title}`,
    `State: ${issue.state} | Comments: ${issue.comments} | Updated: ${formatDate(issue.updated_at)}`,
    `URL: ${issue.html_url}`,
    issue.labels.length > 0 ? `Labels: ${issue.labels.join(', ')}` : '',
    '',
    '## Body',
    '',
    truncate(issue.body || '(no description)', MAX_ISSUE_BODY_CHARS),
  ].filter((line) => line !== '');
  if (comments.length > 0) {
    lines.push('', '## Comments');
    for (const comment of comments.slice(0, MAX_ISSUE_COMMENT_LINES)) {
      lines.push('', `- ${comment.user} (${formatDate(comment.createdAt)}): ${truncate(comment.body, MAX_ISSUE_COMMENT_CHARS)}`);
    }
  }
  return lines.join('\n');
};

/** A batch of Release digest evidences; de-duplicated by normalized virtual path to avoid collisions between different tags. */
export const buildReleasesEvidence = (repository: Repository, releases: Array<Pick<Release, 'tag_name' | 'name' | 'body' | 'published_at' | 'html_url' | 'prerelease' | 'assets'>>): ToolEvidence[] => {
  const seenPaths = new Set<string>();
  return releases.slice(0, MAX_RELEASES).flatMap((release) => {
    const tag = release.tag_name || `unknown-${seenPaths.size + 1}`;
    const virtualPath = virtualReleasePath(tag);
    if (seenPaths.has(virtualPath)) return [];
    seenPaths.add(virtualPath);
    return [makeMetaEvidence(repository, virtualPath, release.html_url, buildReleaseDigest(release))];
  });
};

/** Search hit + optional comment excerpts (commentThreads is distinct from Issue.comments count field). */
export type IssueHitWithComments = IssueSearchHit & { commentThreads?: IssueComment[] };

/** A batch of Issue digest evidences (comments fetched on demand by caller). */
export const buildIssuesEvidence = (repository: Repository, issues: IssueHitWithComments[]): ToolEvidence[] => issues
  .slice(0, MAX_ISSUE_RESULTS)
  .map((issue) => makeMetaEvidence(repository, virtualIssuePath(issue.number), issue.html_url, buildIssueDigest(issue, issue.commentThreads ?? [])));

/** Factual evidence when repository has no Releases (enables citing "no releases published" as a verifiable conclusion). */
export const buildNoReleasesEvidence = (repository: Repository, checkedAt: Date): ToolEvidence => makeMetaEvidence(
  repository,
  'releases-empty.md',
  `https://github.com/${repository.full_name}/releases`,
  [
    `# Releases`,
    `The GitHub API returned no published releases for ${repository.full_name} (checked at ${checkedAt.toISOString()}).`,
  ].join('\n'),
);

/** Factual evidence when Issue search yields no hits. */
export const buildNoIssuesEvidence = (repository: Repository, keywords: string[], checkedAt: Date): ToolEvidence => makeMetaEvidence(
  repository,
  'issues-search-empty.md',
  `https://github.com/${repository.full_name}/issues`,
  [
    '# Issue search',
    `No repository issues matched the search keywords: ${keywords.join(', ') || '(none)'} (checked at ${checkedAt.toISOString()}).`,
  ].join('\n'),
);

/**
 * Deterministic meta intent recognition (safety net): detects "recent updates / build packages / troubleshooting"
 * query intents. The retrieval planner proposing meta targets is the primary path; this signal automatically unlocks
 * when documentation evidence stalls, ensuring all three scenarios are covered even in quick mode (2 turns only).
 */
export const detectMetaIntent = (question: string): MetaInfoKind[] => {
  const normalized = question.toLowerCase();
  const kinds: MetaInfoKind[] = [];
  // Chinese keywords for "recent updates / changelog / what's new"
  if (/(?:\u6700\u8fd1|\u6700\u65b0|\u66f4\u65b0\u4e86|\u66f4\u65b0\u65e5\u5fd7|\u53d8\u66f4|\u65b0\u7248\u672c|\u7248\u672c\u5386\u53f2|what'?s new|changelog|recent(?:ly)?\s+(?:update|release|change)|latest\s+(?:release|update|version)|release\s+notes?)/i.test(normalized)) kinds.push('releases');
  // Chinese keywords for "build packages / installers / platforms / downloads"
  if (/(?:\u6784\u5efa\u5305|\u5b89\u88c5\u5305|\u5b89\u88c5\u6587\u4ef6|\u5b89\u88c5\u4ecb\u8d28|\u54ea\u4e9b\u5e73\u53f0|\u4ec0\u4e48\u5e73\u53f0|\u5e73\u53f0.*(?:\u6784\u5efa|\u5305|\u4e0b\u8f7d)|\u4e0b\u8f7d.*(?:\u5305|\u6587\u4ef6)|binar|artifact|installer|build\s*packages?|prebuilt|download\s+(?:page|link|asset)|which\s+platforms?)/i.test(normalized)) kinds.push('releases');
  // Chinese keywords for "errors / exceptions / crashes / failures / troubleshooting"
  if (/(?:\u62a5\u9519|\u51fa\u9519|\u9519\u8bef|\u5f02\u5e38|\u5d29\u6e83|\u95ea\u9000|\u65e0\u6cd5|\u5931\u8d25|\u9047\u5230.{0,8}\u95ee\u9898|\u7591\u96be|\u5df2\u77e5\u95ee\u9898|bug|crash|broken|error|fail(?:ed|ure)?|not\s+work|issue\s+with|troubleshoot|doesn'?t\s+work)/i.test(normalized)) kinds.push('issues');
  // Both releases regexes may match simultaneously: de-duplicate to avoid occupying multiple meta target slots.
  return Array.from(new Set(kinds));
};

/** meta intent → virtual target path. */
export const metaTargetForKind = (kind: MetaInfoKind): string => (kind === 'releases' ? META_RELEASES_TARGET : META_ISSUES_TARGET);
