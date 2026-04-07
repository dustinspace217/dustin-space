# Gallery Features Design Spec

10 new features for the dustin.space astrophotography portfolio. Each feature ships as an independent commit for easy rollback.

**Branch:** `preview/osd-viewer`
**Date:** 2026-04-06

---

## Table of Contents

1. [F9: RSS/Atom Feed](#f9-rssatom-feed)
2. [F1: Integration Time Badge](#f1-integration-time-badge)
3. [F11: Image Statistics Badge](#f11-image-statistics-badge)
4. [F2: Bortle Class / Sky Quality](#f2-bortle-class--sky-quality)
5. [F12: Light Pollution Display](#f12-light-pollution-display)
6. [F8: Equipment Category Filtering](#f8-equipment-category-filtering)
7. [F4: Processing Workflow Notes](#f4-processing-workflow-notes)
8. [F5: Object Information Panel](#f5-object-information-panel)
9. [F10: EXIF/FITS Metadata Viewer](#f10-exiffits-metadata-viewer)
10. [F3: Before/After Comparison Slider](#f3-beforeafter-comparison-slider)

---

## Architecture

All features follow the existing pattern:

- **Build-time** computation via Eleventy + Nunjucks for static content
- **Runtime JS** only for interactive features (comparison slider, equipment filtering)
- **No new dependencies** — vanilla JS, no bundler, no framework changes
- `images.json` schema additions are backward-compatible (new nullable fields)
- Each feature's ingest tool changes (form fields + pipeline) ship in the same commit as the frontend display

### Rollback Strategy

Each feature is a single atomic commit. To roll back:
```bash
git revert <sha>   # creates a revert commit
```

Features that add schema fields to images.json: reverting the commit removes the display code but leaves the data in images.json (harmless — unused fields are ignored by templates). To fully clean up, remove the fields from images.json after reverting.

---

## F9: RSS/Atom Feed

**Goal:** Let visitors subscribe to new images via feed readers.

### Files

| File | Action | Description |
|------|--------|-------------|
| `src/feed.njk` | CREATE | Atom XML feed template |
| `src/_includes/layouts/base.njk` | EDIT | Add `<link rel="alternate">` in `<head>` |

### Template: `src/feed.njk`

Eleventy renders this as `/feed.xml` in the built site. Uses the same `images` data and sort order as the gallery page.

```njk
---
permalink: /feed.xml
eleventyExcludeFromCollections: true
---
<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>{{ site.title }}</title>
  <subtitle>{{ site.description }}</subtitle>
  <link href="{{ site.url }}/feed.xml" rel="self"/>
  <link href="{{ site.url }}/"/>
  <updated>{% set newest = images | sort(true, false, "date") | first %}{% set npv = newest.variants | selectattr("primary") | first %}{{ npv.date }}T12:00:00Z</updated>
  <id>{{ site.url }}/</id>
  <author><name>{{ site.author }}</name></author>
  {% for image in images | sort(true, false, "date") %}
  {% set pv = image.variants | selectattr("primary") | first %}
  {% set pv = pv if pv else image.variants[0] %}
  <entry>
    <title>{{ image.title }}</title>
    <link href="{{ site.url }}/gallery/{{ image.slug }}/"/>
    <id>{{ site.url }}/gallery/{{ image.slug }}/</id>
    <updated>{{ pv.date }}T12:00:00Z</updated>
    <summary type="text">{{ image.description or image.title }}</summary>
    {% if pv.thumbnail %}
    <content type="html">&lt;img src=&quot;{{ site.url }}{{ pv.thumbnail }}&quot; alt=&quot;{{ image.title }}&quot;/&gt;{% if image.description %}&lt;p&gt;{{ image.description }}&lt;/p&gt;{% endif %}</content>
    {% endif %}
  </entry>
  {% endfor %}
</feed>
```

### Head link (in `base.njk`)

```html
<link rel="alternate" type="application/atom+xml" title="{{ site.title }}" href="/feed.xml" />
```

### Verification

- `npm run build` produces `_site/feed.xml`
- Feed validates at https://validator.w3.org/feed/
- RSS readers (NetNewsWire, Feedly) can subscribe via `https://dustin.space/feed.xml`

---

## F1: Integration Time Badge

**Goal:** Show total integration time as a visual badge on gallery thumbnails.

### Files

| File | Action | Description |
|------|--------|-------------|
| `src/gallery/index.njk` | EDIT | Add badge element inside `.card-thumb` |
| `src/index.njk` | EDIT | Add same badge to home page gallery cards |
| `src/assets/css/main.css` | EDIT | Add `.integration-badge` styles |

### Schema

No change. Uses existing `pv.acquisition.filters` with the `formatExposure` filter.

### Template addition (inside `.card-thumb`, after variant-count badge)

```njk
{% set totalExp = pv.acquisition.filters | formatExposure if pv.acquisition else "" %}
{% if totalExp and totalExp != "---" %}
<span class="integration-badge" aria-label="{{ totalExp }} total integration time">{{ totalExp }}</span>
{% endif %}
```

The badge only renders when integration time data is available and non-zero.

### CSS

```css
/* Integration time badge — bottom-left of gallery thumbnail */
.integration-badge {
    position: absolute;
    bottom: 8px;
    left: 8px;
    padding: 2px 8px;
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--text-primary);
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(4px);
    border-radius: 4px;
    letter-spacing: 0.02em;
    pointer-events: none;
}
```

Position: bottom-left (top-right is variant count; bottom-right reserved for future use).

### Behavior for images without data

Images with `filters: []` or all-null minutes render no badge. This includes most older iTelescope captures that lack integration data. The badge appears progressively as images are re-ingested with full data.

---

## F11: Image Statistics Badge

**Goal:** Display key acquisition metrics in a compact strip on the detail page.

### Files

| File | Action | Description |
|------|--------|-------------|
| `src/_data/images.json` | EDIT | Add `stats` to populated variants |
| `src/gallery/image.njk` | EDIT | Add stats strip below hero |
| `src/assets/css/main.css` | EDIT | Add `.stats-strip` styles |

### Schema addition (per variant)

```json
"stats": {
    "total_frames": 164,
    "total_integration_min": 680,
    "fov_arcmin": "166' x 111'",
    "resolution": "6280 x 4210",
    "pixel_scale": "1.58\"/px"
}
```

All fields nullable. `total_frames` and `total_integration_min` are derived from the acquisition filters array (sum of frames, sum of minutes). `fov_arcmin`, `resolution`, and `pixel_scale` come from the equipment preset and image dimensions.

### Template (in `image.njk`, after `.image-hero-wrap`, before `.image-detail-body`)

```njk
{% if not isMulti and pv.stats %}
<div class="stats-strip" aria-label="Image statistics">
    {% if pv.stats.total_integration_min %}
    <span class="stat-item">
        <span class="stat-value">{{ pv.stats.total_integration_min | formatExposure }}</span>
        <span class="stat-label">Integration</span>
    </span>
    {% endif %}
    {% if pv.stats.total_frames %}
    <span class="stat-item">
        <span class="stat-value">{{ pv.stats.total_frames }}</span>
        <span class="stat-label">Frames</span>
    </span>
    {% endif %}
    {% if pv.stats.fov_arcmin %}
    <span class="stat-item">
        <span class="stat-value">{{ pv.stats.fov_arcmin }}</span>
        <span class="stat-label">Field of View</span>
    </span>
    {% endif %}
    {% if pv.stats.resolution %}
    <span class="stat-item">
        <span class="stat-value">{{ pv.stats.resolution }}</span>
        <span class="stat-label">Resolution</span>
    </span>
    {% endif %}
    {% if pv.stats.pixel_scale %}
    <span class="stat-item">
        <span class="stat-value">{{ pv.stats.pixel_scale }}</span>
        <span class="stat-label">Scale</span>
    </span>
    {% endif %}
</div>
{% endif %}
```

For multi-variant targets, each variant section gets its own stats strip (rendered inside the variant loop).

### CSS

Horizontal flexbox strip with gap. Each stat-item is a vertical stack (value on top, label below). Muted color scheme matching the existing metadata tables. Wraps to two rows on mobile (`flex-wrap: wrap`).

---

## F2: Bortle Class / Sky Quality

**Goal:** Display sky darkness information for each image.

### Files

| File | Action | Description |
|------|--------|-------------|
| `src/_data/images.json` | EDIT | Add `bortle` and `sqm` to `sky` objects |
| `src/gallery/image.njk` | EDIT | Display Bortle in sky coordinates section |
| `src/assets/css/main.css` | EDIT | Add Bortle badge/label styles |
| `src/_data/images.schema.md` | EDIT | Document new fields |

### Schema addition (inside existing `sky` object per variant)

```json
"sky": {
    "ra": "05h 40m 59s",
    "dec": "-02 deg 27' 30\"",
    "bortle": 6,
    "sqm": 19.5,
    ...existing fields...
}
```

- `bortle`: integer 1-9, nullable. The Bortle Dark-Sky Scale class.
- `sqm`: float, nullable. Sky Quality Meter reading in mag/arcsec^2. Optional — not all imaging locations have SQM data.

### Bortle scale reference (for display labels)

| Bortle | Label | Color |
|--------|-------|-------|
| 1 | Excellent dark site | #1a472a (dark green) |
| 2 | Typical truly dark site | #2d6a3f |
| 3 | Rural sky | #3d8b4f |
| 4 | Rural/suburban transition | #7aa83e |
| 5 | Suburban sky | #bfb830 |
| 6 | Bright suburban sky | #d4942a |
| 7 | Suburban/urban transition | #c96830 |
| 8 | City sky | #b84530 |
| 9 | Inner-city sky | #992233 |

### Template (in `image.njk`, inside sky coordinates section)

```njk
{% if variant.sky and variant.sky.bortle %}
<div class="bortle-display">
    <span class="bortle-number" data-bortle="{{ variant.sky.bortle }}">{{ variant.sky.bortle }}</span>
    <span class="bortle-label">Bortle {{ variant.sky.bortle }}{% if variant.sky.sqm %} (SQM {{ variant.sky.sqm }}){% endif %}</span>
</div>
{% endif %}
```

### CSS

`.bortle-number` is a small circle with the digit centered. Background color is set via `[data-bortle="1"]` through `[data-bortle="9"]` attribute selectors mapping to the color table above.

---

## F12: Light Pollution Display

**Goal:** Visual Bortle scale gauge on the detail page. Lat/lon coordinates are NEVER stored in source code or images.json.

### Files

| File | Action | Description |
|------|--------|-------------|
| `src/gallery/image.njk` | EDIT | Add Bortle gauge below coordinates |
| `src/assets/css/main.css` | EDIT | Add gauge styles |
| `ingest/public/index.html` | EDIT | Add lat/lon fields for derivation |
| `ingest/lib/pipeline.js` | EDIT | Derive Bortle from coordinates, discard coordinates |

### Privacy model

1. User optionally enters lat/lon in ingest tool
2. Pipeline derives Bortle class from coordinates using a lookup table
3. Only `sky.bortle` (integer 1-9) is written to images.json
4. Lat/lon are NEVER written to disk, NEVER included in any JSON, NEVER logged
5. The `equipment.location` field remains a manual, deliberately vague string

### Bortle derivation

Two concrete approaches (choose during implementation):

**Approach A — Curated location table (recommended):**
A small JSON lookup table in the ingest tool mapping known observatory locations to Bortle classes. Since the user's imaging sites are a finite set (backyard in PNW, iTelescope Utah/Spain/Australia/Chile, JAST Arizona), a table of ~10 entries covers all cases. Lat/lon are only used to select the nearest entry, never stored. New locations can be added by entering coordinates once.

```js
// ingest/lib/bortle-lookup.json (example entries)
[
  { "name": "PNW Backyard", "lat": 47.6, "lon": -122.3, "bortle": 6, "sqm": 19.5 },
  { "name": "Utah Desert Remote Observatory", "lat": 38.3, "lon": -113.6, "bortle": 2, "sqm": 21.8 },
  ...
]
```

Wait — this table would contain coordinates. For privacy, the lookup table itself should NOT be committed to the public repo. Instead, it lives in `ingest/config.json` (which is gitignored) alongside R2 credentials.

**Approach B — Free API lookup:**
Call `https://www.lightpollutionmap.info/QueryRaster/` with lat/lon to get SQM. Convert SQM to Bortle class via standard mapping. This avoids any local coordinate storage. Downside: external API dependency during ingest.

Both approaches return `{ bortle: int, sqm: float|null }` and discard the input coordinates.

### Template: Bortle scale gauge

A horizontal row of 9 small segments. The segment matching the current Bortle class is highlighted and expanded. Segments to the left (darker skies) are colored in their scale color but dimmed. Segments to the right (brighter skies) are similarly dimmed.

```njk
{% if variant.sky and variant.sky.bortle %}
<div class="bortle-gauge" aria-label="Bortle scale class {{ variant.sky.bortle }}">
    {% for b in range(1, 10) %}
    <span class="bortle-seg{% if b == variant.sky.bortle %} bortle-seg--active{% endif %}" data-bortle="{{ b }}"
          aria-hidden="{{ 'false' if b == variant.sky.bortle else 'true' }}">{{ b }}</span>
    {% endfor %}
</div>
{% endif %}
```

### CSS

```css
.bortle-gauge {
    display: flex;
    gap: 2px;
    margin-top: 8px;
}
.bortle-seg {
    width: 20px;
    height: 20px;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.65rem;
    font-weight: 600;
    opacity: 0.3;
    color: transparent;
}
.bortle-seg--active {
    opacity: 1;
    color: #fff;
    transform: scale(1.2);
}
/* Each segment's background from the Bortle color table */
.bortle-seg[data-bortle="1"] { background: #1a472a; }
/* ... through 9 ... */
```

### Ingest tool form

New expandable section "Derive Sky Quality" with:
- Latitude input (number, -90 to 90)
- Longitude input (number, -180 to 180)
- "Derive Bortle" button → calls the pipeline helper → populates the Bortle dropdown
- OR manual Bortle/SQM entry (same fields as F2)

The lat/lon fields are NOT included in the FormData sent to `/api/process`. They're used client-side to call a lookup, then discarded. Alternatively, a server-side endpoint `/api/derive-bortle` can take lat/lon, return Bortle, and log nothing.

---

## F8: Equipment Category Filtering

**Goal:** Filter gallery images by equipment origin (personal rig, remote/iTelescope, solar).

### Files

| File | Action | Description |
|------|--------|-------------|
| `src/_data/images.json` | EDIT | Add `equipment_category` to each target |
| `src/gallery/index.njk` | EDIT | Add data attribute + filter buttons |
| `src/assets/js/gallery.js` | EDIT | Add equipment filter logic (AND with tag filter) |
| `src/assets/css/main.css` | EDIT | Style new filter group |
| `ingest/lib/pipeline.js` | EDIT | Auto-set equipment_category from preset |

### Schema addition (per target, top level)

```json
"equipment_category": "personal"
```

Values:
- `"personal"` — Dustin's own gear at home (Eon 70, Esprit 100)
- `"itelescope"` — iTelescope.net remote scopes
- `"solar"` — Coronado Solarmax (distinct imaging mode)

### Data population for existing images

| Image | Category |
|-------|----------|
| solar-ha-prominence | solar |
| horsehead-nebula | personal |
| orion-nebula | personal |
| veil-nebula | personal |
| pleiades-cluster | itelescope |
| omega-nebula | itelescope |
| andromeda-galaxy | itelescope |
| m101-pinwheel-galaxy | personal |
| tarantula-nebula | itelescope |
| flaming-star-nebula | itelescope |
| rosette-nebula | itelescope |

### Template: data attribute on gallery cards

```njk
<a href="/gallery/{{ image.slug }}/"
   class="gallery-card"
   data-tags="..."
   data-equipment="{{ image.equipment_category or 'unknown' }}">
```

### Template: new filter group

```njk
<div class="filter-group filter-group--equipment" role="group" aria-label="Filter by equipment">
    <span class="filter-group-label">Equipment</span>
    <button class="filter-btn filter-btn--equipment" data-filter-eq="all" aria-pressed="true">All</button>
    <button class="filter-btn filter-btn--equipment" data-filter-eq="personal" aria-pressed="false">My Rig</button>
    <button class="filter-btn filter-btn--equipment" data-filter-eq="itelescope" aria-pressed="false">iTelescope</button>
    <button class="filter-btn filter-btn--equipment" data-filter-eq="solar" aria-pressed="false">Solar</button>
</div>
```

### JS: combined filtering

The existing `applyFilter(tag)` function is extended to support two independent filter dimensions:

```js
var activeTagFilter = "all";
var activeEqFilter  = "all";

function applyFilters() {
    galleryCards.forEach(function (card) {
        var cardTags = (card.getAttribute("data-tags") || "").split(" ");
        var cardEq   = card.getAttribute("data-equipment") || "";
        var matchesTag = (activeTagFilter === "all" || cardTags.includes(activeTagFilter));
        var matchesEq  = (activeEqFilter === "all" || cardEq === activeEqFilter);
        card.classList.toggle("hidden", !(matchesTag && matchesEq));
    });
    // ...update counts, empty state, animation...
}
```

URL persistence: both dimensions stored as query params (`?filter=messier&eq=personal`).

### CSS

`.filter-group--equipment` uses a third accent color (e.g., teal) to distinguish it from subject-type (default) and catalog (indigo) filter groups.

---

## F4: Processing Workflow Notes

**Goal:** Let the photographer share processing details on the detail page.

### Files

| File | Action | Description |
|------|--------|-------------|
| `src/_data/images.json` | EDIT | Add `processing_notes` to populated variants |
| `src/gallery/image.njk` | EDIT | Add collapsible processing section |
| `src/assets/css/main.css` | EDIT | Style the details/summary element |
| `ingest/public/index.html` | EDIT | Add textarea field |

### Schema addition (per variant)

```json
"processing_notes": "Captured over 3 nights in October 2025. Calibrated with 50 darks, 100 flats, 50 dark flats.\n\nPixInsight workflow: WBPP -> DBE -> SPCC -> BlurXTerminator -> NoiseXTerminator -> HistogramTransformation -> CurvesTransformation -> final crop and export."
```

Plain text string. Double newlines (`\n\n`) treated as paragraph breaks. Nullable — most existing images won't have this initially.

### Template (inside variant loop, after equipment table, before aladin panel)

```njk
{% if variant.processing_notes %}
<details class="processing-notes">
    <summary>
        <h3>Processing</h3>
    </summary>
    <div class="processing-notes-body">
        {# Split on double-newline to create paragraphs. Safe because
           processing_notes is plain text, and autoescape is enabled. #}
        {% for para in variant.processing_notes | split('\n\n') %}
        <p>{{ para }}</p>
        {% endfor %}
    </div>
</details>
{% endif %}
```

Note: Nunjucks doesn't have a built-in `split` filter. Add one in `.eleventy.js`:

```js
eleventyConfig.addFilter("split", function (str, sep) {
    return str ? str.split(sep) : [];
});
```

### CSS

```css
.processing-notes summary {
    cursor: pointer;
    list-style: none;
}
.processing-notes summary h3 {
    display: inline;
}
.processing-notes summary::before {
    content: '\25B6';  /* right triangle */
    display: inline-block;
    margin-right: 6px;
    transition: transform 0.2s;
    font-size: 0.7em;
}
.processing-notes[open] summary::before {
    transform: rotate(90deg);
}
.processing-notes-body {
    padding: 12px 0 0 0;
    color: var(--text-secondary);
    line-height: 1.6;
}
```

---

## F5: Object Information Panel

**Goal:** Display astronomical properties of the target from Simbad data.

### Files

| File | Action | Description |
|------|--------|-------------|
| `src/_data/images.json` | EDIT | Add `object_info` to targets with data |
| `src/gallery/image.njk` | EDIT | Add info panel after description |
| `src/assets/css/main.css` | EDIT | Style the info panel |
| `ingest/lib/simbad.js` | EDIT | Extend query to fetch additional fields |
| `ingest/public/index.html` | EDIT | Add manual override fields |

### Schema addition (per target, top level)

```json
"object_info": {
    "object_type": "Emission Nebula",
    "constellation": "Orion",
    "distance": "1,344 light-years",
    "apparent_size": "65' x 60'",
    "visual_magnitude": 4.0,
    "other_designations": ["Barnard 33", "LBN 953"]
}
```

All fields nullable. `other_designations` is an array of alternate catalog names.

### Simbad query extension

The current `simbadSearch()` in `ingest/lib/simbad.js` queries TAP for coordinates. Extend the query to also fetch:
- `otype_txt` (object type in human-readable form)
- `coo_bibcode` (coordinate reference)
- Object dimensions (major/minor axis) from the `dimensions` table
- Flux/magnitude from the `flux` table

For fields Simbad doesn't provide (distance, constellation), the ingest form includes manual entry fields.

### Template (after `.image-description`, before variant loop)

```njk
{% if image.object_info %}
<div class="object-info-panel">
    <h2 class="object-info-title">About {{ image.target or image.title }}</h2>
    <div class="object-info-grid">
        {% if image.object_info.object_type %}
        <div class="oi-item">
            <span class="oi-label">Type</span>
            <span class="oi-value">{{ image.object_info.object_type }}</span>
        </div>
        {% endif %}
        {% if image.object_info.constellation %}
        <div class="oi-item">
            <span class="oi-label">Constellation</span>
            <span class="oi-value">{{ image.object_info.constellation }}</span>
        </div>
        {% endif %}
        {% if image.object_info.distance %}
        <div class="oi-item">
            <span class="oi-label">Distance</span>
            <span class="oi-value">{{ image.object_info.distance }}</span>
        </div>
        {% endif %}
        {% if image.object_info.apparent_size %}
        <div class="oi-item">
            <span class="oi-label">Apparent Size</span>
            <span class="oi-value">{{ image.object_info.apparent_size }}</span>
        </div>
        {% endif %}
        {% if image.object_info.visual_magnitude %}
        <div class="oi-item">
            <span class="oi-label">Magnitude</span>
            <span class="oi-value">{{ image.object_info.visual_magnitude }}</span>
        </div>
        {% endif %}
    </div>
    {% if image.object_info.other_designations and image.object_info.other_designations | length %}
    <p class="oi-designations">Also known as: {{ image.object_info.other_designations | join(', ') }}</p>
    {% endif %}
</div>
{% endif %}
```

### CSS

A subtle card-style panel with a thin top border accent. Grid layout for the info items (2 columns desktop, 1 column mobile). Small, muted labels above slightly larger values.

---

## F10: EXIF/FITS Metadata Viewer

**Goal:** Display technical file metadata from the source image.

### Files

| File | Action | Description |
|------|--------|-------------|
| `src/_data/images.json` | EDIT | Add `file_metadata` to variants with data |
| `src/gallery/image.njk` | EDIT | Add collapsible metadata section |
| `src/assets/css/main.css` | EDIT | Style the metadata table |
| `ingest/lib/pipeline.js` | EDIT | Extract metadata during pipeline |

### Schema addition (per variant)

```json
"file_metadata": {
    "source_format": "TIFF",
    "bit_depth": 16,
    "color_space": "sRGB",
    "dimensions": "6280 x 4210",
    "file_size_mb": 52.3,
    "fits_headers": {
        "TELESCOP": "Orion Eon 70mm ED",
        "INSTRUME": "QHY268M",
        "EXPTIME": "300",
        "FILTER": "Ha",
        "DATE-OBS": "2025-11-02T03:24:15",
        "GAIN": "26",
        "OFFSET": "50",
        "CCD-TEMP": "-10"
    }
}
```

All fields nullable. `fits_headers` is an object of key-value pairs — only interesting headers are included (not the full FITS header dump).

### Metadata extraction in ingest pipeline

After source file validation:
1. `vips header` provides dimensions, bit depth, color space, bands
2. `exiftool -json <file>` provides EXIF/FITS headers
3. `fs.stat()` provides file size
4. Pipeline selects interesting FITS keywords and writes the subset to `file_metadata`

### FITS keywords to extract

```
TELESCOP, INSTRUME, EXPTIME, FILTER, DATE-OBS, GAIN, OFFSET,
CCD-TEMP, XBINNING, YBINNING, BAYERPAT, OBJECT, NAXIS1, NAXIS2,
BITPIX, SITELAT, SITELONG (excluded from output for privacy)
```

Note: `SITELAT` and `SITELONG` are explicitly excluded from the output to maintain the privacy guarantee from F12.

### Template (inside variant loop, after equipment table)

```njk
{% if variant.file_metadata %}
<details class="file-metadata-panel">
    <summary>
        <h3>File Metadata</h3>
    </summary>
    <table class="metadata-table" aria-label="Source file metadata">
        <tbody>
            {% if variant.file_metadata.source_format %}
            <tr><th scope="row">Format</th><td>{{ variant.file_metadata.source_format }}</td></tr>
            {% endif %}
            {% if variant.file_metadata.dimensions %}
            <tr><th scope="row">Dimensions</th><td>{{ variant.file_metadata.dimensions }}</td></tr>
            {% endif %}
            {% if variant.file_metadata.bit_depth %}
            <tr><th scope="row">Bit Depth</th><td>{{ variant.file_metadata.bit_depth }}-bit</td></tr>
            {% endif %}
            {% if variant.file_metadata.color_space %}
            <tr><th scope="row">Color Space</th><td>{{ variant.file_metadata.color_space }}</td></tr>
            {% endif %}
            {% if variant.file_metadata.file_size_mb %}
            <tr><th scope="row">File Size</th><td>{{ variant.file_metadata.file_size_mb }} MB</td></tr>
            {% endif %}
        </tbody>
    </table>
    {% if variant.file_metadata.fits_headers %}
    <h4>FITS Headers</h4>
    <table class="metadata-table metadata-table--mono" aria-label="FITS header data">
        <tbody>
            {% for key, value in variant.file_metadata.fits_headers %}
            <tr><th scope="row">{{ key }}</th><td>{{ value }}</td></tr>
            {% endfor %}
        </tbody>
    </table>
    {% endif %}
</details>
{% endif %}
```

### CSS

`.metadata-table--mono td` uses `font-family: monospace` for technical FITS values. Same collapsible pattern as processing notes.

---

## F3: Before/After Comparison Slider

**Goal:** Interactive slider for comparing revision versions of the same image.

### Files

| File | Action | Description |
|------|--------|-------------|
| `src/gallery/image.njk` | EDIT | Add comparison container in variant loop |
| `src/assets/js/detail.js` | EDIT | Add slider initialization and interaction |
| `src/assets/css/main.css` | EDIT | Add slider styles |

### Schema

No change. Uses existing revision data:
- `variant.revisions[].preview_url` — the images to compare
- `variant.revisions[].label` — labels for "before" and "after"

### Eligibility

The slider renders when a variant has **2 or more revisions** that both have `preview_url` set. Currently only the Tarantula Nebula qualifies (v1 and v2 both have preview WebPs).

### Eleventy filter (in `.eleventy.js`)

Nunjucks has no built-in way to filter arrays by a nested property. Add a custom filter:

```js
eleventyConfig.addFilter("withPreview", function (revisions) {
    return (revisions || []).filter(function (r) { return r.preview_url; });
});
```

### Template (inside variant loop, after the variant hero, before info-grid)

```njk
{% set revWithPreview = variant.revisions | withPreview %}
{% if revWithPreview | length >= 2 %}
{# last = oldest revision (before), first = newest revision (after) #}
{% set beforeRev = revWithPreview[revWithPreview | length - 1] %}
{% set afterRev = revWithPreview[0] %}
<div class="comparison-slider"
     data-before="{{ beforeRev.preview_url }}"
     data-after="{{ afterRev.preview_url }}"
     data-before-label="{{ beforeRev.label or 'Before' }}"
     data-after-label="{{ afterRev.label or 'After' }}"
     role="img"
     aria-label="Before and after comparison: {{ beforeRev.label or 'Before' }} vs {{ afterRev.label or 'After' }}">
    <noscript>
        <p>Enable JavaScript to use the comparison slider.</p>
    </noscript>
</div>
{% endif %}
```

### JS (added to `detail.js`)

```js
function initComparisonSliders() {
    document.querySelectorAll('.comparison-slider').forEach(function (container) {
        var beforeSrc  = container.dataset.before;
        var afterSrc   = container.dataset.after;
        var beforeLabel = container.dataset.beforeLabel;
        var afterLabel  = container.dataset.afterLabel;

        // Build DOM: two images, a clip container, and a draggable handle.
        var wrapper = document.createElement('div');
        wrapper.className = 'cs-wrapper';

        // "After" image (full, behind)
        var afterImg = document.createElement('img');
        afterImg.src = afterSrc;
        afterImg.alt = afterLabel;
        afterImg.className = 'cs-img cs-img--after';

        // "Before" image (clipped, on top)
        var beforeImg = document.createElement('img');
        beforeImg.src = beforeSrc;
        beforeImg.alt = beforeLabel;
        beforeImg.className = 'cs-img cs-img--before';

        // Handle
        var handle = document.createElement('div');
        handle.className = 'cs-handle';
        handle.setAttribute('role', 'slider');
        handle.setAttribute('aria-label', 'Comparison slider');
        handle.setAttribute('aria-valuemin', '0');
        handle.setAttribute('aria-valuemax', '100');
        handle.setAttribute('aria-valuenow', '50');
        handle.tabIndex = 0;

        wrapper.appendChild(afterImg);
        wrapper.appendChild(beforeImg);
        wrapper.appendChild(handle);

        // Labels
        var lBefore = document.createElement('span');
        lBefore.className = 'cs-label cs-label--before';
        lBefore.textContent = beforeLabel;
        var lAfter = document.createElement('span');
        lAfter.className = 'cs-label cs-label--after';
        lAfter.textContent = afterLabel;
        wrapper.appendChild(lBefore);
        wrapper.appendChild(lAfter);

        container.textContent = '';
        container.appendChild(wrapper);

        // Interaction: update clip-path on the "before" image.
        var position = 50; // percentage from left

        function setPosition(pct) {
            pct = Math.max(0, Math.min(100, pct));
            position = pct;
            beforeImg.style.clipPath = 'inset(0 ' + (100 - pct) + '% 0 0)';
            handle.style.left = pct + '%';
            handle.setAttribute('aria-valuenow', Math.round(pct));
        }
        setPosition(50);

        // Mouse drag
        var dragging = false;
        handle.addEventListener('mousedown', function (e) { dragging = true; e.preventDefault(); });
        document.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            var rect = wrapper.getBoundingClientRect();
            setPosition(((e.clientX - rect.left) / rect.width) * 100);
        });
        document.addEventListener('mouseup', function () { dragging = false; });

        // Touch drag
        handle.addEventListener('touchstart', function (e) { dragging = true; e.preventDefault(); }, { passive: false });
        document.addEventListener('touchmove', function (e) {
            if (!dragging) return;
            var rect = wrapper.getBoundingClientRect();
            var touch = e.touches[0];
            setPosition(((touch.clientX - rect.left) / rect.width) * 100);
        });
        document.addEventListener('touchend', function () { dragging = false; });

        // Keyboard: arrow keys
        handle.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowLeft') { setPosition(position - 2); e.preventDefault(); }
            if (e.key === 'ArrowRight') { setPosition(position + 2); e.preventDefault(); }
        });
    });
}
```

### CSS

```css
.cs-wrapper {
    position: relative;
    overflow: hidden;
    cursor: col-resize;
    border-radius: 8px;
    aspect-ratio: 3/2; /* match preview WebP aspect ratio */
}
.cs-img {
    position: absolute;
    top: 0; left: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    user-select: none;
    pointer-events: none;
}
.cs-img--before {
    z-index: 2;
    clip-path: inset(0 50% 0 0);
}
.cs-handle {
    position: absolute;
    top: 0; bottom: 0;
    left: 50%;
    width: 4px;
    background: white;
    z-index: 3;
    transform: translateX(-50%);
    cursor: col-resize;
    box-shadow: 0 0 8px rgba(0,0,0,0.5);
}
.cs-handle::after {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    width: 32px;
    height: 32px;
    background: white;
    border-radius: 50%;
    transform: translate(-50%, -50%);
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
}
.cs-label {
    position: absolute;
    bottom: 12px;
    padding: 4px 10px;
    font-size: 0.75rem;
    background: rgba(0,0,0,0.6);
    color: white;
    border-radius: 4px;
    pointer-events: none;
    z-index: 4;
}
.cs-label--before { left: 12px; }
.cs-label--after { right: 12px; }
```

---

## Commit Sequence

| # | Feature | Commit message |
|---|---------|----------------|
| 1 | F9 | `feat: add RSS/Atom feed at /feed.xml` |
| 2 | F1 | `feat: add integration time badge on gallery tiles` |
| 3 | F11 | `feat: add image statistics strip on detail pages` |
| 4 | F2 | `feat: add Bortle class / sky quality display` |
| 5 | F12 | `feat: add light pollution gauge with coordinate-derived Bortle` |
| 6 | F8 | `feat: add equipment category gallery filtering` |
| 7 | F4 | `feat: add processing workflow notes section` |
| 8 | F5 | `feat: add object information panel from Simbad data` |
| 9 | F10 | `feat: add EXIF/FITS metadata viewer` |
| 10 | F3 | `feat: add before/after revision comparison slider` |

Order rationale:
- F9 first: entirely new file, zero conflict risk with anything
- F1 before F11: gallery tiles before detail page (simpler first)
- F2 before F12: schema fields before visual gauge (data before display)
- F8 in middle: gallery JS is a larger change, give it space
- F4, F5, F10 together: all add detail page sections, ordered by simplicity
- F3 last: most complex (interactive JS), benefits from all other work being stable
