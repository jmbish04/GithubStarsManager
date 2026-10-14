import { describe, expect, it } from "vitest";

import { createSessionToken, safeEqual, verifySessionToken } from "../src/lib/auth";
import { parseJsonAnswer } from "../src/lib/guardian";
import { splitFullName } from "../src/lib/github";
import { buildQueries, discoveryScore } from "../src/services/discovery";
import { reciprocalRankFusion, repoEmbeddingText, stripMarkdown } from "../src/services/repos";
import { decideAutoResearch, exportMarkdown, normalizeCriterion, sanitizeAgentPlans } from "../src/services/research";

describe("auth", () => {
  it("compares secrets exactly, including length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
    expect(safeEqual("abc", "abc\u0000")).toBe(false); // only the length check catches a trailing NUL
  });

  it("accepts its own session token and rejects a forged, foreign-key or expired one", async () => {
    const now = Date.UTC(2026, 9, 14);
    const token = await createSessionToken("key-1", now);
    expect(await verifySessionToken("key-1", token, now)).toBe(true);
    expect(await verifySessionToken("key-2", token, now)).toBe(false); // rotated key signs everyone out
    const [expires, sig] = token.split(".");
    expect(await verifySessionToken("key-1", `${Number(expires) + 1}.${sig}`, now)).toBe(false); // extended expiry
    expect(await verifySessionToken("key-1", token, now + 401 * 86_400_000)).toBe(false); // past 400 days
  });
});

describe("guardian answers", () => {
  it("reads JSON from a fenced block, from prose, and fails loudly on none", () => {
    expect(parseJsonAnswer<{ a: number }>('Sure!\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJsonAnswer<number[]>("Here: [1, 2] done")).toEqual([1, 2]);
    expect(() => parseJsonAnswer("no json here")).toThrow(/no JSON/);
  });
});

describe("github", () => {
  it("accepts owner/name and rejects anything else", () => {
    expect(splitFullName("cloudflare/workers-sdk")).toEqual(["cloudflare", "workers-sdk"]);
    expect(() => splitFullName("cloudflare")).toThrow();
    expect(() => splitFullName("a/b/c")).toThrow();
    expect(() => splitFullName("../etc/passwd")).toThrow();
  });
});

describe("discovery", () => {
  const now = new Date("2026-10-14T00:00:00Z");
  const profile = { id: null, name: "p", keywords: ["vector search"], topics: ["mcp", "cloudflare-workers"], languages: ["TypeScript"], minStars: 200, freshnessDays: 30 };

  it("builds one query per topic and keyword with star floor, freshness and language", () => {
    const queries = buildQueries(profile, now);
    expect(queries).toEqual([
      "topic:mcp stars:>=200 created:>=2026-09-14 archived:false language:TypeScript",
      "topic:cloudflare-workers stars:>=200 created:>=2026-09-14 archived:false language:TypeScript",
      '"vector search" in:name,description,readme stars:>=200 created:>=2026-09-14 archived:false language:TypeScript',
    ]);
  });

  it("falls back to language queries when there are no topics or keywords, and caps at 12", () => {
    expect(buildQueries({ ...profile, topics: [], keywords: [], languages: ["Go", "Rust"] }, now)).toEqual([
      "language:Go stars:>=200 created:>=2026-09-14 archived:false",
      "language:Rust stars:>=200 created:>=2026-09-14 archived:false",
    ]);
    const many = { ...profile, topics: Array.from({ length: 20 }, (_, i) => `t${i}`) };
    expect(buildQueries(many, now)).toHaveLength(12);
  });

  it("ranks a closer match above a more popular but unrelated repo", () => {
    expect(discoveryScore(0.8, 300)).toBeGreaterThan(discoveryScore(0.3, 90_000));
    expect(discoveryScore(null, 1_000)).toBeGreaterThan(0);
    expect(discoveryScore(0.5, 0)).toBe(0.4);
  });
});

describe("search", () => {
  it("fuses ranked lists so an item in both beats items in one", () => {
    const fused = reciprocalRankFusion([
      [{ id: 1 }, { id: 2 }, { id: 3 }],
      [{ id: 3 }, { id: 4 }],
    ]);
    expect(fused[0].id).toBe(3);
    expect(fused.map((f) => f.id).sort()).toEqual([1, 2, 3, 4]);
  });

  it("keeps embedding text short and free of markdown noise", () => {
    const text = repoEmbeddingText({ fullName: "a/b", description: "Fast thing", topics: ["x"], language: "Go", readmeExcerpt: "# Title\n```js\nsecret()\n```\n[link](http://x) " + "word ".repeat(2000) });
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).not.toContain("secret()");
    expect(text).not.toContain("http://x");
    expect(stripMarkdown("**bold** <b>tag</b>")).toBe("bold tag");
  });
});

describe("research", () => {
  it("normalizes criteria so whitespace and case do not create duplicate runs", () => {
    expect(normalizeCriterion("  Vector   Search\nOn Workers ")).toBe("vector search on workers");
  });

  it("keeps well-formed agent plans, forces the star floor and drops malformed entries", () => {
    const plans = sanitizeAgentPlans(
      {
        agents: [
          { name: "orm", angle: "ORMs", queries: ["drizzle postgres stars:>10", "x"] },
          { name: "bad", queries: "not-an-array" },
          { angle: "no name", queries: ["q1"] },
        ],
      },
      500,
    );
    expect(plans).toEqual([{ name: "orm", angle: "ORMs", queries: ["drizzle postgres stars:>=500 archived:false"] }]);
    expect(sanitizeAgentPlans("garbage", 10)).toEqual([]);
  });

  it("researches a project once, rescans for new repos weekly, and fully re-runs on a plan change", () => {
    const now = new Date("2026-10-14T00:00:00Z");
    expect(decideAutoResearch(undefined, "h1", now).action).toBe("full");
    expect(decideAutoResearch({ planHash: "h1", lastScannedAt: new Date("2026-10-12T00:00:00Z") }, "h1", now).action).toBe("skip");
    expect(decideAutoResearch({ planHash: "h1", lastScannedAt: new Date("2026-10-01T00:00:00Z") }, "h1", now).action).toBe("incremental");
    expect(decideAutoResearch({ planHash: "h0", lastScannedAt: new Date("2026-10-13T00:00:00Z") }, "h1", now).action).toBe("full");
  });

  it("gives every exported finding its own h2 so a Maestro task can attach to it", () => {
    const md = exportMarkdown(
      { id: "run-1", criterion: "MCP servers", targetRepo: null, targetInfrastructure: "Cloudflare Workers", reportMarkdown: "# Research\nSummary text.\n\n## Findings\n|table|" },
      [
        { findingId: "f1", repoId: 1, fullName: "a/one", htmlUrl: "https://github.com/a/one", description: null, stars: 12_345, license: "MIT", isStarred: false, similarity: 0.7, relevance: 0.9, rationale: "fits", leverageMode: "dependency", leverage: { borrow: ["the client"], effort: "small", risks: [], summary: "Use it" }, selected: true },
      ],
    );
    expect(md).toContain("## Summary");
    expect(md).toContain("Summary text.");
    expect(md).not.toContain("|table|");
    expect(md).toContain("## a/one");
    expect(md).toContain("12,345 stars");
    expect(md).toContain("- the client");
  });
});
