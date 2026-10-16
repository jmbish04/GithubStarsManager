import { describe, expect, it } from 'vitest';
import type { Category, Repository } from '../types';
import { getAICategory, getEffectiveTags, matchesCategory, resolveCategoryAssignment, buildCategoryHints } from './categoryUtils';

const aiCategory: Category = {
  id: 'ai',
  name: 'AI/\u673a\u5668\u5b66\u4e60', // Chinese for "AI/Machine Learning"
  icon: 'bot',
  keywords: ['AI', '\u673a\u5668\u5b66\u4e60'], // Chinese for "Machine Learning"
};

const webCategory: Category = {
  id: 'web',
  name: 'Web\u5e94\u7528', // Chinese for "Web Apps"
  icon: 'globe',
  keywords: ['Web'],
};

const baseRepository: Repository = {
  id: 1,
  name: 'demo',
  full_name: 'owner/demo',
  description: null,
  html_url: 'https://github.com/owner/demo',
  stargazers_count: 1,
  forks_count: 0,
  forks: 0,
  language: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  pushed_at: '2026-01-01T00:00:00Z',
  owner: {
    login: 'owner',
    avatar_url: 'https://example.com/avatar.png',
  },
  topics: [],
  ai_tags: ['AI/\u673a\u5668\u5b66\u4e60'], // Chinese for "AI/Machine Learning"
};

describe('getEffectiveTags', () => {
  it('prioritizes non-empty custom tags', () => {
    const repository = {
      ...baseRepository,
      custom_tags: ['\u6211\u7684\u9879\u76ee'], // Chinese for "My Projects"
      ai_tags: ['AI/\u673a\u5668\u5b66\u4e60'], // Chinese for "AI/Machine Learning"
      topics: ['web'],
    };
    expect(getEffectiveTags(repository)).toEqual(['\u6211\u7684\u9879\u76ee']); // Chinese for "My Projects"
  });

  it('falls back to AI tags when custom tags are empty', () => {
    const repository = {
      ...baseRepository,
      custom_tags: [],
      ai_tags: ['AI/\u673a\u5668\u5b66\u4e60'], // Chinese for "AI/Machine Learning"
      topics: ['web'],
    };
    expect(getEffectiveTags(repository)).toEqual(['AI/\u673a\u5668\u5b66\u4e60']); // Chinese for "AI/Machine Learning"
  });

  it('falls back to topics when custom and AI tags are empty', () => {
    const repository = {
      ...baseRepository,
      custom_tags: [],
      ai_tags: [],
      topics: ['machine-learning'],
    };
    expect(getEffectiveTags(repository)).toEqual(['machine-learning']);
  });

  it('ignores whitespace-only custom tags and falls back to AI tags', () => {
    const repository = {
      ...baseRepository,
      custom_tags: [' ', '  '],
      ai_tags: ['AI/\u673a\u5668\u5b66\u4e60'], // Chinese for "AI/Machine Learning"
      topics: ['web'],
    };
    expect(getEffectiveTags(repository)).toEqual(['AI/\u673a\u5668\u5b66\u4e60']); // Chinese for "AI/Machine Learning"
  });

  it('ignores whitespace-only AI tags and falls back to topics', () => {
    const repository = {
      ...baseRepository,
      custom_tags: [''],
      ai_tags: [' ', ''],
      topics: ['machine-learning'],
    };
    expect(getEffectiveTags(repository)).toEqual(['machine-learning']);
  });

  it('returns empty array when all sources contain only whitespace tags', () => {
    const repository = {
      ...baseRepository,
      custom_tags: ['   '],
      ai_tags: [' '],
      topics: [' ', ''],
    };
    expect(getEffectiveTags(repository)).toEqual([]);
  });
});

describe('matchesCategory', () => {
  it('uses AI tags when custom_category is undefined', () => {
    expect(matchesCategory(baseRepository, aiCategory)).toBe(true);
  });

  it('uses AI tags when legacy backend data has custom_category null', () => {
    const legacyRepository = {
      ...baseRepository,
      custom_category: null,
    } as unknown as Repository;

    expect(matchesCategory(legacyRepository, aiCategory)).toBe(true);
  });

  it('does not match any category when custom_category is explicitly empty', () => {
    const repository = {
      ...baseRepository,
      custom_category: '',
    };

    expect(matchesCategory(repository, aiCategory)).toBe(false);
  });

  it('re-matches by tags when custom_category is set but not locked (AI-derived value)', () => {
    const repository = {
      ...baseRepository,
      custom_category: 'Web\u5e94\u7528', // Chinese for "Web Apps"
    };

    expect(matchesCategory(repository, aiCategory)).toBe(true);
    expect(matchesCategory(repository, webCategory)).toBe(false);
  });

  it.each(['legacy', 'effective'] as const)(
    'keeps legacy behavior for AI tags in %s mode when no custom tags',
    (mode) => {
      expect(matchesCategory(baseRepository, aiCategory, mode)).toBe(true);
    }
  );

  it('does not treat whitespace-only AI tags as a match in legacy mode', () => {
    const repository = {
      ...baseRepository,
      custom_category: undefined,
      custom_tags: undefined,
      ai_tags: [' ', '  '],
      topics: [],
    };
    expect(matchesCategory(repository, aiCategory, 'legacy')).toBe(false);
  });

  it('does not match when ai_tags contain only blanks in effective mode', () => {
    const repository = {
      ...baseRepository,
      custom_category: undefined,
      custom_tags: [],
      ai_tags: ['   '],
      topics: [],
    };
    expect(matchesCategory(repository, aiCategory, 'effective')).toBe(false);
  });

  it('does not match in legacy mode when execute effective custom tags do not overlap', () => {
    const repository = {
      ...baseRepository,
      custom_tags: ['\u6211\u7684\u9879\u76ee'], // Chinese for "My Projects"
      ai_tags: ['AI/\u673a\u5668\u5b66\u4e60'], // Chinese for "AI/Machine Learning"
    };
    expect(matchesCategory(repository, aiCategory, 'legacy')).toBe(true);
  });

  it('matches via custom tags in effective mode', () => {
    const repository = {
      ...baseRepository,
      custom_tags: ['\u524d\u7aef'], // Chinese for "Frontend"
      ai_tags: ['AI/\u673a\u5668\u5b66\u4e60'], // Chinese for "AI/Machine Learning"
    };
    const frontendCategory: Category = {
      id: 'frontend',
      name: '\u524d\u7aef', // Chinese for "Frontend"
      icon: 'code',
      keywords: ['\u524d\u7aef'], // Chinese for "Frontend"
    };
    expect(matchesCategory(repository, frontendCategory, 'effective')).toBe(true);
    expect(matchesCategory(repository, aiCategory, 'effective')).toBe(false);
  });

  it('uses custom tags even without AI tags in effective mode', () => {
    const repository = {
      ...baseRepository,
      custom_tags: ['\u524d\u7aef'], // Chinese for "Frontend"
      ai_tags: undefined,
    };
    const frontendCategory: Category = {
      id: 'frontend',
      name: '\u524d\u7aef', // Chinese for "Frontend"
      icon: 'code',
      keywords: ['\u524d\u7aef'], // Chinese for "Frontend"
    };
    expect(matchesCategory(repository, frontendCategory, 'effective')).toBe(true);
  });

  it('matches a custom category with empty keywords by name in effective mode', () => {
    const repository = {
      ...baseRepository,
      custom_tags: ['\u6211\u7684\u9879\u76ee'], // Chinese for "My Projects"
      ai_tags: ['AI/\u673a\u5668\u5b66\u4e60'], // Chinese for "AI/Machine Learning"
    };
    const myProjects: Category = {
      id: 'custom-1',
      name: '\u6211\u7684\u9879\u76ee', // Chinese for "My Projects"
      icon: '📁',
      keywords: [],
      isCustom: true,
    };
    expect(matchesCategory(repository, myProjects, 'effective')).toBe(true);
  });

  it('does not match default categories by name in effective mode', () => {
    const repository = {
      ...baseRepository,
      custom_tags: ['AI'],
      ai_tags: ['AI/\u673a\u5668\u5b66\u4e60'], // Chinese for "AI/Machine Learning"
    };
    // Custom tags match default categories only by keyword; the default category name itself does not participate in matching
    expect(matchesCategory(repository, aiCategory, 'effective')).toBe(true);
    expect(matchesCategory(repository, webCategory, 'effective')).toBe(false);
  });
});

describe('resolveCategoryAssignment', () => {
  const customCategory: Category = {
    id: 'custom-1',
    name: '\u6211\u7684\u9879\u76ee', // Chinese for "My Projects"
    icon: '📁',
    keywords: [],
    isCustom: true,
  };

  const categories: Category[] = [aiCategory, webCategory, customCategory];

  it('recomputes an unlocked custom_category from tags (AI-derived value)', () => {
    const repository = {
      ...baseRepository,
      custom_category: '\u6211\u7684\u9879\u76ee', // Chinese for "My Projects"
      custom_tags: ['\u6211\u7684\u9879\u76ee'], // Chinese for "My Projects"
    };
    // Unlocked custom_category is treated as a value written by AI analysis; recomputed rather than directly preserved
    expect(resolveCategoryAssignment(repository, ['AI/\u673a\u5668\u5b66\u4e60'], categories)).toBe(undefined); // Chinese for "AI/Machine Learning"
  });

  it('preserves a locked valid custom_category', () => {
    const repository = {
      ...baseRepository,
      custom_category: '\u6211\u7684\u9879\u76ee', // Chinese for "My Projects"
      custom_tags: ['\u6211\u7684\u9879\u76ee'], // Chinese for "My Projects"
      category_locked: true,
    };
    expect(resolveCategoryAssignment(repository, ['AI/\u673a\u5668\u5b66\u4e60'], categories)).toBe('\u6211\u7684\u9879\u76ee'); // Chinese for "AI/Machine Learning", "My Projects"
  });

  it('preserves an explicitly empty custom_category', () => {
    const repository = {
      ...baseRepository,
      custom_category: '',
    };
    expect(resolveCategoryAssignment(repository, ['AI/\u673a\u5668\u5b66\u4e60'], categories)).toBe(''); // Chinese for "AI/Machine Learning"
  });

  it('does not clear custom_category when locked even without tags', () => {
    const repository = {
      ...baseRepository,
      custom_category: '\u6211\u7684\u9879\u76ee', // Chinese for "My Projects"
      category_locked: true,
    };
    expect(resolveCategoryAssignment(repository, [], categories)).toBe('\u6211\u7684\u9879\u76ee'); // Chinese for "My Projects"
  });

  it('assigns a custom category when AI tag contains the category name', () => {
    const repository = {
      ...baseRepository,
      custom_category: undefined,
    };
    expect(resolveCategoryAssignment(repository, ['\u6211\u7684\u9879\u76ee'], categories)).toBe('\u6211\u7684\u9879\u76ee'); // Chinese for "My Projects"
  });

  it('assigns a custom category when the category name contains the AI tag', () => {
    const repository = {
      ...baseRepository,
      custom_category: undefined,
    };
    expect(resolveCategoryAssignment(repository, ['\u9879\u76ee'], categories)).toBe('\u6211\u7684\u9879\u76ee'); // Chinese for "Project", "My Projects"
  });

  it('returns undefined when AI tags match a default category and no custom assignment exists', () => {
    const repository = {
      ...baseRepository,
      custom_category: undefined,
    };
    expect(resolveCategoryAssignment(repository, ['Web\u5e94\u7528'], categories)).toBe(undefined); // Chinese for "Web Apps"
  });

  it('does not match by name substring for default categories', () => {
    const repository = {
      ...baseRepository,
      custom_category: undefined,
    };
    // "app" (in Chinese) is a substring of default category "Web Apps", but default categories require exact name match
    expect(resolveCategoryAssignment(repository, ['\u5e94\u7528'], categories)).toBe(undefined); // Chinese for "App"
  });
});

describe('resolveCategoryAssignment metadata fallback for custom categories', () => {
  const customSkills: Category = {
    id: 'custom-skills',
    name: 'skills',
    icon: '💡',
    keywords: ['Skills', '\u6280\u80fd', 'skill'], // Chinese for "skill"
    isCustom: true,
  };

  it('assigns skills category via metadata when AI tags miss the custom name', () => {
    const repository = {
      ...baseRepository,
      full_name: 'Leonxlnx/taste-skill',
      name: 'taste-skill',
      description: 'Taste-Skill - gives your AI good taste',
      language: 'JavaScript',
      topics: ['agent', 'ai', 'skill', 'skills', 'vibecoding'],
      custom_category: undefined,
    };
    // AI returns generic tags; matches custom category solely through skill/skills in topics
    expect(resolveCategoryAssignment(repository, ['AI/\u673a\u5668\u5b66\u4e60', '\u5f00\u53d1\u5de5\u5177', '\u6548\u7387\u5de5\u5177'], [customSkills, aiCategory])).toBe('skills'); // Chinese for "AI/Machine Learning", "Development Tools", "Productivity Tools"
  });

  it('assigns skills category for pm-skills repo (topics match keywords)', () => {
    const repository = {
      ...baseRepository,
      full_name: 'phuryn/pm-skills',
      name: 'pm-skills',
      description: 'PM Skills Marketplace: 100+ agentic skills',
      language: '',
      topics: ['agent-skills', 'agentic-skills', 'claude-code-plugins', 'product-management'],
      custom_category: undefined,
    };
    expect(resolveCategoryAssignment(repository, ['\u5f00\u53d1\u5de5\u5177'], [customSkills, aiCategory])).toBe('skills'); // Chinese for "Development Tools"
  });

  it('assigns custom category via description even without topics', () => {
    const repository = {
      ...baseRepository,
      full_name: 'acme/skill-pack',
      name: 'skill-pack',
      description: '\u63d0\u4f9b 30+ \u6280\u80fd\u63d2\u4ef6\u5e93', // Chinese for "Provides 30+ skill plugin library"
      language: 'TypeScript',
      topics: [],
      custom_category: undefined,
    };
    expect(resolveCategoryAssignment(repository, [], [customSkills, aiCategory])).toBe('skills');
  });

  it('preserves a locked custom_category despite metadata fallback', () => {
    const repository = {
      ...baseRepository,
      full_name: 'phuryn/pm-skills',
      name: 'pm-skills',
      description: 'PM Skills Marketplace',
      language: '',
      topics: ['agent-skills'],
      custom_category: 'Web\u5e94\u7528', // Chinese for "Web Apps"
      category_locked: true,
    };
    expect(resolveCategoryAssignment(repository, ['AI/\u673a\u5668\u5b66\u4e60'], [customSkills, aiCategory, webCategory])).toBe('Web\u5e94\u7528'); // Chinese for "AI/Machine Learning", "Web Apps"
  });

  it('recomputes an unlocked custom_category via metadata fallback', () => {
    const repository = {
      ...baseRepository,
      full_name: 'phuryn/pm-skills',
      name: 'pm-skills',
      description: 'PM Skills Marketplace',
      language: '',
      topics: ['agent-skills'],
      custom_category: 'Web\u5e94\u7528', // Chinese for "Web Apps"
      category_locked: false,
    };
    // Unlocked legacy value is treated as AI-written; recomputed using metadata fallback
    expect(resolveCategoryAssignment(repository, ['AI/\u673a\u5668\u5b66\u4e60'], [customSkills, aiCategory, webCategory])).toBe('skills'); // Chinese for "AI/Machine Learning"
  });

  it('preserves explicitly cleared custom_category despite metadata fallback', () => {
    const repository = {
      ...baseRepository,
      full_name: 'phuryn/pm-skills',
      name: 'pm-skills',
      description: 'PM Skills Marketplace',
      language: '',
      topics: ['agent-skills'],
      custom_category: '',
    };
    expect(resolveCategoryAssignment(repository, [], [customSkills, aiCategory])).toBe('');
  });

  it('keeps default category behavior when no custom metadata matches', () => {
    const repository = {
      ...baseRepository,
      full_name: 'foo/demo-app',
      name: 'demo-app',
      description: 'A web demo',
      language: 'JavaScript',
      topics: ['web'],
      custom_category: undefined,
    };
    expect(resolveCategoryAssignment(repository, ['Web\u5e94\u7528'], [customSkills, aiCategory, webCategory])).toBe(undefined); // Chinese for "Web Apps"
  });
});

describe('resolveCategoryAssignment with real repositories and other custom categories', () => {
  // Real repository metadata (fetched from GitHub API, frozen offline to prevent flakiness)
  const customDataAnalysis: Category = {
    id: 'custom-data',
    name: '\u6570\u636e\u5206\u6790', // Chinese for "Data Analytics"
    icon: '📊',
    keywords: ['data-analysis', '\u6570\u636e\u5206\u6790', 'pandas'], // Chinese for "Data Analytics"
    isCustom: true,
  };
  const customCli: Category = {
    id: 'custom-cli',
    name: '\u547d\u4ee4\u884c\u5de5\u5177', // Chinese for "Command Line Tools"
    icon: '🖥',
    keywords: ['cli', '\u547d\u4ee4\u884c', 'terminal'], // Chinese for "Command Line"
    isCustom: true,
  };

  it('classifies pandas-dev/pandas to custom data analysis via topics', () => {
    const pandas = {
      ...baseRepository,
      id: 2,
      full_name: 'pandas-dev/pandas',
      name: 'pandas',
      description: 'Flexible and powerful data analysis / manipulation library for Python',
      language: 'Python',
      topics: ['alignment', 'data-analysis', 'data-science', 'flexible', 'pandas', 'python'],
      custom_category: undefined,
    };
    expect(resolveCategoryAssignment(pandas, ['AI/\u673a\u5668\u5b66\u4e60'], [customDataAnalysis, customCli, aiCategory])).toBe('\u6570\u636e\u5206\u6790'); // Chinese for "AI/Machine Learning", "Data Analytics"
  });

  it('classifies cli/cli to custom command-line tools via topics', () => {
    const repository = {
      ...baseRepository,
      id: 3,
      full_name: 'cli/cli',
      name: 'cli',
      description: 'GitHub official command line tool',
      language: 'Go',
      topics: ['cli', 'git', 'github-api-v4', 'golang'],
      custom_category: undefined,
    };
    expect(resolveCategoryAssignment(repository, ['\u5f00\u53d1\u5de5\u5177'], [customCli, customDataAnalysis, aiCategory])).toBe('\u547d\u4ee4\u884c\u5de5\u5177'); // Chinese for "Development Tools", "Command Line Tools"
  });
});

describe('buildCategoryHints', () => {
  it('builds hint text with keywords', () => {
    const categories: Category[] = [
      { id: 'c1', name: 'skills', icon: '💡', keywords: ['Skill', '\u6280\u80fd'], isCustom: true }, // Chinese for "skill"
      { id: 'c2', name: '\u6570\u636e\u5206\u6790', icon: '📊', keywords: ['pandas'], isCustom: true }, // Chinese for "Data Analytics"
    ];
    expect(buildCategoryHints(categories)).toContain('skills');
    expect(buildCategoryHints(categories)).toContain('\u6280\u80fd'); // Chinese for "skill"
    expect(buildCategoryHints(categories)).toContain('\u6570\u636e\u5206\u6790'); // Chinese for "Data Analytics"
  });

  it('returns empty string when no custom categories', () => {
    expect(buildCategoryHints([aiCategory])).toBe('');
  });

  it('handles categories without keywords', () => {
    const categories: Category[] = [
      { id: 'c1', name: '\u6211\u7684\u9879\u76ee', icon: '📁', keywords: [], isCustom: true }, // Chinese for "My Projects"
    ];
    expect(buildCategoryHints(categories)).toContain('\u6211\u7684\u9879\u76ee'); // Chinese for "My Projects"
  });

  it('normalizes whitespace-only keywords out of hint text', () => {
    const categories: Category[] = [
      { id: 'c1', name: 'skills', icon: '💡', keywords: [' ', '  ', 'Skill'], isCustom: true },
    ];
    // Retain only valid keywords to generate precise hint text
    expect(buildCategoryHints(categories)).toBe('skills\uff08Skill\uff09');
  });
});

describe('resolveCategoryAssignment whitespace-keyword regression', () => {
  const whitespaceCategory: Category = {
    id: 'custom-whitespace',
    name: '\u7a7a\u5173\u952e\u8bcd', // Chinese for "Empty Keywords"
    icon: '⚠️',
    keywords: [' ', '  ', ''],
    isCustom: true,
  };

  it('does not match every repository when keywords are whitespace-only', () => {
    const repository = {
      ...baseRepository,
      full_name: 'foo/demo-app',
      name: 'demo-app',
      description: 'A web demo',
      language: 'JavaScript',
      topics: ['web'],
      custom_category: undefined,
    };
    // When keywords are all whitespace, fall back to category name matching; repo name does not contain category name -> no match
    expect(resolveCategoryAssignment(repository, ['Web\u5e94\u7528'], [whitespaceCategory, aiCategory, webCategory])).toBe(undefined); // Chinese for "Web Apps"
  });

  it('matches by name via fallback when keywords are whitespace-only and name is present in repo text', () => {
    const repository = {
      ...baseRepository,
      full_name: 'acme/empty-category',
      name: 'empty-category',
      description: '\u7a7a\u5173\u952e\u8bcd demo app', // Chinese for "Empty Keywords demo app"
      language: 'JavaScript',
      topics: [],
      custom_category: undefined,
    };
    expect(resolveCategoryAssignment(repository, ['Web\u5e94\u7528'], [whitespaceCategory, aiCategory, webCategory])).toBe('\u7a7a\u5173\u952e\u8bcd'); // Chinese for "Web Apps", "Empty Keywords"
  });

  it('matches via a genuine non-whitespace keyword among whitespace keywords', () => {
    const category: Category = {
      id: 'custom-mixed',
      name: '\u6570\u636e\u5206\u6790', // Chinese for "Data Analytics"
      icon: '📊',
      keywords: ['  ', ' pandas ', ''],
      isCustom: true,
    };
    const repository = {
      ...baseRepository,
      full_name: 'acme/pandas-playground',
      name: 'pandas-playground',
      description: 'Data science repo',
      language: 'Python',
      topics: [],
      custom_category: undefined,
    };
    expect(resolveCategoryAssignment(repository, [], [category, aiCategory])).toBe('\u6570\u636e\u5206\u6790'); // Chinese for "Data Analytics"
  });
});

describe('resolveCategoryAssignment summary-only metadata match', () => {
  const customSkills: Category = {
    id: 'custom-skills',
    name: 'skills',
    icon: '💡',
    keywords: ['Skills', '\u6280\u80fd'], // Chinese for "skill"
    isCustom: true,
  };

  it('assigns a custom category matched only by the freshly generated ai_summary', () => {
    const repository = {
      ...baseRepository,
      full_name: 'leon/repo',
      name: 'repo',
      description: 'Generic CLI tool',
      language: 'Go',
      topics: [],
      ai_summary: 'A curated collection of reusable agent skills and prompt libraries',
      custom_category: undefined,
    };
    // Neither name, description, nor topics contain skills; matched solely by ai_summary
    expect(resolveCategoryAssignment(repository, ['\u5f00\u53d1\u5de5\u5177'], [customSkills, aiCategory])).toBe('skills'); // Chinese for "Development Tools"
  });

  it('does not assign via ai_summary when the summary contains no matching keyword', () => {
    const repository = {
      ...baseRepository,
      full_name: 'leon/repo',
      name: 'repo',
      description: 'Generic CLI tool',
      language: 'Go',
      topics: [],
      ai_summary: 'A minimal HTTP server written in Go',
      custom_category: undefined,
    };
    expect(resolveCategoryAssignment(repository, ['\u5f00\u53d1\u5de5\u5177'], [customSkills, aiCategory])).toBe(undefined); // Chinese for "Development Tools"
  });
});

describe('category keyword direction', () => {
  const gameCategory: Category = {
    id: 'game', name: '\u6e38\u620f', icon: '🎮', // Chinese for "game"
    keywords: ['\u6e38\u620f', 'game', 'gaming', 'unity', 'unreal', 'godot'], // Chinese for "game"
  };

  it.each(['legacy', 'effective'] as const)('does not classify Go tags as Godot in %s mode', (mode) => {
    const repository = { ...baseRepository, ai_tags: ['Go'] };
    expect(matchesCategory(repository, gameCategory, mode)).toBe(false);
    expect(getAICategory(repository, [gameCategory])).toBe('');
  });

  it('does not classify Go topics as Godot', () => {
    const repository = { ...baseRepository, ai_tags: [], topics: ['go', 'docker'] };
    expect(matchesCategory(repository, gameCategory, 'effective')).toBe(false);
  });

  const chineseGameDevTag = '\u6e38\u620f\u5f00\u53d1'; // Chinese for "game development"
  it.each(['godot', 'godot-engine', 'gaming', chineseGameDevTag])('keeps matching relevant tag %s', (tag) => {
    const repository = { ...baseRepository, ai_tags: [tag] };
    expect(matchesCategory(repository, gameCategory, 'effective')).toBe(true);
    expect(getAICategory(repository, [gameCategory])).toBe('\u6e38\u620f'); // Chinese for "game"
  });

  it('does not assign a custom Godot category to Go tags', () => {
    const category = { ...gameCategory, isCustom: true };
    expect(resolveCategoryAssignment(baseRepository, ['Go'], [category])).toBeUndefined();
  });

  it('preserves a locked manual game category', () => {
    const repository = { ...baseRepository, ai_tags: ['Go'], custom_category: '\u6e38\u620f', category_locked: true }; // Chinese for "game"
    expect(matchesCategory(repository, gameCategory, 'effective')).toBe(true);
  });
});
