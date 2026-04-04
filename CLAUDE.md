# dustin.space — Astrophotography Portfolio

Live site: https://dustin.space
Repo: https://github.com/dustinspace217/dustin-space
Owner: dustinspace217

## Tech Stack
- **Static site generator:** Eleventy (11ty) v3 — Nunjucks templates
- **Hosting:** Cloudflare Pages (auto-deploys from `main` branch)
- **Deep-zoom tiles:** Cloudflare R2 via `@aws-sdk/client-s3` (tiles.dustin.space)
- **Comments:** Giscus (GitHub Discussions → `Comments` category)
- **Fonts:** Self-hosted (woff2) in `src/assets/fonts/`
- **CSS:** Single file at `src/assets/css/main.css` — no preprocessor
- **JS:** Single file at `src/assets/js/gallery.js` — vanilla JS, no bundler
- **Deep-zoom viewer:** OpenSeadragon (loaded from CDN on detail pages)
- **Sky atlas:** Aladin Lite v3.8.2 (jsDelivr CDN, loaded via IntersectionObserver)

## Ingest Tool
`ingest/` — local Node.js tool for adding new images. Runs a web UI for:
- Pulling metadata from Simbad/AstroBin
- Plate solving via ASTAP
- Generating DZI tiles via vips
- Uploading tiles to R2
- Writing entries to `images.json`

Config (R2 credentials, ASTAP path) lives in `ingest/config.json` (gitignored).

## Project Structure
```
src/
  _data/           Global data (images.json, site.json, gear.json, year.js)
  _includes/
    layouts/       base.njk, guide.njk
    partials/      header.njk, footer.njk
  assets/
    css/main.css   All styles
    js/gallery.js  Gallery filtering, animations, OSD viewer
    img/gallery/   Thumbnails and preview WebPs
    fonts/         Self-hosted woff2 files
  gallery/
    index.njk      Gallery listing page
    image.njk      Detail page template (generates one page per image)
    gallery.11tydata.js  Pagination data from images.json
  about/, contact/, guides/, setup/, store/  — section pages
  index.njk        Home page with hero
  _headers         Cloudflare Pages cache rules
  favicon.ico, apple-touch-icon.png
ingest/            Image ingest tool (separate Node app)
.eleventy.js       11ty configuration
```

## Key Data Files
- `src/_data/images.json` — all gallery targets (11 currently). Uses variant schema: each target has a `variants[]` array containing equipment, acquisition, sky, and image URLs. Templates read from `image.variants[]` directly inside the variant loop. See `VARIANT-REVISION-PLAN.md` for full schema docs.
- `src/_data/site.json` — site title, tagline, description, URL, Giscus config
- `src/_data/gear.json` — equipment descriptions for the My Setup page

## Image Workflow
When adding a new image, three assets are generated from source files:

1. **DZI tiles** (from TIF): `vips dzsave` → upload to R2 → `dzi_url: "https://tiles.dustin.space/<slug>.dzi"`
2. **Preview WebP** (from full JPG): `vips thumbnail` 2400px Q=82 → `src/assets/img/gallery/<slug>-preview.webp`
3. **Thumbnail WebP** (from JPG): `vips thumbnail` 600px Q=80 → `src/assets/img/gallery/<slug>-thumb.webp`

Never use AstroBin's 620px thumbnail for preview_url — it's too pixelated at hero scale.

## Branches
- `main` — production, auto-deploys to Cloudflare Pages
- `preview/*` — feature/experiment branches (font choices, hero variants, etc.)
- Current working branch: `preview/osd-viewer`

## Frontend Design
Frontend design mode is permanently on for this project. All visual/animation/UI work should be treated with full aesthetic intent — typography, motion, spatial composition, coherence. Don't just make things work; make them feel intentional and polished.

## Build & Run
```bash
npm start        # eleventy --serve (dev server with hot reload)
npm run build    # eleventy (production build to _site/)
```

## GitHub Discussion Categories
Used for multi-agent coordination and Giscus comments:

| Category | ID | Purpose |
|---|---|---|
| Dev Sessions | `DIC_kwDORsquQs4C5WvD` | Multi-agent coordination threads |
| Decisions | `DIC_kwDORsquQs4C5WvE` | Synthesis — what was agreed/tabled |
| Comments | `DIC_kwDORsquQs4C5Wo7` | Giscus public comments on detail pages |
| Repo ID | `R_kgDORsquQg` | Used in GraphQL mutations |

## Relevant Agents for This Project
- **code-reviewer**, **security-auditor** — before PRs and after major changes
- **feature-dev:code-architect** — when planning new features or pages
- **feature-dev:code-explorer** — when tracing how existing features work
- **accessibility-auditor** — for all page/component changes (public site)
- **performance-analyst** — for image loading, gallery rendering, CSS/JS optimization
- **frontend-design:frontend-design** skill — permanently on for this project (see Frontend Design above)

## Relevant MCP Servers
- **mcp__github__*** — repo operations (issues, PRs, file contents). Use MCP, not gh CLI.
- **mcp__memory__*** — context persistence across sessions
- **mcp__cloudflare-docs__*** — when working with R2, Pages, or Cloudflare config
- **mcp__context7__*** — when referencing Eleventy, OpenSeadragon, or Aladin Lite docs

## Memory Files
- `project_dustin_space_frontend_design.md` — frontend design mode (permanently on)
- `project_dustin_space_image_workflow.md` — TIF→DZI, JPG→WebP conversion workflow
- `project_dustin_space_checklist.md` — full site roadmap and audit findings
- `reference_github_dustin_space.md` — repo ID, Discussion category IDs, GraphQL templates
