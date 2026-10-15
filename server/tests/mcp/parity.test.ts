import { beforeEach, describe, expect, it, vi } from 'vitest';

const providerMocks = vi.hoisted(() => ({
  getRepository: vi.fn(),
  getRepositories: vi.fn(),
  getRepoEvidence: vi.fn(),
  getStats: vi.fn(),
  getVectorAvailability: vi.fn(() => ({ available: true })),
  listCategories: vi.fn(),
  loadAllRepositories: vi.fn(() => []),
  searchRepos: vi.fn(),
  vectorSearch: vi.fn(),
  findSimilarRepositories: vi.fn(),
}));

vi.mock('../../src/mcp/provider.js', () => providerMocks);

const { registerMcpTools } = await import('../../src/mcp/tools.js');
const { getMcpToolAvailability: getBackendToolAvailability } = await import('../../src/mcp/tools.js');
const { buildRepoEvidence: buildBackendRepoEvidence } = await import('../../src/mcp/evidence.js');
const { searchRepositories: backendSearch } = await import('../../src/mcp/repoSearch.js');
const electronModule = await import('../../../electron/mcpLocalServer.js');
const electronDiscovery = await import('../../../electron/mcpDiscovery.js');
const getElectronTools =
  electronModule.getMcpToolDefinitions || electronModule.default.getMcpToolDefinitions;
const getElectronToolAvailability =
  electronModule.getMcpToolAvailability || electronModule.default.getMcpToolAvailability;

function getBackendTools() {
  const registrations: Array<{ name: string; inputSchema?: Record<string, unknown> }> = [];
  registerMcpTools({
    registerTool(name: string, config: { inputSchema?: Record<string, unknown> }) {
      registrations.push({ name, inputSchema: config.inputSchema });
    },
  } as never);
  return registrations;
}

function contract(tool: { name: string; inputSchema?: Record<string, unknown> }) {
  return {
    name: tool.name,
    properties: Object.keys(tool.inputSchema || {}),
  };
}

describe('backend/Electron MCP parity', () => {
  // registerMcpTools reads getVectorAvailability() at registration time;
  // must be reset before each case to prevent overrides from leaking into subsequent registrations.
  beforeEach(() => {
    providerMocks.getVectorAvailability.mockReturnValue({ available: true });
  });

  it('keeps the same names and input property sets for vector-enabled MCP', () => {
    const backend = getBackendTools().map(contract);
    const electron = getElectronTools(true).map((tool: { name: string; inputSchema?: { properties?: Record<string, unknown> } }) => ({
      name: tool.name,
      properties: Object.keys(tool.inputSchema?.properties || {}),
    }));

    expect(electron).toEqual(backend);
  });

  it('keeps the same non-vector inventory when vector search is unavailable', () => {
    providerMocks.getVectorAvailability.mockReturnValue({ available: false, reason: 'disabled' });
    const backend = getBackendTools().map((tool) => tool.name);
    expect(getElectronTools(false).map((tool: { name: string }) => tool.name)).toEqual(backend);
  });

  it('keeps structured availability metadata identical in both runtimes', () => {
    for (const vectorAvailable of [true, false]) {
      expect(getElectronToolAvailability(vectorAvailable)).toEqual(
        getBackendToolAvailability(vectorAvailable)
      );
    }
  });

  it('keeps evidence freshness metadata identical in both runtimes', () => {
    const fixture = parityRepo({ id: 1, name: 'alpha', full_name: 'acme/alpha', stargazers_count: 10 });
    const backend = buildBackendRepoEvidence(fixture, null);
    const electron = electronDiscovery.buildRepoEvidence(fixture, null);
    expect(electron.evidence.evidenceFreshness).toEqual(backend.evidence.evidenceFreshness);
  });

  it('keeps Repository Health facts identical in both runtimes', async () => {
    // Health facts has three mirrored implementations (src/utils/repositoryHealth.ts, electron/repoHealth.js,
    // server/src/mcp/repoHealth.ts). Lock the Electron and backend versions here to prevent metric drift.
    const electronHealth = await import('../../../electron/repoHealth.js');
    const backendHealth = await import('../../src/mcp/repoHealth.js');
    const now = Date.parse('2026-09-17T00:00:00.000Z');
    const fixture = {
      id: 1,
      name: 'alpha',
      full_name: 'acme/alpha',
      stargazers_count: 1500,
      forks_count: 120,
      created_at: '2020-09-17T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
      pushed_at: '2024-01-01T00:00:00.000Z',
      license: 'MIT',
      has_fetched_releases: true,
      archived: true,
      disabled: false,
      fork: false,
      is_template: false,
      open_issues_count: 32,
      default_branch: 'main',
    };
    const releases = [
      { repo_id: 1, tag_name: 'v1.0.0', published_at: '2025-01-01T00:00:00.000Z', prerelease: false },
      { repo_id: 1, tag_name: 'v2.0.0-rc1', published_at: '2026-06-01T00:00:00.000Z', prerelease: true },
      { repo_id: 99, tag_name: 'v9.0.0', published_at: '2026-07-01T00:00:00.000Z', prerelease: false },
    ];

    const electron = electronHealth.deriveRepositoryHealthFacts(fixture, releases, now);
    const backend = backendHealth.deriveRepositoryHealthFacts(fixture, releases, now);

    expect(electron).toEqual(backend);
    expect(electron.signals).toEqual(['archived', 'no-recent-activity']);
  });

  it('keeps unknown health facts unknown in both runtimes', async () => {
    const electronHealth = await import('../../../electron/repoHealth.js');
    const backendHealth = await import('../../src/mcp/repoHealth.js');
    const fixture = parityRepo({ id: 2, name: 'beta', full_name: 'acme/beta', stargazers_count: 5 });

    const electron = electronHealth.deriveRepositoryHealthFacts(fixture, undefined, 0);
    const backend = backendHealth.deriveRepositoryHealthFacts(fixture, undefined, 0);

    expect(electron).toEqual(backend);
    expect(electron.archived).toBeNull();
    expect(electron.release_count).toBeNull();
  });

  it('orders tied repos identically by full_name on both ends', () => {
    const fixtures = [
      parityRepo({ id: 1, name: 'zeta', full_name: 'acme/zeta', stargazers_count: 100 }),
      parityRepo({ id: 2, name: 'alpha', full_name: 'acme/alpha', stargazers_count: 100 }),
      parityRepo({ id: 3, name: 'mid', full_name: 'acme/mid', stargazers_count: 100 }),
      parityRepo({ id: 4, name: 'solo', full_name: 'other/solo', stargazers_count: 5 }),
    ];
    // Input order is reversed relative to expected output, proving tie-break takes effect rather than inheriting input order
    const expected = [
      'acme/alpha',
      'acme/mid',
      'acme/zeta',
      'other/solo',
    ];
    const backend = backendSearch(fixtures, {});
    const electron = electronDiscovery.searchRepositories(fixtures, {});
    expect(backend.items.map((repo: { full_name: string }) => repo.full_name)).toEqual(expected);
    expect(electron.items.map((repo: { full_name: string }) => repo.full_name)).toEqual(
      backend.items.map((repo: { full_name: string }) => repo.full_name)
    );
  });

  it('clamps a zero limit identically on both ends', () => {
    const fixtures = [
      parityRepo({ id: 1, name: 'alpha', full_name: 'acme/alpha', stargazers_count: 100 }),
      parityRepo({ id: 2, name: 'beta', full_name: 'acme/beta', stargazers_count: 50 }),
    ];
    const backend = backendSearch(fixtures, { limit: 0 });
    const electron = electronDiscovery.searchRepositories(fixtures, { limit: 0 });
    expect(backend.items).toHaveLength(1);
    expect(electron.limit).toBe(1);
    expect(electron.items.map((repo: { full_name: string }) => repo.full_name)).toEqual(
      backend.items.map((repo: { full_name: string }) => repo.full_name)
    );
  });
});

function parityRepo(partial: {
  id: number;
  name: string;
  full_name: string;
  stargazers_count: number;
}): {
  id: number;
  name: string;
  full_name: string;
  description: null;
  html_url: string;
  stargazers_count: number;
  language: string;
  topics: string[];
} {
  return {
    description: null,
    html_url: `https://github.com/${partial.full_name}`,
    language: 'TS',
    topics: [],
    ...partial,
  };
}
