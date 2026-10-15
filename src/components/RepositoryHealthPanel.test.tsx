import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Release, Repository } from '../types';
import { RepositoryHealthPanel } from './RepositoryHealthPanel';

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: 1,
    name: 'alpha',
    full_name: 'acme/alpha',
    description: 'A test repository',
    html_url: 'https://github.com/acme/alpha',
    stargazers_count: 1500,
    forks_count: 120,
    forks: 120,
    language: 'TypeScript',
    created_at: '2020-09-17T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    pushed_at: '2026-09-01T00:00:00.000Z',
    owner: { login: 'acme', avatar_url: '' },
    topics: [],
    license: 'MIT',
    ...overrides,
  };
}

const release: Release = {
  id: 1,
  tag_name: 'v1.2.0',
  name: 'v1.2.0',
  body: null,
  published_at: '2026-08-01T00:00:00.000Z',
  html_url: 'https://github.com/acme/alpha/releases/tag/v1.2.0',
  assets: [],
  repository: { id: 1, full_name: 'acme/alpha', name: 'alpha' },
};

async function expandPanel() {
  const trigger = screen.getByRole('button', { name: /仓库概况/ });
  if (trigger.getAttribute('aria-expanded') !== 'true') {
    await userEvent.click(trigger);
  }
}

// Copy is retrieved via useT; test environment defaults to language 'zh' (see src/test/setup.ts), hence Chinese assertions.
describe('RepositoryHealthPanel', () => {
  it('defaults to collapsed, expands facts after clicking the header', async () => {
    render(<RepositoryHealthPanel repository={makeRepo()} releases={[release]} language="zh" />);

    const trigger = screen.getByRole('button', { name: /仓库概况/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('活跃度')).not.toBeInTheDocument();

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('活跃度')).toBeVisible();
  });

  it('formats relative time using the date-fns locale corresponding to language', async () => {
    render(
      <RepositoryHealthPanel
        repository={makeRepo({ created_at: '2020-09-17T00:00:00.000Z' })}
        releases={[release]}
        language="ja"
      />,
    );

    await expandPanel();
    // language only drives date-fns; ja locale uses "約N年前", distinct from Chinese "约N年前".
    expect(screen.getByText(/約\d+(\.\d+)?年前/)).toBeInTheDocument();
  });

  it('displays facts across four fixed groups', async () => {
    render(<RepositoryHealthPanel repository={makeRepo()} releases={[release]} language="zh" />);
    await expandPanel();

    for (const label of ['活跃度', '维护', '社区', '成熟度']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('explicitly states it does not contain an aggregate health score', async () => {
    render(<RepositoryHealthPanel repository={makeRepo()} releases={[release]} language="zh" />);
    await expandPanel();

    expect(
      screen.getByText('以上为客观事实，不含健康总分。「未知」表示尚未获得该事实。'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/健康评分|健康分数/)).not.toBeInTheDocument();
  });

  it('displays conservative observations as neutral information', async () => {
    render(
      <RepositoryHealthPanel
        repository={makeRepo({ archived: true, pushed_at: '2020-01-01T00:00:00.000Z' })}
        releases={[release]}
        language="zh"
      />,
    );

    // Collapsed state still shows neutral observation badges
    expect(screen.getByText('近 12 个月无推送')).toBeInTheDocument();
    expect(screen.queryByText(/不健康|已废弃/)).not.toBeInTheDocument();

    await expandPanel();
    // "Archived" appears in both observation badges and maintenance group fact rows
    expect(screen.getAllByText('已归档').length).toBeGreaterThanOrEqual(2);
  });

  it('displays unknown facts as "Unknown" rather than guessing', async () => {
    render(<RepositoryHealthPanel repository={makeRepo()} releases={[release]} language="zh" />);
    await expandPanel();

    // Contributors require network fetch to populate; no local data available
    const contributorsRow = screen.getByText('贡献者').closest('div');
    expect(contributorsRow).not.toBeNull();
    expect(within(contributorsRow as HTMLElement).getByText('未知')).toBeInTheDocument();
  });

  it('does not report "No releases" when Release data is absent', async () => {
    render(
      <RepositoryHealthPanel
        repository={makeRepo({ has_fetched_releases: true })}
        releases={undefined}
        language="zh"
      />,
    );
    await expandPanel();

    expect(screen.queryByText('无 Release')).not.toBeInTheDocument();
    // Facts unrelated to Release are still displayed
    expect(screen.getByText('Stars')).toBeInTheDocument();
  });

  it('reports Release facts normally after obtaining Release data', async () => {
    render(
      <RepositoryHealthPanel
        repository={makeRepo({ has_fetched_releases: true })}
        releases={[]}
        language="zh"
      />,
    );
    await expandPanel();

    expect(screen.getByText('无 Release')).toBeInTheDocument();
  });
});
