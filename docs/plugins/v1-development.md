# V1 Local Plugin Development Guide

V1 plugins are local Node.js plugins explicitly installed and authorized by the user. Each plugin executes in an isolated `worker_threads.Worker` to isolate lifecycles, crashes, and timeouts.

A Worker is not a security sandbox. Plugin code can still access local files, environment variables, and networks directly via Node.js; therefore, only enable local plugins you have reviewed and trust. The host never proactively passes GitHub Tokens, AI Keys, Electron APIs, or the Zustand Store to plugins.

V1.1 introduced Release processors, read-only semantic `github.*` Host APIs, and Release Asset downloads requiring explicit user confirmation of save locations. The GitHub API queries sanitized snapshots currently loaded in host memory; it never delegates tokens, authorization headers, or arbitrary networking capabilities to plugins.

V1.2 added page contributions. Page-only plugins without a `main` entry do not launch Node Workers; pages run inside a `sandbox="allow-scripts allow-same-origin"` iframe and cannot read host DOM, Electron APIs, tokens, or the Zustand Store. `allow-same-origin` preserves the `plugin-page://<plugin-id>` origin, enabling the host to reject documents replaced by navigation; the page and host remain cross-origin, preventing pages from reading host data. If a plugin also declares `main`, that Worker remains trusted local code; page isolation does not alter its privileges.

## Minimal Directory

```text
my-plugin/
├─ manifest.json
└─ worker.js
```

Select this directory from "Settings → Plugins → Install Local Plugin". Newly installed plugins are disabled by default and will only start after the user reviews and confirms all permissions listed in the Manifest. Upon uninstallation, the host removes the plugin installation directory and prompts the user to either "Uninstall and keep data" or "Uninstall and delete data"; the latter deletes the plugin's isolated storage files and logs.

## Permissions

V1 accepts the following permissions. Unimplemented permissions can appear in the Manifest, but the corresponding Host APIs will not be provided:

| Permission | V1 Behavior |
|---|---|
| `repositories:read` | Read loaded repository snapshots in the host, **including private repository metadata**. A dedicated notice is displayed in Settings when enabled. |
| `privateRepositories:read` | Reserved. Currently lacks separate filtering; behaves identically to `repositories:read` covering private repositories. |
| `releases:read` | Read loaded Release / Asset snapshots in the host. |
| `storage` | Isolated JSON storage per plugin. |
| `clipboard:write` | Allows Actions to suggest copying text. |
| `external:open` | Allows Actions to open credential-free HTTPS URLs. |
| `downloads:create` | Allows Settings to display "Host download"; user confirmation of destination required. |
| `ai:invoke` | Page Bridge only: calls current AI Provider after per-invocation confirmation. Not available to Workers. |
| `web:search` | Page Bridge only: queries user-configured SearXNG after per-invocation confirmation. Not available to Workers. |
| `repositories:write` | Reserved; V1 does not provide Host APIs for mutating repositories. |
| `gists:read` | Reserved; V1 does not provide Gist queries. |
| `network:<domain>` | Page Bridge only (V1.5): host-authorized read-only GET proxy. Currently supports `api.github.com` with allowlisted endpoints only (see "V1.5 Page Network Capabilities"). Not available to Workers; general networking remains unavailable. |

## Manifest

```json
{
  "manifestVersion": 1,
  "id": "com.example.markdown-exporter",
  "name": "Markdown Exporter",
  "version": "0.1.0",
  "apiVersion": "1",
  "main": "worker.js",
  "permissions": ["repositories:read", "storage", "clipboard:write"],
  "contributes": {
    "repositoryActions": [
      {
        "id": "copy-repository",
        "title": "Copy repository",
        "placement": "repository-card"
      }
    ],
    "repositoryProcessors": [
      { "id": "health", "title": "Repository health" }
    ],
    "releaseProcessors": [
      { "id": "recommend-asset", "title": "Recommend asset" }
    ],
    "exporters": [
      {
        "id": "markdown",
        "title": "Markdown",
        "fileExtension": ".md",
        "mimeType": "text/markdown"
      }
    ]
  }
}
```

Plugin ID, version, permissions, contribution points, and entry paths are strictly validated. Entries must reside within the plugin directory; absolute paths, directory traversals, and symlinks are rejected.

## Worker API

The entry point exports CommonJS methods:

```js
module.exports = {
  async activate(context) {},
  async deactivate() {},
  async runAction({ actionId, repositories }) {},
  async runProcessor({ processorId, repositories }) {},
  async runReleaseProcessor({ processorId, repository, release, hostEnvironment }) {},
  async runExporter({ exporterId, repositories }) {},
};
```

`activate(context)` receives only plugin ID, granted permissions, sanitized logging, and isolated plugin storage:

```js
await context.storage.set('settings', { enabled: true });
const settings = await context.storage.get('settings');
await context.storage.delete('settings');
await context.log.info('Activated', { enabled: settings?.enabled });
```

`context.storage` is provided only when the `storage` permission is declared and granted. Common tokens, Authorization headers, and sensitive fields are redacted from logs, but plugins should not intentionally log private data.

When declaring `repositories:read` or `releases:read`, plugins receive corresponding read-only query capabilities:

```js
const matches = await context.github.searchRepositories('electron', { limit: 20 });
const repository = await context.github.getRepository(repositoryId);
const release = await context.github.getRelease(releaseId);
```

These queries inspect sanitized snapshots in host memory without making live GitHub API requests. `repositories:read` includes metadata for starred private repositories; V1 does not apply separate private repository filtering.

## Return Structures

Repository Actions return structured intents for the host to handle:

```js
return { type: 'text', content: '...', suggestedAction: 'copy' };
return { type: 'notice', level: 'info', message: 'Done' };
return { type: 'open-external', url: 'https://example.com' };
```

- `copy` requires `clipboard:write`.
- `open-external` requires `external:open` and accepts credential-free HTTPS URLs only.
- Plugins cannot return raw HTML or arbitrary host commands.

Processors can only return summary, tag, and category suggestions for repository IDs present in the current input:

```js
return {
  repositories: [{ id: 1, summary: 'Active', tags: ['healthy'] }]
};
```

Exporters return plain text and an optional filename; the host determines file extension and MIME type according to the Manifest:

```js
return { content: '# Repositories', fileName: 'stars.md' };
```

Release processors return an Asset ID belonging to the current Release, along with confidence and a concise rationale:

```js
return {
  recommendedAssetId: 123,
  confidence: 0.92,
  reason: 'Windows x64 installer'
};
```

The host verifies asset ownership. Only when a plugin declares and receives `downloads:create` will recommendation results display "Host download"; when clicked, users must still confirm filename, source, and destination in a native save dialog. Plugins receive neither the download URL nor the local path, and cannot run installers automatically.

## Limitations

- Single Action / Processor / Exporter invocations accept at most 1,000 repositories.
- Action / Processor result payload capped at 1 MiB; Exporter text capped at 5 MiB.
- Individual Storage values capped at 64 KiB; total quota capped at 1 MiB per plugin.
- Local installation packages capped at 2,000 files and 50 MiB total; symlinks disallowed.
- Runtime invocations time out after 5 seconds by default; timeouts or protocol errors terminate the plugin runtime.

Complete examples available at `examples/plugins/markdown-exporter` and `examples/plugins/smart-release-recommender`.

## V1.2 Full Plugin Pages

Page-only Manifests can omit `main`:

```json
{
  "manifestVersion": 1,
  "id": "com.githubstarsmanager.repo-insights",
  "name": "Repo Insights",
  "version": "0.1.0",
  "apiVersion": "1",
  "permissions": ["repositories:read"],
  "contributes": {
    "pages": [{ "id": "insights", "title": "Repository Insights", "entry": "ui/index.html" }]
  }
}
```

Once enabled, click "Open Page" under "Settings → Plugins". The host serves HTML, JS, CSS, and images from the page directory via the `plugin-page:` custom protocol; path traversals and symlinks escaping the page directory are rejected. The iframe CSP blocks external networking, nested frames, Workers, forms, and inline scripts by default. Frameworks such as React or Vue must be pre-built into static assets using relative paths, avoiding external CDN runtime scripts.

The CSP `style-src` directive permits only external stylesheets within the plugin directory and excludes `'unsafe-inline'`: dynamically injected `<style>` elements and `style` attributes are silently blocked, reverting cards or charts to browser defaults. For runtime styles, use external stylesheets or Constructable Stylesheets (`new CSSStyleSheet()` + `replaceSync()`, attached to `root.adoptedStyleSheets`). In Shadow DOM, note that `:root` does not match elements inside the shadow tree; custom properties should be attached to actual root elements like `#card`. A working example is available in `examples/plugins/repo-info-card`.

Pages communicate with the host via a versioned `postMessage` protocol. Upon loading, the host dispatches `plugin-page:init` containing an ephemeral token for the page session. Requests follow this structure:

```js
window.parent.postMessage({
  type: 'plugin-page:request',
  pluginId: 'com.githubstarsmanager.repo-insights',
  pageId: 'dashboard',
  requestId: 'request_1',
  token,
  method: 'repositories.search',
  args: { query: 'react', limit: 20 },
  origin: window.location.origin,
}, '*');
```

Because the host window origin varies (`localhost` in dev, `file://` packaged), the page must target `'*'`. Messages must therefore specify `origin`, matching `event.origin` and equaling `plugin-page://<plugin-id>`. The host dispatches messages to pages using this exact origin rather than `'*'`.

Available methods: `repositories.search`, `repositories.get`, `releases.get`, `storage.get`, `storage.set`, `storage.delete`. Every request is re-validated in the Electron main process against plugin state, page declarations, parameter schemas, and Manifest permissions. Returns represent sanitized host memory snapshots rather than live GitHub API calls; without `repositories:read`, `releases:read`, or `storage` permissions, calls are rejected. Page messages are further governed by origin, ephemeral token, payload size, concurrency, and rate limits.

A complete runnable example is available at `examples/plugins/repo-insights`. When pages close or plugins are disabled or uninstalled, the host terminates page resources and capability access. V1.2 is a local development feature and does not imply marketplace vetting or full security isolation against arbitrary local malicious code.

## V1.3 Advanced Page Capabilities

Page plugins can optionally declare `ai:invoke` and/or `web:search`. These are exposed solely via the sandboxed page `postMessage` Bridge; AI keys, search credentials, arbitrary `fetch`, and Node APIs are never exposed to plugins. Local Workers with a `main` entry remain trusted local code and do not receive corresponding Worker `context` methods by declaring these permissions.

```js
// Sent using the V1.2 message format, with method and args updated:
method: 'ai.generate',
args: { system: 'Summarize this repository', user: 'Public repository details', maxTokens: 500 },
// On success, returns value: 'generated text'

method: 'web.search',
args: { query: 'open source alternatives', limit: 5 },
// On success, returns value: [{ title, url, snippet }]
```

The host verifies plugin state, page declarations, arguments, and Manifest permissions, then presents the complete AI prompt or search query, explains the target service, and prompts the user for confirmation. If denied, no request is sent. AI requests route exclusively through the user's currently active Provider; requests may be proxied through a configured backend, and the plugin receives only generated text. Plugin AI prompts are never written to debug logs; closing the page aborts active AI requests. Invocations fail without fallback if no Provider is configured.

`ai.generate` enforces strict parameter limits: `system` ≤ 2,000 characters, `user` ≤ 160,000 characters, `maxTokens` ≤ 4,000. The 160,000 character user budget (~480 KB UTF-8, well within the 1 MiB request budget even with JSON escaping) allows content generation pages to include full repository README contents verbatim (see `examples/plugins/repo-info-card`); the confirmation modal displays the full text for user review.

Web searches require users to configure a trusted SearXNG HTTPS instance in "Settings → Plugins"; this feature is disabled by default with no public instances pre-configured. The instance must have JSON output enabled. Plugins cannot specify domains or URLs, and can submit queries up to 200 characters with a limit of 1–10 results. The host rejects non-HTTPS, credentialed, or localhost addresses, does not follow redirects, and enforces timeout and response size limits. Queries are sent to the configured instance and its underlying search engines; do not include private repository information, personal notes, or secret keys in queries without user consent. `network:<domain>` remains a reserved Manifest declaration; V1.3 does not provide general networking APIs.

## V1.4 Modal Actions (opensPage) and Page Output Capabilities

Page plugins can declare a "Modal Action": when a user clicks the action under "Plugin Actions" in a repository card's `…` menu, the host does not launch a Worker; instead, it mounts the specified plugin page inside a modal (sandboxed iframe with an identical capability bridge to V1.2/V1.3).

```json
{
  "contributes": {
    "repositoryActions": [
      {
        "id": "generate-info-card",
        "title": "Generate repo info card",
        "placement": "repository-card",
        "opensPage": "info-card"
      }
    ],
    "pages": [
      { "id": "info-card", "title": "Repository Info Card", "entry": "ui/index.html" }
    ]
  }
}
```

Constraints and Validation:

- `opensPage` must reference a valid page id declared in `contributes.pages` of the same plugin, and `placement` must be `repository-card`; references to non-existent pages fail installation.
- Actions declaring `opensPage` do not require a `main` entry in the Manifest; plugins containing only these actions do not spawn Node Workers. Plugins with standard actions (without `opensPage`) must still provide `main`.
- Repository contribution permissions remain identical: `repositories:read` (or `privateRepositories:read`) is required.

Repository Context Delivery: Upon opening the modal, the host delivers an initial `context` field inside the `plugin-page:init` message:

```js
{
  type: 'plugin-page:init', pluginId, pageId, token,
  context: { repository: { /* Renderer repository object */ }, readme: '… or null', language: 'en' }
}
```

`context` is proactively dispatched by the host; it bypasses the capability bridge and does not require per-invocation confirmation. Subsequent capability calls from the page must still navigate the permission-gated bridge. README content is fetched by the host when opening the modal (or `null` on failure); plugins must function gracefully using metadata alone. Page plugin `context` also provides `accountTag` (the current GitHub identity tag), allowing pages to namespace local caches before rendering.

Page Output Capabilities (Page Bridge only, unavailable to Workers):

| Method | Arguments | Permission | Behavior |
|---|---|---|---|
| `clipboard.write` | `{ text }` | `clipboard:write` | Main process writes text to system clipboard |
| `clipboard.writeImage` | `{ dataBase64 }` (PNG) | `clipboard:write` | Main process decodes and writes image to system clipboard |
| `downloads.saveFile` | `{ fileName, dataBase64 }` | `downloads:create` | Opens native save dialog; writes file upon user confirmation |

Parameter Limits: Base64 payloads for `clipboard.writeImage` and `downloads.saveFile` are permitted up to 10 MiB (other methods remain capped at 1 MiB); `fileName` prohibits path separators and leading dots. Save locations are always confirmed by users in native dialogs; plugins never receive file paths.

A complete runnable example is available at `examples/plugins/repo-info-card`.

## V1.5 Page Network Capabilities (network.request)

Page plugins can declare `network:<domain>` permissions (e.g., `network:api.github.com`) to make read-only GET requests proxied by the host via the `network.request` bridge method. In V1.5, authorization is granted once upon enabling the plugin (with descriptive details in the permission dialog), without per-request prompts. Execution mirrors `ai.generate` / `web.search`: the main process validates parameter allowlists and `network:<host>` permissions (returning authorized metadata), and the renderer dispatches requests using the user's GitHub Token. Tokens never enter IPC arguments and are never exposed to pages.

```js
// Dispatched using the V1.2 message format, with method and args updated:
method: 'network.request',
args: {
  host: 'api.github.com',
  path: '/repos/facebook/react/stats/commit_activity',
  query: { per_page: 12 },           // Optional; permits only per_page / page (1–100)
                                     // and state (open/closed/all enum)
},
// On success, returns value: { status, body, acct }; acct is the current GitHub identity tag
// (truncated SHA-256 of token, or 'anon' for unauthenticated requests; token unexposed),
// used to namespace local caches per account; 202/204 responses return body: null,
// non-2xx HTTP responses normalize to success: false (code: 'PLUGIN_NETWORK_HTTP_ERROR').
// Redirects are rejected (redirect: 'error') to prevent bypassing path allowlists.
```

Constraints and Validation (Enforced symmetrically across main process `pluginPageBridge` and renderer executor):

- `host` currently accepts `api.github.com` only; `path` must be a clean path (no query strings, fragments, credentials, or whitespace) matching an allowlist of read-only metrics endpoints:
  `/repos/{owner}/{repo}`, `/stats/commit_activity`, `/stats/participation`, `/stats/code_frequency`, `/contributors`, `/languages`, `/releases`, `/pulls`, `/tags`, `/stargazers`, `/stargazers/history`, `/community/profile`, `/security-advisories`, and owner profiles `/users/{login}`.
- GET only; request headers are fixed by the host (`Accept: application/vnd.github+json`, `X-GitHub-Api-Version`, and `Authorization: Bearer` when token is present).
- Requests without configured tokens proceed anonymously (subject to GitHub's 60 req/hour limit).
- Response timeout 15 seconds, body size cap 4 MiB; page Bridge concurrency and rate limits apply.
- Method unavailable to Workers (`network` capability in Worker routing performs authorization checks only).

`stats/*` endpoints return 202 (`body: null`) when GitHub generates caches for the first time; pages should treat this as "statistics generating" and retry later.

A complete runnable example is available at `examples/plugins/repo-insights` (Repository Insights dashboard: health check summary, authors, contributors, commit activity, code frequency, languages, release cadence, community health, security advisories, star trends, and health score, using bundled Chart.js).
