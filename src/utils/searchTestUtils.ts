import { Repository } from '../types';

/**
 * Search functionality test utilities
 * Used to verify real-time search and AI search features
 */

type CountedSearchQuery = {
  query: string;
  expectedCount: number;
  description: string;
};

type AiSearchQuery = {
  query: string;
  description: string;
};

type SearchTestCase =
  | {
      name: string;
      type: 'realtime' | 'basic';
      queries: CountedSearchQuery[];
    }
  | {
      name: string;
      type: 'ai';
      queries: AiSearchQuery[];
    };

// Mock repository data for testing
export const mockRepositories: Repository[] = [
  {
    id: 1,
    name: 'react',
    full_name: 'facebook/react',
    description: 'A declarative, efficient, and flexible JavaScript library for building user interfaces.',
    html_url: 'https://github.com/facebook/react',
    stargazers_count: 220000,
    forks_count: 45000,
    forks: 45000,
    language: 'JavaScript',
    created_at: '2013-05-24T16:15:54Z',
    updated_at: '2024-01-15T10:30:00Z',
    pushed_at: '2024-01-15T10:30:00Z',
    owner: {
      login: 'facebook',
      avatar_url: 'https://avatars.githubusercontent.com/u/69631?v=4'
    },
    topics: ['javascript', 'react', 'frontend', 'ui'],
    // Chinese description for React
    ai_summary: '\u4e00\u4e2a\u7528\u4e8e\u6784\u5efa\u7528\u6237\u754c\u9762\u7684\u58f0\u660e\u5f0f\u3001\u9ad8\u6548\u4e14\u7075\u6d3b\u7684JavaScript\u5e93',
    // Chinese for "frontend framework", "UI library", "JavaScript tools"
    ai_tags: ['\u524d\u7aef\u6846\u67b6', 'UI\u5e93', 'JavaScript\u5de5\u5177'],
    ai_platforms: ['web', 'cli']
  },
  {
    id: 2,
    name: 'vue',
    full_name: 'vuejs/vue',
    description: 'Vue.js is a progressive, incrementally-adoptable JavaScript framework for building UI on the web.',
    html_url: 'https://github.com/vuejs/vue',
    stargazers_count: 207000,
    forks_count: 34000,
    forks: 34000,
    language: 'JavaScript',
    created_at: '2013-07-29T03:24:51Z',
    updated_at: '2024-01-14T15:20:00Z',
    pushed_at: '2024-01-14T15:20:00Z',
    owner: {
      login: 'vuejs',
      avatar_url: 'https://avatars.githubusercontent.com/u/6128107?v=4'
    },
    topics: ['javascript', 'vue', 'frontend', 'framework'],
    // Chinese description for Vue
    ai_summary: '\u6e10\u8fdb\u5f0f\u3001\u53ef\u9010\u6b65\u91c7\u7528\u7684JavaScript\u6846\u67b6\uff0c\u7528\u4e8e\u6784\u5efaWeb UI',
    // Chinese for "frontend framework", "Web application", "JavaScript tools"
    ai_tags: ['\u524d\u7aef\u6846\u67b6', 'Web\u5e94\u7528', 'JavaScript\u5de5\u5177'],
    ai_platforms: ['web']
  },
  {
    id: 3,
    name: 'vscode',
    full_name: 'microsoft/vscode',
    description: 'Visual Studio Code',
    html_url: 'https://github.com/microsoft/vscode',
    stargazers_count: 158000,
    forks_count: 28000,
    forks: 28000,
    language: 'TypeScript',
    created_at: '2015-09-03T20:23:21Z',
    updated_at: '2024-01-16T09:45:00Z',
    pushed_at: '2024-01-16T09:45:00Z',
    owner: {
      login: 'microsoft',
      avatar_url: 'https://avatars.githubusercontent.com/u/6154722?v=4'
    },
    topics: ['editor', 'typescript', 'electron'],
    // Chinese description for VSCode
    ai_summary: '\u529f\u80fd\u5f3a\u5927\u7684\u4ee3\u7801\u7f16\u8f91\u5668\uff0c\u652f\u6301\u591a\u79cd\u7f16\u7a0b\u8bed\u8a00\u548c\u6269\u5c55',
    // Chinese for "code editor", "development tools", "IDE"
    ai_tags: ['\u4ee3\u7801\u7f16\u8f91\u5668', '\u5f00\u53d1\u5de5\u5177', 'IDE'],
    ai_platforms: ['windows', 'mac', 'linux']
  },
  {
    id: 4,
    name: 'obsidian-sample-plugin',
    full_name: 'obsidianmd/obsidian-sample-plugin',
    description: 'Sample plugin for Obsidian (https://obsidian.md)',
    html_url: 'https://github.com/obsidianmd/obsidian-sample-plugin',
    stargazers_count: 2500,
    forks_count: 1000,
    forks: 1000,
    language: 'TypeScript',
    created_at: '2020-10-15T14:30:00Z',
    updated_at: '2024-01-10T11:15:00Z',
    pushed_at: '2024-01-10T11:15:00Z',
    owner: {
      login: 'obsidianmd',
      avatar_url: 'https://avatars.githubusercontent.com/u/65011256?v=4'
    },
    topics: ['obsidian', 'plugin', 'notes', 'markdown'],
    // Chinese description for Obsidian plugin
    ai_summary: 'Obsidian\u7b14\u8bb0\u5e94\u7528\u7684\u793a\u4f8b\u63d2\u4ef6\uff0c\u5c55\u793a\u5982\u4f55\u5f00\u53d1\u7b14\u8bb0\u5de5\u5177\u6269\u5c55',
    // Chinese for "note tools", "plugin development", "productivity tools"
    ai_tags: ['\u7b14\u8bb0\u5de5\u5177', '\u63d2\u4ef6\u5f00\u53d1', '\u6548\u7387\u5de5\u5177'],
    ai_platforms: ['windows', 'mac', 'linux']
  },
  {
    id: 5,
    name: 'tensorflow',
    full_name: 'tensorflow/tensorflow',
    description: 'An Open Source Machine Learning Framework for Everyone',
    html_url: 'https://github.com/tensorflow/tensorflow',
    stargazers_count: 185000,
    forks_count: 74000,
    forks: 74000,
    language: 'C++',
    created_at: '2015-11-07T01:19:20Z',
    updated_at: '2024-01-16T14:20:00Z',
    pushed_at: '2024-01-16T14:20:00Z',
    owner: {
      login: 'tensorflow',
      avatar_url: 'https://avatars.githubusercontent.com/u/15658638?v=4'
    },
    topics: ['machine-learning', 'deep-learning', 'neural-networks', 'ai'],
    // Chinese description for TensorFlow
    ai_summary: '\u5f00\u6e90\u673a\u5668\u5b66\u4e60\u6846\u67b6\uff0c\u652f\u6301\u6df1\u5ea6\u5b66\u4e60\u548c\u795e\u7ecf\u7f51\u7edc\u5f00\u53d1',
    // Chinese for "machine learning", "AI framework", "deep learning"
    ai_tags: ['\u673a\u5668\u5b66\u4e60', 'AI\u6846\u67b6', '\u6df1\u5ea6\u5b66\u4e60'],
    ai_platforms: ['linux', 'mac', 'windows', 'docker']
  }
];

/**
 * Test real-time search functionality
 */
export function testRealTimeSearch(repositories: Repository[], query: string): Repository[] {
  if (!query.trim()) return repositories;
  
  const normalizedQuery = query.toLowerCase();
  return repositories.filter(repo => {
    return repo.name.toLowerCase().includes(normalizedQuery) ||
           repo.full_name.toLowerCase().includes(normalizedQuery);
  });
}

/**
 * Test basic text search functionality
 */
export function testBasicTextSearch(repositories: Repository[], query: string): Repository[] {
  if (!query.trim()) return repositories;
  
  const normalizedQuery = query.toLowerCase();
  
  return repositories.filter(repo => {
    const searchableText = [
      repo.name,
      repo.full_name,
      repo.description || '',
      repo.language || '',
      ...(repo.topics || []),
      repo.ai_summary || '',
      ...(repo.ai_tags || []),
      ...(repo.ai_platforms || []),
    ].join(' ').toLowerCase();
    
    // Split query into words and check if all words are present
    const queryWords = normalizedQuery.split(/\s+/);
    return queryWords.every(word => searchableText.includes(word));
  });
}

/**
 * Test search scenarios
 */
export const searchTestCases: SearchTestCase[] = [
  {
    name: 'Real-time search - repository name matching',
    type: 'realtime',
    queries: [
      { query: 'react', expectedCount: 1, description: 'Should find react repository' },
      { query: 'vue', expectedCount: 1, description: 'Should find vue repository' },
      { query: 'vs', expectedCount: 1, description: 'Should find vscode repository' },
      { query: 'obsidian', expectedCount: 1, description: 'Should find obsidian-related repository' }
    ]
  },
  {
    name: 'Basic text search - multi-field matching',
    type: 'basic',
    queries: [
      { query: 'javascript', expectedCount: 2, description: 'Should find JavaScript-related repositories' },
      // Chinese for "frontend framework"
      { query: '\u524d\u7aef\u6846\u67b6', expectedCount: 2, description: 'Should find frontend framework-related repositories' },
      { query: 'machine learning', expectedCount: 1, description: 'Should find machine learning-related repository' },
      // Chinese for "notes"
      { query: '\u7b14\u8bb0', expectedCount: 1, description: 'Should find note-related repository' },
      { query: 'editor', expectedCount: 1, description: 'Should find editor-related repository' }
    ]
  },
  {
    name: 'AI search test scenarios',
    type: 'ai',
    queries: [
      // Chinese for "Find all frontend frameworks"
      { query: '\u67e5\u627e\u6240\u6709\u524d\u7aef\u6846\u67b6', description: 'Should match React and Vue' },
      { query: 'find note-taking apps', description: 'Should match Obsidian plugin' },
      // Chinese for "code editor"
      { query: '\u4ee3\u7801\u7f16\u8f91\u5668', description: 'Should match VSCode' },
      // Chinese for "AI tools"
      { query: 'AI\u5de5\u5177', description: 'Should match TensorFlow' },
      { query: 'web development tools', description: 'Should match frontend-related tools' }
    ]
  }
];

/**
 * Run search tests
 */
export function runSearchTests(): void {
  console.log('🔍 Starting search feature tests...\n');
  
  searchTestCases.forEach(testCase => {
    console.log(`📋 Test type: ${testCase.name}`);
    
    if (testCase.type === 'realtime') {
      testCase.queries.forEach(({ query, expectedCount, description }) => {
        const results = testRealTimeSearch(mockRepositories, query);
        const passed = results.length === expectedCount;
        console.log(`  ${passed ? '✅' : '❌'} "${query}" - ${description} (expected: ${expectedCount}, actual: ${results.length})`);
        if (!passed) {
          console.log(`    Found repositories: ${results.map(r => r.name).join(', ')}`);
        }
      });
    } else if (testCase.type === 'basic') {
      testCase.queries.forEach(({ query, expectedCount, description }) => {
        const results = testBasicTextSearch(mockRepositories, query);
        const passed = results.length === expectedCount;
        console.log(`  ${passed ? '✅' : '❌'} "${query}" - ${description} (expected: ${expectedCount}, actual: ${results.length})`);
        if (!passed) {
          console.log(`    Found repositories: ${results.map(r => r.name).join(', ')}`);
        }
      });
    } else if (testCase.type === 'ai') {
      testCase.queries.forEach(({ query, description }) => {
        console.log(`  🤖 "${query}" - ${description} (requires AI service support)`);
      });
    }
    
    console.log('');
  });
  
  console.log('🎉 Search feature tests completed!');
}

/**
 * Performance test
 */
export function performanceTest(repositories: Repository[], iterations: number = 1000): void {
  console.log(`⚡ Starting performance test (${iterations} iterations)...\n`);
  
  // Includes Chinese for "frontend"
  const testQueries = ['react', 'javascript', '\u524d\u7aef', 'machine learning'];
  
  testQueries.forEach(query => {
    // Real-time search performance test
    const realtimeStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      testRealTimeSearch(repositories, query);
    }
    const realtimeEnd = performance.now();
    const realtimeAvg = (realtimeEnd - realtimeStart) / iterations;
    
    // Basic search performance test
    const basicStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      testBasicTextSearch(repositories, query);
    }
    const basicEnd = performance.now();
    const basicAvg = (basicEnd - basicStart) / iterations;
    
    console.log(`Query "${query}":`);
    console.log(`  Real-time search average time: ${realtimeAvg.toFixed(3)}ms`);
    console.log(`  Basic search average time: ${basicAvg.toFixed(3)}ms`);
    console.log(`  Performance ratio: ${(basicAvg / realtimeAvg).toFixed(2)}x\n`);
  });
}

/**
 * Chinese input method test scenarios
 */
export const imeTestCases = [
  {
    description: 'Chinese Pinyin input test',
    scenarios: [
      // Chinese for "front"
      { input: 'qian', expected: '\u524d', description: 'Search should not trigger during Pinyin composition' },
      // Chinese for "frontend"
      { input: 'qianduan', expected: '\u524d\u7aef', description: 'Complete Pinyin input' },
      // Chinese for "notes"
      { input: 'biji', expected: '\u7b14\u8bb0', description: 'Note application search' }
    ]
  }
];

// Export test functions for developer use
export default {
  mockRepositories,
  testRealTimeSearch,
  testBasicTextSearch,
  searchTestCases,
  runSearchTests,
  performanceTest,
  imeTestCases
};