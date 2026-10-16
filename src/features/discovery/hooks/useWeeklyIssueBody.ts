
import { useT } from '../../../i18n/useT';
import { useEffect, useState } from 'react';
import { createGitHubApiService } from '../../../services/githubApiFactory';
import { fetchWeeklyIssueBody } from '../../../services/weeklyIssuesService';
import type { WeeklyStoredIssue } from '../../../services/weeklyIssuesStorage';
import { useAppStore } from '../../../store/useAppStore';

/**
 * Body content loader for the "View Original Post" modal: prefers local synchronized cache,
 * falling back to real-time fetch when absent. Business service calls are encapsulated in the
 * feature hook layer; view components must not directly depend on services.
 */
export const useWeeklyIssueBody = (issueNumber: number, enabled: boolean) => {
  const githubToken = useAppStore(state => state.githubToken);
  const language = useAppStore(state => state.language);
  const t = useT('discovery');
  const [issueData, setIssueData] = useState<WeeklyStoredIssue | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !issueNumber) return;
    let cancelled = false;
    setIssueData(null);
    setError(null);
    setLoading(true);
    const load = async () => {
      // Cache hits do not require a token (logging out does not clear the weekly cache); only instantiate the API to fetch from upstream when there is a cache miss and a token exists
      try {
        const api = githubToken ? createGitHubApiService(githubToken) : null;
        const result = await fetchWeeklyIssueBody(api, issueNumber);
        if (!cancelled) {
          setIssueData(result);
          if (!result?.body) {
            setError(language === 'zh'
              ? (githubToken ? 'No content available' : 'GitHub token not found. Please login again.')
              : (githubToken ? 'No content available' : 'GitHub token not found. Please login again.'));
          }
        }
      } catch {
        if (!cancelled) {
          setError(t('useWeeklyIssueBody.failed-to-load-content-please-check-your-network'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [enabled, issueNumber, githubToken, language, t]);

  return { issueData, loading, error };
};
