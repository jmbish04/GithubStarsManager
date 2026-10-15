# Diagnostic Logging Overhaul Plan

Date: 2026-10-04 (v2, revised based on audit report)
Status: Pending Review
Audit: `audit-diagnostic-logging-design.md` (Verification log in Section 7 — adopted 7 revisions and 5 safeguards; rejected 3 unfounded claims)
Delivery Strategy: **Single branch, single PR, single commit** (Internal work items represent implementation order only; see Section 4)
Goal: Make "user-provided diagnostic logs" a self-sufficient means to diagnose issues across any module; ensure debug mode captures **all** outbound requests; maintain zero behavioral changes across existing functionality throughout.

---

## 1. Current State Diagnosis (Code Walkthrough, Figures Verified & Corrected via Audit)

The current architecture consists of **three isolated logging silos + ad-hoc manual network tracing**, with inherently incomplete coverage:

| Component | Location | Current State | Deficiencies |
|---|---|---|---|
| Renderer Logger | `src/services/logger.ts` | In-memory ring buffer (2,000 entries), sanitized on write, broadcast to UI via DOM CustomEvent (`gsm:diagnostic-log-added`); 22 files referenced across repo (including tests) | **No persistence**; lost on reload or crash |
| Backend Logger | `server/src/services/logger.ts` | Identical in-memory ring buffer + `/api/logs` | In-memory only; most desktop users do not run the backend |
| Plugin Logs | `electron/plugins/pluginLogger.js` | One JSONL file per plugin, 1MB rotation, written to disk | Not visible in diagnostics panel or export bundles; effectively stranded |
| Main Process | `electron/main.js` | Bare `console.log` only | **Zero logging**: no disk persistence, no process-level exception handling, no crash event capture |
| Global Error Handling | — | No `window.onerror`, `unhandledrejection`, or `process.on('uncaughtException')` | Errors escaping try/catch can only be inspected via DevTools |
| Debug Request Tracing | `githubApi.ts`, `backendAdapter.ts`, `aiService.ts`, `webdavService.ts` (4 locations) | Hand-crafted `if (logger.isDebugMode()) {...}` cloning responses for logging | **Manual instrumentation with blind spots**: 4 direct fetch calls in `githubApi` (`getGistFileRaw` 787/802, RSS 1644/1851) bypass `makeRequest` debug blocks; `webdavService` only logs minimally in upload/download, leaving `davFetch`/`testConnection`/`listFiles` completely unlogged |
| Uncaptured Callers | — | — | 10+ renderer service files call bare `fetch()` directly (`vectorSearch`, `translate`, `telegram`, `xTweet`, `update`, `rpcDownload`, `grepApp`, `weeklyIssues`, `externalDiscoveryFeed`, `useNetworkActions`, etc.); all 3 main-process network stacks (`undici` fetch / `net.fetch` / `node:https`) are uncaptured |
| Environment Info | `DiagnosticLogsPanel.tsx:393-405` exported env block | 10 browser fields only | Lacks OS/architecture, Electron/Node/Chrome versions, plugin list, proxy status, and session IDs |
| Export | `DiagnosticLogsPanel.tsx:377-419` | Browser Blob download containing only frontend ring buffer + backend in-memory logs | Excludes main process, plugins, and network logs; data lost after page reload |

Conclusion: The root issue is not "insufficient instrumentation", but the **absence of a logging core** (no main-process disk persistence, no global safety nets) and **reliance on manual tracing** (new code inherently escapes capture). This plan rebuilds around these two pillars.

---

## 2. Design Principles (Hard Guarantees for Zero Functional Regression)

1. **Additive Only**: The `Logger` class (`src/services/logger.ts`) receives **zero modifications**—its output is already broadcast via DOM CustomEvent `gsm:diagnostic-log-added` (logger.ts:58). The persistence bridge simply listens to this event. The 22 existing business references remain completely unaware of the new functionality. `LogEntry` only adds fields and never removes existing ones.
2. **Capture Layer Never Throws**: All capture code (fetch patch, netTap, global handlers, disk persistence, startup cleanup) is wrapped in top-level try/catch. Capture failures silently degrade to in-memory only, never impacting business request execution paths.
3. **Out-of-Band Network Capture**: Requests and responses pass through untouched. `response.clone()` occurs only when debug mode is enabled and all three size/type/frequency guards pass (large files, binary payloads, SSE streams, and high frequencies are never cloned). Request headers and bodies are sanitized before truncation; **business ReadableStreams are never consumed**—the cloned branch is read asynchronously after cloning.
4. **Performance Budget**: In normal mode, the capture path only performs string truncation and regex redaction (microsecond scale). Main-process disk writes use **batched IPC** (flushed every 2 seconds or 32 entries), avoiding per-entry IPC. The main process writes files using a serialized queue with backpressure control.
5. **Privacy Safe by Default**: Redaction rules currently have **three distinct implementations** (`src/utils/logSanitizer.ts`, `server/src/services/logSanitizer.ts`, and inline rules in `electron/plugins/pluginLogger.js`). The main process core introduces a fourth (`electron/redact.js`, as TS cannot be reused directly). Behavior is locked across all implementations using **cross-consistency tests against shared test vectors** (see 3.1). Body capture is enabled **only in debug mode**; redaction is applied both at write time and export time.
6. **Disk Budget**: 5MB/day in normal mode, 20MB/day in debug mode, retained for 7 days with a 20MB total cap (relaxed to 40MB in debug mode), pruned on startup. Pruning and disk write failures degrade silently to in-memory without throwing errors or blocking application startup.

---

## 3. Target Architecture

```
┌─ Renderer Process ───────────────────────────────┐
│ Business code (zero changes, 22 logger references)│
│   └→ window.fetch ─→ [fetchCapture decorator] ─→ Network
│ Logger (unchanged)──CustomEvent──→ diagnosticsBridge
│   ├ Global safety net: onerror / unhandledrejection
│   ├ Flood aggregation (repeatCount)
│   └ Batched throttling (2s / 32 entries) ──invoke─┐
│     Unload flush ────send (one-way)───────────────┤
└─────────────────────────────────┬────────────────┘
                                  ▼
┌─ Main Process ────────────────────────────────────────────────────────┐
│ diagLogger (Single disk core: <userData>/logs/diagnostics/ daily JSONL)│
│   ← Renderer batches (no duplicate flood aggregation)                  │
│   ← Main process logs + process exceptions + render/child-process-gone │
│   ← undici / builtin fetch netTap (2+3 call sites) ← Plugin fetchImpl  │
│   ← session.webRequest observer (Zero-change Chromium stack coverage)  │
│   ← webSearch.js node:https manual entry (Only viable path; agent:false)│
│   ← Plugin capability log mirror (Single line in capabilityRouter)     │
│ systemInfo (OS / arch / versions / plugin list / proxy status / session)│
│ diagnostics:exportBundle → aggregates 5 sources → dialog.showSaveDialog│
└────────────────────────────────────────────────────────────────────────┘
Backend server (optional): Existing /api/logs preserved, merged on export; plugin logs included in bundle
```

### 3.1 Main Process Logging Core `electron/diagLogger.js` (New)

```js
createDiagLogger({ logsDir, maxFileBytes, maxFiles = 7, maxTotalBytes })
// Normal mode maxFileBytes=5MB; debug mode relaxed to 20MB; maxTotalBytes 20MB/40MB accordingly
```

- Disk format: `<userData>/logs/diagnostics/diagnostics-YYYY-MM-DD.jsonl`, one entry per line; daily rotation + startup pruning for budget overages. **Pruning failures are caught and swallowed, never blocking application startup**.
- `record(entry)`: Write-time redaction → serial write queue (backpressure safe); `ingestRenderer(entries)`: validates + rate-limits (≤200 entries/batch) before ingestion. **Entries with `source=frontend` bypass secondary flood aggregation** (renderer already aggregates them, preventing double-counting `repeatCount`); `readTail({ since, level, sources, limit })` powers panel display and bundle exports.
- Flood aggregation for main-process entries: Identical `module+level+message` hashes within a 10-second window aggregate into a single entry with `repeatCount` (suppressing retry storms and offline polling noise).
- Automatically logged main-process events (previously uncaptured):
  - `process.on('uncaughtException' | 'unhandledRejection')` (`electron.app`)
  - `app.on('render-process-gone' | 'child-process-gone')` (critical crash evidence)
  - `webContents.on('console-message')` with `level === 'error'` capturing escaped renderer logs (deduplicated, module name `electron.renderer-console`)
  - `app.on('will-quit')` queue flush (audit confirmed `will-quit` is correct; `before-quit` semantics do not match)
- Every entry carries a uniform `sessionId` (a UUID generated on each startup), allowing end-to-end trace correlation.

Tests: `electron/diagLogger.test.js` (`node:test`, dependency-injected fs/clock, matching `desktopPrefs.test.js` style).

### 3.2 Renderer Process Refactoring

- **`src/services/diagnosticsBridge.ts` (New) — Key to Zero Logger Changes**:
  - Listens to the **existing** DOM CustomEvent `gsm:diagnostic-log-added` to collect all Logger output; upon initialization, calls `logger.getEntries()` once to backfill startup logs (including early errors) before beginning incremental listening; also listens to `gsm:diagnostic-logs-cleared` to synchronize disk clear state.
  - Tiered persistence: normal mode persists `warn/error`; debug mode persists all levels (matching existing `minLevel` semantics).
  - Flood aggregation occurs at this layer (entries dispatched to the main process already carry `repeatCount`).
  - Electron environment detection reuses `src/services/electronProxy.ts` checking `window.electronAPI`; web mode cleanly degrades to in-memory only (matching current behavior).
  - Batched throttling: regular flushes every 2 seconds or 32 entries via `ipcRenderer.invoke('diagnostics:append', entries)`; **additionally exposes `diagnostics:flush` over `ipcRenderer.send` (one-way, non-blocking)** triggered during `pagehide` and `beforeunload`—ensuring buffer logs are not lost prior to reload or crash (a gap identified during audit).
- **Global Safety Nets (`src/main.tsx` installation, new `src/services/globalErrorHandlers.ts`)**: `window.onerror`, `unhandledrejection`, resource loading errors → recorded as `logger.error('ui.global', ...)`, complementing ErrorBoundary (`src/components/ErrorBoundary.tsx`, which only protects within the React tree) to capture escaped exceptions.
- **`src/services/fetchCapture.ts` (New, Core Solution)**: Decorates `window.fetch` once before `main.tsx` mounts (idempotency guard; provides `uninstall()` to restore original fetch for testing; not auto-installed in Vitest). Tiered capture:
  - **Normal mode**: Logs failures only—rejected fetches (network errors) logged as `error`, HTTP 4xx/5xx logged as `warn` (URL, method, status code, duration, no headers/body). Negligible log volume, establishing comprehensive error visibility.
  - **Debug mode**: Full recording + request headers (values redacted, key names preserved) + request body preview (string bodies only, truncated at 8KB) + response headers / body preview (`clone()` followed by async read of clone branch, truncated at 16KB).
  - Triple safety guard: (1) `content-length > 256KB` or binary content-type → do not clone or read body, log metadata only; (2) **Inspect response Content-Type for streaming** (`text/event-stream` → skip body capture; does not rely on request headers, correcting an audit finding); (3) **Body capture rate budget**: Global maximum of 60 body captures per minute; exceeding requests degrade to metadata-only (protecting against memory pressure from rapid bursts of small responses, added via audit).
  - Independent network ledger ring buffer (**FIFO cap of 1,000 entries**) available for export and panel inspection.
  - **Coexists** with existing 4 manual tracing blocks: manual blocks retain business context (`operationTag`, rate limit headroom), while fetchCapture provides exhaustive network visibility; entries align by URL + timestamp in panel without deduplication (retaining manual blocks avoids touching `githubApi.ts` hot paths).

### 3.3 Main Process Request Capture

`electron/main.js` network stack conventions are constrained by source scanning in `electron/outboundFetchGate.test.js`. **Gate tests have been verified by inspection**, asserting: (1) Must include a destructuring line matching `/\{\s*fetch:\s*undiciFetch\s*,\s*ProxyAgent\s*\}\s*=\s*require\('undici'\)/`; (2) Disallows bare calls matching `/(?<![.\w$])fetch\s*\(/`. Gate safety policy is established accordingly (avoiding runtime reassignment tricks):

```js
// Top of main.js: preserve destructuring line byte-for-byte (assertion 1 intact)
const { fetch: undiciFetch, ProxyAgent } = require('undici');
// Immediately follow with wrappers: identifiers contain uppercase Fetch; fetch.bind( does not match bare call regex (assertion 2 intact)
const undiciFetchTapped = diagTap.wrapFetch(undiciFetch, { source: 'main:undici' });
const builtinFetchTapped = diagTap.wrapFetch(fetch.bind(globalThis), { source: 'main:node-fetch' });
```

| Network Stack | Capture Mechanism | Scope of Change (Individually Verified) |
|---|---|---|
| Direct undici calls (`main.js:439` telegram, `:507` webdav; 2 total) | Rename call sites to reference `undiciFetchTapped` | 2 direct replacements |
| Ternary selection sites (`:378`, `:584`, `:654`, e.g., `dispatcher ? undiciFetch : fetch`) | Change to `dispatcher ? undiciFetchTapped : builtinFetchTapped` — **captures builtin fetch fallback**, which was missing in original design | 3 call sites |
| Chromium stack (`net.fetch` across ~8 call/pass sites, including marketplace, registry, downloads) | **`session.webRequest` observer** (`onBeforeRequest/onCompleted/onErrorOccurred`): zero call-site changes, automatically covering current and future `net.fetch` calls | 1 new code block |
| undici error details | Inside `diagTap.wrapFetch`, reuse `electron/mainFetch.js`'s existing `summarizeFetchError` to unroll error chains | — |
| `node:https` (`electron/plugins/webSearch.js`, verified `agent: false` + custom `publicLookup`; **bypasses both undici and Chromium session; neither observer nor wrapper can intercept**) | Manually record in completion callback within that file — the only viable path | 1 call site |
| Plugin-injected `fetchImpl` (`main.js:1166`) | Wrap with `diagTap.wrapFetch` | 1 call site |

`electron/netTap.js` (New): `wrapFetch(fetchImpl, { source })` pure decorator—passes arguments transparently, rethrows exceptions transparently, logging only URL (redacted), method, status, duration, and error chain; normal mode logs failures only; debug mode logs full traffic with small response previews.

### 3.4 System Information `electron/systemInfo.js` (New)

Written as snapshots upon export and at startup: OS platform/release/arch, Electron/Chrome/Node versions (`process.versions` + `app.getVersion()`), language/timezone, proxy configuration shape (**passwords excluded**), plugin inventory (id/version/enabled state), repository count, routing mode (`routeMode`), frontend/backend debug toggles, sessionId. Replaces existing 10-field env block (retaining backward-compatible fields).

### 3.5 Diagnostic Bundle Export v2

- New IPC `diagnostics:exportBundle`: Main process aggregates **frontend ring buffer + main process JSONL tail + network ledger + backend `/api/logs` (passed from renderer) + plugin log tails + system snapshot** → writes to disk via `dialog.showSaveDialog` (reusing pattern from `pluginHostOperations.saveFile` in `main.js:1132`: filename sanitization, overwrite confirmation, createDirectory); web mode retains Blob download path.
- Format `github-stars-manager-logs-v2`: Preserves v1 fields `frontendLogs`, `backendLogs`, and `sanitizationNote`; adds `sources.{main,network,plugins}`, `app`, and `sessionId`.
- Default time window: 24h (UI selectable: 1h / 24h / All); maximum bundle size: 5MB (pruned from oldest with truncation marker when exceeded).

### 3.6 Panel and Debug Toggles (Conservative Modifications)

- `DiagnosticLogsPanel.tsx`: Source filter expands from Frontend/Backend to **Frontend / Main Process / Backend / Plugins**; "Generate Diagnostic Bundle" button (with time-window picker); expandable network ledger in debug mode. Existing filters, event types (`logEventTypes.ts`), and indicators (`DebugModeIndicator.tsx`) remain unchanged.
- New i18n keys (passing `check:i18n` gate for both zh/en locales): `settings.logs.sourceMain`, `settings.logs.sourcePlugins`, `settings.logs.exportBundle`, `settings.logs.exportWindowHour`, `settings.logs.exportWindowDay`, `settings.logs.exportWindowAll`, `settings.logs.networkLedger`.
- Debug toggle continues using sessionStorage (session-scoped). "Persisting debug mode across restarts" alters existing behavioral semantics and remains an optional future enhancement outside this scope.

---

## 4. Implementation Plan (Single Branch · Single PR · Single Commit)

All work is delivered in **one PR, one commit** (suggested commit message: `feat(diagnostics): build comprehensive diagnostic logging and global request capture`). The following outlines the implementation order and self-check sequence prior to committing.

### Implementation Sequence (Within the Commit)

1. **Core and Invariants**: `electron/redact.js` (+test) → `electron/diagLogger.js` (+test) → `electron/systemInfo.js` (+test) → `electron/netTap.js` (+test)
2. **Main Process Wiring**: `main.js` (IPCs `diagnostics:append`/`diagnostics:flush`/`diagnostics:exportBundle`, process-level handlers, webRequest observer, 3+2 fetch call-site wrappers, plugin fetchImpl wrapper, will-quit), `preload.js`, `webSearch.js` 1 manual logging point
3. **Renderer Process**: `diagnosticsBridge.ts` (+test, CustomEvent listener + flood aggregation + batched throttling + unload flush), `globalErrorHandlers.ts`, `fetchCapture.ts` (+test), `electronProxy.ts` typings, `main.tsx` installation
4. **UI and Export**: `DiagnosticLogsPanel.tsx` (source filters / export bundle button / ledger view), i18n strings (zh/en)
5. **Tests and Scripts**: `package.json` — **Note: `test:electron:mcp` explicitly enumerates test files rather than using a glob; newly added tests are not auto-discovered**: add `test:electron:diagnostics` script (`node --test electron/diagLogger.test.js electron/redact.test.js electron/netTap.test.js electron/systemInfo.test.js`) and wire into `test:run` chain
6. **Cross-Consistency Redaction Tests**: `tests/fixtures/sanitization-vectors.json` shared test vectors (GitHub tokens, `sk-`, Bearer, gsm_mcp_, emails, URL query parameters, etc.), driving `src/utils/logSanitizer.ts` (Vitest), `electron/redact.js` (node:test), and `server/src/services/logSanitizer.ts` (server tests)—locking identical behavior across all four implementations

### Pre-Commit Checklist (All Must Pass)

- [ ] `npm run typecheck`, `npm run lint`, `npm run test:run` (including `test:electron:diagnostics`) all green
- [ ] `outboundFetchGate.test.js` passes: destructuring line untouched, no bare `fetch(` calls (verified new identifiers do not trigger regex)
- [ ] `check:i18n` and `check:bundle-size` pass (fetchCapture and bridge are lightweight modules)
- [ ] Manual test matrix: web mode / Electron mode × debug toggle × proxy toggle × AI streaming chat × large release asset download × WebDAV transfer × plugin runtime — request behavior matches pre-change baseline
- [ ] Prior to implementation, re-verify call sites per audit suggestion: `grep -n 'undiciFetch\|net\.fetch' electron/main.js` matches the table (wrap any newly discovered sites)
- [ ] Disk logs remain intact across reloads, restarts, and process kills (verified flush path)

### Workload Estimate

Total ≈ 2,000 lines (including tests). Breakdown: core and invariants ~700, main process wiring ~400, renderer ~500, UI/export/i18n ~250, cross-consistency tests and scripts ~150.

---

## 5. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| fetch patch breaks streaming responses (AI SSE) | **Inspect response Content-Type**: skip cloning on `text/event-stream`; targeted streaming manual testing |
| fetch patch consumes business ReadableStream | Only read asynchronous clone branch after `clone()`, never touching the original response stream |
| `clone()` causes memory amplification (release asset downloads) | Size/type dual guards + **rate budget of 60 body captures/min**; >256KB logs metadata only |
| Per-entry IPC flood | Batched throttling (2s / 32 entries) + ≤200 entries/batch + auto-degradation to error-only if renderer entries/sec exceed threshold |
| Crash or reload drops trailing logs | `pagehide`/`beforeunload` triggers one-way non-blocking `send` flush; bridge backfills startup buffer upon installation |
| Disk fills up / pruning fails | Rotation + budget (debug mode relaxed to 20MB/day) + startup pruning wrapped in try/catch to avoid blocking startup; write failures silently degrade |
| Log flooding (retry storms / offline polling) | Flood aggregation (`repeatCount`); **renderer aggregates, main process skips secondary aggregation for frontend entries**, avoiding semantic overlap |
| Network ledger memory growth | Standalone ring buffer capped at 1,000 entries FIFO |
| Sensitive data leaks into logs | Double redaction at write time + export time; body capture in debug mode only; **four redaction implementations locked via shared test vectors** |
| Conflict with outboundFetchGate gate | Verified assertions: destructuring line untouched byte-for-byte, new identifiers contain no bare `fetch(`; grep verify call sites prior to implementation |
| Logging code throws, impacting business paths | All capture layers wrapped in try/catch + silent degradation |

## 6. Explicitly Out of Scope

- No third-party telemetry / crash reporting integrations (Sentry, etc.)—diagnostic data remains local and is provided only with explicit user action.
- Inbound request logging for local MCP server (`mcpLocalServer.js`) is unchanged—it does not constitute an "outbound request".
- Debug toggle persistence semantics unchanged (retains sessionStorage; listed as optional enhancement).
- Backend server retains existing `/api/logs` format, with optional file logging via env flag; no UI added.
- No capture for `XMLHttpRequest`, `EventSource`, or `WebSocket`—**verified zero usage across entire `src/` directory**; if introduced in the future, probes should be added alongside fetchCapture (extension comment left in module).
- No child process output capture—**verified zero usage of `child_process`/`exec`/`spawn` across `electron/`**; plugins execute within Worker threads (`pluginRuntime.js`), leaving no surface here.

## 7. Audit Verification Record (2026-10-04)

Following itemized review of the audit report: **Adopted** 7 revisions and 5 safeguards (reflected in this v2 document: Logger unchanged via CustomEvent (3.2), gate assertions verified with fixed strategy (3.3), third redaction copy and shared test vectors (Section 2.5 / 4.6), existing manual tracing blind spots and coexistence strategy (Section 1 / 3.2), webSearch single viable path confirmed (3.3), beforeunload flush / ledger cap / rate budget / flood semantics / non-blocking pruning / SSE Content-Type detection / debug mode disk relaxation / explicit gate test enumeration (3.1–3.2 / 4 / 5)).

**Rejected** 3 unfounded claims (evidence below):

1. "Logger import measured across 35 files" — Actual `grep -rl "services/logger" src` = **22** files (including tests); original "20+" was accurate.
2. "Plugin execution may use child processes, missing stderr capture" — `grep child_process|execSync|.spawn(` yields zero hits across `electron/`; plugins run in Worker threads (`pluginRuntime.js` `new Worker(pluginWorker.js, ...)`), so this gap does not exist.
3. "XMLHttpRequest/WebSocket coverage gap" — Zero usage across repo `src/`; this represents a hypothetical rather than an actual gap; downgraded to an explicit out-of-scope note.

Corrected figures: undici call sites consist of **2 direct calls + 3 ternary selections** (original "~6" was ambiguous; audit's "5 sites" missed builtin fetch fallback coverage—v2 adds `builtinFetchTapped`); `net.fetch` spans ~8 call/pass sites; "20+ services uncaptured" refined to "10+ renderer service files + 3 main-process stacks".
