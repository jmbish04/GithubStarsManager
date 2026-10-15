import { describe, expect, it } from 'vitest';
import {
  evaluateAssetFilter,
  normalizeAssetFilters,
  normalizeMatchedLinkName,
} from './assetFilters';

/** Both tiers share the same evaluator: two helper assertions are extracted in tests to avoid drifting from the production implementation. */
const releaseMatches = (
  filter: Parameters<typeof evaluateAssetFilter>[0],
  repoKey: string,
  allLinkNames: string[] = [],
  realAssetNames: string[] = allLinkNames,
): boolean => evaluateAssetFilter(filter, repoKey, allLinkNames, realAssetNames).matchesRelease;

/** Asset indices contributed by this filter (ascending); see asset-level rules in evaluateAssetFilter. */
const matchedIndexes = (
  filter: Parameters<typeof evaluateAssetFilter>[0],
  repoKey: string,
  allLinkNames: string[] = [],
  realAssetNames: string[] = allLinkNames,
): number[] => [...evaluateAssetFilter(filter, repoKey, allLinkNames, realAssetNames).matchedLinkIndexes];

describe('normalizeAssetFilters', () => {
  it('strips the obsolete excludeRepos field from persisted filters', () => {
    // #405 briefly implemented inverted-semantics excludeRepos; old keys must be stripped during hydration
    const filters = [
      {
        id: 'f1',
        name: 'Portable',
        keywords: ['portable'],
        excludeRepos: ['owner/legacy'],
        includeRepos: ['owner/beta'],
      },
      { id: 'f2', name: 'Windows', keywords: ['exe'] },
    ];

    expect(normalizeAssetFilters(filters)).toEqual([
      { id: 'f1', name: 'Portable', keywords: ['portable'], includeRepos: ['owner/beta'] },
      { id: 'f2', name: 'Windows', keywords: ['exe'] },
    ]);
  });

  it('preserves alwaysExcludeRepos and keeps legacy excludeRepos unactivated', () => {
    expect(normalizeAssetFilters([
      {
        id: 'f1',
        name: 'Portable',
        keywords: ['portable'],
        includeRepos: ['owner/beta'],
        alwaysExcludeRepos: ['owner/noise'],
        excludeRepos: ['owner/legacy'],
      },
    ])).toEqual([
      {
        id: 'f1',
        name: 'Portable',
        keywords: ['portable'],
        includeRepos: ['owner/beta'],
        alwaysExcludeRepos: ['owner/noise'],
      },
    ]);
  });

  it('preserves preset metadata and coerces non-string elements out of string arrays', () => {
    expect(normalizeAssetFilters([
      {
        id: 'preset-windows',
        name: 'Windows',
        keywords: ['exe', 42, null],
        excludeKeywords: ['setup'],
        includeRepos: ['owner/beta', 7],
        alwaysExcludeRepos: ['owner/noise', false],
        isPreset: true,
        icon: 'Monitor',
      },
    ])).toEqual([
      {
        id: 'preset-windows',
        name: 'Windows',
        keywords: ['exe'],
        excludeKeywords: ['setup'],
        includeRepos: ['owner/beta'],
        alwaysExcludeRepos: ['owner/noise'],
        isPreset: true,
        icon: 'Monitor',
      },
    ]);
  });

  it('trims entries and drops empty or whitespace-only items (incl. empty-string keywords)', () => {
    // If keywords: [""] were preserved, includes("") would always be true and inadvertently match all releases
    expect(normalizeAssetFilters([
      {
        id: 'f1',
        name: 'X',
        keywords: ['  mac  ', '', '   '],
        excludeKeywords: ['setup', ''],
        includeRepos: [' owner/beta ', '  '],
        alwaysExcludeRepos: [' owner/noise ', ''],
      },
    ])).toEqual([
      {
        id: 'f1',
        name: 'X',
        keywords: ['mac'],
        excludeKeywords: ['setup'],
        includeRepos: ['owner/beta'],
        alwaysExcludeRepos: ['owner/noise'],
      },
    ]);
  });

  it('dedupes repositories case-insensitively and keywords case-insensitively, keeping the first entry', () => {
    expect(normalizeAssetFilters([
      {
        id: 'f1',
        name: 'X',
        keywords: ['Mac', 'mac', 'MAC'],
        excludeKeywords: ['Setup', 'setup'],
        includeRepos: ['Owner/Beta', 'owner/beta'],
        alwaysExcludeRepos: ['Owner/Noise', 'owner/noise'],
      },
    ])).toEqual([
      {
        id: 'f1',
        name: 'X',
        keywords: ['Mac'],
        excludeKeywords: ['Setup'],
        includeRepos: ['Owner/Beta'],
        alwaysExcludeRepos: ['Owner/Noise'],
      },
    ]);
  });

  it('does not cross-dedupe includeRepos against alwaysExcludeRepos', () => {
    // Duplicates between both sets are valid state (used to display "exclude takes precedence" conflict hints)
    expect(normalizeAssetFilters([
      {
        id: 'f1',
        name: 'X',
        keywords: ['k'],
        includeRepos: ['owner/both'],
        alwaysExcludeRepos: ['owner/both'],
      },
    ])).toEqual([
      {
        id: 'f1',
        name: 'X',
        keywords: ['k'],
        includeRepos: ['owner/both'],
        alwaysExcludeRepos: ['owner/both'],
      },
    ]);
  });

  it('preserves empty arrays written by the editor instead of dropping the keys', () => {
    expect(normalizeAssetFilters([
      {
        id: 'f1',
        name: 'X',
        keywords: [],
        excludeKeywords: [],
        includeRepos: [],
        alwaysExcludeRepos: [],
      },
    ])).toEqual([
      {
        id: 'f1',
        name: 'X',
        keywords: [],
        excludeKeywords: [],
        includeRepos: [],
        alwaysExcludeRepos: [],
      },
    ]);
  });

  it('drops filters missing required fields so keyword matching cannot throw', () => {
    expect(normalizeAssetFilters([
      { id: 'f1' },                              // missing name / keywords
      { id: '', name: 'X', keywords: ['k'] },    // empty id
      { id: 'f2', keywords: ['k'] },             // missing name
      { id: 'f3', name: 'X' },                   // missing keywords
      { id: 'f4', name: 'X', keywords: 'oops' }, // keywords is not an array
      { id: 'ok', name: 'OK', keywords: ['k'] }, // valid entry preserved
    ])).toEqual([{ id: 'ok', name: 'OK', keywords: ['k'] }]);
  });

  it('drops non-object entries and returns empty for non-arrays', () => {
    expect(normalizeAssetFilters([null, 'oops', { id: 'f1' }])).toEqual([]);
    expect(normalizeAssetFilters(undefined)).toEqual([]);
    expect(normalizeAssetFilters('nope')).toEqual([]);
  });
});

describe('evaluateAssetFilter (release-level match)', () => {
  // Lists passed by callers are already lowercased (consistent with lowerLinkNames in ReleaseTimeline)
  const match = (
    filter: Parameters<typeof evaluateAssetFilter>[0],
    repoKey: string,
    allLinkNames: string[] = [],
    realAssetNames: string[] = allLinkNames,
  ) => releaseMatches(filter, repoKey, allLinkNames, realAssetNames);

  it('lets alwaysExcludeRepos win over includeRepos and keywords in the same filter', () => {
    const filter = {
      keywords: ['zip'],
      includeRepos: ['Owner/Repo'],
      alwaysExcludeRepos: ['owner/repo'],
    };
    expect(match(filter, 'owner/repo', ['app.zip'])).toBe(false);
  });

  it('matches case-insensitively on repository keys', () => {
    const filter = { keywords: [], alwaysExcludeRepos: ['OWNER/ALPHA'] };
    expect(match(filter, 'owner/alpha')).toBe(false);
    expect(match(filter, 'owner/beta')).toBe(true);
  });

  it('lets includeRepos bypass keywords and excludeKeywords of the same filter', () => {
    const filter = {
      keywords: ['portable'],
      excludeKeywords: ['beta'],
      includeRepos: ['owner/beta'],
    };
    expect(match(filter, 'owner/beta', ['beta.zip'])).toBe(true);
  });

  it('requires an asset to hit an include keyword and no exclude keyword', () => {
    const filter = { keywords: ['zip'], excludeKeywords: ['setup'] };
    expect(match(filter, 'owner/a', ['app.zip'])).toBe(true);
    expect(match(filter, 'owner/a', ['app-setup.zip'])).toBe(false);
  });

  it('keeps the legacy matching scope when include keywords are present (pseudo assets & body links)', () => {
    // Preserves existing behavior where preset-source relies on "source code (...)" pseudo-asset names matching
    const filter = { keywords: ['source'] };
    expect(match(filter, 'owner/a', ['app.bin', 'source code (v1.zip)'], ['app.bin'])).toBe(true);
    // Download link names extracted from the body also participate in matching (existing behavior when keywords are non-empty)
    expect(match(filter, 'owner/a', ['app.bin', 'download-setup.exe'], ['app.bin'])).toBe(false);
    const setupFilter = { keywords: ['setup'] };
    expect(match(setupFilter, 'owner/a', ['app.bin', 'download-setup.exe'], ['app.bin'])).toBe(true);
  });

  it('matches only real uploaded assets when include keywords are empty', () => {
    const filter = { keywords: [], excludeKeywords: ['setup'] };

    // At least one real uploaded asset is not excluded -> match
    expect(match(filter, 'owner/a', ['source code (v1.zip)', 'app.zip'], ['app.zip'])).toBe(true);

    // All real assets excluded, but pseudo-assets not excluded -> hide (exclude keywords must be able to hide releases)
    expect(
      match(filter, 'owner/a', ['source code (v1.zip)', 'app-setup.zip'], ['app-setup.zip']),
    ).toBe(false);

    // No real uploaded assets -> hide
    expect(match(filter, 'owner/a', ['source code (v1.zip)'], [])).toBe(false);
  });

  it('treats a pure includeRepos filter as a repository whitelist', () => {
    const filter = { keywords: [], includeRepos: ['owner/beta'] };
    expect(match(filter, 'owner/beta', [], [])).toBe(true);
    expect(match(filter, 'owner/gamma', ['tool.zip'], ['tool.zip'])).toBe(false);
  });

  it('treats a pure alwaysExcludeRepos filter as a repository denylist', () => {
    const filter = { keywords: [], alwaysExcludeRepos: ['owner/gamma'] };
    expect(match(filter, 'owner/gamma', [], [])).toBe(false);
    expect(match(filter, 'owner/beta', [], [])).toBe(true);
  });

  it('keeps includeRepos whitelist semantics when both repo lists are configured', () => {
    // Rule 7: when both sets exist, only repos in the include list and not in the exclude list match
    const filter = {
      keywords: [],
      includeRepos: ['owner/beta'],
      alwaysExcludeRepos: ['owner/alpha'],
    };
    expect(match(filter, 'owner/beta', [], [])).toBe(true);
    expect(match(filter, 'owner/alpha', [], [])).toBe(false);
    expect(match(filter, 'owner/gamma', [], [])).toBe(false);
  });

  it('never matches a defense-grade empty filter', () => {
    expect(match({ keywords: [] }, 'owner/a', ['app.zip'])).toBe(false);
    // Malformed filters with empty-string keywords must not inadvertently match all releases
    expect(match({ keywords: [''] }, 'owner/a', ['app.zip'])).toBe(false);
  });
});

describe('normalizeMatchedLinkName', () => {
  it('strips the archive suffix GitHub appends to source-code pseudo assets', () => {
    // Both pseudo-assets exist on every release: matching them as-is would make zip / tar.gz match all releases
    expect(normalizeMatchedLinkName('source code (v1.2.0.zip)', true)).toBe('source code (v1.2.0)');
    expect(normalizeMatchedLinkName('source code (v1.2.0.tar.gz)', true)).toBe('source code (v1.2.0)');
  });

  it('leaves real uploaded assets and body-extracted links untouched', () => {
    expect(normalizeMatchedLinkName('app-1.0.zip', false)).toBe('app-1.0.zip');
    expect(normalizeMatchedLinkName('app-1.0.tar.gz', false)).toBe('app-1.0.tar.gz');
    expect(normalizeMatchedLinkName('download-setup.exe', false)).toBe('download-setup.exe');
  });

  it('keeps the source keyword able to hit source archives (preset-source)', () => {
    const sourceFilter = { keywords: ['source'] };
    const allLinkNames = [
      'binary.bin',
      normalizeMatchedLinkName('source code (v1.zip)', true),
    ];
    expect(releaseMatches(sourceFilter, 'owner/a', allLinkNames, ['binary.bin'])).toBe(true);
  });

  it('stops a zip-only filter from matching a release that has no real zip asset', () => {
    // Replicates production false positives: MinerU only uploads .whl, cline / openclaw have zero assets,
    // yet appeared in macOS (containing zip keyword) filter results because of "Source code (<tag>.zip)"
    const zipFilter = { keywords: ['zip'] };
    const pseudoOnlyLinks = [
      'mineru-4.0.0-py3-none-any.whl',
      normalizeMatchedLinkName('source code (mineru-4.0.0-released.zip)', true),
      normalizeMatchedLinkName('source code (mineru-4.0.0-released.tar.gz)', true),
    ];
    expect(
      releaseMatches(zipFilter, 'opendatalab/mineru', pseudoOnlyLinks, ['mineru-4.0.0-py3-none-any.whl']),
    ).toBe(false);

    // Real uploaded zip assets still match
    const realZipLinks = ['app-1.0.zip', normalizeMatchedLinkName('source code (v1.zip)', true)];
    expect(releaseMatches(zipFilter, 'owner/a', realZipLinks, ['app-1.0.zip'])).toBe(true);
  });
});

describe('evaluateAssetFilter (asset-level pruning)', () => {
  // Link names passed by callers are lowercased and normalized via normalizeMatchedLinkName
  const linkNames = ['app-macos.dmg', 'app-setup.exe', 'app-linux.appimage'];

  it('keeps only the links hitting an include keyword', () => {
    expect(matchedIndexes({ keywords: ['mac'] }, 'owner/a', linkNames)).toEqual([0]);
    expect(matchedIndexes({ keywords: ['app'] }, 'owner/a', linkNames)).toEqual([0, 1, 2]);
  });

  it('keeps only the links hitting any of several include keywords (scenario: macos / arm64)', () => {
    const armNames = [
      'koreader-macos-11.0-arm64-v1.7z',
      'koreader-android-arm64-v1.apk',
      'koreader-appimage-x86_64-v1.AppImage',
      'koreader_1-1_amd64.deb',
    ];
    // macos matches item 0, arm64 matches items 0 and 1 -> keep only 0 and 1
    expect(matchedIndexes({ keywords: ['macos', 'arm64'] }, 'koreader/koreader', armNames))
      .toEqual([0, 1]);
  });

  it('drops links hitting an exclude keyword, and treats empty include keywords as no restriction', () => {
    expect(matchedIndexes({ keywords: [], excludeKeywords: ['setup'] }, 'owner/a', linkNames))
      .toEqual([0, 2]);
    expect(matchedIndexes({ keywords: ['app'], excludeKeywords: ['setup'] }, 'owner/a', linkNames))
      .toEqual([0, 2]);
  });

  it('returns every index for always-included repos and none for always-excluded repos', () => {
    expect(matchedIndexes({ keywords: ['mac'], includeRepos: ['owner/a'] }, 'owner/a', linkNames))
      .toEqual([0, 1, 2]);
    expect(matchedIndexes({ keywords: ['mac'], alwaysExcludeRepos: ['owner/a'] }, 'owner/a', linkNames))
      .toEqual([]);
  });

  it('does not restrict assets for pure repo-rule filters and contributes nothing outside a whitelist', () => {
    expect(matchedIndexes({ keywords: [], alwaysExcludeRepos: ['owner/other'] }, 'owner/a', linkNames))
      .toEqual([0, 1, 2]);
    expect(matchedIndexes({ keywords: [], includeRepos: ['owner/b'] }, 'owner/a', linkNames))
      .toEqual([]);
  });

  it('contributes nothing for a rule-less filter (audit: it must not unlock every asset list)', () => {
    // A rule-less filter neither matches any release nor contributes assets — otherwise releases
    // filtered by other rules would display all their assets because of it
    expect(matchedIndexes({ keywords: [] }, 'owner/a', linkNames)).toEqual([]);
    expect(matchedIndexes({ keywords: [''] }, 'owner/a', linkNames)).toEqual([]);
    expect(releaseMatches({ keywords: [] }, 'owner/a', linkNames)).toBe(false);
  });

  it('contributes nothing when the filter misses the release (visible release ⇒ visible asset)', () => {
    const evaluation = evaluateAssetFilter({ keywords: ['mac'] }, 'owner/a', ['linux.appimage'], ['linux.appimage']);
    expect(evaluation.matchesRelease).toBe(false);
    expect(evaluation.matchedLinkIndexes.size).toBe(0);
  });

  it('never counts the auto-generated source archive for zip-like keywords', () => {
    const archiveNames = [
      ...linkNames.map(name => normalizeMatchedLinkName(name, false)),
      normalizeMatchedLinkName('source code (v1.zip)', true),
    ];
    expect(archiveNames[3]).toBe('source code (v1)');
    expect(matchedIndexes({ keywords: ['zip'] }, 'owner/a', archiveNames)).toEqual([]);
    // source keyword still matches source archive entries (preset-source behavior unchanged)
    expect(matchedIndexes({ keywords: ['source'] }, 'owner/a', archiveNames)).toEqual([3]);
  });
});
