# images.json — Field Schema (Variant Architecture)

Each entry in `images.json` is a **target** (astronomical object). A target has
one or more **variants** (different imaging setups / processing runs), and each
variant can have zero or more **revisions** (reprocessings of the same data).

See `VARIANT-REVISION-PLAN.md` for the full design rationale and migration history.

## Target (top-level entry)

| Field              | Type           | Required | Notes |
|--------------------|----------------|----------|-------|
| slug               | string         | yes      | URL key — must be unique, lowercase, kebab-case |
| title              | string         | yes      | Display name |
| target             | string or null | no       | Canonical object name (e.g. "Barnard 33") |
| catalog            | string or null | no       | Catalog designation(s), e.g. "NGC 1499 / IC 434" |
| tags               | string[]       | yes      | At least one tag. First tag drives the badge color. Valid: emission-nebula, reflection-nebula, dark-nebula, planetary-nebula, supernova-remnant, galaxy, open-cluster, globular-cluster, solar, other |
| catalogs           | string[]       | no       | Collection memberships: "messier", "caldwell" |
| featured           | boolean        | no       | If true, shown in the home page hero section |
| astrobin_id        | string or null | no       | AstroBin image ID (e.g. "d9vpf4") — renders a "View on AstroBin" link |
| description        | string or null | no       | Long-form prose description of the object |
| equipment_category | string         | no       | "personal", "itelescope", or "solar" — drives equipment filter on gallery page |
| object_info        | object or null | no       | Simbad-sourced data (see Object Info below) |
| variants           | variant[]      | yes      | At least one variant required |

## Variant (inside `variants[]`)

| Field             | Type           | Required | Notes |
|-------------------|----------------|----------|-------|
| id                | string         | yes      | Unique within the target (e.g. "default", "ha-oiii") |
| label             | string or null | no       | Human-readable label (e.g. "Narrowband HOO"); null for single-variant targets |
| primary           | boolean        | no       | If true, this variant's data appears on gallery cards and the feed. Exactly one per target. |
| date              | string         | yes      | ISO date "YYYY-MM-DD" — date of acquisition |
| thumbnail         | string         | yes      | Path or URL to 600px WebP thumbnail |
| preview_url       | string or null | no       | Path or URL to 2400px WebP detail page hero |
| full_url          | string or null | no       | Path or URL to full-size JPG (fallback for non-DZI) |
| dzi_url           | string or null | no       | Full URL to DZI descriptor on R2 — enables deep-zoom lightbox |
| annotated_dzi_url | string or null | no       | URL to annotated DZI on R2 — tile-swap annotations |
| annotated_url     | string or null | no       | URL to annotated JPG (fallback for non-DZI) |
| annotations       | object[]       | no       | [{name, x, y}] — x/y are 0–1 fractions from top-left |
| equipment         | object or null | no       | See Equipment below |
| acquisition       | object or null | no       | See Acquisition below |
| sky               | object or null | no       | See Sky below; null for solar images |
| image_stats       | object or null | no       | See Image Stats below |
| file_metadata     | object or null | no       | See File Metadata below |
| processing_notes  | string or null | no       | Plain text workflow notes (double-newline for paragraph breaks) |
| revisions         | revision[]     | no       | Reprocessings of this variant's data |

## Revision (inside `variant.revisions[]`)

| Field       | Type           | Required | Notes |
|-------------|----------------|----------|-------|
| id          | string         | yes      | Unique within the variant (e.g. "v2", "v3") |
| label       | string or null | no       | Human-readable label (e.g. "PixInsight reprocess") |
| date        | string         | yes      | ISO date of the revision |
| preview_url | string or null | no       | Path or URL to the revised preview image |
| dzi_url     | string or null | no       | DZI URL for the revision |
| is_final    | boolean        | no       | If true, this revision's images replace the parent variant's in the viewer |

## Equipment

| Field     | Type           | Notes |
|-----------|----------------|-------|
| telescope | string or null | Telescope/lens used |
| camera    | string or null | Camera model |
| mount     | string or null | Mount model |
| guider    | string or null | Guide scope/camera or "N/A" |
| filters   | string or null | Filters used |
| location  | string or null | Capture site |
| software  | string or null | Processing software |

## Acquisition

| Field   | Type           | Notes |
|---------|----------------|-------|
| mode    | string or null | "lucky" for lucky imaging; omit for standard long-exposure |
| note    | string or null | Free-text capture note |
| filters | filter[]       | [{name, frames, minutes}] — minutes: null for lucky/solar |

## Sky

| Field         | Type           | Notes |
|---------------|----------------|-------|
| ra            | string or null | Right ascension (e.g. "5h 40m 59s") |
| dec           | string or null | Declination (e.g. "-1° 56' 6\"") |
| ra_deg        | number or null | RA in decimal degrees |
| dec_deg       | number or null | Dec in decimal degrees |
| fov_deg       | number or null | max(fov_w, fov_h) — used for Aladin Lite FOV |
| fov_w         | number or null | Field width in degrees |
| fov_h         | number or null | Field height in degrees |
| aladin_target | string or null | Aladin Lite target string |
| bortle        | number or null | Bortle class (1–9) of the capture site |

## Object Info

Sourced from Simbad/NED data, stored at the target level.

| Field              | Type           | Notes |
|--------------------|----------------|-------|
| object_type        | string or null | e.g. "Emission Nebula", "Spiral Galaxy" |
| constellation      | string or null | e.g. "Orion" |
| distance           | string or null | e.g. "1,375 light-years" |
| apparent_size      | string or null | e.g. "6' × 4'" |
| visual_magnitude   | string or null | e.g. "3.4" |
| other_designations | string[]       | Alternative catalog names |

## Image Stats

Computed from the source FITS/TIF file, displayed on the stats strip.

| Field         | Type           | Notes |
|---------------|----------------|-------|
| resolution    | string or null | e.g. "6252 × 4176" |
| bit_depth     | string or null | e.g. "16-bit" |
| file_size     | string or null | e.g. "245 MB" |
| color_space   | string or null | e.g. "sRGB" |

## File Metadata

EXIF/FITS header data extracted at ingest time.

| Field        | Type           | Notes |
|--------------|----------------|-------|
| exif         | object or null | Key-value pairs from EXIF headers |
| fits_headers | object or null | Key-value pairs from FITS headers |

## Hero display priority (detail page)

1. `dzi_url` set → thumbnail preview + deep-zoom lightbox on click
2. `full_url` set → plain `<img>` (transitional)
3. Neither → placeholder div

## Preview image priority (detail page hero src)

1. `preview_url` — 2400px WebP (preferred)
2. `full_url`
3. `thumbnail` — 600px WebP (pixelated at hero size)

## sky.fov_deg convention

`fov_deg` should equal `max(fov_w, fov_h)` — the widest dimension of the camera's
field of view. The Aladin Lite widget is initialized to this value so the FOV
rectangle fits within the sky atlas view without clipping.
