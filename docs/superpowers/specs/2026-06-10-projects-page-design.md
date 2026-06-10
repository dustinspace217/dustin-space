# Projects Page — Design Spec

## Status (updated 2026-06-10, post-implementation)
Phase: Implemented and committed (76730ef page, 2c43718 nav split)
Done: page live in main; nav restructured into flanking clusters (see
Deviations below); visual verification desktop/laptop/breakpoint/mobile
Next: three-phase QA review (GitHub Discussions), then Dustin decides
DEF-A-01 (sitemap inclusion)
Blocked: nothing

## Deviations from spec (recorded at commit boundary)
1. **Nav restructure (scope-change, user-directed).** Spec added a Projects
   link to the existing right-aligned nav. Implementation surfaced a
   pre-existing nav/centered-title collision (worsened by the 8th link);
   Dustin chose a flanking-cluster split (4+4, topic-matched), hamburger
   below 1300px, compact spacing tier 1300–1449px. Commit 2c43718.
2. **writing-plans skipped (process, user-directed).** "Just write it" +
   spec already carried implementation detail.
3. **Sitemap (deferment → DEF-A-01 below).**
4. **Row entrance stagger (behavioral addition).** CSS-only fade-up
   reusing gallery card-enter keyframes; prefers-reduced-motion respected.
   Standing frontend-design mode justifies; remove is one CSS block.

## Appendix: Deferments originated in this work
- **DEF-A-01** — Found by: build verification (Claude). Commit: 76730ef.
  Defer target: Dustin's decision (indefinite). Severity: LOW.
  What: /projects/ is not in sitemap.xml — sitemap.njk deliberately lists
  only home + gallery + published images ("content-readiness" policy);
  robots.txt mirrors this. The Projects page is a career artifact and may
  deserve indexing.
  Why deferred: site-wide indexing policy is Dustin's call, not a bug.
  Fix direction: add a /projects/ <url> entry to sitemap.njk (3 lines),
  consider also about/setup/guides at the same time.
  Obsolescence: a future decision to index all section pages.

## Goal

Add a `/projects/` page to dustin.space serving the project-portfolio purpose of
the site: GitHub links and substantive descriptions of software work, voiced for
technical peers. The page is a career artifact — it should read as deliberate
expert judgment, not a link dump.

## Decisions (with rationale)

| Decision | Choice | Why |
|---|---|---|
| Entries | 5: Astrowidget, PixInsight GPU, SDDM PR, MCP Memory Server, Epistemic Mode | Dustin named four; added mcp-memory-server at his option during brainstorm |
| Astrowidget link | `dustinspace217/astrowidget` only (not `-pub`) | Astrospheric granted distribution permission; full version now subsumes `-pub` (verified: README documents free-source fallback, optional key) |
| GPU work | One entry, two links | One story ("GPU acceleration for PixInsight AI tools on Linux/Blackwell"), two techniques |
| SDDM link | Upstream PR `sddm/sddm#2174` + investigation gist | The PR is the artifact peers should read; honestly badged as an open PR. Gist shows methodology |
| Layout | B — full-width rows (meta left, paragraph right) | Descriptions are the payload; rows give narrative room. Dustin chose B independently; runner-up A (card grid) |
| Architecture | Data-driven: `projects.json` + thin template | Mirrors gear.json → My Setup pattern; project #6 later = one JSON entry |

## Route & Navigation

- New page: `src/projects/index.njk` → `/projects/`, layout `layouts/base.njk`
- Header nav (`src/_includes/partials/header.njk`): add **Projects between
  Guides and About** — neighbors are "what I use" (My Setup) and "who I am"
  (About). Active-state conditional follows the existing `in page.url` pattern.
- Footer nav (`src/_includes/partials/footer.njk`): same link, same position
  (footer is a curated subset — it omits Skywatching; Projects belongs in it).
- Look-and-feel requirement (Dustin, explicit): the page inherits the real site
  chrome — navbar, background, palette — via base.njk + main.css tokens. The
  brainstorm mockup's chrome was approximation only; do not replicate it.

## Data Model — `src/_data/projects.json`

Array of entries, page order = array order (astro work → Linux upstream →
Claude tooling):

```json
{
	"category": "KDE Plasma Widget",      // small accent-colored label above name
	"name": "Astrowidget",
	"status": "Open PR",                  // OPTIONAL badge; only SDDM uses it
	"tech": ["QML", "Plasma 6"],          // chip list under the name
	"links": [                            // 1..n external links
		{ "label": "GitHub", "url": "https://github.com/dustinspace217/astrowidget" }
	],
	"description": [                      // ARRAY of paragraphs, not a string —
		"…"                               // SDDM/GPU stories may grow a second
	]                                     // paragraph; template cost is one for-loop
}
```

### Entry data (approved content — use verbatim)

Page intro (under the `h1`):

> Astrophotography keeps pulling me into building things — desktop widgets, GPU
> plumbing, upstream fixes, AI tooling. The keepers live here.

**1. Astrowidget** — category `KDE Plasma Widget`; tech QML · Plasma 6 ·
Astrospheric · Open-Meteo · 7Timer!; link GitHub →
`https://github.com/dustinspace217/astrowidget`

> Imaging time is scarce — when a clear night shows up, I want to know in one
> glance whether it's worth setting up, and for which kind of target. Astrowidget
> puts go/no-go verdicts for up to three imaging sites of your choosing in the
> Plasma panel: three colored dots, one click for the full three-night forecast.
> It scores each night for broadband and narrowband imaging separately, weighing
> transparency, seeing, the astronomical dark window, moon geometry, and dew
> spread alongside ordinary weather. Forecasts blend Astrospheric, Open-Meteo,
> and 7Timer!, falling back gracefully when a source doesn't cover a site —
> which matters when your sites are scattered between a backyard rig and remote
> observatories you rent time on.

*(Revised 2026-06-10 post-QA per Dustin: description made location-agnostic —
the product is user-configured for any sites; the original copy narrated his
personal config, including a city-level home-location disclosure the QA
security review flagged. This supersedes the earlier verbatim block.)*

**2. PixInsight GPU Acceleration on Linux** — category `GPU Compute · Linux`;
tech TensorFlow · ONNX Runtime · CUDA · sm_120; links "TensorFlow build" →
`https://github.com/dustinspace217/pixinsight-blackwell-tensorflow`, "DeepSNR
fix" → `https://github.com/dustinspace217/deepsnr-gpu-linux`

> The AI tools astrophotographers lean on — StarXTerminator, NoiseXTerminator,
> BlurXTerminator, DeepSNR — run CPU-only on Linux out of the box, and every
> existing GPU recipe broke on NVIDIA's Blackwell cards. I fixed it twice, two
> different ways. For the RC Astro tools: a reproducible recipe for building
> TensorFlow's C library from source with native sm_120 kernels. For the
> ONNX-backed DeepSNR: no build at all — a documented library swap that supplies
> the CUDA execution provider the Linux package ships without. Confirmed working
> on an RTX 5080 under Fedora 44. Processing that took minutes per image now
> takes seconds.

**3. SDDM: Stale VT_PROCESS Handler Fix** — category `Upstream Contribution`;
status badge `Open PR`; tech C++ · Wayland · systemd-logind · bpftrace; links
"sddm/sddm#2174" → `https://github.com/sddm/sddm/pull/2174`, "Investigation
gist" → `https://gist.github.com/dustinspace217/c7e46a43cd3274921a8266134d17a049`

> A race between SDDM and KWin could leave a Plasma Wayland session hanging for
> 30 seconds at login, kick the user back to the login screen minutes later, and
> hang the machine entirely on the next attempt. I traced it with strace and
> bpftrace down to a stale VT_PROCESS handler left on tty1, and proposed a
> minimum-scope fix upstream: make sddm-helper the handshake process for the VT
> handoff. Pre-patch, my machine failed roughly two of every three cold boots —
> post-patch, none. The full investigation, kernel-level evidence included, lives
> in a companion gist.

**4. MCP Memory Server** — category `AI Tooling · MCP`; tech TypeScript ·
SQLite · sqlite-vec · ONNX embeddings; link GitHub →
`https://github.com/dustinspace217/mcp-memory-server`

> Claude Code forgets everything between sessions. This fork of Anthropic's
> reference memory server gives it a persistent knowledge graph: SQLite storage
> with semantic vector search, temporal versioning so superseded facts are hidden
> but never lost, point-in-time queries, and a context-layer system that
> auto-loads the right knowledge at session start. It's been the backbone of
> months of collaborative work — the difference between an assistant that
> re-learns the project every morning and one that picks up where it left off.

**5. Epistemic Mode** — category `AI Tooling · Claude Code`; tech Claude Code
skills · behavioral rules; link GitHub →
`https://github.com/dustinspace217/claude-epistemic-mode`

> Language models drift toward telling you what you want to hear — and an MIT
> CSAIL paper showed that even ideal Bayesian reasoners can be steered into
> delusional spirals by sycophantic feedback. Epistemic Mode is a three-tier
> countermeasure toolkit for Claude Code: always-on rules that force
> counter-frames and convergence disclosure, inline self-monitoring warnings, and
> a full epistemic mode for high-stakes decisions. Built after catching the
> pattern live in my own sessions — including the model flattering me about being
> immune to it.

## Template & CSS

- `src/projects/index.njk`: front matter (layout, title "Projects", description
  meta, permalink `/projects/`), `h1` + intro paragraph, then
  `{% for project in projects %}` rendering rows. Same thin-template shape as
  `src/setup/index.njk`.
- New styles in `src/assets/css/main.css` under a `.projects-page` section,
  using existing tokens (verified 2026-06-10): `--bg-base #09090f`,
  `--bg-surface`, `--accent #22d3ee`, `--text-primary #e2e8f0`,
  `--text-secondary #94a3b8`, `--font-heading` Space Grotesk, `--font-body`
  Inter, `--space-*` scale, `--border-subtle`.
- Row anatomy: `border-top: 1px solid var(--border-subtle)` separators;
  meta column ~32% (category label in accent, `h2` name, tech list, links),
  description column flex 1. The tech list renders as a single
  `·`-separated text line in `--text-secondary` (as in the approved mockup),
  NOT pill-style chips.
- Responsive: rows stack (meta above description) at the site's primary
  breakpoint, `@media (max-width: 768px)` (verified dominant breakpoint).
- External links: `target="_blank" rel="noopener noreferrer"` (footer
  convention).
- Status badge: small label next to the category, only rendered when `status`
  is present. Color `#fbbf24` (the amber from the approved mockup) as a literal
  with a comment — a single-use value doesn't earn a `:root` token.

## SEO & Accessibility

- Meta description: "Software projects and upstream contributions — KDE
  widgets, GPU acceleration for astrophotography processing, an SDDM race fix,
  and Claude Code tooling."
- Heading hierarchy: `h1` page title, `h2` per project name.
- Sitemap/feed: `src/sitemap.njk` should pick the page up automatically —
  verify in build output during implementation.
- Link text meaningful out of context (no bare "here"); arrows are decorative.

## Out of Scope

- Per-project detail pages (no content to fill them; links go straight to GitHub)
- Screenshots/thumbnails per project (revisit later if wanted — would need
  capture + WebP workflow)
- Other public repos (claude-waiting-notification etc.) — page design makes
  adding them a JSON entry whenever desired
- Any redesign of the brainstorm mockup chrome — real page uses real site chrome

## Verification Plan

- `npm run build` clean; page renders at `/projects/` in dev server
- Playwright screenshot desktop + mobile widths for visual check
- All five entries render; SDDM badge shows; GPU entry shows two links
- Nav active state highlights on /projects/; footer link present
- QA Review per workspace CLAUDE.md (Post-Coding Process) after implementation
