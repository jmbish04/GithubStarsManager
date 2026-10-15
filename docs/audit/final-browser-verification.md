# Final Browser Verification

Verified: 2026-08-22 UTC (2026-08-23 in the user's time zone). Build preview URL: `http://127.0.0.1:4174/`. Viewport: `1440 × 1000`. The browser used an isolated profile and a local visual-review fixture. No real credentials were used and no real business data was written. The fixture contained at least 1 repository, 1 release (6 asset rows), 1 gist, 1 fork, and 20 custom categories. The walkthrough loaded data through the app's existing sync, subscribe, refresh, and card-click flows.

## Key geometry and interaction evidence

| Check | Measured result | Screenshot/report |
|---|---|---|
| README dialog | dialog `x=150, y=75, width=1130, height=850, right=1280, bottom=925`; centered relative to client width 1430 and viewport height 1000, and within the viewport safe margins | `readme-dialog.png`; `readmeDialog` in `metrics.json` |
| Release assets panel | Expanded successfully; panel `x=65, y=511, width=1300, right=1365`; in the dark theme it uses a semantic surface clearly lighter than the page background, and all 6 asset rows are fully visible | `release-assets.png`; `releaseAfterAsset` in `metrics.json` |
| Fork page-size control | The right edges of the search frame, ForkCard, and page-size trigger are all `1382`; page-size trigger `x=1302, width=80, right=1382` | `fork-layout.png`; `forkLayout` in `metrics.json` |
| Gist left and right containers | Sidebar `y=85, right=288`; right-hand search toolbar `y=85, right=1398`; same top baseline | `gist-layout.png`; `gistLayout` in `metrics.json` |
| Gist hover readability | After a real pointer hover, the item and count are both `rgb(248, 250, 252)` and the hover background is `rgba(30, 41, 59, 0.5)` | Output of `round42_dropdown_hover_check.py` |
| Select horizontal stability | For the Release, Gist, and Fork dropdowns across the closed/open/closed states, body and root both stay at `x=0, width=1430, right=1430` with `margin-right=0px`; only `data-scroll-locked=1` appears while open | Output of `round42_dropdown_hover_check.py` |
| Category scrollbar | The scrollbar element's right edge stays at `x=287` and the sidebar card's right edge at `x=288`; the thumb is transparent when idle or after scrolling stops, is `rgba(75, 85, 99, 0.8)` while scrolling, and its width does not change | `category-idle.png`, `category-scrolling.png`, `category-after-stop.png`; `metrics.json` |

The README, Release, Gist, and Fork screenshots all show populated states, not empty-state placeholders. The Fork screenshot includes the `magpie-fork` card. The Release screenshot includes the `Visual Release` of `magpie` and its 6 asset rows. The Gist screenshot includes real fixture cards and the sidebar counts. The category screenshot includes a populated repository card. The CSS states of the category scroll fixture are verified together by the idle, scrolling, and after-stop screenshots from the same page and by the computed-style results.

## Artifacts

The screenshots and geometry report from this round are saved in `ui-screenshots-round42/`, including `readme-dialog.png`, `release-assets.png`, `gist-layout.png`, `gist-dialog.png`, `fork-layout.png`, `category-idle.png`, `category-scrolling.png`, `category-after-stop.png`, and `metrics.json`. These files serve only as local verification evidence and are not committed. This record file itself is a tracked verification record.

## Code gate status

The final full gate for this round passed: `npm run lint`, `npx tsc -b`, `npm run test:run`, `npm run build`, `git diff --check`, and `npm audit --omit=dev --audit-level=high` all succeeded. All 332 tests across 31 test files passed. The legacy entry is `2713.22 KiB`, under the `3000 KiB` limit, and the production dependency audit reports `0 vulnerabilities`.
