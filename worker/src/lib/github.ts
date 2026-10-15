/**
 * GitHub through Octokit, authenticated with the GH_TOKEN Secret Store binding.
 */
import { Octokit } from "@octokit/rest";

import { requireSecret } from "./secrets";

export type GitHubRepo = {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string; avatar_url?: string } | null;
  description: string | null;
  html_url: string;
  homepage?: string | null;
  language: string | null;
  topics?: string[];
  license?: { spdx_id?: string | null } | null;
  stargazers_count: number;
  forks_count: number;
  archived?: boolean;
  created_at?: string | null;
  pushed_at?: string | null;
};

export async function octokit(env: Env): Promise<Octokit> {
  return new Octokit({ auth: await requireSecret(env, "GH_TOKEN"), userAgent: "github-stars-manager-worker" });
}

/** Search repositories, highest stars first. GitHub caps search at 1,000 results and 30 req/min. */
export async function searchRepos(gh: Octokit, query: string, limit = 30): Promise<GitHubRepo[]> {
  const perPage = Math.min(Math.max(limit, 1), 100);
  const { data } = await gh.rest.search.repos({ q: query, sort: "stars", order: "desc", per_page: perPage });
  return data.items.slice(0, limit) as unknown as GitHubRepo[];
}

/**
 * Every repository the authenticated user has starred, with `starred_at`.
 * `complete` is false when the page cap stopped the walk: the list is then a
 * prefix, and absence from it says nothing about whether a repo is starred.
 */
export async function listStarred(gh: Octokit, maxPages = 100): Promise<{ rows: Array<{ starred_at: string; repo: GitHubRepo }>; complete: boolean }> {
  const out: Array<{ starred_at: string; repo: GitHubRepo }> = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await gh.request("GET /user/starred", {
      per_page: 100,
      page,
      headers: { accept: "application/vnd.github.star+json" },
    });
    const rows = data as unknown as Array<{ starred_at: string; repo: GitHubRepo }>;
    out.push(...rows);
    if (rows.length < 100) return { rows: out, complete: true };
  }
  return { rows: out, complete: false };
}

export async function getRepo(gh: Octokit, fullName: string): Promise<GitHubRepo> {
  const [owner, repo] = splitFullName(fullName);
  const { data } = await gh.rest.repos.get({ owner, repo });
  return data as unknown as GitHubRepo;
}

/** README as plain text, truncated to `maxChars`; null when the repo has none. */
export async function getReadme(gh: Octokit, fullName: string, maxChars = 6000): Promise<string | null> {
  const [owner, repo] = splitFullName(fullName);
  try {
    const { data } = await gh.rest.repos.getReadme({ owner, repo, mediaType: { format: "raw" } });
    const text = typeof data === "string" ? data : String(data);
    return text.slice(0, maxChars);
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

/** Top-level file and folder names: a cheap map of what a repository contains. */
export async function getTopLevelTree(gh: Octokit, fullName: string): Promise<string[]> {
  const [owner, repo] = splitFullName(fullName);
  try {
    const { data } = await gh.rest.repos.getContent({ owner, repo, path: "" });
    return Array.isArray(data) ? data.map((entry) => (entry.type === "dir" ? `${entry.name}/` : entry.name)) : [];
  } catch (error) {
    if ((error as { status?: number }).status === 404) return [];
    throw error;
  }
}

export async function starRepo(gh: Octokit, fullName: string): Promise<void> {
  const [owner, repo] = splitFullName(fullName);
  await gh.rest.activity.starRepoForAuthenticatedUser({ owner, repo });
}

export async function unstarRepo(gh: Octokit, fullName: string): Promise<void> {
  const [owner, repo] = splitFullName(fullName);
  await gh.rest.activity.unstarRepoForAuthenticatedUser({ owner, repo });
}

export function splitFullName(fullName: string): [string, string] {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(fullName.trim());
  if (!match) throw new Error(`"${fullName}" is not an owner/name repository`);
  return [match[1], match[2]];
}

/** Format a date as YYYY-MM-DD for GitHub search qualifiers. */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
