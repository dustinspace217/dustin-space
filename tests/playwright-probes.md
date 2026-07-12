# On-demand Playwright geometry probes

Issue #96, item 4. These are the **on-demand** geometry probes for the header
nav and hero wordmark at boundary viewport widths. They are deliberately kept
**out of CI and out of `npm test`**:

- **Not in `npm test`** — the file is `tests/probes/nav-geometry.spec.js`. The
  test script globs `tests/**/*.test.js`, so a `.spec.js` under `tests/probes/`
  is never collected by the fast `node:test` suite.
- **Not in CI** — browser-driven geometry probes are the slow/flaky class. They
  caught two real bugs this round (dropdown clusters rendering side-by-side;
  shrink-wrapped tap targets) that only pixel geometry can see, but they are a
  human-run tool, not a gate. Playwright is intentionally **not** a project
  dependency — nothing in `package.json` pulls it in.

## What they check

The through-line is **vertical centering and horizontal clearance of the header
at the collapse boundary** (1300px, per issue #95's range-syntax fix), plus the
regression probes the manual verification round relied on:

| Probe | Viewport / condition | Asserts |
|---|---|---|
| Descent clearance | 1310 × 680 | Hero title, at its widest while descending, does not overlap either nav cluster. |
| Header vertical centering | boundary widths (1299 / 1300 / 1310) | Logo, left cluster, right cluster share one centered row (equal vertical centers). |
| Dropdown stacked | 1250 | Nav collapsed to hamburger; opened nav links are full-width, stacked, tappable (≥ 44px). |
| Clusters in grid | 1920 | Two `.nav-cluster` lists sit in grid columns 1 and 3, logo in column 2. |
| Keyboard focus | 1250, nav closed | Tab never lands focus on a zero-height (collapsed, hidden) nav element. |
| Fractional width | ~1299.2 (125% zoom) | Collapse behaves correctly at a fractional viewport width the old min/max form fell through. |
| 20px root font | root font-size 20px | Breakpoints gate on the intended width (px media queries, not rem-scaled). |
| Nav-state regression | resize across boundary with nav open | Nav doesn't get stuck open/closed when the viewport crosses the boundary. |

## Running them

Playwright is not installed here — run it on demand, no `package.json` change:

```
npm start                                   # serve the site (Eleventy dev server, :8080)
npx playwright install chromium             # one-time, if not already present
BASE_URL=http://localhost:8080 npx playwright test tests/probes/nav-geometry.spec.js
```

`BASE_URL` defaults to `http://localhost:8080` (Eleventy `--serve`). Point it at
a preview deploy or a locally-served `_site/` build instead if preferred.

The spec is a **skeleton**: the vertical-centering and clearance probes are
implemented concretely; the zoom / root-font / nav-state probes carry `test.fixme`
markers with inline notes on what they still need (a Playwright config with device
scale factor, or a resize-and-reassert loop). Fill those in when a specific
regression makes them worth wiring up.
