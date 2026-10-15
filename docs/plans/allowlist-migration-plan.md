# Allowlist Zero-Out Migration Implementation Specification v2 (ADR 0001 · Option B: Relocate + Refine Inline · Single PR)

- **Status**: Implementation Specification (Accepted on merge)
- **Repository Root**: This repository (GithubStarsManager)
- **Contract**: `docs/adr/0001-frontend-layering.md` (View → Hook → Application → Service → Store)
- **Goal**: Fully **remove the mechanism** (not just empty the array) of `COMPONENT_BOUNDARY_ALLOWLIST` in `eslint.config.js` (lines 52–63, exactly 10 entries) and `COMPONENT_ALLOWLIST` in `scripts/check-boundaries.cjs` (lines 48–59, mirroring 10 entries); consolidate direct service calls and store writes across all 10 View components into hooks.
- **Behavior Baseline**: Zero behavioral changes. Exceptions = **8 micro-differences / equivalent adjustments** declared in the PR description (3 specification presets in §2.5 + 5 implementation supplements; the PR description checklist serves as the authoritative source of truth); GistEditorModal type uncoupling has zero behavioral impact.
- **Audit Findings Absorbed**: Round 1 A1–A8 + Round 2 B1–B8 (two tables in Appendix, all 16 items addressed throughout this document).
- **Text Fidelity Rule**: All toast, confirm, and error messages **must be copied verbatim from existing code**; do not paraphrase, summarize, or "improve" phrasing. Strings in this document are for reference and location identification only.

---

## 0. Background and Current Status (10 Allowlist Entries)

PRs 0–8 completed non-breaking migration; PR 9 locked boundaries via ESLint + `check-boundaries.cjs`, retaining a 10-item phased allowlist. **The two allowlist constants are the sole source of truth** (the 13-item illustrative list in ADR §Phased enforcement is outdated: LoginScreen, CategorySidebar, and DebugModeIndicator no longer contain violations; do not investigate them).

12 banned services (`eslint.config.js:16-29` and `check-boundaries.cjs:32-45` match): `githubApi / aiService / aiAnalysisHelper / aiAnalysisOptimizer / vectorSearchService / autoSync / webdavService / backendAdapter / rpcDownloadService / githubApiFactory / updateService / translateService`. Note that the ADR text still mentions 10 items (claiming updateService/translateService were not banned)—**the documentation lags behind the implementation; treat 12 items as authoritative**, with ADR errata tracked as follow-up (§10); this PR does not modify ADRs.

| # | File | Direct Service References | Migration Target |
|---|---|---|---|
| 1 | `src/components/SearchBar.tsx` | aiService, vectorSearchService, githubApi, githubApiFactory, autoSync (5 services, largest file, 1,618 lines) | `useSearchActions` (new, in repositories/hooks) |
| 2 | `src/components/SubscriptionRepoCard.tsx` | aiAnalysisHelper, autoSync, githubApi | `useDiscoveryRepoActions` (new, in discovery/hooks) |
| 3 | `src/components/GistCard.tsx` | githubApiFactory, aiService | `useGistActions` (extended) |
| 4 | `src/components/GistDetailModal.tsx` | githubApiFactory | `useGistActions.fetchGistFileRaw` (extended) |
| 5 | `src/components/GistEditorModal.tsx` | `import type` only, zero runtime (false positive) | Re-export types from `useGistActions` (§5) |
| 6 | `src/components/ReleaseCard.tsx` | rpcDownloadService, aiService | `useReleaseArtifactActions` (new, in src/hooks) |
| 7 | `src/components/ReadmeModal.tsx` | githubApi, backendAdapter (also imports routeMode, not banned) | `useReadmeFetch` (new, in src/hooks) |
| 8 | `src/components/ReleaseSourceSettingsModal.tsx` | githubApi | `useReleaseTimelineActions.syncWatchedSources` (new method) |
| 9 | `src/components/RepositoryEditModal.tsx` | autoSync (1 call site only) | `useCategorySyncActions` (existing, direct reuse) |
| 10 | `src/components/SettingsPanel.tsx` | backendAdapter.backend.isAvailable gate | `useBackendAvailability` (new, in settings/hooks) |

`src/components/ui/**` contains zero violations and remains untouched. `updateService/translateService` already have zero violations in components; do not investigate further during execution (Round 1 A6).

---

## 1. General Principles

### 1.1 Core Rules

1. **Relocate Only, Do Not Alter Semantics**: Relocate each action line-by-line following the §1.2 order-preserving table, including toast/confirm strings, console diagnostics, error branches, and fallback paths.
2. **Analysis Actions Do Not forceSync**: Only star / unstar / save / sync actions invoke `forceSyncToBackend()`, with await points identical to original files (see §1.2, hard constraint).
3. **API Conventions Align with Precedents**: Zero-argument hooks construct `t` internally (following `useGistActions`/`useReleaseTimelineActions`); hooks requiring injection accept `{ t }` arguments (following `useStarSyncActions`/`useBackendSettingsActions`); confirm/toast go through `useDialog`; store reads use selectors + `useShallow`; return values are stabilized with `useMemo` (following `useRepositoryCardActions`; existing files being extended retain their existing style without retroactive refactoring).
4. **Preserve `getState()` for Non-Reactive Store Reads**: Where original files read non-reactively via `useAppStore.getState()` (e.g., vsConfig/storeRepos in SearchBar), retain `getState()` rather than switching to reactive selectors.

### 1.2 Action Order-Preserving Table (Match 1:1 During Relocation; **Bold** Indicates forceSync Points)

| # | Source Action (File:Lines, Baseline Lines) | Original Execution Sequence (→ denotes order) | Destination |
|---|---|---|---|
| 1 | SearchBar.handleAISearch (370-559) | View-UI state remains in View → isSearching/searchPhase → vectorScoreMapRef reset → [vsConfig gate (enabled && workerUrl && activeEmbConfig) → new EmbeddingClient/VectorSearchService per search → HyDE (only if enableHyDE!==false && hydeConfig; local AbortController + Promise.race 5s timeout fallback to raw query) → embed → query(topK??30, threshold??0.35) → local keyword boost → AI rerank (only if enableReranking!==false, no signal; failures console.warn and fall back to vector order) → setSearchResults + setSearchFilters + skipNextTextSearchRef=true + vectorScoreMapRef write + return] or keyword branch [activeConfig? → searchRepositoriesWithReranking (fallback to performBasicTextSearch on error): performBasicTextSearch] → applyFilters(results) → setSearchResults → setSearchFilters | useSearchActions.aiSearch / keywordSearch |
| 2 | SearchBar.handleStarSync (714-926) | token check toast → setSyncingStars(true) → new GitHubApiService → getAllStarredRepositories → merge field-by-field with getState().repositories (license `?? null` backfill) → [for stars-and-lists: createGitHubListsApiService → getUserLists(login) (throws without login) → create missing custom categories (addCustomCategory, id=`custom-sync-${Date.now()}-${idx}`) → preExistingLocked set → tag/categorize/lock loop → appliedTagsCount toast (two phrasing branches) → list failures toast and **continue without breaking** star results] → setRepositories(final) → **await forceSyncToBackend()** → setLastSync → new repo count toast (success/info branches) → catch: message containing 'token' dedicated branch / generic toast → finally setSyncingStars(false) | useSearchActions.syncStars |
| 3 | SearchBar.handleStarAndListSync (941-958) | confirm(warning, original copy) → handleStarSync('stars-and-lists') | **View retains confirm wrapper** (§2.1; 'auto'/'stars-only' entries had no confirm originally, do not add) |
| 4 | SubscriptionRepoCard.executeUnstar (91-125) | Silent return if no token → setIsStarring → optimistic setOptimisticStarred(false) → new GitHubApiService → unstarRepository(owner,name) → deleteRepository(find id by full_name) → **await forceSyncToBackend()** → reset optimistic to null; catch: rollback optimistic + toast (original copy); finally setIsStarring(false). **No toast on success**. Confirmation uses custom Modal (remains in View, B8) | useDiscoveryRepoActions.executeUnstar |
| 5 | SubscriptionRepoCard.handleStar (128-183) | Short-circuit if isStarring → optimistic(true) → starRepository(owner,name) → construct repositoryToAdd (rank/channel/platform set to undefined + starred_at) → addRepository → onStar(repo) → **await forceSyncToBackend()** → reset optimistic to null → success toast; catch rollback + toast | useDiscoveryRepoActions.star |
| 6 | SubscriptionRepoCard.handleAnalyze (193-274) | 4-step validation toasts (token → missing config → apiKeyStatus → baseUrl/apiKey/model; **copy strings from original file**, distinct from useRepositoryCardActions) → short-circuit if isAnalyzing → abort previous request (abortControllerRef, unmount abort) → analyzeRepository({repository: repo, githubToken, aiConfig, language, categories, signal}) (aiAnalysisHelper) → return if aborted → success patch (ai_summary/ai_tags/ai_platforms/analyzed_at/analysis_failed/analysis_error:undefined, **no custom_category/category_locked**) → updateDiscoveryRepo → onAnalyze(updatedRepo). **No forceSync, no success toast, no re-analyze confirm** (do not "align" with RepositoryCard); catch (non-abort): createFailedAnalysisResult → failure patch → updateDiscoveryRepo → toast | useDiscoveryRepoActions.analyze |
| 7 | GistCard.handleAnalyze (68-120) | 3-step validation (gist-specific original copy) → if already analyzed, confirm overwrite (original copy) → setAnalyzingGist(id,true) (store) + local flag → createGitHubApiService → getGistForAnalysis(id, gist) → new AIService → analyzeGist(detail, api.getGistContentPreview(detail)) (**no Abort**) → updateGist(success patch) → toast; catch → updateGist(failure patch) → toast; finally reset both flags. **No forceSync** | useGistActions.analyzeOne |
| 8 | GistCard.handleUnstar (122-143) | Silent return if no token → confirm(warning + confirmText original copy) → api.unstarGist(id) → onUnstarred(gist.id) → updateGist({starred:false}) → toast; catch toast. **No forceSync** | useGistActions.unstarGist |
| 9 | GistCard.handleDelete (145-174) | Silent return if no token / !isMine → confirm(danger + confirmText original copy) → api.deleteGist(id) → store.deleteGist → onDeleted(gist.id) → toast; catch: 403/404/forbidden/scope/permission → permission hint toast (original copy). **No forceSync** | useGistActions.deleteGist |
| 10 | GistDetailModal.HighlightedCode effect (45-80) | needsRawFetch=(truncated\|\|!content)&&raw_url → local AbortController (cleanup abort) → no token: setRawError(original copy) → createGitHubApiService().getGistFileRaw(raw_url, signal) → setRawContent + onContentLoaded callback (local cache + store updateGist, key `${gist.id}:${filename}:${rawUrl}`); catch: abort returns early, 'Aborted' → canceled copy; retry button increments retryTick. **Abort/retry/local cache remain in View** | useGistActions.fetchGistFileRaw |
| 11 | ReleaseCard.handleRpcDownload (120-155) | key=`${url}@${updatedAt??''}` → short-circuit if sending → retry clears sent first → forceUpdate → sendToRpcDownload(url, name, backendApiSecret\|\|undefined) (**3 parameters**) → success: mark sent + toast; failure: 'RPC service not running' branch / result.error / generic failure → toast(error); catch: RPC not running copy → toast; finally sending=false + forceUpdate | useReleaseArtifactActions.sendRpcDownload |
| 12 | ReleaseCard.runSummaryAnalysis (160-206) | No activeConfig → toast (original copy) → abort previous (summaryAbortRef, unmount abort) → new AIService → analyzeReleaseSummary(release.body\|\|'', {repoName, tagName, releaseName}, signal) → done(content) + expand; catch AbortError silent return / otherwise error(message) + expand + toast. No store writes, **no forceSync**. Summary state machine idle/loading/done/error is ephemeral local state | useReleaseArtifactActions.generateSummary |
| 13 | ReadmeModal dual fetchers (332-392) | shouldBypassBackend()\|\|!backend.isAvailable → direct GitHubApiService (content path throws original copy if no token / candidates path returns [] if no token); otherwise backend.*, on failure if non-abort and has token → console.warn(original copy) + fallback to direct GitHubApiService. Two controllers, abort previous before fetch, abort + null on unmount/close | useReadmeFetch |
| 14 | ReleaseSourceSettingsModal → WatchCustomReleaseSyncPanel.handleSync (221-249) | Silent return if no token or isSyncing (no toast) → new GitHubApiService → getAllWatchedRepositories() (/user/subscriptions only) → repositoryToCustomReleaseRepository(repo, WATCH_CUSTOM_RELEASE_SOURCE_ID) mapping + preserve existing release_hidden → setReleaseSourceRepositories(sourceId, repos) (store) → toast(success); catch toast(error); finally reset isSyncing. **No forceSync, no confirm, no Abort** | useReleaseTimelineActions.syncWatchedSources |
| 15 | RepositoryEditModal.handleSave tail (402-404) | updateRepository(updatedRepo) → **await forceSyncToBackend()** → onClose() | Reuse useCategorySyncActions |

### 1.3 Invariants and Prohibitions (Red Lines)

- **Do Not Import Hooks Cross-Feature** (ADR footnote 2): `useDiscoveryRepoActions` must not import `useRepositoryCardActions` (replicate patterns, do not import); hooks may call only hooks in their own feature or shared hooks in `src/hooks/**`.
- **Do Not Create New Application Directories**: Only one new file in existing `src/features/repositories/application/` is permitted (§3.1); refined functions for search, gists, and releases are exported within their respective hook files. New application directories are tracked as follow-up items.
- **Do Not Mutate Store Slices**: Do not alter state/action signatures in any store slice; do not touch `partialize`, `migrate`, `merge`, or `version`; `src/store/useAppStore.modularization.test` must pass with zero changes.
- **Do Not Alter the 12 BANNED_COMPONENT_SERVICES**: The 12 items in both gate checks remain unchanged.
- **Do Not Set `allowTypeImports: true`**: `check-boundaries.cjs` regex `IMPORT_RE` (lines 74–75) also matches `import type`; updating only ESLint will break CI (A2).
- **Zero Banned Service Imports in Views**: Static imports, `import type`, dynamic `import()`, and `export from` are all prohibited; non-banned imports like `isElectron`, `logger`, and `routeMode` remain unchanged.
- **No Scope Creep or Phrasing Changes**: Do not introduce unrequested features; do not alter any confirm or toast copy.

### 1.4 Infrastructure Allowlist Scope (B7)

The boundary check is a **blacklist system**: any service outside the 12 banned items can still be imported by components. Existing infrastructure tools (not banned, permissible in components): `logger`, `electronProxy`/`isElectron`, `indexedDbStorage`, `mcpElectronBridge`, `aiRequestLimiter`, `discoveryAnalysisStorage`; plus `routeMode` (`shouldBypassBackend`)—an undocumented, unbanned factual infrastructure utility that **remains untouched in this PR** (its decision logic moves into hooks alongside fetch logic, §2.4).

### 1.5 Application Purity Gate Scope (B6)

The application layer gate (`eslint.config.js:125-180`, `check-boundaries.cjs:143-183`) **only blocks** `react/react-dom` imports and `**/store/**`, `**/services/**` paths. The prohibition on DOM/JSX is an architectural convention (ADR footnote 3) rather than an enforced rule—new pure function files should avoid DOM/JSX, but no new assertions are required for acceptance. Automated enforcement is tracked as follow-up (§10).

---

## 2. Hook API Design

### 2.1 `useSearchActions` (New `src/features/repositories/hooks/useSearchActions.ts`) — Heaviest

**Domain**: SearchBar searches starred repositories globally, belonging to the repositories domain. Zero-argument hook that constructs `t` internally (following `useGistActions`).

```ts
export interface SearchActions {
  isSearching: boolean;
  searchPhase: string | null;
  // Rendering refs: View filtering effect (SearchBar.tsx:239-277) reads/writes these; exposed as RefObject
  vectorScoreMapRef: MutableRefObject<{ query: string; scores: Map<string, number> } | null>;
  skipNextTextSearchRef: MutableRefObject<boolean>;
  aiSearch: (query: string, applyFilters: (repos: Repository[]) => Repository[]) => Promise<void>;
  keywordSearch: (query: string, applyFilters: (repos: Repository[]) => Repository[]) => Promise<void>;
  syncStars: (mode?: 'auto' | 'stars-only' | 'stars-and-lists') => Promise<void>;
}
```

- **Ref Ownership**: Writes occur in handleAISearch (moving to hook); reads occur in the View filtering effect (lines 242, 249, 252, 254, 264, 266, depending on View-local applyFilters closure and 17 filter dependencies). Relocating this effect entirely into the hook would expand change surface and risk drift. Therefore, **refs reside in the hook and are exposed as RefObjects for the View to read/write**—the lowest-risk boundary under "relocate without altering semantics". Document this contract in comments.
- **`applyFilters` Parameter**: Original handleAISearch calls the View-local closure at lines 490 and 546; the hook accepts it as a parameter (passed upon invocation to prevent stale closures) and invokes it at **the exact same two points**.
- `aiSearch`: Relocates non-UI portions of 370–559 line-by-line. UI aspects (setIsRealTimeSearch(false), setShowSearchHistory(false), setShowSuggestions(false), search history localStorage) **remain in View**; View's handleAISearch becomes a thin wrapper (§4.1). Hook execution begins from setIsSearching(true) + setSearchPhase(null) + resetting vectorScoreMapRef. Vector search gate reads `useAppStore.getState().vectorSearchConfig/embeddingConfigs` (retaining original timing). Vector hits: setSearchResults → setSearchFilters → skipNextTextSearchRef=true → return; misses/errors: `await keywordSearch(query, applyFilters)` (equivalent to original fall-through). Retains HyDE local controller + 5s race, rerank without signal, and console diagnostics.
- `keywordSearch`: Relocates 517–552. Uses hook selector for `repositories`; activeConfig branch → searchRepositoriesWithReranking (catch falls back to `performBasicTextSearch`, imported from utils, not services); missing config → performBasicTextSearch; tail applyFilters(filtered) → setSearchResults → setSearchFilters. Exposed separately for testability.
- `syncStars(mode='auto')`: Relocates 714–926 line-by-line (table #2). storeRepos uses `useAppStore.getState().repositories`; allCategories is computed in callback identically to View useMemo (getAllCategories(customCategories, language, hiddenDefaultCategoryIds, defaultCategoryOverrides)); lists element type inferred from `getUserLists` return (`src/services/githubListsApi.ts:502`).
- **Confirmation Ownership (B8)**: `syncStars` **does not embed confirmation**—original code only prompted for stars-and-lists dropdown; View retains handleStarAndListSync wrapper: confirm (original copy) → `syncStars('stars-and-lists')`.
- **Toasts**: All relocate into hook alongside actions. **Abort**: HyDE local controller only (relocates into hook without persistent ref).
- **Selector** (single useShallow block): `repositories, aiConfigs, activeAIConfig, language, setSearchFilters, setSearchResults, githubToken, setRepositories, setLastSync, setSyncingStars, syncMode, user, addCustomCategory, customCategories, hiddenDefaultCategoryIds, defaultCategoryOverrides`. Pure display fields like `isSyncingStars` stay in View's own selector.
- Return value stabilized via `useMemo` (refs are inherently stable).

### 2.2 `useGistActions` Extension (`src/features/gists/hooks/useGistActions.ts`)

Current State: Zero arguments, `useShallow(selectGistViewState)` (**already includes** updateGist/deleteGist/setAnalyzingGist, selectors.ts:97-116; no selector modifications needed), useDialog, internal t. Added members:

```ts
analyzeOne: (gist: Gist) => Promise<void>;
unstarGist: (gist: Gist, onUnstarred?: (gistId: string) => void) => Promise<void>;
deleteGist: (gist: Gist, onDeleted?: (gistId: string) => void) => Promise<void>;
fetchGistFileRaw: (rawUrl: string, signal?: AbortSignal) => Promise<string>;
isAnalyzingGist: (gistId: string) => boolean;
isMutating: boolean;
```

- `analyzeOne`: Relocates table #7; View retains `event.stopPropagation()` prefix. Overwrite confirmation **moves into hook**. Local isAnalyzingLocal and setAnalyzingGist are set/cleared synchronously, with rendered values matching the store set—the hook manipulates store analyzingGistIds and exposes `isAnalyzingGist(id)`. **Document this equivalence in code comments** to prevent future regressions. No Abort, no forceSync.
- `unstarGist/deleteGist`: View callbacks (onUnstarred/onDeleted) are passed as **parameters**, called at original points in sequence. Confirmations **move into hook** (original copy). `isMutating` remains in hook (instantiated per card, equivalent to card-local state).
- `fetchGistFileRaw(rawUrl, signal)`: Thin wrapper—throws if no token, with err.message matching GistDetailModal original copy **verbatim** (View catch assigns rawError, rendering identically to original); if token exists, calls `createGitHubApiService(token).getGistFileRaw(rawUrl, signal)`. **Abort belongs to View** (HighlightedCode local controller and retry logic remain untouched).
- Return object appends above members, preserving file's existing style without wrapping in extra useMemo.

### 2.3 `useDiscoveryRepoActions` (New `src/features/discovery/hooks/useDiscoveryRepoActions.ts`)

Note: `discovery/hooks/` already contains `useDiscoveryActions.ts` (channel loading / bulk analysis)—the new hook coexists with zero overlap (card-level actions). Names verified unique. **Do not import useRepositoryCardActions** (cross-feature red line); validation structure **mirrors** useRepositoryCardActions.analyze (B3), but copy uses SubscriptionRepoCard originals verbatim.

```ts
export interface UseDiscoveryRepoActionsOptions { repo: DiscoveryRepo; }
export interface DiscoveryRepoActions {
  analyze: (onAnalyzed?: (repo: DiscoveryRepo) => void) => Promise<void>;
  star: (onStar?: (repo: DiscoveryRepo) => void) => Promise<void>;
  executeUnstar: () => Promise<void>;
  isAnalyzing: boolean;
  isStarring: boolean;
  isStarred: boolean;          // optimisticStarred ?? isStarredComputed (original View formula)
  optimisticStarred: boolean | null;
}
```

- **Selector** (useShallow): `githubToken, aiConfigs, activeAIConfig, language, customCategories, repositories, updateDiscoveryRepo, addRepository, deleteRepository`; `isStarredComputed = repositories.some(r => r.full_name === repo.full_name)` wrapped in useMemo.
- `analyze(onAnalyzed?)`: Follows table #6 line-by-line. AbortController ref attached to hook; unmount effect aborts in-flight request. Success/failure patches use §3.1 pure functions. Preserves getAllCategories call site.
- `star(onStar?)`: Follows table #5; optimistic state `optimisticStarred` **moves from View to hook**; repositoryToAdd constructed via §3.2 pure function.
- `executeUnstar()`: Follows table #4. **No confirm**—unstar confirmation uses a custom Modal; **confirmation UI remains in View** (B8). The original finally block's `setPendingUnstarAction(null)` is View state; View confirm button becomes: `setUnstarConfirmOpen(false); setPendingUnstarAction(null); void executeUnstar();` (behaviorally equivalent).
- `isStarring` local state moves into hook (shared by star/unstar).

### 2.4 `useReadmeFetch` (New `src/hooks/useReadmeFetch.ts`, Shared Layer)

Rationale for shared layer: ReadmeModal is a generic owner/name props component used across multiple features; `src/hooks/` already has precedents like useAutoUpdateCheck calling services directly; ADR footnote 2 allows feature hooks and Views to call `src/hooks/**`.

```ts
export interface UseReadmeFetchOptions { owner: string; name: string; }
export interface ReadmeFetchActions {
  fetchReadmeContent: (variant: ReadmeVariant) => Promise<string>;              // 332-364 path
  fetchReadmeCandidates: (defaultBranch: string | undefined) => Promise<GitHubReadmeCandidateItem[]>; // 366-392 path
  cancel: () => void;  // aborts both controllers and resets to null; called when View closes; auto on unmount
}
export const pickReadmeCandidate = (
  variants: ReadmeVariant[], selectedKey: string | undefined, defaultVariant: ReadmeVariant,
): ReadmeVariant;  // ReadmeModal.tsx:468 find(...)||default extraction
```

- **Abort Belongs to Hook**: Hook maintains two controllers (content/candidates), aborting previous before each fetch; `useEffect(() => cancel, [])` cleans up on unmount. View removes its two refs and abort blocks, calling `cancel()` on close instead.
- **shouldBypassBackend Logic Relocates with Fetch**: routeMode import moves from View into hook.
- Selector: `githubToken, language` (useShallow). Backend-first → GitHub fallback hierarchy and console.warn copy copied verbatim (including candidates branch returning `[]` rather than throwing if no token). No toasts, confirms, or store writes.
- View retains `readmeCache`, variant tab state, and `buildReadmeVariants(candidates, language)` (from utils); line 468 variant resolution switches to `pickReadmeCandidate`.

### 2.5 `useReleaseArtifactActions` (New `src/hooks/useReleaseArtifactActions.ts`) + `useRepositoryReleaseSheet` Delegation

**Canonical Semantics = ReleaseCard Version** (migration target semantics take precedence); `useRepositoryReleaseSheet` (repositories/hooks:119, containing duplicate RPC+AI logic; avoid a third copy—A1) delegates to this hook.

```ts
export type ReleaseArtifactSummaryState =
  { status: 'idle' | 'loading' | 'done' | 'error'; content?: string; error?: string };
export interface ReleaseArtifactActions {
  summaries: Record<number, ReleaseArtifactSummaryState>;
  rpcDownloadStates: Record<string, 'idle' | 'sending' | 'sent'>;  // key = computeRpcDownloadKey(link)
  sendRpcDownload: (link: { url: string; name: string; updatedAt?: string }) => Promise<void>;
  generateSummary: (release: Release) => Promise<void>;
  cancelSummaryRequests: () => void;
  reset: () => void;  // Clear summaries/RPC state and abort pending requests (needed by sheet loadReleases)
}
export const computeRpcDownloadKey = (link: { url: string; updatedAt?: string }): string; // `${url}@${updatedAt ?? ''}`
```

- Zero-argument hook constructing `t` internally; selector (useShallow): `language, backendApiSecret, aiConfigs, activeAIConfig`.
- `sendRpcDownload(link)`: Follows table #11 line-by-line. Key computed via `computeRpcDownloadKey`; downloading/downloaded uses `useState` Records instead of refs + forceUpdate; 3-argument call: `sendToRpcDownload(link.url, link.name, backendApiSecret || undefined)`; retains 'RPC service not running' branch (original copy).
- `generateSummary(release)`: Follows table #12 + sheet guard (returns early if existing status is 'loading' or 'done' with content). `summaryAbortRefs: Record<number, AbortController>` maintained in hook; unmount effect aborts all. Missing activeConfig triggers toast (original copy) without updating state; AbortError handled silently.
- **useRepositoryReleaseSheet Delegation Changes** (completed in same commit to avoid third copy):
  1. Remove sendToRpcDownload/AIService imports, summaryAbortRefs, inline generateSummary (288–329), and sendAssetToRpc (231–249).
  2. Instantiate `useReleaseArtifactActions()` internally; forward generateSummary directly; sendAssetToRpc becomes `if (!rpcDownloadConfig.enabled) return; await actions.sendRpcDownload(link);` (enabled guard remains in sheet; handled by button visibility in ReleaseCard).
  3. summaries/downloadStates mapped from hook via computeRpcDownloadKey (RepositoryReleaseSheet UI and tests updated to match).
  4. cancelPendingRequests retains fetch abort and delegates summary cancellation to cancelSummaryRequests.
  4b. loadReleases clears summaries/rpcDownloadStates via `reset()` on shared hook: reset invokes `cancelSummaryRequests()` before clearing state, preventing late response writes.
  5. **3 Documented Micro-Differences (declared in PR description)**: (1) Deduplication key changes from url-only to `url@updatedAt` (aligning with card); (2) Missing AI configuration changes from silently setting error state to toast-only; (3) RPC failure copy standardized to ReleaseCard version. Update assertions in tests if applicable.

### 2.6 `useReleaseTimelineActions` Adds `syncWatchedSources` (B1: New Method)

`src/features/releases/hooks/useReleaseTimelineActions.ts` currently provides handleRefresh, handleMarkAllRead, and handleUnsubscribeRelease.

```ts
syncWatchedSources: () => Promise<void>;
isSyncingWatchedSources: boolean;
```

Relocates table #14 line-by-line. Repositories read directly from `state.releaseSourceSettings.watchCustomReleaseRepos` in `selectReleaseTimelineState` (**shared selector unchanged**); `setReleaseSourceRepositories` obtained via single-value selector wrapped in useCallback. Imports `repositoryToCustomReleaseRepository` and `WATCH_CUSTOM_RELEASE_SOURCE_ID` from utils. Silent return if no token or isSyncing (no toast, no confirm, no forceSync, no Abort).

### 2.7 `useBackendAvailability` (New `src/features/settings/hooks/useBackendAvailability.ts`)

```ts
export const useBackendAvailability = (): boolean;
// Returns backend.isAvailable (synchronous property read, no subscriptions needed)
```

SettingsPanel replaces `(isElectron() || backend.isAvailable)` with `(isElectron() || backendAvailable)` at lines 369 and 380; removes line 24 import. `isElectron` remains as infrastructure.

### 2.8 `RepositoryEditModal` → Reuse `useCategorySyncActions`

`src/features/repositories/hooks/useCategorySyncActions.ts` already exists (zero arguments, returns `{ forceSyncToBackend }`). View removes line 12 import, adds `const { forceSyncToBackend } = useCategorySyncActions();`, retaining call site lines 402–404 untouched (table #15).

---

## 3. Pure Function Refinement List

### 3.1 `src/features/repositories/application/discoveryRepoPatches.ts` (Only New Application File)

```ts
import type { DiscoveryRepo } from '../../../types';
export interface DiscoveryAnalysisSuccessInput {
  summary: string | undefined; tags: string[] | undefined; platforms: string[] | undefined;
  analyzedAt: string; analysisFailed: boolean | undefined;
}
export interface DiscoveryAnalysisFailureInput {
  analyzedAt: string; analysisFailed: boolean | undefined; analysisError: string | undefined;
}
export const applyDiscoveryAnalysisSuccess = (repo: DiscoveryRepo, input: DiscoveryAnalysisSuccessInput): DiscoveryRepo;
export const applyDiscoveryAnalysisFailure = (repo: DiscoveryRepo, input: DiscoveryAnalysisFailureInput): DiscoveryRepo;
```

**Fields taken verbatim from SubscriptionRepoCard lines 239–247 and 260–265** (including `analysis_failed: result.analysis_failed` and `analysis_error: undefined`), **excluding** custom_category and category_locked—this has a distinct shape from `repositoryPatches.applyAnalysisSuccess`; do not merge them. Accepts and returns DiscoveryRepo (preserving rank/channel/platform). Bound by application purity gate (§1.5). Unit tests in `__tests__/`.

### 3.2 Pure Functions Exported in Hook Files (Covered in Same-File Unit Tests)

| File | Pure Function | Origin (Extracted Block) |
|---|---|---|
| useSearchActions.ts | `buildSearchPatch(query, vectorResults): Map<string, number>` | SearchBar 446-459: name +0.05 / desc +0.03 / tags +0.02 boost + scoreMap construction |
| useSearchActions.ts | `mergeStarredRepositories(newRepos, storeRepos): Repository[]` | SearchBar 725-750 field merge (license `?? null` backfill) |
| useSearchActions.ts | `planListCategories(lists, localCategoryNames, makeCategoryId): { toCreate: Category[]; categoryByLowerName: Map<string,string> }` | SearchBar 774-799; `makeCategoryId: (idx) => \`custom-sync-${Date.now()}-${idx}\`` injected by hook for testability; filters isReservedCategoryName |
| useSearchActions.ts | `applyListsToRepositories(repositories, lists, categoryByLowerName): { repositories: Repository[]; appliedTagsCount: Record<string, number> }` | SearchBar 807-868: preExistingLocked set + tag/categorize/lock loop + last_edited |
| useDiscoveryRepoActions.ts | `discoveryRepoToRepository(repo: DiscoveryRepo, starredAt: string): Repository` | SubscriptionRepoCard 152-160 (rank/channel/platform set to undefined) |
| useGistActions.ts | `applyGistAnalysisSuccess(detail: Gist, summary: string, now: string): Gist` / `applyGistAnalysisFailure(gist: Gist, error: string, now: string): Gist` | GistCard 100-106 / 109-114 patch literals |
| useReleaseArtifactActions.ts | `computeRpcDownloadKey(link)` (§2.5) | ReleaseCard 123 |
| useReadmeFetch.ts | `pickReadmeCandidate(variants, selectedKey, defaultVariant)` (§2.4) | ReadmeModal 468 |

---

## 4. Per-View Modification Checklist

### 4.1 `src/components/SearchBar.tsx` (Heaviest, Updated Last)

- **Remove Imports**: AIService (L7), EmbeddingClient/VectorSearchService (L8), GitHubApiService (L9), createGitHubListsApiService (L10), forceSyncToBackend (L11).
- **Add**: `import { useSearchActions } from '../features/repositories/hooks/useSearchActions';`
- **Remove State/Refs**: isSearching/searchPhase useStates; vectorScoreMapRef and skipNextTextSearchRef declarations (destructured from hook instead).
- **Relocate Bodies**: handleAISearch 370–559 becomes thin wrapper (UI flags + history persistence + `await aiSearch(searchQuery, applyFilters)`); handleStarSync 714–926 removed; handleStarAndListSync 941–958 retains confirm copy and delegates to `syncStars('stars-and-lists')`.
- **Retained in View**: applyFilters closure, filtering effect 239–277 (reads/writes hook refs unchanged), real-time search/history/suggestions/IME, formatLastSync, selector display fields (isSyncingStars, releaseSubscriptions, lastSync).
- Store selector pruned of fields used only by relocated logic.

### 4.2 `src/components/GistCard.tsx`

- **Remove Imports**: createGitHubApiService (L4), AIService (L5). **Add**: `import { useGistActions } from '../features/gists/hooks/useGistActions';`
- Three handlers delegate to `analyzeOne(gist)` / `unstarGist(gist, onUnstarred)` / `deleteGist(gist, onDeleted)` (View retains stopPropagation and callback pass-through). `isAnalyzing` changes to `isAnalyzingGist(gist.id)`, `isMutating` obtained from hook. Remove local states and unused store selector fields.

### 4.3 `src/components/GistDetailModal.tsx`

- **Remove Import**: createGitHubApiService (L9).
- Parent calls `useGistActions()` for fetchGistFileRaw, passing prop `fetchRaw: (rawUrl: string, signal: AbortSignal) => Promise<string>` to HighlightedCode; HighlightedCode removes service calls and githubToken, calling `await fetchRaw(file.raw_url!, controller.signal)` in effect. **Abort, retry, and local cache stay in View**.

### 4.4 `src/components/SubscriptionRepoCard.tsx`

- **Remove Imports**: analyzeRepository/createFailedAnalysisResult (L6), forceSyncToBackend (L7), GitHubApiService (L8). **Add**: `import { useDiscoveryRepoActions } from '../features/discovery/hooks/useDiscoveryRepoActions';`
- Destructure `{ analyze, star, executeUnstar, isAnalyzing, isStarring, isStarred, optimisticStarred }`. Remove local isStarring/isAnalyzing/optimisticStarred states, abortControllerRef + unmount effect, and unused store selector items.
- **Retained in View**: unstarConfirmOpen/pendingUnstarAction state, custom Modal JSX (499–544, copy unchanged), confirm button handler update (§2.3), onStar/onAnalyze forwarding, stopPropagation.

### 4.5 `src/components/ReleaseCard.tsx`

- **Remove Imports**: sendToRpcDownload (L11), AIService (L12). **Add**: `import { useReleaseArtifactActions, computeRpcDownloadKey } from '../hooks/useReleaseArtifactActions';`
- Destructure `{ summaries, rpcDownloadStates, sendRpcDownload, generateSummary, cancelSummaryRequests }`. Remove SummaryState type, summary state, summaryAbortRef + unmount effect, downloadingRef/downloadedRef/forceUpdate, handleRpcDownload, runSummaryAnalysis, and selector fields backendApiSecret/aiConfigs/activeAIConfig.
- handleToggleSummary reads `summaries[release.id] ?? { status: 'idle' }`; unmount cancellation handled by hook.

### 4.6 `src/components/ReadmeModal.tsx`

- **Remove Imports**: GitHubApiService (L8), backend (L9), shouldBypassBackend (L10). **Add**: `import { useReadmeFetch, pickReadmeCandidate } from '../hooks/useReadmeFetch';`
- Remove two fetcher useCallbacks (332–364, 366–392), two abortControllerRefs, and abort/cleanup blocks. fetchReadmeContent/fetchReadmeVariants retain cache and loading coordination while calling hook methods; line 468 calls `pickReadmeCandidate(...)`. Modal close triggers `cancel()`. readmeCache/TOC/translation remain untouched.

### 4.7 `src/components/ReleaseSourceSettingsModal.tsx`

- **Remove Import**: GitHubApiService (L9). **Add**: `import { useReleaseTimelineActions } from '../features/releases/hooks/useReleaseTimelineActions';`
- WatchCustomReleaseSyncPanel.handleSync removed; button invokes `syncWatchedSources`; isSyncing mapped to `isSyncingWatchedSources`. `updateReleaseSourceRepository` (line 284 toggle) is View→Store and **remains in View**.

### 4.8 `src/components/RepositoryEditModal.tsx`

- Remove line 12 import; add `useCategorySyncActions` (§2.8). Lines 402–404 call site remains unchanged.

### 4.9 `src/components/SettingsPanel.tsx`

- Remove line 24 import; add `const backendAvailable = useBackendAvailability();`, updating conditions at lines 369 and 380 (§2.7).

### 4.10 `src/components/GistEditorModal.tsx`

- See §5.

---

## 5. Type Uncoupling: GistEditorModal (First Commit, Independently Revertible)

Line 9: change `import type { GistCreateInput, GistUpdateInput } from '../services/githubApi';` to `from '../features/gists/hooks/useGistActions'` (re-exported at line 12 of that file). **Zero rule file changes**; passes both ESLint and check-boundaries checks.

---

## 6. Test Plan

### 6.1 New Tests (Matching `.test.tsx` Files, Vitest Globals + jsdom)

| File (New) | Mock Focus | Key Assertions |
|---|---|---|
| `src/features/repositories/application/__tests__/discoveryRepoPatches.test.ts` | Pure function, no mocks | Success/failure patch fields (no custom_category/category_locked), DiscoveryRepo fields preserved |
| `src/features/repositories/hooks/useSearchActions.test.tsx` | Store mock must provide getState: `useAppStore: Object.assign(vi.fn(sel => sel(state)), { getState: () => state })`; mock vectorSearchService/aiService/githubApi/githubApiFactory/autoSync | (1) Vector hit: topK/threshold defaults 30/0.35, score boost mapping, rerank failure fallback without toast, skipNextTextSearchRef=true; (2) HyDE 5s race fallback to original query; (3) Vector miss → keywordSearch AI failure fallback to performBasicTextSearch; (4) syncStars('stars-and-lists'): **setRepositories precedes forceSyncToBackend, followed by setLastSync**; list failure does not disrupt star sync; token expiration branch; (5) 4 pure functions |
| `src/features/gists/hooks/useGistActions.test.tsx` (New) | Store state covering selectGistViewState; githubApiFactory mocks; AIService.analyzeGist | analyzeOne: triggers confirm when analyzed, patch fields, **no forceSync call**; unstarGist/deleteGist: confirm false aborts, onUnstarred/onDeleted invoked at respective sequence points; fetchGistFileRaw: throws verbatim copy without token, passes signal with token |
| `src/features/discovery/hooks/useDiscoveryRepoActions.test.tsx` | aiAnalysisHelper/autoSync/githubApi/store | analyze 4-step validation copy and order, abort short-circuit, patch without custom_category, **no forceSync**; star optimistic → remote → addRepository → onStar → **forceSync** → clear optimistic → toast order; executeUnstar optimistic/rollback, deleteRepository by full_name, **forceSync**, no toast on success |
| `src/hooks/useReadmeFetch.test.tsx` | backendAdapter/githubApi/routeMode | bypass or !isAvailable → direct; backend success skips GitHub; backend failure non-abort with token → fallback + warn; no token: content throws / candidates returns []; cancel aborts previous fetch; pickReadmeCandidate |
| `src/hooks/useReleaseArtifactActions.test.tsx` | rpcDownloadService/AIService/useDialog/store | sendRpcDownload: key=url@updatedAt, sending short-circuit, retry clears sent, 'RPC service not running' branch, catch copy; generateSummary: missing config toast, loading/done short-circuit, error state + toast, AbortError silent, unmount abort, deduplication for concurrent calls; reset: aborts active requests, ignores late responses, clears summaries/rpcDownloadStates; computeRpcDownloadKey |
| `src/features/releases/hooks/useReleaseTimelineActions.test.tsx` (New, syncWatchedSources) | githubApi/store (including releaseSourceSettings.watchCustomReleaseRepos, setReleaseSourceRepositories) | Silent return without token or when syncing; preserves release_hidden; setReleaseSourceRepositories arguments; success/failure toast; **does not call forceSync** |
| `src/features/settings/hooks/useBackendAvailability.test.tsx` (Small) | backendAdapter | Returns backend.isAvailable states |

### 6.2 Existing Regressions (`npm run test:run` Must Pass Cleanly)

`src/components/SearchBar.test.tsx`, `RepositoryEditModal.test.tsx`, `ReadmeModal.test.tsx`, `ReleaseCard.test.tsx`, `RepositoryReleaseSheet.test.tsx` + `src/features/repositories/hooks/useRepositoryReleaseSheet.test.tsx`, `useRepositoryCardActions.test.tsx`, `ReleaseTimeline.test.tsx`, `ForkTimeline.test.tsx`, `settings/BackendPanel.test.tsx`, `src/store/useAppStore.modularization.test.ts` (**must pass with zero modifications** as proof of untouched Store).

**vi.mock Behavior (B4)**: When components stop importing services, existing `vi.mock('.../services/x')` calls continue intercepting identical imports inside hooks via module resolution—**do not preemptively rewrite existing test files**.

---

## 7. Execution Order and Commit Breakdown (Single PR, ~17 Commits)

1. `refactor(gists): GistEditorModal imports types from useGistActions re-export` (§5)
2. `feat(gists): extend useGistActions + gist patch pure functions + unit tests`
3. `feat(discovery): create useDiscoveryRepoActions + discoveryRepoPatches + unit tests`
4. `feat(readme): create src/hooks/useReadmeFetch + pickReadmeCandidate + unit tests`
5. `feat(release): create src/hooks/useReleaseArtifactActions + unit tests; useRepositoryReleaseSheet delegates`
6. `feat(releases): add syncWatchedSources to useReleaseTimelineActions + unit tests`
7. `feat(settings): create useBackendAvailability`
8. `feat(repositories): create useSearchActions + pure functions + unit tests`
9. View migrations (one commit per file): 9a GistCard; 9b GistDetailModal; 9c SettingsPanel; 9d RepositoryEditModal; 9e ReleaseSourceSettingsModal; 9f SubscriptionRepoCard; 9g ReleaseCard; 9h ReadmeModal; 9i SearchBar
10. `chore(boundaries): remove component boundary allowlist mechanism` (**final step**):
    - `eslint.config.js`: remove COMPONENT_BOUNDARY_ALLOWLIST constant (lines 52–63) + JSDoc notes; remove `...COMPONENT_BOUNDARY_ALLOWLIST` from ignores (lines 97–101, **retaining** `'src/components/**/*.test.{ts,tsx}'`); trim comments mentioning allowlist.
    - `scripts/check-boundaries.cjs`: remove COMPONENT_ALLOWLIST Set (lines 48–59) + sync comments + early return in checkComponentFile (line 106); update file header comments.
    - **Do not leave empty arrays**—clean removal of mechanism is required.

---

## 8. Acceptance Criteria

Three gate checks (executed in order, all green required):

```sh
npm run lint                        # eslint . across entire repository
node scripts/check-boundaries.cjs   # equivalent to npm run check:boundaries
npm run test:run                    # vitest run (non-watch mode)
```

Auxiliary sanity checks:

```sh
npm run typecheck                   # tsc -b --noEmit
rg -n 'services/(githubApi|aiService|aiAnalysisHelper|aiAnalysisOptimizer|vectorSearchService|autoSync|webdavService|backendAdapter|rpcDownloadService|githubApiFactory|updateService|translateService)' src/components --glob '*.ts' --glob '*.tsx' --glob '!*.test.*'
# Expect empty
rg -n 'import\s*\(' src/components --glob '*.ts' --glob '*.tsx' --glob '!*.test.*' | rg 'services/'
# Expect empty
rg -n 'COMPONENT_BOUNDARY_ALLOWLIST|COMPONENT_ALLOWLIST' eslint.config.js scripts/check-boundaries.cjs
# Expect empty
```

---

## 9. Risks and Rollback

| Risk | Mitigation |
|---|---|
| Large single PR | Commits structured per file/topic (§7) for clean revertability; hook commits decouple from View commits |
| SearchBar broad change scope | Ref exposure strategy (§2.1) leaves filtering effect untouched; applyFilters parameter prevents stale closures; migrated in last View commit |
| DiscoveryRepo type friction | Pure patch functions accept and return DiscoveryRepo (§3.1); store shape and modularization tests untouched |
| useRepositoryReleaseSheet delegation micro-differences | 3 preset differences declared in §2.5 + all 8 documented in PR description; tests updated in lockstep |
| Existing test mock mismatches | vi.mock intercepts resolve paths automatically (§6.2); add missing fixtures rather than rewriting tests |
| New violations appearing after allowlist removal | Run all 3 gate checks prior to final commit; allowlist removal commit modifies only the two gate files |

---

## 10. Follow-Up (Out of Scope for This PR)

1. **ADR Errata**: Update ban list 10 → 12 items; update expired 13-item list in §Phased enforcement; record allowlist zeroed and removed.
2. **Automate Application DOM/JSX Rules** (B6).
3. **Evaluate New Application Directories**: Assess whether search/gists/releases pure functions warrant dedicated `application/` folders.
4. Document `routeMode` as infrastructure.
5. Add token/config validation and toasts to `useVectorSearchActions` (B3).
6. Assess moving SearchBar applyFilters closure and filtering effect into hook.
7. Clean up UI layer after completely unifying RPC status keys between `useRepositoryReleaseSheet` and `useReleaseArtifactActions`.

---

## Appendix 1: Round 1 Audit Log (A1–A8, Resolved)

| # | Issue | Severity | Resolution |
|---|---|---|---|
| A1 | Proposed new useReleaseCardActions ignored existing useRepositoryReleaseSheet with identical RPC+AI logic, introducing a third copy | High | Extract shared `src/hooks/useReleaseArtifactActions.ts`, delegating from both sites (§2.5) |
| A2 | GistEditorModal uncoupling via allowTypeImports:true: check-boundaries IMPORT_RE also matches import type, leaving CI red | High | Re-export import types from useGistActions, zero rule changes (§5) |
| A3 | Creating top-level features/search/ + 3 application/ directories conflicted with "7 feature hooks-only" architecture | High | Locate hooks in existing directories (repositories/hooks, src/hooks); pure functions in repositories/application + inline exports (§2/§3) |
| A4 | Acceptance rg scoped only to src/components/*.tsx, missing subdirectories and dynamic imports | Medium | Use gate checks as authority, expand auxiliary rg to full repo scope (§8) |
| A5 | Acceptance specified "empty array", leaving dead constants and ignore wiring | Medium | Full removal of mechanism (§7.10); treat allowlist constants as sole source of truth |
| A6 | Did not declare updateService/translateService already violation-free, risking wasted investigation | Low | Clarified in §0 as completed |
| A7 | "Reuse useRepositoryCardActions pattern" did not forbid cross-feature imports | High | Explicitly state pattern replication while forbidding cross-feature imports (§1.3/§2.3) |
| A8 | useStarSyncActions/useBackendSettingsActions require { t }, unaddressed in proposal | Low | Hooks in this scope use zero-argument pattern constructing t internally (§2) |

## Appendix 2: Round 2 Audit Log (B1–B8, Resolved in This Version)

| # | Issue | Severity | Resolution |
|---|---|---|---|
| B1 | useReleaseTimelineActions.syncWatchedSources did not exist (0 hits across repo); "merge" phrasing was erroneous | High | Documented as new method with full design (§2.6) |
| B2 | Data flow "patch → updateX → forceSyncToBackend → toast" was inaccurate: analysis actions do not forceSync on success | High | Created 15-item order-preserving table (§1.2) under "relocate without altering semantics" |
| B3 | "Validate reusing useVectorSearchActions pattern" was inaccurate—that hook lacks token/AI validation and toasts | Medium | Re-pointed validation references to useRepositoryCardActions.analyze and useGistActions.analyzeVisibleGists (§2.3; follow-up §10.5) |
| B4 | Inaccurate test inventory: useGistActions had no tests; useReleaseCardActions.test name obsolete | Medium | Rewrote test plan (§6): 8 new tests + existing regression list + vi.mock principles |
| B5 | Inaccurate acceptance commands: vitest is watch mode; eslint ran components only | Medium | Updated §8 to npm run lint (full repo), check-boundaries, test:run, typecheck, and rg |
| B6 | "Application layer blocks DOM via lint and boundary check" was inaccurate—neither gate enforces DOM/JSX rules | Low | Corrected §1.5; automated enforcement listed as follow-up (§10.2) |
| B7 | Inaccurate infrastructure allowlist description—system is a blacklist, with 6 documented tools excluding routeMode | Low | Corrected §1.4; classified routeMode as factual infrastructure left untouched |
| B8 | SubscriptionRepoCard unstar confirmation uses custom Modal rather than useDialog.confirm | Medium | Explicitly assigned confirm/toast/Abort ownership per hook (§2); UI stays in View, hook exposes actions (§2.3) |
