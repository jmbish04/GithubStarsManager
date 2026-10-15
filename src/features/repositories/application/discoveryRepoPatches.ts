import type { DiscoveryRepo } from '../../../types';

export interface DiscoveryAnalysisSuccessInput {
  summary: string | undefined;
  tags: string[] | undefined;
  platforms: string[] | undefined;
  analyzedAt: string;
  analysisFailed: boolean | undefined;
}

export interface DiscoveryAnalysisFailureInput {
  analyzedAt: string;
  analysisFailed: boolean | undefined;
  analysisError: string | undefined;
}

// Patch shape for single-card analysis on Discovery page: differs from repositoryPatches.applyAnalysisSuccess
// — does not include custom_category/category_locked; both input and output are DiscoveryRepo (preserving rank/channel/platform).
export const applyDiscoveryAnalysisSuccess = (
  repo: DiscoveryRepo,
  input: DiscoveryAnalysisSuccessInput,
): DiscoveryRepo => ({
  ...repo,
  ai_summary: input.summary,
  ai_tags: input.tags,
  ai_platforms: input.platforms,
  analyzed_at: input.analyzedAt,
  analysis_failed: input.analysisFailed,
  analysis_error: undefined,
});

export const applyDiscoveryAnalysisFailure = (
  repo: DiscoveryRepo,
  input: DiscoveryAnalysisFailureInput,
): DiscoveryRepo => ({
  ...repo,
  analyzed_at: input.analyzedAt,
  analysis_failed: input.analysisFailed,
  analysis_error: input.analysisError,
});
