# Header-geometry Playwright probes

Issue #96 item 4, extended in #118 (Fix Wave 2 W7). These are the browser-driven
geometry probes for the header nav and hero wordmark at boundary viewport widths.
They live in `tests/probes/nav-geometry.spec.js` and split into two classes:

- **CI subset (4 probes, tagged `@ci`)** — the stable geometry checks: header
  vertical centering, hero-descent horizontal clearance, collapsed-nav tap
  targets (1250), and the 1920 grid layout. These run in CI via
  `--grep @ci` (see `.github/workflows/ci.yml`, the "Run header-geometry probes"
  step). Playwright is a **devDependency** (`@playwright/test` in the root
  `package.json`) so `npm ci` provides the runner; CI installs the Chromium
  browser separately with `npx playwright install --with-deps chromium`.
- **On-demand subset (untagged)** — the slower/flakier class: keyboard focus,
  fractional-width (125% zoom), 20px-root-font, and nav-state-across-resize.
  These are browser-version-sensitive or timing-sensitive, so they are left out
  of the `@ci` grep and run by hand when chasing a specific regression.

Both classes are **excluded from `npm test`**: the file is a `.spec.js` under
`tests/probes/`, and the root test script globs `tests/**/*.test.js`, so
`node:test` never collects it. Playwright and `node:test` are deliberately
separate tools.

## What they check

The through-line is **vertical centering and horizontal clearance of the header
at the collapse boundary** (1300px, per issue #95's range-syntax fix), plus the
regression probes the manual verification round relied on.

| Probe | Viewport / condition | Asserts | In CI? |
|---|---|---|---|
| Header vertical centering | 1310 × 680 | Logo, left cluster, right cluster share one centered row (equal vertical centers). | `@ci` |
| Descent clearance | 1310 × 680 | Hero title, scrolled through a bounded ladder, never overlaps either nav cluster mid-descent. | `@ci` |
| Dropdown stacked | 1250 | Nav collapsed to hamburger; opened nav links are full-width, stacked, tappable (≥ 44px). | `@ci` |
| Clusters in grid | 1920 | Two `.nav-cluster` lists sit in the outer grid columns, logo centered between them. | `@ci` |
| Keyboard focus | 1250, nav closed | Tab never lands focus on a zero-height (collapsed, hidden) nav element. | on-demand |
| Fractional width | ~1299.2 (125% zoom) | Collapse behaves correctly at a fractional viewport width the old min/max form fell through. | on-demand |
| 20px root font | root font-size 20px | Breakpoints gate on the intended width (px media queries, not rem-scaled). | on-demand |
| Nav-state regression | resize across boundary with nav open | Nav doesn't get stuck open/closed when the viewport crosses the boundary. | on-demand |

All eight probes are **implemented** — the former `test.fixme` skeletons for the
zoom / root-font / nav-state cases were filled in in #118 W7.

## Running them locally

Playwright is installed via the root devDependency, so `npm ci` (or `npm install`)
already provides the test runner. You still need the browser binary once:

```
npx playwright install chromium              # one-time browser download
npx playwright test --config tests/probes/playwright.config.js            # all probes
npx playwright test --config tests/probes/playwright.config.js --grep @ci # CI subset only
```

The config's `webServer` boots the Eleventy dev server itself, so no separate
`npm start` is required — though an already-running `npm start` on :8080 is
reused. Override the target with `BASE_URL` (default `http://localhost:8080`) to
point the probes at a preview deploy or a locally-served `_site/` build instead.
