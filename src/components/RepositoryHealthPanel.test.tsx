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
  const trigger = screen.getByRole('button', { name: /Repository overview/ });
  if (trigger.getAttribute('aria-expanded') !== 'true') {
    await userEvent.click(trigger);
  }
}

// Copy is retrieved via useT; tests use English strings from src/locales/en.
describe('RepositoryHealthPanel', () => {
  it('defaults to collapsed, expands facts after clicking the header', async () => {
    render(<RepositoryHealthPanel repository={makeRepo()} releases={[release]} language="en" />);

    const trigger = screen.getByRole('button', { name: /Repository overview/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Activity')).not.toBeInTheDocument();

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Activity')).toBeVisible();
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
    render(<RepositoryHealthPanel repository={makeRepo()} releases={[release]} language="en" />);
    await expandPanel();

    for (const label of ['Activity', 'Maintenance', 'Community', 'Maturity']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('explicitly states it does not contain an aggregate health score', async () => {
    render(<RepositoryHealthPanel repository={makeRepo()} releases={[release]} language="en" />);
    await expandPanel();

    expect(
      screen.getByText('These are objective facts with no overall score. “Unknown” means the fact has not been obtained yet.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/health score/i)).not.toBeInTheDocument();
  });

  it('displays conservative observations as neutral information', async () => {
    render(
      <RepositoryHealthPanel
        repository={makeRepo({ archived: true, pushed_at: '2020-01-01T00:00:00.000Z' })}
        releases={[release]}
        language="en"
      />,
    );

    // Collapsed state still shows neutral observation badges
    expect(screen.getByText('No pushes in 12 months')).toBeInTheDocument();
    expect(screen.queryByText(/unhealthy|deprecated/i)).not.toBeInTheDocument();

    await expandPanel();
    // "Archived" appears in both observation badges and maintenance group fact rows
    expect(screen.getAllByText('Archived').length).toBeGreaterThanOrEqual(2);
  });

  it('displays unknown facts as "Unknown" rather than guessing', async () => {
    render(<RepositoryHealthPanel repository={makeRepo()} releases={[release]} language="en" />);
    await expandPanel();

    // Contributors require network fetch to populate; no local data available
    const contributorsRow = screen.getByText('Contributors').closest('div');
    expect(contributorsRow).not.toBeNull();
    expect(within(contributorsRow as HTMLElement).getByText('Unknown')).toBeInTheDocument();
  });

  it('does not report "No releases" when Release data is absent', async () => {
    render(
      <RepositoryHealthPanel
        repository={makeRepo({ has_fetched_releases: true })}
        releases={undefined}
        language="en"
      />,
    );
    await expandPanel();

    expect(screen.queryByText('No releases')).not.toBeInTheDocument();
    // Facts unrelated to Release are still displayed
    expect(screen.getByText('Stars')).toBeInTheDocument();
  });

  it('reports Release facts normally after obtaining Release data', async () => {
    render(
      <RepositoryHealthPanel
        repository={makeRepo({ has_fetched_releases: true })}
        releases={[]}
        language="en"
      />,
    );
    await expandPanel();

    expect(screen.getByText('No releases')).toBeInTheDocument();
  });
});
