/**
 * Extracts GitHub repository links from RSS/Atom feed content.
 * Links in feed items can appear anywhere, such as in <link>, <guid>, or description/content,
 * so pattern extraction is applied directly to the text (extracting only the owner/repo segments, rejecting internal GitHub functional paths).
 */

/** GitHub internal non-repository functional areas (these top-level paths are reserved by GitHub and cannot be usernames). */
const NON_REPO_SEGMENTS = new Set([
  'topics', 'trending', 'features', 'marketplace', 'collections', 'explore',
  'sponsors', 'orgs', 'apps', 'search', 'settings', 'notifications', 'login',
  'join', 'pricing', 'security', 'events', 'about', 'contact', 'docs', 'site',
  'new', 'import', 'gist', 'gists', 'labs', 'customer-stories', 'readme',
  'maintainer', 'sponsored', 'enterprise', 'team', 'pricing',
]);

/** The trailing segment cannot end with a period, preventing trailing punctuation like "repo." from being extracted from body sentences. */
const GITHUB_REPO_LINK = /https?:\/\/github\.com\/([A-Za-z0-9_.-]*[A-Za-z0-9_-])\/([A-Za-z0-9_.-]*[A-Za-z0-9_-])/gi;

function isRssLike(text: string): boolean {
  if (/<html[\s>]/i.test(text)) return false;
  return /<(?:rss|feed|channel|item|entry)[\s>]/i.test(text);
}

export function parseDiscoveryRssRepositories(input: string): string[] {
  const text = input.trim();
  if (!text || text.length > 2_000_000 || !isRssLike(text)) {
    throw new Error('The URL did not return a valid RSS or Atom feed');
  }
  const names = new Map<string, string>();
  for (const match of text.matchAll(GITHUB_REPO_LINK)) {
    const owner = match[1];
    const repo = match[2];
    if (NON_REPO_SEGMENTS.has(owner.toLowerCase())) continue;
    const fullName = `${owner}/${repo}`;
    if (!names.has(fullName.toLowerCase())) names.set(fullName.toLowerCase(), fullName);
    // Feed content may mention many repositories; take up to the first 30 in order of appearance (matching the JSON limit)
    if (names.size === 30) break;
  }
  if (names.size === 0) throw new Error('No GitHub repository links were found in the feed');
  return [...names.values()];
}
