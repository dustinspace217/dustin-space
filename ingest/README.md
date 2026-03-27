# dustin-space — Image Ingest Tool

Local pipeline for adding new astrophotography images to the site. Runs on your machine, never exposed to the internet.

---

## What it does

When you submit an image, the server runs these steps in order:

1. **Read metadata** — extracts FITS/EXIF fields from the TIF (telescope, camera, date, RA/Dec, filter, exposure time). Auto-fills the form where possible. Requires `exiftool`.
2. **Plate-solve** — runs ASTAP on the JPG to get a precise WCS solution (RA/Dec center, pixel scale, rotation). Required for Simbad lookup and the Aladin FOV rectangle.
3. **Simbad lookup** — queries the Simbad astronomical database for non-stellar objects within the image field of view. Results become the annotation overlay on the detail page.
4. **Preview WebP** — converts the JPG to a 2400px-wide WebP at Q=82, saved to `src/assets/img/gallery/`. This is the hero image on the detail page and the OG image for sharing.
5. **Thumbnail WebP** — converts the JPG to a 600px-wide WebP at Q=80, saved to the same folder. Used in the gallery grid.
6. **DZI tile generation** — if a TIF is provided, `vips` slices it into a deep-zoom tile tree. These tiles power the OpenSeadragon zoomable viewer.
7. **R2 upload** — uploads the DZI tiles to the Cloudflare R2 bucket (`dustinspace`) using the S3-compatible API. Skipped if no TIF was provided.
8. **images.json** — prepends a new entry to `src/_data/images.json`. The site rebuilds from this file.
9. **Git commit + push** — stages the new images and updated JSON, commits, and pushes to GitHub. Cloudflare Pages picks up the push and deploys automatically.

Progress for every step streams live to the browser while the job runs.

---

## One-time setup

### 1. Install Node dependencies

```bash
cd ingest
npm install
```

### 2. Install required system tools

| Tool | Required | Install |
|---|---|---|
| `vips` | Yes — image conversion and DZI tiling | `sudo dnf install vips-tools` |
| `git` | Yes — commit and push after ingest | already installed |
| `astap` | Optional — plate-solving for WCS/annotations | download from [astap.org](https://www.hnsky.org/astap.htm), install to `/usr/local/bin/astap`, star database to `/opt/astap` |
| `exiftool` | Optional — reads FITS metadata from TIF to auto-fill the form | `sudo dnf install perl-Image-ExifTool` |

Without `astap`, you can still ingest images — plate-solving, Simbad lookup, and the Aladin FOV rectangle will simply be skipped.

Without `exiftool`, the form won't auto-fill from TIF metadata, but you can fill it manually.

### 3. Set R2 credentials

Open `ingest/server.js` and find these three lines near the top:

```js
const R2_ACCOUNT_ID      = 'FILL_IN_ACCOUNT_ID';
const R2_ACCESS_KEY_ID   = 'FILL_IN_ACCESS_KEY_ID';
const R2_SECRET_ACCESS_KEY = 'FILL_IN_SECRET_ACCESS_KEY';
```

Replace the placeholder strings with your real values. **Keep this file out of git after filling these in** (or use a `.gitignore` entry for a secrets file if you prefer).

**How to get the values:**

**Account ID**
Cloudflare dashboard → **R2** in the left nav → Account ID is shown in the right-hand sidebar.

**Access Key ID and Secret Access Key**
R2 dashboard → **Manage R2 API Tokens** (top-right of the R2 overview) → **Create API token** → set Permissions to **Object Read & Write**, scope to bucket **dustinspace** → **Create Token** → copy both values. The secret is only shown once.

The server prints a warning at startup if the placeholders haven't been replaced yet. DZI uploads will fail until they are.

---

## Running the server

From the `ingest/` directory:

```bash
node server.js
```

Then open [http://localhost:3333](http://localhost:3333) in a browser.

The server checks for required tools at startup and prints a summary. If `vips` or `git` is missing it will warn you — those must be present before starting a job.

The server does not need to be restarted between jobs. It handles one job at a time (a mutex prevents two jobs from writing to `images.json` simultaneously).

---

## Submitting an image

### Required

| Field | Notes |
|---|---|
| **JPG file** | Your fully processed, exported JPEG. Used for the preview WebP, thumbnail WebP, and plate-solving. |
| **Slug** | URL-safe identifier, e.g. `horsehead-nebula`. Must be unique — the pipeline fails immediately if the slug already exists in `images.json`. Lowercase letters, numbers, and hyphens only. |
| **Title** | Display name, e.g. `Horsehead Nebula`. |
| **Date** | Acquisition date (YYYY-MM-DD). Used for sort order in the gallery. |
| **Tags** | At least one subject tag (Galaxy, Emission Nebula, etc.). The first tag drives the badge color on the gallery card. |

### Optional but recommended

| Field | Notes |
|---|---|
| **TIF file** | Full-resolution master TIFF. Triggers DZI tile generation and R2 upload, enabling the deep-zoom viewer. Without it, the detail page shows only the static preview image. |
| **Catalog** | Human-readable catalog designation, e.g. `M 42` or `NGC 1499`. Displayed below the title on the gallery card. |
| **AstroBin ID** | The numeric ID from your AstroBin URL (e.g. `1234567`). Enables the "View on AstroBin" link and pulls the AstroBin thumbnail for the OG image. |
| **Description** | Markdown-supported text shown on the detail page. |
| **Acquisition data** | Telescope, camera, mount, guider, filters, frames, and minutes per filter. Shown in the detail page sidebar and used to compute total exposure time. |
| **Plate-solve** | Check to run ASTAP. Requires ASTAP installed and the JPG to contain a recognizable star field. Produces RA/Dec, pixel scale, and the Aladin FOV rectangle. |
| **Simbad lookup** | Check to query Simbad for in-frame objects. Requires plate-solve to succeed first. Results populate the annotation overlay. |
| **Generate DZI + upload** | Check to generate and upload deep-zoom tiles. Requires a TIF file and R2 credentials filled in. |
| **Git push** | Check to commit and push to GitHub after the job completes. Cloudflare Pages deploys automatically on push. |

### Verifying success

The log panel in the browser shows the result of every step in real time. A successful run ends with a green **Done** message and a link to the new image's detail page on the live site (after Cloudflare Pages finishes deploying, usually under a minute).

If any required step fails, the pipeline stops and the error is shown in red. Images and JSON are not written until all preceding steps succeed, so a failed run leaves no partial state.

---

## Troubleshooting

**"Slug already exists"** — the slug you entered is already in `images.json`. Pick a different slug or check if the image was already ingested.

**"ASTAP could not solve the field"** — the plate-solve failed. Common causes: image is too blurry or noisy, FOV hint is wrong, or the star database doesn't cover that area of sky. The pipeline continues without WCS — Simbad lookup and the Aladin FOV rectangle will be skipped.

**"R2 upload failed" / S3 error** — check that the three credential constants in `server.js` are correct and that the API token has Read & Write access to the `dustinspace` bucket.

**Server won't start / "vips not found"** — install `vips-tools` with `sudo dnf install vips-tools` and restart.

**Git push fails** — the server uses your local git credentials. Make sure you're authenticated (`gh auth status`) and that the `preview/osd-viewer` branch has an upstream set.
