# DUST IN SPACE

Astrophotography portfolio by Dustin K.

**Live site:** [dustin.space](https://dustin.space)

## Tech Stack

- **Static site generator:** [Eleventy (11ty)](https://www.11ty.dev/) v3 with Nunjucks templates
- **Hosting:** Cloudflare Pages (auto-deploys from `main`)
- **Deep-zoom tiles:** Cloudflare R2 via `@aws-sdk/client-s3` ([tiles.dustin.space](https://tiles.dustin.space))
- **Deep-zoom viewer:** [OpenSeadragon](https://openseadragon.github.io/) v6
- **Sky atlas:** [Aladin Lite](https://aladin.cds.unistra.fr/AladinLite/) v3.8.2
- **Comments:** [Giscus](https://giscus.app/) (GitHub Discussions)
- **Fonts:** Self-hosted (woff2)
- **CSS/JS:** Vanilla, no preprocessor or bundler

## Local Development

```bash
npm install
npm start          # eleventy --serve (dev server with hot reload)
```

Production build:

```bash
npm run build      # eleventy → _site/
```

## Image Ingest Tool

The `ingest/` directory contains a separate Node.js app for adding new images to the gallery. It handles metadata lookup, plate solving, DZI tile generation, R2 upload, and `images.json` updates.

```bash
cd ingest
npm install
npm start          # http://localhost:3333
```

## Project Structure

```
src/
  _data/           Global data (images.json, site.json, gear.json)
  _includes/       Layouts and partials (Nunjucks)
  assets/          CSS, JS, images, fonts
  gallery/         Gallery listing + per-image detail pages
  about/, contact/, guides/, setup/
  index.njk        Home page
ingest/            Image ingest tool (separate Node app)
.eleventy.js       Eleventy configuration
```

## Built With

Eleventy v3, Cloudflare R2 + Pages, OpenSeadragon, Aladin Lite, libvips, self-hosted fonts. Code quality maintained via multi-agent audit workflow.
