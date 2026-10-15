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
    ai_summary: '一个用于构建用户界面的声明式、高效且灵活的JavaScript库',
    ai_tags: ['前端框架', 'UI库', 'JavaScript工具'],
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
    ai_summary: '渐进式、可逐步采用的JavaScript框架，用于构建Web UI',
    ai_tags: ['前端框架', 'Web应用', 'JavaScript工具'],
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
    ai_summary: '功能强大的代码编辑器，支持多种编程语言和扩展',
    ai_tags: ['代码编辑器', '开发工具', 'IDE'],
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
    ai_summary: 'Obsidian笔记应用的示例插件，展示如何开发笔记工具扩展',
    ai_tags: ['笔记工具', '插件开发', '效率工具'],
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
    ai_summary: '开源机器学习框架，支持深度学习和神经网络开发',
    ai_tags: ['机器学习', 'AI框架', '深度学习'],
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
      { query: '前端框架', expectedCount: 2, description: 'Should find frontend framework-related repositories' },
      { query: 'machine learning', expectedCount: 1, description: 'Should find machine learning-related repository' },
      { query: '笔记', expectedCount: 1, description: 'Should find note-related repository' },
      { query: 'editor', expectedCount: 1, description: 'Should find editor-related repository' }
    ]
  },
  {
    name: 'AI search test scenarios',
    type: 'ai',
    queries: [
      { query: '查找所有前端框架', description: 'Should match React and Vue' },
      { query: 'find note-taking apps', description: 'Should match Obsidian plugin' },
      { query: '代码编辑器', description: 'Should match VSCode' },
      { query: 'AI工具', description: 'Should match TensorFlow' },
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
  
  const testQueries = ['react', 'javascript', '前端', 'machine learning'];
  
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
      { input: 'qian', expected: '前', description: 'Search should not trigger during Pinyin composition' },
      { input: 'qianduan', expected: '前端', description: 'Complete Pinyin input' },
      { input: 'biji', expected: '笔记', description: 'Note application search' }
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