# Smart Release Recommender

A sample V1.1 Release processor plugin. It only reads sanitized Release and Asset metadata provided by the host and matches filenames against the current operating system and CPU architecture; it does not read tokens or access the network.

Requires explicit approval after installation:

- `releases:read`: Read sanitized Release and Asset metadata.
- `downloads:create`: Allow the user to trigger downloads via the host from recommended results.

The download button is rendered by GithubStarsManager. The plugin only returns `recommendedAssetId`, `confidence`, and `reason`; the host reconfirms asset ownership, presents the save dialog, and handles the download.
