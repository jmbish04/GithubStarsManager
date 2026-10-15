# October 2026 Dependency Audit Decision Record

> Related PR: `build/desktop-deps-hardening` (PR-02, desktop packaging and dependency health)
> Audit and implementation date: 2026-10-12 · Node 24 / npm 11 · Main repo audit baseline: 13 vulnerabilities (8 moderate + 5 high)

## 1. Audit baseline (snapshot of `npm audit` output on the day of implementation)

```
# npm audit report

braces  *
Severity: high
braces vulnerable to stack-exhaustion denial of service through deeply nested patterns
  → GHSA-vfj7-8cjw-p6xm
node_modules/braces
  chokidar 2.0.0 - 3.6.0 → tailwindcss <=3.4.19
  micromatch >=0.2.0 → fast-glob *

sprintf-js  *
Severity: moderate
sprintf-js vulnerable to denial of service through unbounded precision specifiers
  → GHSA-hp3w-g68c-fv3c
node_modules/sprintf-js
  roarr <=2.15.4
    global-agent <=3.0.0
      @electron/get 1.6.0 - 4.0.3
        app-builder-lib 26.6.0 - 27.0.0-alpha.2
          dmg-builder / electron-builder / electron-builder-squirrel-windows

13 vulnerabilities (8 moderate, 5 high)
```

- The 5 high-severity issues all sit in the braces chain (tailwindcss@3 → chokidar@3 → braces/micromatch/fast-glob).
- The 8 moderate issues all sit in the electron-builder build chain (`@electron/get → global-agent → roarr → sprintf-js`).
- Runtime dependencies: `npm audit --omit=dev` reports **0 vulnerabilities**. `server/` and `cloudflare-worker/` have their own lockfiles and were already at 0; this PR does not touch them.

## 2. braces chain (5 high): risk accepted

**Decision: accepted; not fixed in this PR.**

Rationale:

1. **Build-time only**: braces comes in through `tailwindcss@3 → chokidar@3`. It exists in the devDependencies tree only while Tailwind JIT scans the content globs and while `vite build`/`vitest` run. The electron-builder `files` list packages only `dist/`, `build/`, `electron/`, and `package.json`. It does **not include node_modules**, so this chain never ends up in any desktop installer or web artifact.
2. **Hard to trigger**: the vulnerability is a stack-exhaustion DoS caused by deeply nested glob patterns (GHSA-vfj7-8cjw-p6xm). Exploiting it requires feeding a maliciously crafted glob pattern to braces. This repo's content globs are hardcoded in `tailwind.config.js` (a file we own), so build inputs are not externally controlled.
3. **No fixed version within v3**: every braces version through 3.0.3, which chokidar 3.x depends on, is affected, and there is no upgrade path within Tailwind 3.
4. **Permanent fix already planned**: the Tailwind 3 → 4 migration (PR-11, `build/tailwind-v4`) removes the entire chokidar@3 chain from the dependency tree, which brings the 5 highs to zero.

## 3. electron-builder chain (8 moderate): downgrade to 26.5.0 tried, rolled back per the contingency plan, risk accepted

**Decision: stay on `electron-builder ^26.15.3` and accept the 8 moderate issues.**

### 3.1 Where the plan and reality diverged

In the audit snapshot that PR-02's plan was based on, npm audit suggested downgrading to `electron-builder@26.5.0` as the fix for the 8 moderate issues (26.6.0 reintroduced `@electron/get` with global-agent). On the day of implementation we actually performed the downgrade and re-ran the audit. The result got **worse, not better**:

| State | Vulnerabilities | Breakdown |
|---|---|---|
| `^26.15.3` (baseline) | 13 (8 moderate + 5 high) | All highs are in the braces chain |
| `26.5.0` (measured after downgrade) | **14 (13 high + 1 critical)** | 3 new advisories, published after the plan's snapshot, hit the 26.5.0 tree |

New hits after the downgrade (none of them affect the 26.15.3 tree):

- `app-builder-lib <=26.14.0` **high** — GHSA-7g7r-gx96-252g (app-builder-lib: a built AppImage sets LD_LIBRARY_PATH with an empty path component at runtime, allowing library search path injection; fixed in 26.15.0);
- `builder-util-runtime <9.7.0` **high** — GHSA-p2f4-r6v6-j797 (electron-updater: cross-origin redirects leak PRIVATE-TOKEN / Authorization credentials);
- `tar <=7.5.20` **critical** — 12 tar advisories (GHSA-34x7-hfp2-rc4v and others) pulled in via `@electron/rebuild`.

Version 26.5.0 would directly violate this PR's acceptance criterion ("the only remaining high-severity `npm audit` findings are in the braces chain") and would make overall severity worse. We therefore followed the contingency plan in section 1 of the plan: revert the downgrade and close the item out with this decision record.

### 3.2 Why the 8 moderate issues are accepted, and when to revisit

1. **Build-time only, not shipped**: `global-agent → roarr → sprintf-js` is a build-time transitive dependency of `@electron/get` inside app-builder-lib (proxy support when downloading the Electron binary). It exists only on a local machine or in CI while running `npm install` and `electron-builder`. As noted above, node_modules is not included in the installer, so shipped artifacts have zero exposure.
2. **No fixed upstream version to pin**: the advisory marks the sprintf-js vulnerable range as `*` (all versions), and roarr, global-agent, and @electron/get have no fixed versions within the affected ranges either, so npm overrides have nothing to work with. The only fix npm audit itself offers (downgrading to 26.5.0) has been disproven by testing.
3. **Ongoing tracking**: once electron-builder ships a release that drops the global-agent dependency chain, a routine Dependabot bump will clear these naturally.

## 4. Other dependency decisions in the same PR

- **patch/minor cleanup**: based on the full `npm outdated` output on the day of implementation. Any major version jump is excluded (eslint 10, eslint-plugin-react-hooks 7, vite 8, vitest 5, tailwindcss 4, zustand 5, react 19, lucide-react 1.x, jsdom 30, date-fns 4, concurrently 10, typescript 7, @testing-library/react 16, mermaid 12, @vitejs/plugin-legacy 8, ajv 8, globals 17, katex 0.19, eslint-plugin-react-refresh 0.5, @vitejs/plugin-react 6). Major upgrades are validated one at a time through the Dependabot channel introduced in PR-01.
- **eslint-plugin-react-hooks**: the declared range changes from `^5.1.0-rc.0` to `^5.2.0`, matching the stable version that is actually resolved and installed, which removes RC drift.
- **asar**: `asar: false` in `electron-builder.yml` becomes `true` (see the notes in commit 75b4ca4 and the PR's self-test record). Every `__dirname` reference in `electron/main.js` is for read-only resources, and all writes go to userData.
- **Explicitly out of scope**: no change to the `version` field in `package.json`; no changes to `versions/`; no changes to the `server/` and `cloudflare-worker/` dependencies.

## 5. Residual risk and next steps

| Risk | Severity | Disposition |
|---|---|---|
| braces chain (tailwindcss@3) | 5 high (build-time) | Fixed for good by the PR-11 Tailwind v4 migration |
| @electron/get → global-agent chain | 8 moderate (build-time) | Wait for an upstream electron-builder fix; follow up via Dependabot |
| electron-builder 26.5.0 downgrade | N/A | Rolled back per the contingency plan; the tag-triggered release build will validate 26.15.3 artifacts on all three platforms in the next release window |
