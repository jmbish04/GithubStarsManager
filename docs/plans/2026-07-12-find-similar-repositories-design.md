# "Find Similar Repositories" Feature Design for the Repositories Page

Date: 2026-07-12
Status: Implemented

## Goals

Add a vector-semantic-search-based "Find Similar Repositories" interaction to the Repositories view:

- When the vector search toggle is on in settings and the vector index is available, hovering a repository card turns the "Last commit" time at the bottom left into a highlighted text button, "Find Similar Repositories".
- Clicking it uses vector retrieval to match semantically similar repositories and **completely replaces** the current repository list with the similar-repository results (entering the "similar repositories view").
- Chained lookups are supported: cards in the similar results can also be hovered and clicked to go deeper.
- A banner at the top of the list shows the current state and provides a "Reset" button that **returns directly to the original list from before the similarity lookup**.
- The interaction is clear and unambiguous: clicking the category sidebar while in the similar view leaves that view and switches to the chosen category.

## Key Decisions (from clarifying Q&A)

1. After clicking, the list is **completely replaced** with the similar-repository results (not appended, not filtered).
2. **Continuous chained lookups** are supported inside the similar-repositories view (find similar repos on top of results).
3. The reset button **returns directly to the initial list**, ignoring intermediate levels (no multi-level stack needed).
4. The status message and reset entry point live in a **banner at the top of the list**.
5. Button visibility is based on **actual availability** (toggle on + Worker connected + nonzero vector count + complete Embedding configuration), not just the toggle, to avoid dead clicks.

## Architecture

### State (`useAppStore`)

```ts
similarView: SimilarViewState | null;

interface SimilarViewState {
  active: boolean;
  anchorRepoFullName: string;
  anchorRepoName: string;
  similarResults: Repository[];        // Current similar results (used for rendering)
  originalSearchResults: Repository[]; // Snapshot of searchResults before entering, used by reset to restore
}
```

- `enterSimilarView(repos, anchor)`: saves the current `searchResults` to `originalSearchResults` and writes `similarResults` and the anchor info.
- `resetSimilarView()`: restores `searchResults = originalSearchResults` and clears `similarView`.
- Not persisted (a reload returns to the normal view, avoiding ambiguous state).

### Vector Retrieval (`vectorSearchService.findSimilarRepositories`)

`buildEmbeddingText(sourceRepo)` → `EmbeddingClient.embed([text], 'query')` generates the query vector → `VectorSearchService.query(vector, { topK: topK+1, threshold })` → map to the full repository list by id and **filter out the source repository itself** → return `Repository[]`.

### Rendering Integration (`App.tsx` RepositoriesView)

- When `similarView?.active`, the list data source switches to `similarView.similarResults`, and `selectedCategory='all'` is forced (category filtering is ignored so the similar results are shown in full).
- Otherwise the original logic applies: `hasActiveSearchFilters(searchFilters) ? searchResults : repositories`.
- `handleCategorySelect`: when the similar view is active, clicking a category first calls `resetSimilarView()` and then switches category, guaranteeing that "click a category = leave the similar view".

### Card Button (`RepositoryCard`)

- Derived `vectorSearchAvailable` flag: toggle on + `vectorSearchStatus.connected` + `vectorCount > 0` + complete Embedding configuration + non-empty Worker URL/Token.
- "Last commit" row rework: the time text shows by default; on `group-hover` the time fades out and a highlighted `<button>"🔍 Find Similar Repositories"` is shown, absolutely positioned over it. The button uses `pointer-events-none group-hover:pointer-events-auto` so it does not intercept card clicks when not hovered.
- The button is a `<button>`, and the card's `handleCardClick` already excludes it via `closest('button')`, so it will not accidentally open the README modal.
- `handleFindSimilar`: creates EmbeddingClient + VectorSearchService → `findSimilarRepositories` → `enterSimilarView`; shows a loading state during the process (spinner inside the card); on failure, shows a `toast` error and keeps the original view; empty results also enter the view and are indicated by the banner.

### Top Banner (`SimilarViewBanner`)

- Rendered conditionally at the top of `RepositoryList` (before the controls bar).
- Left side: "Viewing repositories similar to **{anchorRepoName}**"; right side: a prominent "← Reset" button.

## Edge Cases and Removing Ambiguity

- Empty similar results: the banner still shows, the list shows its empty state message, and reset remains available.
- While loading: the button shows a spinner and repeated clicks are blocked.
- Non-repository pages (gists / releases / forks / settings / subscription) do not show this feature.
- After restarting the app, `vectorSearchStatus` is not persisted (initially `connected:false`), so the button stays hidden until a connection is re-established, consistent with "requires an available index".

## Modified Files

- `src/types/index.ts` — adds the `SimilarViewState` type and the `AppState.similarView` field.
- `src/store/useAppStore.ts` — adds `similarView` state, `enterSimilarView` / `resetSimilarView` actions, and initial values.
- `src/services/vectorSearchService.ts` — adds `findSimilarRepositories`.
- `src/components/RepositoryCard.tsx` — hover button + `handleFindSimilar`.
- `src/components/SimilarViewBanner.tsx` — new component (banner).
- `src/components/RepositoryList.tsx` — renders the banner.
- `src/App.tsx` — `RepositoriesView` renders similar results; `handleCategorySelect` exit logic.

## Testing Suggestions

- Unit test `findSimilarRepositories` (mock EmbeddingClient / VectorSearchService).
- Unit test store action snapshot restoration.
- Manual verification: turn on the toggle + configure → hover a card to show the button → click to enter the similar view → banner appears → hover again for chained lookup → reset returns to the initial list → clicking a category in the similar view leaves the view.
