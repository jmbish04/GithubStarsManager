# Community plugin registry

This directory is the **static registry** for community plugins: clients install plugins only from the pinned versions recorded in `community-plugins.json`, verifying the `sha256` before unpacking. There is no central server, and clients do not automatically track latest versions.

For the complete workflow, review checklist, and open questions, see [`docs/proposals/community-plugin-registry.md`](../docs/proposals/community-plugin-registry.md).

## Files

| File | Purpose |
|---|---|
| `community-plugins.json` | Accepted plugin versions. One entry = **one** version of a plugin. |
| `removed-plugins.json` | Revoked or blocked plugins. `revoke` deactivates matching installed versions and prevents install/update/rollback; `block` only prevents new install/update/rollback. |
| `schemas/community-plugin.schema.json` | JSON Schema for `community-plugins.json`. |
| `schemas/removed-plugin.schema.json` | JSON Schema for `removed-plugins.json`. |

## Contribution Workflow

1. The plugin author publishes the plugin to their own GitHub repository, tags a Release, and attaches a zip asset.
2. Open a PR against this repository, **modifying only `community-plugins.json`**, adding a new entry pointing to that Release's immutable URL and `sha256`.
3. CI verifies `(id, version)` uniqueness, network declarations, and removal record semantics; downloads the zip and recalculates the SHA-256; verifies the Release tag or build provenance binds the asset to `review.commit`; and scans for zip slip, symlinks, eval, shell execution, undeclared network calls, telemetry, self-updating, obfuscation, and remote resources.
4. Maintainers review the exact hash-verified zip (ensuring description matches behavior, permissions are necessary, network domains and data purposes are documented, and license is compliant). Phase 1 of the community registry does not accept native code plugins containing `manifest.main`.
5. Once merged, it becomes visible to clients.

## Client Conventions

- Only install the pinned version specified in the registry; discard immediately if `sha256` verification fails.
- When a higher compatible version is available, **prompt** for an update (including changelog and permission diffs) for user confirmation; Phase 1 does not perform automatic updates.
- Check `removed-plugins.json` before version selection, installation, update, or rollback; `revoke` also immediately deactivates matching installed versions, taking precedence over `block` in case of abnormal overlap.

Run `npm run check:plugin-registry` locally to verify cross-entry uniqueness, network declaration consistency, and removal record conflicts; JSON Schema continues to enforce structure constraints on individual entries.
