# GithubStarsManager Plugin System Design Proposal

Status: Draft
Date: 2026-09-12
Target Platform: Electron Desktop
Scope: Plugin discovery, permission declarations, restricted extension points, sandboxed pages, and Host Capabilities

## 1. Background

GithubStarsManager already includes repository management, AI analysis, vector search, Release tracking, Gists, Forks, WebDAV, optional backend services, and MCP capabilities, but it currently lacks a runtime extension mechanism for third-party developers.

The project's frontend follows this layered architecture:

```text
View → Feature Hook / ViewModel → Application Command → Service → Store
```

The plugin system must strictly respect this existing layering. Plugins are never permitted to bypass Hooks, Services, or Host APIs to directly access Zustand Stores, Electron IPC, credentials, or the underlying runtime environment.

The core principle of this proposal is:

> Plugins should request capabilities, not inherit Electron privileges.

Specifically: plugins request host-defined and host-enforced capabilities rather than inheriting Electron or Node.js privileges.

## 2. Goals

The plugin system will eventually support:

1. Repository and bulk repository actions, such as copying repository details, generating reports, and opening external URLs.
2. Data processors for repositories, Releases, Gists, etc.
3. Exporters for Markdown, CSV, JSON, and other formats.
4. Release extensions such as Smart Release Asset Recommendation.
5. Analysis features such as Repo Health, alternative recommendations, and duplicate project detection.
6. Host-proxied GitHub, AI, Web Search, and download capabilities.
7. Full plugin Dashboards hosted in isolated pages.
8. Clear visibility into plugin permissions, versions, origins, and runtime errors.

## 3. Non-Goals

Plugin API v1 does NOT provide:

- Arbitrary Node.js APIs.
- Raw Electron IPC.
- Credentials such as GitHub Tokens, AI API Keys, WebDAV passwords, or aria2 Secrets.
- Arbitrary filesystem read/write access.
- Arbitrary process or shell execution.
- Unrestricted network access.
- Direct access or subscriptions to the Zustand Store.
- Direct import of third-party React components into the main Renderer.
- Remote code plugin marketplaces, automatic updates, or silent background installations.
- Automatic execution of software installers.
- Guarantees of a bulletproof security sandbox against malicious local plugins.

## 4. Risk Levels and Implementation Stages

| Level | Capability | Risk | Timeline |
|---|---|---:|---|
| L1 | Repository actions, data processing, export, plugin storage, and logging | Low | V1 |
| L2 | Sandboxed full plugin pages | Low-Medium | V1.2 |
| L3 | Host APIs for GitHub, AI, Web Search, downloads, and controlled networking | Medium | V1.1–V1.3 |
| L4 | Arbitrary filesystem, Node, shell, process execution, and auto-installers | High | Not supported |

## 4.1 Threat Model

The plugin system must account for at least the following attacker and failure scenarios:

| Scenario | Potential Consequence | Primary Defense |
|---|---|---|
| Malicious plugin | Exfiltration of stars, user preferences, or credentials | Zero credential exposure, Capability Router, data trimming |
| Compromised legitimate plugin | Newly added exfiltration behavior in updates | Origin pinning, hashes/signatures, re-confirmation on permission expansion |
| Malformed package attacks | Zip Slip, symlink traversal, overwriting host files | Safe decompression, fixed installation directory, path validation |
| Plugin UI attacking host | DOM probing, phishing, spoofing system UI | Sandbox iframe, CSP, explicit plugin identity labeling |
| SSRF | Probing or attacking localhost / intranet services | HTTPS allowlist, DNS/IP pinning and validation, redirect re-checking |
| Resource exhaustion | Infinite loops, oversized responses, storage bloat | Timeouts, termination, payload size limits, quotas, and rate limiting |
| Confused deputy attack | Plugin uses host GitHub/AI capabilities to perform unauthorized actions | Semantic APIs, bounded parameter scopes, user scope verification |
| Log leakage | Tokens, URL parameters, prompts, or private repo content entering logs | Structured logs, field allowlist, centralized redaction |

The security model must explicitly distinguish between:

- **Trusted host code**: GithubStarsManager itself.
- **User-installed local plugins**: In V1, treated as trusted or semi-trusted, but still enforced under least-privilege principles.
- **Plugin page content**: Treated as untrusted content.
- **Public marketplace plugins**: In the future, must be treated by default as untrusted supply chain inputs.

## 4.2 Privacy Principles

1. **Data Minimization**: Only send fields strictly necessary to complete the current operation; never pass the complete Store snapshot by default.
2. **Purpose Binding**: Inputs provided to a plugin are bound solely to the action currently triggered by the user; background batch reads require explicit separate declaration.
3. **Explicit User Triggering Preferred**: V1 actions execute upon explicit user click; silent listeners on Store mutations are prohibited.
4. **Local First**: Plugins without networking capabilities must run fully offline.
5. **Zero Credential Exposure**: Plugins only receive host-proxied results; tokens, keys, cookies, or authorization headers are never returned under any circumstances.
6. **Private Repository Sensitivity Marking**: Prompt the user before passing private repository data to a plugin; future iterations may introduce a dedicated `privateRepositories:read` permission.
7. **Revocability**: Users can disable plugins, revoke permissions, and delete plugin data at any time.
8. **Explainability**: The settings page displays recent capability invocations, network activity timestamps, target domains, and success/failure status.
9. **Deletability**: Uninstallation presents an explicit choice to either "Keep data" or "Delete plugin data".
10. **No Implied Telemetry Consent**: Plugins cannot inherit the host's telemetry channels; any plugin-specific telemetry must declare target network domains and explicit purpose.

Recommended separate definition of repository models passed to plugins, rather than reusing internal `Repository` models:

```ts
interface PluginRepositorySummary {
  id: number;
  name: string;
  fullName: string;
  htmlUrl: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  archived: boolean;
  pushedAt: string | null;
  latestReleaseAt: string | null;
  isPrivate: boolean;
}
```

By default, full README text, local notes, AI conversations, visit history, user identity, internal database fields, and credentials are excluded. When more detailed content is needed, it must be requested per-invocation via dedicated capabilities.

## 4.3 Permission Combination Risks

Permissions cannot merely be evaluated individually; combined capabilities must also be evaluated:

| Permission Combination | Actual Risk | Recommendation |
|---|---|---|
| `repositories:read` + arbitrary networking | Can exfiltrate all starred repositories | Prohibit arbitrary networking |
| `privateRepositories:read` + domain networking | Can exfiltrate private repository metadata | High-risk prompt; deny background calls by default |
| `ai.generate` + README content | Content is transmitted to user's configured AI Provider | Disclose Provider and data scope before invocation |
| `releases:read` + `downloads:create` | Can lure user into downloading malicious assets | Host validates origin and requires explicit user confirmation |
| `storage` + background execution | Can continuously build user profiles | Prohibit persistent background triggers in V1 |
| `external:open` + arbitrary URLs | Can be exploited for phishing | Require HTTPS, display URLs, reject dangerous schemes |

The installation confirmation dialog should highlight high-risk combinations rather than merely presenting a technical permission list.

## 5. Overall Architecture

```text
┌──────────────────────── GithubStarsManager ────────────────────────┐
│                                                                    │
│  React Renderer                         Electron Main Process       │
│  ┌────────────────────┐                 ┌────────────────────────┐  │
│  │ Settings Plugin UI │                 │ PluginManager          │  │
│  │ Plugin Registry    │──Restricted IPC→│ Manifest Validation    │  │
│  │ Contribution Slots │←────────────────│ Permission Decisions   │  │
│  └────────────────────┘                 │ Lifecycle / Timeouts   │  │
│           │                              └───────────┬────────────┘  │
│           │ sandboxed iframe                        │               │
│           ↓                                         ↓               │
│  ┌────────────────────┐                 ┌────────────────────────┐  │
│  │ Plugin Page        │←─postMessage───→│ Capability Router      │  │
│  │ No Node / No Token │                 │ GitHub / AI / Download │  │
│  └────────────────────┘                 └───────────┬────────────┘  │
│                                                     │               │
│                                            Isolated Plugin Runtime  │
└────────────────────────────────────────────────────────────────────┘
```

### 5.1 Electron PluginManager

`PluginManager` is responsible for:

- Scanning `<userData>/plugins/<plugin-id>/`.
- Reading and validating `manifest.json`.
- Validating `manifestVersion`, `apiVersion`, plugin ID, and entry point paths.
- Managing plugin enable, disable, uninstall, and error states.
- Starting and terminating isolated runtimes.
- Registering and tearing down plugin contributions.
- Performing permission checks on every Host API invocation.
- Enforcing timeouts, request payload limits, and response size caps on calls.

Recommended directory layout:

```text
electron/plugins/
├─ pluginManager.js
├─ pluginRuntime.js
├─ manifestSchema.js
├─ pluginProtocol.js
├─ capabilityRouter.js
└─ pluginStorage.js
```

### 5.2 Plugin Runtime

Phase 1 can use `worker_threads.Worker` to achieve:

- Lifecycle isolation.
- Main thread unblocking.
- Crash isolation.
- Runtime termination upon timeout.

A Worker is not a security sandbox. When running standard Node.js plugin code, it may still read files, inspect environment variables, or initiate direct network requests. Therefore, V1 must clearly label local plugins as "trusted or semi-trusted plugins", and must not claim to safely execute untrusted malicious code.

If a public third-party ecosystem is opened in the future, stronger boundaries such as isolated utility processes, OS sandboxing, WASM, or declarative plugins should be evaluated.

### 5.3 Renderer PluginHost

The Renderer only receives serialized and sanitized data:

```text
src/plugins/
├─ types.ts
├─ pluginClient.ts
├─ pluginRegistry.ts
├─ slots.ts
└─ hooks/
   └─ usePluginActions.ts
```

Plugin runtime objects, functions, Workers, and Electron instances must never enter the Zustand Store. `PluginRegistry` in the Renderer is an ephemeral, reconstructible in-memory state populated via IPC from `PluginManager` upon startup.

## 6. Plugin Package Format

```text
repo-health/
├─ manifest.json
├─ worker.js
└─ ui/
   ├─ index.html
   ├─ index.js
   └─ styles.css
```

Minimal manifest example:

```json
{
  "manifestVersion": 1,
  "id": "com.example.markdown-exporter",
  "name": "Markdown Exporter",
  "version": "0.1.0",
  "description": "Export selected repositories as Markdown",
  "author": "Example",
  "apiVersion": "1",
  "main": "worker.js",
  "permissions": ["repositories:read"],
  "contributes": {
    "repositoryActions": [
      {
        "id": "export-markdown",
        "title": "Export as Markdown",
        "placement": "bulk-toolbar"
      }
    ]
  }
}
```

Full plugin page example:

```json
{
  "manifestVersion": 1,
  "id": "com.example.repo-health",
  "name": "Repo Health",
  "version": "0.1.0",
  "apiVersion": "1",
  "permissions": ["repositories:read"],
  "contributes": {
    "pages": [
      {
        "id": "dashboard",
        "title": "Repository Health",
        "entry": "ui/index.html"
      }
    ]
  }
}
```

Manifest validation must satisfy:

- Plugin IDs are globally unique and immutable post-installation.
- Entry files must reside within the plugin directory.
- Reject absolute paths, `..` path traversal, and symlink escapes.
- Reject unknown permissions, unknown contribution types, and incompatible API versions immediately.
- Maintain backward compatibility within the same major API version; breaking changes require bumping the major version.

## 7. Extension Points

### 7.1 V1 Extension Points

```ts
type PluginPlacement = 'repository-card' | 'bulk-toolbar';

interface RepositoryActionContribution {
  pluginId: string;
  actionId: string;
  title: string;
  placement: PluginPlacement;
}

interface RepositoryActionInput {
  repositories: PluginRepository[];
}

type PluginActionResult =
  | { type: 'text'; content: string; suggestedAction?: 'copy' | 'save' }
  | { type: 'open-external'; url: string }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string };
```

Plugins return structured intents, and the host decides whether to copy, save, navigate to a page, or display a notification. Plugins do not directly touch host UI, the clipboard, or the filesystem.

### 7.2 Future Extension Points

- `repositoryProcessors`
- `releaseProcessors`
- `exporters`
- `pages`
- `repositoryBadges`
- `settings`

Each newly introduced extension point must have distinct inputs, outputs, permissions, and failure modes, rather than providing a generic "execute arbitrary host command" interface.

## 8. Permissions and Host Capabilities

### 8.1 Base Permissions

| Permission | Description |
|---|---|
| `repositories:read` | Read sanitized repository metadata |
| `repositories:write` | Modify allowed tags or categories via host commands |
| `releases:read` | Read Release and Asset metadata |
| `gists:read` | Read sanitized Gist metadata |
| `storage` | Access isolated plugin storage |
| `clipboard:write` | Request host to write to system clipboard |
| `external:open` | Request host to open a validated HTTPS URL |
| `downloads:create` | With user confirmation, host downloads an asset verified to belong to current Release |

### 8.2 Semantic Capabilities First

Prioritize providing semantic APIs:

```text
github.searchRepositories
github.getRepository
github.getRelease
ai.generate
web.search
downloads.downloadReleaseAsset
```

Rather than raw primitives:

```text
fetch(anyUrl)
fs.writeFile(anyPath)
exec(anyCommand)
```

GitHub and AI requests are proxied by existing host Services. Plugins only receive sanitized results, never tokens, API keys, or custom authorization headers.

### 8.3 Domain-Scoped Network Permissions

Only when semantic Host APIs cannot satisfy integration needs should domain-scoped networking be considered:

```json
{
  "permissions": [
    "network:api.github.com",
    "network:gitlab.com"
  ]
}
```

Controlled HTTP APIs must enforce all of the following:

- HTTPS only.
- Hostname must match manifest authorization entries exactly.
- Enforce allowed HTTP methods.
- Enforce request and response payload size caps.
- Set connection and total response timeouts.
- Disallow custom sensitive headers.
- Disallow automatic credential attachment.
- Disallow `localhost`, loopback, private intranet, link-local, and reserved IP ranges.
- Disallow non-HTTPS protocols such as `file:` or `ftp:`.
- Re-validate destination domain and IP on each redirect.
- Block private addresses post-DNS resolution to mitigate DNS rebinding and SSRF risks.

`network:any` is never supported.

### 8.4 Permissions Never Directly Exposed

```text
node:execute
shell:execute
process:spawn
filesystem:any
network:any
environment:read
credentials:read
ipc:any
```

## 9. Full Plugin Pages

Full pages do not import plugin React, Vue, or Svelte bundles directly. The host only loads isolated pages provided by the plugin:

```text
Host Route / Page Slot
        ↓
sandboxed iframe
        ↕ postMessage
Plugin Page Bridge
        ↓
Capability Router
```

Plugin pages must satisfy:

- No Node.js.
- No Electron APIs.
- No host Zustand Store.
- No credentials.
- No raw IPC.
- No arbitrary filesystem access.
- No arbitrary networking by default.
- Strict CSP enforcement.
- `postMessage` validates source, origin, pluginId, requestId, and message schemas.

Rich UI and high privilege are entirely distinct concerns. A plugin can display a sophisticated Dashboard while still obtaining data solely through restricted Capabilities.

## 10. Smart Release Recommendation Capability Mapping

This plugin serves as a reference verification case for subsequent capabilities:

```text
Provided by Host
├─ repository metadata
├─ release metadata
├─ asset list
└─ hostEnvironment: os + arch

Returned by Plugin
├─ recommendedAssetId
├─ confidence
└─ reason

Enforced by Host
├─ Verify asset belongs to specified release
├─ Display recommendation rationale
├─ User confirmation prompt
├─ Download destination picker
├─ Download progress indicator
└─ Optional hash verification
```

Phase 1 only recommends and downloads; it does not automatically install. If installation support is added in the future, it must require a standalone host modal displaying source, filename, and SHA-256; plugins may never execute installers directly.

## 11. Lifecycle

```text
discovered
  → validated
  → disabled / enabled
  → activating
  → active
  → deactivating
  → disabled

Failure at any stage
  → error
```

Requirements:

- Plugins are disabled by default or require explicit user confirmation of permissions after installation.
- If `activate` times out, terminate the runtime and clean up registered contributions.
- `deactivate` must tear down all actions, processors, and pages registered by the plugin.
- A failure in an individual plugin must never prevent host startup.
- Plugin errors must be viewable in Settings, but logs must be sanitized.

## 12. Data and Persistence

```text
<userData>/
├─ plugins/<plugin-id>/          Plugin files
├─ plugin-data/<plugin-id>.json  Isolated plugin data
└─ plugins-state.json            Enabled state, granted permissions, error state
```

Plugin runtime objects are never persisted into existing Zustand snapshots. Plugin state is managed by Electron; the Renderer queries and constructs the in-memory registry upon startup.

Plugin storage must:

- Be isolated per plugin ID.
- Restrict key and value sizes as well as total storage quotas.
- Only accept JSON-serializable data.
- Use safe atomic write strategies to prevent corruption from abrupt termination.

## 13. IPC Boundaries

`electron/preload.js` exposes only explicit operational methods, never raw `ipcRenderer`:

```ts
interface ElectronPluginApi {
  list(): Promise<InstalledPlugin[]>;
  installFromDirectory(): Promise<InstallResult>;
  enable(pluginId: string): Promise<PluginOperationResult>;
  disable(pluginId: string): Promise<PluginOperationResult>;
  uninstall(pluginId: string, removePluginData?: boolean): Promise<PluginOperationResult>;
  runAction(request: RunPluginActionRequest): Promise<PluginActionResult>;
}
```

The main process must independently validate all Renderer inputs; it must never skip schema validation simply because a request originates from a host page.

## 14. Installation Security

V1 development mode supports loading directly from local directories. Formal installation workflows additionally enforce:

- Explicit user selection of files or directories.
- Display ID, author, version, origin, SHA-256, and all requested permissions prior to installation.
- Enforce limits on archive size, uncompressed size, and file counts.
- Prevent Zip Slip, path traversal, and symlink escapes.
- Plugin installation paths cannot be customized via manifest.
- Re-confirmation is required whenever an update requests additional permissions.
- Deactivate and terminate the plugin runtime prior to uninstallation. Uninstallation presents an explicit choice between "Keep data" or "Delete plugin data" (isolated storage and logs).

Plugin marketplace, signing, publisher verification, and automatic updates belong to V2.

## 15. Plugin Marketplace Review and Release Governance

The plugin marketplace employs four lines of defense:

```text
Technical Runtime Isolation
  → Capability Permission Enforcement
  → Automated Security Scanning
  → Maintainer Manual Review + Version Signing
```

Manual review identifies malicious behavior, permission-to-feature mismatches, low-quality implementations, plagiarism, and intellectual property violations, but cannot substitute for runtime isolation. An approved plugin may become compromised later due to stolen developer accounts, dependency poisoning, or post-release changes.

### 15.1 Trust Levels

| Level | Meaning | Installation Method |
|---|---|---|
| `Official` | Authored and maintained by project maintainers | Direct install from marketplace |
| `Verified` | Publisher identity verified; code and release deeply audited | Direct install from marketplace |
| `Reviewed` | Current version passed manual review | Direct install from marketplace |
| `Community` | Passed automated checks only; not deeply audited manually | Install after warning or gated |
| `Local` | Sideloaded local plugin; unreviewed by marketplace | Developer mode only |

Trust levels describe provenance and review depth; they never grant elevated privileges. An `Official` or `Verified` plugin still cannot directly access Node, credentials, arbitrary networks, filesystems, or shells.

### 15.2 Release Review Workflow

```text
Developer submits source repo + build artifacts + manifest
  → Validate manifest, API version, and permissions automatically
  → Pin dependencies and generate SBOM / dependency list
  → Static scan for dangerous APIs, secrets, and known vulnerabilities
  → Run tests and behavioral checks in an isolated environment
  → Maintainer manually reviews purpose, source code, permissions, and network endpoints
  → Perform reproducible build from reviewed source code (preferred)
  → Record SHA-256, audit verdict, and version signature
  → Publish immutable release
```

Every plugin version is reviewed independently. Approval of an older version does not imply trust for newer versions.

### 15.3 Automated Checks

At minimum, verify:

- Manifest schema, plugin ID, API version, and permission declarations.
- Package size, file count, path traversal, and symlinks.
- Dangerous invocations like `child_process`, `shell`, `eval`, and dynamic code generation.
- Undeclared network endpoints and hardcoded exfiltration URLs.
- Plaintext tokens, keys, private keys, and test credentials.
- Third-party dependency lockfiles, known high-severity vulnerabilities, and install scripts.
- Minified or obfuscated code; marketplace releases generally reject obfuscated artifacts that cannot be reasonably audited.
- Correspondence between source and build artifacts, prioritizing reproducible builds.
- Plugin UI CSP, external resource loading, and `postMessage` usage.

Automated findings do not automatically classify an artifact as malicious, but they must halt automated release and require manual maintainer review.

### 15.4 Manual Review Checklist

Reviewers must confirm at least:

1. Plugin description matches its actual behavior.
2. Every permission has a verifiable functional justification.
3. Permission combinations do not create unnecessary exfiltration capabilities.
4. Network domains belong to services declared by the plugin, without tracking or covert upload endpoints.
5. The plugin does not collect data beyond functional necessity.
6. Sensitive data such as private repositories, README contents, or AI inputs include clear disclosure.
7. The plugin leaves no persistent background tasks after deactivation or uninstallation.
8. Errors and logs never contain credentials or private user content.
9. UI does not impersonate host UI, system permission dialogs, or other trusted plugins.
10. Licenses, names, icons, and code provenance have no obvious infringement.

### 15.5 Updates, Permission Changes, and Rollbacks

- Marketplace versions cannot be overwritten in place; each version tag corresponds to an immutable hash.
- Every new version re-runs automated checks and undergoes full or incremental manual review depending on risk.
- Adding permissions, expanding domains, or changing data usage mandates manual re-review.
- The client presents newly added permissions and requires user re-approval before updating.
- Updates without permission changes must still show version, publisher, and changelog notes.
- The marketplace retains recent safe versions to support rapid rollback.
- Revoked plugins are blocked from new installations; existing users receive explicit alerts without silent local data deletion.

### 15.6 Signing, Indexing, and Revocation

Each version in the marketplace index records at least:

```json
{
  "pluginId": "com.example.repo-health",
  "version": "1.2.0",
  "sha256": "...",
  "publisher": "example",
  "trustLevel": "Reviewed",
  "permissions": ["repositories:read"],
  "reviewedCommit": "...",
  "reviewedAt": "2026-09-12T00:00:00Z",
  "signature": "..."
}
```

Clients verify the index signature and plugin package SHA-256 before installation. Signing private keys must never reside in repositories or standard CI logs; dedicated secrets/signing services with key rotation plans should be used.

The marketplace also requires a cryptographically signed revocation list recording:

- Revoked plugin versions.
- Reason for revocation and link to advisory.
- Recommended rollback version.
- Whether known data exfiltration or remote execution risks exist.

### 15.7 Review Transparency and Privacy

- Plugin detail pages publicly disclose permissions, network domains, data usage, source repository, version hash, and review tier.
- Explicitly state which specific version was reviewed; never grant perpetual review badges.
- Reviewers must not request or access real user tokens, private repository data, or production credentials.
- Behavioral testing uses synthetic datasets and dedicated test accounts.
- Audit logs must not expose sensitive author or reviewer details.
- Provide reporting flows for security issues, emergency takedown procedures, and publisher appeal processes.

### 15.8 Governance Boundaries

While maintainer capacity is limited, public marketplaces should not be opened immediately. Recommended rollout progression:

```text
Local development plugins
  → Official sample plugins
  → Curated Reviewed plugin list
  → Signed marketplace
  → Tiered review and community reviewers
```

Community reviewers can participate in code reviews, but final signing and publishing authority should remain restricted to a minimal set of maintainers, requiring two-person review for plugins with high-risk permissions.

## 16. V1 Implementation Slices

The first PR implements only "discovery and validation", without executing plugin code.

### 16.1 Scope

New files:

```text
electron/plugins/manifestSchema.js
electron/plugins/pluginManager.js
electron/plugins/manifestSchema.test.js
electron/plugins/pluginManager.test.js
```

Modified files:

```text
electron/main.js
electron/preload.js
package.json
```

Features:

1. Scan top-level subdirectories under `<userData>/plugins`.
2. Read and validate `manifest.json`.
3. Return valid plugins along with diagnostic invalid plugin records.
4. Expose read-only list to Renderer via `plugins:list` IPC.
5. In this phase, no `require()`, `import()`, or Worker executes plugin entry points.

### 16.2 Explicitly Out of Scope for Round 1

- Plugin installation UI.
- Plugin execution.
- Permission authorization UI.
- Zustand integration.
- Repository card or bulk toolbar extension points.
- Full plugin pages.
- Network Host APIs.

### 16.3 Acceptance Criteria for Round 1

- Valid manifests are enumerated.
- Missing fields, invalid types, and unknown fields receive deterministic error codes.
- Duplicate plugin IDs are rejected.
- Incompatible `manifestVersion` or `apiVersion` is rejected.
- Entry paths escaping the plugin directory are rejected.
- Non-existent entry files are rejected.
- A corrupted plugin does not prevent other plugins from being scanned.
- No plugin code content is read; no plugin code is executed.
- IPC return values are sanitized and do not leak local absolute paths.
- Existing Electron MCP, proxy, tray, and frontend capabilities remain unaffected.

## 17. Future Version Roadmap

### V1: Base Plugin Protocol

- Manifest discovery and validation.
- Enable, disable, and uninstall.
- Trusted local plugin runtime.
- Repository actions.
- Processors and exporters.
- Isolated plugin storage and logging.

### V1.1: Release Capabilities

- Release processors.
- `github.*` Host APIs.
- `downloads.downloadReleaseAsset`.
- Smart Release Recommendation sample plugin.

### V1.2: Full Plugin Pages

- Plugin page contributions.
- Sandboxed iframes.
- `postMessage` bridge.
- CSP and message schema enforcement.

### V1.3: Advanced Host Capabilities

- `ai.generate`.
- `web.search`.
- Domain-scoped HTTPS networking if necessary.

### V2: Public Ecosystem

- Automated security scanning and manual review workflows.
- Version-pinned review tiers and immutable SHA-256 hashes.
- Package and marketplace index signing.
- Publisher identity, key rotation, and revocation mechanisms.
- Plugin registry/store, updates, and rollbacks.
- Re-review on permission changes and mandatory user re-confirmation.
- Hardened runtime isolation for plugins.

## 18. Testing Strategy

### Unit Tests

- Manifest schema boundaries.
- Path normalization and directory traversal escapes.
- API version compatibility.
- Permission to capability mappings.
- Lifecycle state transitions.
- Plugin storage quotas.
- Network target validation and SSRF blocking.

### Electron Tests

- IPC argument validation.
- PluginManager scan failure isolation.
- Plugin runtime timeouts and termination.
- Complete teardown of contributions upon deactivation.

### Renderer Tests

- Web environment displays "Plugins are only available on desktop".
- Plugin actions appear correctly in assigned slots.
- Action errors surface only as host notifications.
- Sandboxed page message origin and schema validation.

### Regression Verification

- `npm run lint`
- `npm run typecheck`
- `npm run check:boundaries`
- `npm run test:run`
- `npm run build`

## 19. Communication Strategy Before Upstream Submission

The plugin system represents a substantial change spanning Electron, Renderer, security boundaries, and public APIs. Before submitting code upstream, initiate a Discussion or design Issue detailing:

- Electron-only starting point.
- First round focuses solely on manifest discovery without executing third-party code.
- No exposure of credentials, Node, arbitrary networking, or raw IPC.
- Modular phased PRs that can be reviewed and rolled back independently.
- Workers are not represented as security sandboxes against malicious code.
- Full UI, networking, and marketplace are excluded from the initial PR.
- Marketplace leverages automated scanning, manual review, and version signing, but review does not broaden runtime execution privileges.

This alignment ensures maintainers agree on direction before substantial code is written, avoiding rejection over scope or security assumptions.

## 20. Questions Requiring Maintainer Confirmation

1. Is the project willing to accept Electron-only plugin capabilities, or is equivalent Web experience mandatory?
2. Are V1 plugins explicitly scoped as user-installed trusted local code?
3. Does selecting `bulk-toolbar` as the first extension point match product priorities?
4. Is storing plugin state independently in Electron `userData` without Zustand or backend synchronization acceptable?
5. Will the Plugin API be maintained as a long-term stable public interface?
6. Does using iframes for full plugin pages align with current UI architecture and CSP direction?
7. Is the project willing to commit long-term to plugin review, signing keys, revocation advisories, and security response responsibilities?
8. Should high-risk permission plugins require sign-off from at least two maintainers?

## 21. Development Starting Point

Before maintainers approve the overall direction, the only safe slice to begin implementing is Round 1 "Manifest discovery":

1. Define minimal manifest schema and deterministic error codes.
2. Write negative tests: valid, missing fields, incompatible versions, duplicate IDs, path traversal, and corrupted JSON.
3. Implement pure scanning and validation logic.
4. Add read-only `plugins:list` IPC.
5. Run Electron tests and full regression suite.

Completing this phase executes zero plugin code on the host, keeping security impact and review scope strictly bounded.

## 22. Implementation Status

As of 2026-09-13:

- Round 1 Manifest discovery and validation implemented.
- V1 local plugin protocol implemented: installation, disabled-by-default, permission confirmation, enable/disable, uninstall (with optional deletion of isolated data), Worker lifecycle, Repository Actions, Processors, Exporters, isolated Storage, and sanitized logging. `repositories:read` covers starred private repository metadata; `repositories:write` and `gists:read` remain reserved declarations.
- V1 is explicitly a trusted local plugin model; Workers do not serve as security boundaries against malicious code.
- V1.1 Release capabilities implemented: Release processors, read-only `github.*` based on host-sanitized snapshots, Release Asset downloads executed by host after user confirmation, and Smart Release Recommendation sample plugin.
- V1.2 Full plugin pages implemented: page contributions, `plugin-page:` local resource protocol, sandboxed iframes, CSP, validated `postMessage` Bridge, and Repo Health sample page. Page-only plugins can operate without Workers; if a plugin includes a Worker, V1 trusted local code constraints still apply.
- V1.3 Advanced page host capabilities implemented: per-invocation confirmed `ai.generate` and `web.search`; user-configured SearXNG HTTPS instance, preventing plugins from designating arbitrary network targets. Workers do not receive these two capabilities and continue under the V1 trusted local code model. V2 public ecosystem is not yet implemented.

V1 development protocol and examples: `docs/plugins/v1-development.md` and `examples/plugins/markdown-exporter`; V1.1 example: `examples/plugins/smart-release-recommender`.
V1.2 page example: `examples/plugins/repo-health-page`.
V1.3 page capability protocol and privacy constraints: `docs/plugins/v1-development.md`.
