# Variant & Revision System — Implementation Plan

> **Purpose**: Support multiple images of the same astronomical target.
> **Hierarchy**: Target → Variant(s) → Revision(s)
> **Decided**: 2026-04-04

---

## Terminology

| Term | Definition | Example |
|------|-----------|---------|
| **Target** | An astronomical object. One gallery tile per target. | NGC 2070 (Tarantula Nebula) |
| **Variant** | A distinct imaging session of that target — different equipment, FOV, or filter set. Each variant has its own equipment, acquisition, and sky data. | Narrowfield · Orion Eon 70mm · SHO |
| **Revision** | A reprocessing of the same raw data from a single variant. Shares equipment/acquisition with its parent variant. | v2 — PixInsight reprocess |

**Rule of thumb**: If the equipment or raw frames changed → new variant. If only the processing changed → new revision.

---

## Data Model

### Schema (images.json)

Each entry in the array is a **target**:

```jsonc
{
  // ── Target-level fields (shared across all variants) ──
  "slug": "tarantula-nebula",         // URL path: /gallery/tarantula-nebula/
  "title": "NGC 2070 — The Tarantula Nebula",
  "target": "NGC 2070",               // NEW — canonical identifier for cross-linking
  "catalog": "NGC 2070 / 30 Doradus",
  "tags": ["emission-nebula"],
  "catalogs": ["ngc"],                // for gallery filter pills
  "featured": false,                  // show on home page
  "astrobin_id": "mx6d55",           // AstroBin deep link (target-level default)
  "description": "The Tarantula Nebula is...",

  // ── Variants ──
  // Every target has at least one. Single-variant targets omit the label on the UI.
  "variants": [
    {
      "id": "narrowfield",            // URL fragment: #narrowfield
      "label": "Narrowfield · Orion Eon 70mm · SHO",
      "primary": true,                // this variant's thumbnail is the gallery tile
      "date": "2024-06-20",           // most recent date for this variant

      // Variant-specific image URLs (point to the "final" revision, or the
      // only image if no revisions exist)
      "thumbnail": "/assets/img/gallery/tarantula-narrowfield-thumb.webp",
      "preview_url": "/assets/img/gallery/tarantula-narrowfield-preview.webp",
      "full_url": null,
      "dzi_url": "https://tiles.dustin.space/tarantula-narrowfield.dzi",
      "annotated_dzi_url": "https://tiles.dustin.space/tarantula-narrowfield-annotated.dzi",
      "annotated_url": null,
      "annotations": [],              // OSD overlay labels

      // Variant-specific metadata
      "equipment": {
        "telescope": "Orion Eon 70mm ED Quadruplet",
        "camera": "QHY 268M (Monochrome)",
        "mount": "ZWO AM3",
        "guider": "QHY M-Pro OAG + ZWO ASI 220MM",
        "filters": "Antlia Pro-V 3nm SHO + LRGB",
        "location": "Backyard Observatory — Pacific Northwest",
        "software": "N.I.N.A., PixInsight, Photoshop"
      },
      "acquisition": {
        "filters": [
          { "name": "Ha", "frames": 40, "minutes": 200 },
          { "name": "OIII", "frames": 30, "minutes": 150 }
        ]
      },
      "sky": {
        "ra": "05h 38m 00s", "dec": "-69° 06' 00\"",
        "fov_deg": 1.5, "aladin_target": "30 Doradus",
        "ra_deg": 84.5, "dec_deg": -69.1,
        "fov_w": 1.5, "fov_h": 1.0
      },

      // ── Revisions (optional) ──
      // Omit or leave empty for variants with only one processing version.
      // When present, variant-level image URLs above should match the "final" revision.
      "revisions": [
        {
          "id": "v2",
          "label": "v2 — PixInsight reprocess",
          "date": "2025-06-15",
          "is_final": true,
          "preview_url": "/assets/img/gallery/tarantula-narrowfield-v2-preview.webp",
          "dzi_url": "https://tiles.dustin.space/tarantula-narrowfield-v2.dzi",
          "annotated_dzi_url": "https://tiles.dustin.space/tarantula-narrowfield-v2-annotated.dzi",
          "note": "Reprocessed with improved star removal and noise reduction"
        },
        {
          "id": "v1",
          "label": "v1 — Original StarTools",
          "date": "2024-06-20",
          "is_final": false,
          "preview_url": "/assets/img/gallery/tarantula-narrowfield-v1-preview.webp",
          "dzi_url": "https://tiles.dustin.space/tarantula-narrowfield-v1.dzi",
          "annotated_dzi_url": "https://tiles.dustin.space/tarantula-narrowfield-v1-annotated.dzi",
          "note": "First attempt — StarTools only"
        }
      ]
    },
    {
      "id": "widefield",
      "label": "Widefield · iTelescope T33 · LRGB",
      "primary": false,
      "date": "2024-06-18",
      "thumbnail": "...",
      "preview_url": "...",
      "full_url": null,
      "dzi_url": "...",
      "annotated_dzi_url": "...",
      "annotated_url": null,
      "annotations": [],
      "equipment": { "..." : "..." },
      "acquisition": { "..." : "..." },
      "sky": { "..." : "..." },
      "revisions": []
    }
  ]
}
```

### Single-variant targets (majority of current images)

Most images have one variant and no revisions. They use the same schema
but the template suppresses variant labels when `variants.length === 1`:

```jsonc
{
  "slug": "veil-nebula",
  "title": "The Veil Nebula",
  "target": "NGC 6992",
  "catalog": "NGC 6992 / Cygnus Loop",
  "tags": ["supernova-remnant"],
  "catalogs": [],
  "featured": true,
  "astrobin_id": "d9vpf4",
  "description": "The Veil Nebula is...",

  "variants": [
    {
      "id": "default",
      "label": null,
      "primary": true,
      "date": "2025-02-28",
      "thumbnail": "/assets/img/gallery/veil-nebula-thumb.webp",
      "preview_url": "/assets/img/gallery/veil-nebula-preview.webp",
      "full_url": null,
      "dzi_url": "https://tiles.dustin.space/veil-nebula.dzi",
      "annotated_dzi_url": null,
      "annotated_url": null,
      "annotations": [
        { "name": "NGC 6992 — Eastern Veil", "x": 0.75, "y": 0.22 },
        { "name": "NGC 6960 — Western Veil", "x": 0.16, "y": 0.62 },
        { "name": "Pickering's Triangle", "x": 0.46, "y": 0.32 }
      ],
      "equipment": { ... },
      "acquisition": { ... },
      "sky": { ... },
      "revisions": []
    }
  ]
}
```

### Helper properties for templates

To avoid deeply nested lookups in Nunjucks, the 11ty data file
(`gallery.11tydata.js`) computes convenience accessors:

```js
// The primary variant (gallery tile, og:image, JSON-LD)
primaryVariant: (data) => {
  if (!data.image || !data.image.variants) return null;
  return data.image.variants.find(v => v.primary) || data.image.variants[0];
},

// Whether this target has multiple variants (controls label visibility)
hasMultipleVariants: (data) => {
  return data.image && data.image.variants && data.image.variants.length > 1;
}
```

---

## URL Structure

```
/gallery/tarantula-nebula/                              ← detail page (all variants stacked)
/gallery/tarantula-nebula/#widefield                    ← scroll to widefield variant section
/gallery/tarantula-nebula/?r=narrowfield:v1             ← auto-open lightbox at narrowfield, rev v1
/gallery/tarantula-nebula/?r=widefield                  ← auto-open lightbox at widefield (final rev)
```

- Fragment `#id` — each variant section has `id="{{ variant.id }}"`. Browser scrolls natively.
- Query `?r=variantId:revisionId` — `detail.js` reads on load, auto-opens lightbox at that variant+revision.
  `history.replaceState` updates the URL as the user navigates revisions in the lightbox.
- Single-variant targets: no fragment or query needed. Lightbox opens with `?r=default` silently.

---

## UI Behavior

### Gallery Tile (index.njk + gallery page)

```
┌────────────────────────┐
│  [primary variant      │  ← thumbnail from primary variant's final revision
│   thumbnail]           │
│                   ⊞ 2  │  ← variant count badge (hidden if 1; hover-reveal + always on touch)
│                        │
│  Tarantula Nebula      │
│  NGC 2070              │
│  11h 20m   June 2024   │  ← primary variant's date + total exposure
└────────────────────────┘
```

Badge CSS:
```css
.variant-count { opacity: 0; transition: opacity 0.2s ease; pointer-events: none; }
.gallery-card:hover .variant-count,
.gallery-card:focus-within .variant-count { opacity: 1; }
@media (hover: none) { .variant-count { opacity: 1; } }
```

### Detail Page (image.njk) — Multi-Variant

```
┌─────────────────────────────────────────────────────────┐
│  NGC 2070 — The Tarantula Nebula                        │
│  NGC 2070 / 30 Doradus                                  │
│  [Target-level description paragraph]                   │
│                                                         │
│  ── Narrowfield · Orion Eon 70mm · SHO ──────────────   │  ← variant header (hidden if single)
│  ┌──────────────────────────────────────────────────┐   │
│  │  [hero image — click to zoom]                    │   │
│  │  ⌖ Explore full resolution                      │   │
│  └──────────────────────────────────────────────────┘   │
│  ┌──────────────────┬───────────────────────────────┐   │
│  │ Acquisition      │  Sky Position                 │   │
│  │ Equipment        │  [Aladin Lite]                │   │
│  └──────────────────┴───────────────────────────────┘   │
│  RA 05h 38m 00s / Dec -69° 06' 00"                      │
│                                                         │
│  ── Widefield · iTelescope T33 · LRGB ───────────────   │
│  ┌──────────────────────────────────────────────────┐   │
│  │  [hero image — click to zoom]                    │   │
│  │  ⌖ Explore full resolution                      │   │
│  └──────────────────────────────────────────────────┘   │
│  ┌──────────────────┬───────────────────────────────┐   │
│  │ Acquisition      │  Sky Position                 │   │
│  │ Equipment        │  [Aladin Lite]                │   │
│  └──────────────────┴───────────────────────────────┘   │
│  RA 05h 38m 00s / Dec -69° 06' 00"                      │
│                                                         │
│  ── See Also ────────────────────────────────────────   │
│  [cards for other targets sharing the same `target`]    │
│                                                         │
│  Comments                                               │
│  Prev / Next                                            │
└─────────────────────────────────────────────────────────┘
```

### Detail Page — Single Variant

Identical to current layout. Variant header is suppressed. No "See Also" unless
another target entry shares the same `target` value.

### Lightbox (inside zoom viewer) — With Revisions

```
┌──────────────────────────────────────────────────────┐
│  [Show Annotations]  [Show Objects]  [✕ Close]       │
├──────────────────────────────────────────────────────┤
│                                                      │
│              [OpenSeadragon deep zoom]                │
│              showing current revision                 │
│                                                      │
├──────────────────────────────────────────────────────┤
│  ┌────────┐  ┌────────┐  ┌────────┐                 │
│  │ v3 ★   │  │ v2     │  │ v1     │  ← revision     │
│  │ 2025   │  │ 2025   │  │ 2024   │    filmstrip     │
│  └────────┘  └────────┘  └────────┘    (★ = active)  │
│  "Reprocessed with improved noise reduction"          │
│  Arrow keys: pan · +/−: zoom · H: home · Esc: close  │
└──────────────────────────────────────────────────────┘
```

- Clicking a revision thumbnail calls `viewer.open(newDziUrl)` to swap tile sources.
- `history.replaceState` updates `?r=variantId:revisionId` on every swap.
- Annotations button toggles `annotated_dzi_url` for the current revision.
- When no revisions exist, the filmstrip is hidden.

---

## Implementation Phases

### Phase 1: Data Model Migration
**Goal**: Migrate images.json to the new schema. Zero visual changes — templates still work via compatibility layer.

**Files changed**:
- `src/_data/images.json` — restructure all 11 entries
- `src/gallery/gallery.11tydata.js` — add `primaryVariant` and `hasMultipleVariants` computed props

**Compatibility layer in gallery.11tydata.js**:
Compute flat accessors that map old `image.X` references to `primaryVariant.X`:
```js
// These let existing template code work unchanged during migration:
thumbnail: (data) => primaryVariant(data)?.thumbnail,
date: (data) => primaryVariant(data)?.date,
equipment: (data) => primaryVariant(data)?.equipment,
// etc.
```

**Verification**: `npm run build` produces identical HTML output. Diff the _site/ output before and after.

### Phase 2: Gallery Tiles
**Goal**: Gallery tiles and home page cards work with the new schema. Add variant count badge.

**Files changed**:
- `src/gallery/index.njk` — update card template to read from variants
- `src/index.njk` — update home page gallery cards similarly
- `src/assets/css/main.css` — add `.variant-count` badge styles
- `src/assets/js/gallery.js` — no changes expected (reads data-tags from HTML)

**Key template change** (gallery card):
```nunjucks
{# Primary variant determines the tile thumbnail and metadata #}
{% set pv = image.variants | selectattr("primary") | first %}
{% set pv = pv or image.variants[0] %}

<a href="/gallery/{{ image.slug }}/" class="gallery-card"
   data-tags="{{ image.tags | join(' ') }}{% if image.catalogs %} {{ image.catalogs | join(' ') }}{% endif %}">

  <div class="card-thumb">
    <img src="{{ pv.thumbnail }}" alt="{{ image.title }}" ... />
    {% if image.variants | length > 1 %}
    <span class="variant-count" aria-label="{{ image.variants | length }} variants">
      ⊞ {{ image.variants | length }}
    </span>
    {% endif %}
  </div>
  ...
</a>
```

**Verification**: Gallery page renders correctly with single-variant entries. Badge appears on multi-variant entries.

### Phase 3: Detail Page — Variant Loop
**Goal**: Detail page iterates over variants. Single-variant targets look identical to before.

**Files changed**:
- `src/gallery/image.njk` — major rewrite of the body (variant loop)
- `src/assets/css/main.css` — add `.variant-section`, `.variant-header` styles
- `src/gallery/gallery.11tydata.js` — remove compatibility layer (no longer needed)

**Template structure**:
```nunjucks
<article class="image-detail">
  {# Hero: primary variant's image #}
  ...

  <div class="image-detail-body">
    <div class="image-detail-header">
      <h1>{{ image.title }}</h1>
      <div class="image-catalog">{{ image.catalog }}</div>
      ...
    </div>

    {% if image.description %}
    <div class="image-description">
      <p>{{ image.description }}</p>
    </div>
    {% endif %}

    {# ── Variant loop ── #}
    {% for variant in image.variants %}
    <section class="variant-section" id="{{ variant.id }}">

      {% if image.variants | length > 1 %}
      <h2 class="variant-header">{{ variant.label }}</h2>
      {% endif %}

      {# Hero image for this variant (click to zoom) #}
      <div class="image-hero-wrap">
        {% set heroSrc = variant.preview_url or variant.full_url or variant.thumbnail %}
        <button class="zoom-trigger" data-variant="{{ variant.id }}" ...>
          <img src="{{ heroSrc }}" alt="{{ image.title }}{% if variant.label %} — {{ variant.label }}{% endif %}" ... />
          <span class="zoom-trigger-hint" aria-hidden="true">⌖ Explore full resolution</span>
        </button>
      </div>

      {# Two-column info grid — variant-specific metadata #}
      <div class="image-info-grid">
        <div class="image-meta-column">
          {# Acquisition table #}
          {# Equipment table #}
        </div>
        <div class="aladin-panel">
          {# Aladin Lite — each variant can have different sky coordinates #}
        </div>
      </div>

      {% if variant.sky and variant.sky.ra %}
      <div class="image-coords">...</div>
      {% endif %}

    </section>
    {% endfor %}

    {# ── See Also (other targets sharing the same target ID) ── #}
    {# Computed in gallery.11tydata.js as `relatedImages` #}

    {# Comments, Prev/Next #}
    ...
  </div>
</article>
```

**Decisions**:
- The hero-wrap at the top of the page shows the PRIMARY variant's image (clickable to zoom).
- Each variant section ALSO has its own zoom trigger within the loop.
- For single-variant targets, the layout is: hero at top, description, metadata — visually identical to the current site. The variant loop runs once with no variant header.
- For multi-variant targets: hero at top (primary), description, then each variant section with its own hero + metadata.

**Open question for implementation**: Should multi-variant pages show the primary variant hero at the page top (outside the loop) AND repeat it inside the loop? Or should the top hero be omitted and each variant section has its own full-width hero? The vertical-stack design suggests the latter — each variant is a self-contained section with its own hero. The page-level hero can be the primary variant's image but it doubles as the LCP element and the "what is this target" visual context. Recommend: keep page-level hero (primary variant) + per-variant zoom triggers. The page hero is a context-setter, not a duplicate.

**Verification**: Single-variant detail pages are visually identical to current. Multi-variant pages (once data is added) show stacked variant sections.

### Phase 4: Lightbox — Revision Filmstrip
**Goal**: Lightbox supports revision navigation for variants that have multiple revisions.

**Files changed**:
- `src/gallery/image.njk` — update JSON data bridge to include revision data per variant
- `src/assets/js/detail.js` — major update: variant-aware lightbox, revision filmstrip, URL state
- `src/assets/css/main.css` — revision filmstrip styles inside lightbox

**JSON data bridge** (updated):
```nunjucks
<script id="image-data" type="application/json">
{
  "variants": [
    {% for variant in image.variants %}
    {
      "id": {{ variant.id | dump | safe }},
      "label": {{ (variant.label or "") | dump | safe }},
      "dziUrl": {{ variant.dzi_url | dump | safe }},
      "annotatedDziUrl": {{ variant.annotated_dzi_url | dump | safe }},
      "annotations": {{ (variant.annotations or []) | dump | safe }},
      "sky": {% if variant.sky and variant.sky.aladin_target %}{
        "aladinTarget": {{ variant.sky.aladin_target | dump | safe }},
        "fovDeg": {{ variant.sky.fov_deg | dump | safe }},
        "raDeg": {{ variant.sky.ra_deg | dump | safe }},
        "decDeg": {{ variant.sky.dec_deg | dump | safe }},
        "fovW": {{ variant.sky.fov_w | dump | safe }},
        "fovH": {{ variant.sky.fov_h | dump | safe }}
      }{% else %}null{% endif %},
      "revisions": {{ (variant.revisions or []) | dump | safe }}
    }{% if not loop.last %},{% endif %}
    {% endfor %}
  ]
}
</script>
```

**detail.js changes**:
- `initLightbox` accepts a variant ID parameter (from `data-variant` on the zoom trigger button).
- When opened, checks if the variant has revisions. If so, renders a filmstrip below the viewer.
- Filmstrip click handler: `viewer.open(revision.dziUrl)`, updates active state, updates URL.
- Annotation toggle uses the current revision's `annotatedDziUrl`.
- `?r=variantId:revisionId` is read on page load; if present, auto-opens lightbox at that state.

**Verification**: Lightbox opens correctly for each variant. Revision filmstrip appears when revisions exist. URL updates on revision change.

### Phase 5: "See Also" Cross-Links
**Goal**: Detail pages link to other targets of the same astronomical object.

**Files changed**:
- `src/gallery/gallery.11tydata.js` — compute `relatedImages` from shared `target` values
- `src/gallery/image.njk` — render "See Also" section before Comments

**Computed data**:
```js
relatedImages: (data) => {
  if (!data.image || !data.image.target) return [];
  return data.images.filter(
    img => img.target === data.image.target && img.slug !== data.image.slug
  );
}
```

**Verification**: Pages with shared `target` values show cross-links. Pages without show nothing.

### Phase 6: Ingest Tool Update
**Goal**: The ingest tool creates entries in the new schema format.

This overlaps with the monolith refactor (REFACTOR-PLAN.md). Can be done as part of that
refactor or independently. The ingest tool needs to:
- Ask whether the image is a new target, a new variant of an existing target, or a new revision of an existing variant.
- Write to the correct location in images.json (new array entry vs. push to existing variants/revisions array).
- Set `primary: true` and `is_final: true` appropriately.

---

## Migration Script

A Node.js script to convert current flat images.json to the new schema:

```js
// migrate-images.js — run once, then delete
const fs = require('fs');
const images = JSON.parse(fs.readFileSync('src/_data/images.json', 'utf8'));

const migrated = images.map(img => ({
  slug: img.slug,
  title: img.title,
  target: img.catalog.split(' / ')[0],  // first catalog ID as default target
  catalog: img.catalog,
  tags: img.tags,
  catalogs: img.catalogs || [],
  featured: img.featured || false,
  astrobin_id: img.astrobin_id || null,
  description: img.description || null,

  variants: [{
    id: "default",
    label: null,
    primary: true,
    date: img.date,
    thumbnail: img.thumbnail,
    preview_url: img.preview_url || null,
    full_url: img.full_url || null,
    dzi_url: img.dzi_url || null,
    annotated_dzi_url: img.annotated_dzi_url || null,
    annotated_url: img.annotated_url || null,
    annotations: img.annotations || [],
    equipment: img.equipment || null,
    acquisition: img.acquisition || null,
    sky: img.sky || null,
    revisions: []
  }]
}));

fs.writeFileSync('src/_data/images.json', JSON.stringify(migrated, null, '\t'));
console.log(`Migrated ${migrated.length} images`);
```

**Important**: Review the auto-generated `target` values. Some need manual adjustment:
- "Sol" → keep as "Sol"
- "Barnard 33 / IC 434" → target should be "Barnard 33" (primary designation)
- "M42 / NGC 1976" → target should be "M42"
- etc.

---

## Fields Removed from Top Level

These fields move INTO `variants[0]` during migration:
- `date`, `thumbnail`, `preview_url`, `full_url`
- `dzi_url`, `annotated_dzi_url`, `annotated_url`
- `annotations`
- `equipment`, `acquisition`, `sky`

These stay at the top level (target-level):
- `slug`, `title`, `target`, `catalog`, `tags`, `catalogs`
- `featured`, `astrobin_id`, `description`

---

## Template Field Reference

Every place the templates currently access `image.X` needs updating.
Here is the complete list of references found in each file:

### image.njk (detail page)
| Current access | New access |
|---|---|
| `image.slug` | `image.slug` (unchanged) |
| `image.title` | `image.title` (unchanged) |
| `image.catalog` | `image.catalog` (unchanged) |
| `image.description` | `image.description` (unchanged) |
| `image.date` | `variant.date` (inside loop) |
| `image.astrobin_id` | `image.astrobin_id` (unchanged) |
| `image.tags` | `image.tags` (unchanged) |
| `image.thumbnail` | `variant.thumbnail` (inside loop) |
| `image.preview_url` | `variant.preview_url` (inside loop) |
| `image.full_url` | `variant.full_url` (inside loop) |
| `image.dzi_url` | `variant.dzi_url` (inside loop) |
| `image.annotated_dzi_url` | `variant.annotated_dzi_url` (inside loop) |
| `image.annotated_url` | `variant.annotated_url` (inside loop) |
| `image.annotations` | `variant.annotations` (inside loop) |
| `image.equipment` | `variant.equipment` (inside loop) |
| `image.equipment.location` | `variant.equipment.location` (inside loop) |
| `image.acquisition` | `variant.acquisition` (inside loop) |
| `image.sky` | `variant.sky` (inside loop) |

### gallery/index.njk (gallery page) + index.njk (home page)
| Current access | New access |
|---|---|
| `image.slug` | `image.slug` (unchanged) |
| `image.title` | `image.title` (unchanged) |
| `image.catalog` | `image.catalog` (unchanged) |
| `image.tags` | `image.tags` (unchanged) |
| `image.catalogs` | `image.catalogs` (unchanged) |
| `image.thumbnail` | `pv.thumbnail` (where `pv` = primary variant) |
| `image.date` | `pv.date` |
| `image.acquisition` | `pv.acquisition` |

### gallery.11tydata.js (computed data)
| Current access | New access |
|---|---|
| `data.image.title` | `data.image.title` (unchanged) |
| `data.image.description` | `data.image.description` (unchanged) |
| `data.image.thumbnail` | `primaryVariant(data).thumbnail` |

---

## CSS Additions Needed

```css
/* Variant section separator */
.variant-section { }
.variant-section + .variant-section {
  margin-top: var(--space-16);
  padding-top: var(--space-12);
  border-top: 1px solid var(--border-subtle);
}

/* Variant header — only shown when multiple variants */
.variant-header {
  font-family: var(--font-heading);
  font-size: 0.875rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-secondary);
  margin-bottom: var(--space-6);
}

/* Variant count badge on gallery tiles */
.variant-count {
  position: absolute;
  bottom: var(--space-2);
  right: var(--space-2);
  padding: 2px var(--space-2);
  background: rgba(9, 9, 15, 0.75);
  backdrop-filter: blur(6px);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  font-size: 0.75rem;
  font-family: var(--font-heading);
  color: var(--text-secondary);
  letter-spacing: 0.06em;
  opacity: 0;
  transition: opacity var(--transition-fast);
  pointer-events: none;
}
.gallery-card:hover .variant-count,
.gallery-card:focus-within .variant-count { opacity: 1; }
@media (hover: none) { .variant-count { opacity: 1; } }

/* Revision filmstrip inside lightbox */
.revision-strip {
  display: flex;
  gap: var(--space-3);
  justify-content: center;
  padding: var(--space-3) var(--space-4);
  background: rgba(9, 9, 15, 0.8);
}
.revision-thumb {
  width: 80px;
  height: 54px;
  object-fit: cover;
  border: 2px solid transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  opacity: 0.6;
  transition: opacity var(--transition-fast), border-color var(--transition-fast);
}
.revision-thumb:hover { opacity: 0.9; }
.revision-thumb.active {
  opacity: 1;
  border-color: var(--accent);
}
.revision-note {
  text-align: center;
  padding: var(--space-1) var(--space-4);
  font-size: 0.8125rem;
  color: var(--text-secondary);
  background: rgba(9, 9, 15, 0.8);
}
```

---

## Sequencing & Dependencies

```
Phase 1 (data model) ──► Phase 2 (gallery tiles) ──► Phase 3 (detail page)
                                                          │
                                                          ▼
                                                     Phase 4 (lightbox revisions)
                                                          │
                                                          ▼
                                                     Phase 5 (see also links)
                                                          │
                                                          ▼
                                                     Phase 6 (ingest tool)
```

Phases 1-3 are the critical path. Phase 4 can be deferred until actual revisions are added.
Phase 5 can be deferred until a second target shares a `target` value. Phase 6 overlaps
with the monolith refactor.

---

## Verification Checklist

After each phase, verify:
- [ ] `npm run build` — 0 errors, expected file count
- [ ] Gallery page — tiles render with correct thumbnails, filters work, badge appears on multi-variant
- [ ] Detail page (single-variant) — visually identical to current
- [ ] Detail page (multi-variant) — variant sections stack correctly, metadata is variant-specific
- [ ] Lightbox — opens for each variant, revision filmstrip appears when revisions exist
- [ ] Mobile — responsive layout, zoom hint visible, variant sections stack vertically
- [ ] Accessibility — screen reader announces variant count, lightbox focus management, reduced-motion
- [ ] URL — fragments scroll to variant, `?r=` opens correct lightbox state
- [ ] JSON-LD — structured data uses primary variant's image
- [ ] OG tags — social sharing uses primary variant's thumbnail
