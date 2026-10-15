import { describe, expect, it } from "vitest";

import { healthVerdict, publicErrorMessage } from "../src/app";
import { UPSERT_CHUNK, upsertGitHubRepos } from "../src/services/repos";
import { shouldClearMissingStars } from "../src/services/stars";

describe("star sync guard", () => {
  it("never unstars from an empty or capped list", () => {
    expect(shouldClearMissingStars(true, 3_688)).toBe(true);
    expect(shouldClearMissingStars(true, 0)).toBe(false);
    expect(shouldClearMissingStars(false, 10_000)).toBe(false);
  });
});

describe("repository upsert", () => {
  it("splits a large star list into statements under the Postgres parameter limit", async () => {
    const batches: number[] = [];
    const fakeDb = { insert: () => ({ values: (rows: unknown[]) => ({ onConflictDoUpdate: async () => batches.push(rows.length) }) }) };
    const repos = Array.from({ length: 1_201 }, (_, i) => ({ id: i + 1, full_name: `o/r${i}`, name: `r${i}`, owner: { login: "o" }, description: null, html_url: "https://x", language: null, stargazers_count: 1, forks_count: 0 }));
    expect(await upsertGitHubRepos(fakeDb as never, repos, "star_sync")).toBe(1_201);
    expect(batches).toEqual([UPSERT_CHUNK, UPSERT_CHUNK, 201]);
    expect(UPSERT_CHUNK * 18).toBeLessThan(65_535);
  });

  it("collapses duplicate ids before writing", async () => {
    const batches: number[] = [];
    const fakeDb = { insert: () => ({ values: (rows: unknown[]) => ({ onConflictDoUpdate: async () => batches.push(rows.length) }) }) };
    const repo = { id: 7, full_name: "o/r", name: "r", owner: { login: "o" }, description: null, html_url: "https://x", language: null, stargazers_count: 1, forks_count: 0 };
    await upsertGitHubRepos(fakeDb as never, [repo, repo], "discovery");
    expect(batches).toEqual([1]);
  });
});

describe("error responses", () => {
  it("reports the database reason, not the SQL and parameter values", () => {
    const error = new Error('Failed query: insert into "repositories" ... params: secret-row-data', { cause: new Error("MAX_PARAMETERS_EXCEEDED: Max number of parameters (65534) exceeded") });
    const message = publicErrorMessage(error);
    expect(message).toBe("Database error: MAX_PARAMETERS_EXCEEDED: Max number of parameters (65534) exceeded");
    expect(message).not.toContain("secret-row-data");
    expect(publicErrorMessage(new Error("x".repeat(5_000)))).toHaveLength(500);
  });
});

describe("health verdict", () => {
  it("a down critical dependency fails the verdict; a down optional one degrades it", () => {
    const ok = { ok: true, severity: "critical" as const };
    expect(healthVerdict([ok, { ok: true, severity: "degraded" }])).toBe("ok");
    expect(healthVerdict([ok, { ok: false, severity: "degraded" }])).toBe("degraded");
    expect(healthVerdict([{ ok: false, severity: "critical" }, { ok: true, severity: "degraded" }])).toBe("unhealthy");
  });
});
