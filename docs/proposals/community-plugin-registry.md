# Proposal: Community Plugin Registry (Static Registry + GitHub Releases)

Status: Proposal, awaiting maintainer decisions on hosting location and signing key ownership
Relevant Guidelines: §17 Plugin Store / Community Registry, §18 Signing / Revocation / Updates

## 2026-10 Revision: Relationship Between Self-Hosted Sources (Implemented) and Static Registry

In addition to static registries, the client now supports **user-maintained plugin sources** (Plugin Marketplace): a source is a GitHub repository directory (such as `https://github.com/owner/repo/tree/main/plugins`). The client lists directories using the GitHub Contents API and probes for `manifest.json` across subdirectories to assemble a plugin catalog. When installing, it fetches the file list using the Git Trees API, downloads files to a staging directory, and executes the identical validation, copy, and atomic placement pipeline used for local installations (`pluginManager.installFromDirectory`). Updating is equivalent to uninstalling the previous version while preserving data, followed by re-installation; activation always requires explicit user permission confirmation.

Division of responsibilities:

- **Self-hosted plugin sources** address "discovery and distribution": any repository directory can become a source without requiring a registry PR against this repository. The trust model is identical to local installation: installation does not imply execution; Worker plugins retain Node.js capabilities, requiring user discretion prior to enabling.
- **Static registry** serves as the official audited channel: revocation and blocklist records in `community-plugins.json` / `removed-plugins.json` overlay marketplace views—marketplace entries matching revoked or blocklisted versions are blocked from installation and updates, and installed plugins that have been revoked prompt immediate deactivation.

Implementation entry points: `electron/plugins/pluginMarketplace.js` (main process), `src/components/settings/PluginMarketplaceDialog.tsx` (marketplace modal), `src/components/settings/PluginSourcesDialog.tsx` (source management modal).

## Why "Static Registry + Pinned Releases"?

The plugin system already includes manifest validation, permission prompts, sandboxed Plugin Pages, a capability router, and CSP, but this does not mean all plugins have technical runtime isolation: `manifest.main` runs in a Node.js Worker with direct access to filesystems, environment variables, networks, and process capabilities, which the Host capability router cannot restrict. Community distribution still lacks **distribution, trust, and local code isolation**. Three architectural paths exist:

| Path | Issues |
|---|---|
| Client connects directly to latest Release of plugin author repo | Non-reproducible releases; author can replace assets with identical names; cannot review before merging |
| Self-hosted server registry API | Requires ongoing operations; server outage breaks installations; conflicts with offline-first client philosophy |
| **Static JSON Registry + Pinned Release URLs + SHA-256** | Every change requires a reviewable PR; client respects only pinned versions and hashes in registry; straightforward revocation |

We choose the third path: converging "trust" into a human review and an immutable hash. The client never guesses or tracks moving latest tags.

## Directory Layout

```
registry/
├─ community-plugins.json        Accepted plugin versions
├─ removed-plugins.json          Revoked / blocked plugins (with rationale)
└─ schemas/
   ├─ community-plugin.schema.json
   └─ removed-plugin.schema.json
```

Tentatively located in the main repository. Another option is a dedicated `githubstarsmanager-plugins` repository, which prevents registry commit history from polluting the main repo and allows independent review permissions, at the cost of managing an additional repo. **This requires a maintainer decision.**

## Record Fields

`community-plugins.json` is an array where each entry represents "one version of one plugin":

```json
{
  "id": "com.example.repo-health",
  "version": "1.2.0",
  "apiVersion": "1",
  "source": "https://github.com/example/github-stars-manager-repo-health",
  "releaseUrl": "https://github.com/example/github-stars-manager-repo-health/releases/download/v1.2.0/repo-health-1.2.0.zip",
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "permissions": ["repositories:read", "storage"],
  "networkTargets": [],
  "dataUsage": "Only reads metadata of locally starred repositories to calculate health scores; does not exfiltrate data.",
  "review": {
    "status": "approved",
    "date": "2026-09-21",
    "commit": "0123456789abcdef0123456789abcdef01234567"
  }
}
```

- `id` must match the manifest; the same `id` may have multiple version entries; the client selects **the highest version it supports** (governed by `apiVersion`), not blindly "latest".
- The `(id, version)` combination must be unique; a plugin may register multiple distinct versions.
- `sha256` is the hash of the zip archive. The client must verify after downloading, discarding and reporting an error on mismatch.
- `networkTargets` must match `permissions` with `network:<domain>` exactly; client permission warnings use only declarations verified via CI.
- `review.commit` is the commit audited. Manual review must audit the exact ZIP pointed to by `releaseUrl` matching `sha256`, rather than just the source tree; Release tags or verifiable build attestations must bind the ZIP to `review.commit`.

`removed-plugins.json`:

```json
{
  "id": "com.example.bad-actor",
  "versions": ["1.0.0", "1.0.1"],
  "reason": "1.0.1 sent repository lists to third-party domains without declaring it.",
  "date": "2026-09-21",
  "action": "revoke"
}
```

`action` is either `revoke` or `block`. `revoke` immediately deactivates matching versions and prohibits installation, updates, or rollback to that version; `block` prevents new installations, updates, and rollbacks, but does not forcibly deactivate already installed versions. Clients must check removal records before listing, installing, updating, and rolling back. If multiple conflicting records match, `revoke` takes precedence; CI rejects overlapping records, including `block`/`revoke` conflicts for the same version and coexisting `versions: []` with specific version records.

## Submission Workflow

```
Plugin Author Repository
  → Submit PR to this repo (modifying only registry/community-plugins.json)
  → Automated CI Scanning (see below)
  → Maintainer Manual Review (see below)
  → Merge PR
  → Clients install via pinned version + SHA-256
```

Plugin authors **never modify codebase files directly**, submitting only an entry pointing to their own Release.

## CI Automated Scanning Checklist

When a new entry appears in a PR, CI fetches the corresponding zip and performs static checks:

- Manifest structure is valid, `(id, version)` combination is unique, `id` matches registry entry, `apiVersion` is within supported range.
- Re-calculate SHA-256 of downloaded ZIP and compare with `sha256`; verify asset belongs to `source` repository and binds to `review.commit` via Release tag or verifiable build attestation.
- `networkTargets` strictly matches all `network:<domain>` permissions; declaring network permissions with an empty target list is rejected.
- `removed-plugins.json` contains no version overlaps, `block`/`revoke` conflicts, or ambiguous combinations of all-version and specific-version records.
- Enforce file count and uncompressed payload size caps.
- **Zip slip**: Entry paths must not escape extraction root directory.
- **Symlinks**: No symbolic links permitted within the archive.
- Dependency vulnerability scans.
- Hardcoded secrets / token scanning.
- Detection of `eval`, `new Function`, or dynamic code evaluation.
- `child_process`, shell invocations, or process execution.
- Install scripts (`preinstall` / `postinstall`).
- Undeclared network access (compared against `networkTargets`).
- Telemetry / tracking behaviors.
- Self-update logic (plugins must not self-update).
- Signs of code obfuscation.
- Remote resource references (`http(s)://` literals).
- Audit page CSP and message bridge usage boundaries.
- Phase 1 rejects community plugins declaring `manifest.main`. Only after effective runtime isolation and explicit user disclosure of local code execution are provided in the future will such plugins be admitted to the community registry.

Scan outputs are posted as PR comments to assist manual review—CI determines "are there obvious defects", not "is this plugin trustworthy".

## Manual Review Checklist

- Description aligns with behavior (README claims match implementation).
- Permissions are strictly necessary (read permissions used where write is not needed).
- Network domains are legitimate and align with `networkTargets`.
- Data usage is clear; does not exfiltrate private repository data or browsing history.
- No persistent background tasks remain after deactivation.
- UI does not impersonate the host (no fake system prompts or spoofed official settings panels).
- License compliance.
- Audit the release ZIP directly after SHA-256 verification, rather than merely reviewing the source working tree.
- **Every new version must be re-reviewed**; permission increases require explicit client re-confirmation by users.

## Client Behavior

- Only installs **pinned versions** from the registry and verifies SHA-256, aborting on mismatch.
- Installed plugins inspect registry on startup: higher compatible version available → prompts update (displaying changelog and **permission diffs**), confirmed manually by user. **No automatic updates in Phase 1.**
- Inspects `removed-plugins.json` prior to version selection, installation, updates, and rollback: `revoke` deactivates matching installed versions and prevents subsequent use; `block` only blocks new installs, updates, and rollbacks; `revoke` takes precedence on conflicts.
- Retains metadata necessary for rollbacks (previous version, previous hash), though rollbacks remain strictly user-initiated.

## Open Questions

1. Should the registry reside in the main repository or a dedicated repository?
2. Should the registry file itself be cryptographically signed? If so, who holds the private key and how is key rotation handled? Without registry signatures, hashes + review records prevent authors from swapping packages, but do not prevent malicious commits to the registry repo. Version 1 suggests omitting signatures until significant user adoption occurs.
3. Who holds review authority? If limited to a single maintainer, ecosystem growth will be bottlenecked; pre-agreed tiered review criteria ("low-risk permissions can merge quickly") should be established.
4. Squatting rules for plugin names and IDs (first-come-first-served? similarity checks against existing plugins?).
