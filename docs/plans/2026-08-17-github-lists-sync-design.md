# GitHub Lists (Star Lists) Two-Way Sync Design

Date: 2026-08-17
Status: In design

## Goals

While keeping the existing REST star sync, add two-way sync for GitHub's native Lists (star lists):

1. **Pull**: Add a "Sync starred repositories and lists" option that uses GraphQL to fetch the user's Lists and the repositories they contain, then merges them with local data.
2. **Lock**: Repositories pulled from a list have their category locked by default, so AI analysis will not reset it.
3. **Push**: Add "Sync repository categories to GitHub lists" under Settings → Backup & Restore, writing local categories back to GitHub Lists (same-name lists are overwritten).
4. **First login**: Before the first repository pull, ask the user to choose the sync scope (stars only / stars + lists) and save it as a configuration that can be changed in Settings.

## Key Decisions (DEC-*, confirmed by the user)

1. **DEC-delete policy = add only, never delete**: Sync (including list pulls) only adds/updates and never deletes local repositories; unstarring on a list will not make the local repository disappear (status quo).
2. **DEC-multi-list membership = tag mapping, not single-category override**: Categories applied on the repositories page already "follow tags, and one repository can belong to multiple categories". So list pulls use **tag mapping**: the list name is written as a custom tag into the repository's `custom_tags`, and a repository can belong to multiple lists (multiple tags), avoiding "single-category override" conflicts.
3. **DEC-push same-name list = overwrite**: When writing local categories back to GitHub lists, a same-name list has its members overwritten directly.
4. **DEC-lock semantics = only check lock state**: During sync, only `category_locked` is checked. Locked repositories keep their category; unlocked repositories get the list category applied and are then locked. Manually changing a category locks it again (status quo, unless the user unlocks it manually) → for a repository the user unlocked manually, if it is unlocked at the next sync, the list category is reapplied and the repository is locked.
5. **DEC-first-login choice = stored as configuration, switchable**: The first-login choice is saved as a persisted setting that can be switched at any time in Settings.

## Architecture

### Data Flow

```text
Pull: GitHub Lists (GraphQL) → repositories + list-name tags → merge into store → forceSyncToBackend
Push: local categories → compute member repositories per category → GitHub Lists (GraphQL) overwrite write
```

### New Persisted Setting

- `syncMode`: `'stars' | 'stars-and-lists'`, default `'stars'`. Added to the useAppStore persisted-key allowlist.
  - On first login, if it has never been set, show a choice dialog; after the choice, write `syncMode`.
  - The settings panel provides a toggle switch.

### New Service: GitHub Lists GraphQL Client

Create `src/services/githubListsApi.ts`:

- The underlying HTTP follows the same pattern as REST: with a backend, `backend.postProxy`; without one, `fetch('https://api.github.com/graphql')`, with `Authorization: Bearer <token>`. Reuse the existing request-wrapper approach from `githubApi.ts`.
- Query: `getUserLists()` paginates in two phases: first read the `user(login).lists` summary (paginate fully with `first:100`), then read each `UserList.items` page by page via `node(id:)` (`first:100` per page). Both phases carry the `after` cursor and `pageInfo`, avoiding the huge responses from inlining items in a single query, which cause GitHub-side timeouts (502/504).
- Overwrite write: first query existing lists → if a same-name list exists, use `updateUserListsForItem` or delete and recreate; if not, `createUserList` + `updateUserListsForItem`.
- Permission check: GraphQL requires the `user` scope (classic PAT) or a fine-grained token with star-list permissions; on insufficient permissions, return a friendly error suggesting `gh auth refresh -h github.com -s user`.

### Pull Merge Logic (reuses the `handleStarSync` pattern)

- After pulling starred repositories (REST, status quo), if `syncMode === 'stars-and-lists'`, pull lists as well.
- For each list: add the list name to the repository's `custom_tags` (deduplicated), and decide the category per DEC-4:
  - Repository `category_locked === true` → do not change the category (skip).
  - Repository unlocked → set `custom_category = list name` (if the list name matches a category) and `category_locked = true`.
  - If the list name has no matching category, only add the tag (the tag alone lets the repository appear in the matching category).
- The merge still follows add-only: merge via `existingRepoMap`, keeping existing local fields.

### Push Write-back Logic (StarSyncPanel)

- Add a "Sync repository categories to GitHub lists" button + confirmation dialog under Settings → Star Sync (warning: same-name lists will be overwritten).
- Implementation: for each category (default or custom), compute the repositories matched by `matchesCategory` → map to a GitHub list name (the category name) → overwrite members of the same-name list, or create it if none exists.
- Precheck that a token exists; on GraphQL failure, give an actionable error message.

### First Login (SyncModeChoiceModal)

- `SyncModeChoiceModal` is mounted by `App.tsx`: after login completes, if `syncModeConfigured === false`, show a choice dialog: "Sync starred repositories only" / "Sync starred repositories and lists". After the choice, write `syncMode` and `syncModeConfigured`.
- Afterward the main UI is entered, and the sync button behaves according to `syncMode`.

### Sync Button (SearchBar)

- Main button body: clicking it directly runs "sync according to syncMode" (default: stars only).
- The dropdown gains a second item, "Sync starred repositories and lists": a prompt + confirmation dialog (warning that the list pull applies list categories to unlocked repositories and locks them); after confirmation, call the sync that includes lists.
- Reference the existing `handleStarSync` (src/components/SearchBar.tsx:739) and reuse its merge logic.

## Constraints

- Existing users are not forced to update their token; when token permissions are insufficient, give guidance on adding permissions instead of crashing.
- No data structure changes and no required re-indexing of vectors (`vector_indexed_at` is preserved).
- Smooth upgrade/downgrade: when the new config items are absent, behavior matches the status quo (stars only).
- All interaction (including error messages) is presented in English.

## Risks / To Verify

- The exact permissions a fine-grained PAT needs to operate on star lists are not finalized (blocker).
- Performance of paginating large lists via GraphQL (100 items per page).
- When one repository is in multiple lists, `custom_category` takes only one, but multiple tags ensure it is displayed under multiple categories (Decision 2).

## Acceptance

1. Stars-only sync behaves exactly as it does today.
2. After a list pull: repositories appear in the corresponding categories, are locked by default, and AI analysis does not reset them.
3. Push overwrites same-name lists; creates a new list if none has the same name.
4. First login can choose and persist the setting; Settings can switch it.
