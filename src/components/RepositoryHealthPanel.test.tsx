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
  const trigger = screen.getByRole('button', { name: /\u4ed3\u5e93\u6982\u51b5/ }); // Chinese for "Repository Overview"
  if (trigger.getAttribute('aria-expanded') !== 'true') {
    await userEvent.click(trigger);
  }
}

// Copy is retrieved via useT; test environment defaults to language 'zh' (see src/test/setup.ts), hence Chinese assertions.
describe('RepositoryHealthPanel', () => {
  it('defaults to collapsed, expands facts after clicking the header', async () => {
    render(<RepositoryHealthPanel repository={makeRepo()} releases={[release]} language="zh" />);

    const trigger = screen.getByRole('button', { name: /\u4ed3\u5e93\u6982\u51b5/ }); // Chinese for "Repository Overview"
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('\u6d3b\u8dc3\u5ea6')).not.toBeInTheDocument(); // Chinese for "Activity"

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('\u6d3b\u8dc3\u5ea6')).toBeVisible(); // Chinese for "Activity"
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
    // language only drives date-fns; ja locale uses Japanese "about N years ago", distinct from Chinese.
    expect(screen.getByText(/\u7d04\d+(\.\d+)?\u5e74\u524d/)).toBeInTheDocument(); // Japanese for "about N years ago"
  });

  it('displays facts across four fixed groups', async () => {
    render(<RepositoryHealthPanel repository={makeRepo()} releases={[release]} language="zh" />);
    await expandPanel();

    for (const label of ['\u6d3b\u8dc3\u5ea6', '\u7ef4\u62a4', '\u793e\u533a', '\u6210\u719f\u5ea6']) { // "Activity", "Maintenance", "Community", "Maturity"
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('explicitly states it does not contain an aggregate health score', async () => {
    render(<RepositoryHealthPanel repository={makeRepo()} releases={[release]} language="zh" />);
    await expandPanel();

    expect(
      screen.getByText('\u4ee5\u4e0a\u4e3a\u5ba2\u89c2\u4e8b\u5b9e\uff0c\u4e0d\u542b\u5065\u5eb7\u603b\u5206\u3002\u300c\u672a\u77e5\u300d\u8868\u793a\u5c1a\u672a\u83b7\u5f97\u8be5\u4e8b\u5b9e\u3002'), // Objective facts disclaimer
    ).toBeInTheDocument();
    expect(screen.queryByText(/\u5065\u5eb7\u8bc4\u5206|\u5065\u5eb7\u5206\u6570/)).not.toBeInTheDocument(); // "Health score"
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
    expect(screen.getByText('\u8fd1 12 \u4e2a\u6708\u65e0\u63a8\u9001')).toBeInTheDocument(); // "No pushes in last 12 months"
    expect(screen.queryByText(/\u4e0d\u5065\u5eb7|\u5df2\u5e9f\u5f03/)).not.toBeInTheDocument(); // "Unhealthy / Deprecated"

    await expandPanel();
    // "Archived" appears in both observation badges and maintenance group fact rows
    expect(screen.getAllByText('\u5df2\u5f52\u6863').length).toBeGreaterThanOrEqual(2); // "Archived"
  });

  it('displays unknown facts as "Unknown" rather than guessing', async () => {
    render(<RepositoryHealthPanel repository={makeRepo()} releases={[release]} language="zh" />);
    await expandPanel();

    // Contributors require network fetch to populate; no local data available
    const contributorsRow = screen.getByText('\u8d21\u732e\u8005').closest('div'); // "Contributors"
    expect(contributorsRow).not.toBeNull();
    expect(within(contributorsRow as HTMLElement).getByText('\u672a\u77e5')).toBeInTheDocument(); // "Unknown"
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

    expect(screen.queryByText('\u65e0 Release')).not.toBeInTheDocument(); // "No Release"
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

    expect(screen.getByText('\u65e0 Release')).toBeInTheDocument(); // "No Release"
  });
});
