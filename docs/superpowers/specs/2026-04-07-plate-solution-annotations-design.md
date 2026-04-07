# Full Plate Solution Annotations — Design Spec

**Date:** 2026-04-07
**Branch:** `preview/osd-viewer`
**Status:** Approved — ready for implementation planning

## Problem

The "Show Objects" overlay on detail pages currently shows hand-placed point markers (3 for the Veil Nebula, 1 for M101). These are manually positioned dots with labels — not a real plate solution. Users expect AstroBin-style circle overlays that show every cataloged object in the field of view, proportionally sized to each object's angular extent.

## Solution

Extend the existing annotation system to support circle overlays with angular size data from Simbad, queried at ingest time via the Simbad TAP endpoint. The frontend renders sized circles for objects with known angular extent, and point dots for objects without.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Query timing | Ingest-time only | Prevents the site from being a DoS vector for Simbad |
| Data source | Simbad TAP/ADQL cone search | Already partially implemented in `lib/simbad.js` |
| Plate solver | ASTAP CLI (`/usr/local/bin/astap_cli`) | Already installed; star database at `/usr/share/astap/` |
| Overlay rendering | CSS div with `border-radius: 50%` | Matches existing OSD overlay pattern; OSD handles zoom/pan scaling |
| Size filtering | 2% of image width minimum | Matches Astrometry.net's default `-F 0.02` threshold |
| Count cap | None (size filter is sufficient) | Industry standard; no hard cap needed |
| Manual vs. catalog merge | Keep both, `source` field distinguishes | Manual annotations have editorial value; never auto-clobbered |
| Raw data storage | Store arcminutes alongside computed fractions | Enables re-computation without re-querying Simbad |
| SIP distortion | Not implemented (v1) | Linear CD matrix only; edge positions may be off on wide-field images |

---

## 1. Annotation Schema Extension

Each annotation object in `variant.annotations[]` gains new fields:

```json
{
  "name": "NGC 6992",
  "x": 0.75,
  "y": 0.22,
  "radius": 0.08,
  "type": "SNR",
  "major_axis_arcmin": 60.0,
  "minor_axis_arcmin": 8.0,
  "position_angle": 35,
  "source": "simbad"
}
```

### Field definitions

| Field | Type | Description |
|---|---|---|
| `name` | string | Object designation (Simbad `main_id` or hand-written label) |
| `x` | number | Horizontal position as fraction of image width (0-1) |
| `y` | number | Vertical position as fraction of image height (0-1) |
| `radius` | number or null | Circle radius as fraction of image width. `null` for point sources or manual annotations without known angular size |
| `type` | string or null | Abbreviated Simbad object type (`otype_txt`): `"SNR"`, `"HII"`, `"GiG"`, `"EmN"`, etc. `null` for manual annotations |
| `major_axis_arcmin` | number or null | Raw angular major axis from Simbad in arcminutes. Stored for re-computation if the image is re-cropped |
| `minor_axis_arcmin` | number or null | Raw angular minor axis. Stored for future ellipse support |
| `position_angle` | number or null | Position angle in degrees. Stored for future ellipse support |
| `source` | string | `"simbad"` for catalog annotations, `"manual"` for hand-placed annotations |

### Backward compatibility

Existing annotations (no `radius`, no `type`, no `source`) render as point dots. The rendering code treats missing `radius` as a point marker. No migration is required — existing data works as-is. When re-processing an image, existing manual annotations gain `"source": "manual"` if not already present.

### Radius computation

```
radius_fraction = (major_axis_arcmin / 60) / fov_w_deg
```

Where `fov_w_deg` is the horizontal field of view in degrees, derived from the WCS: `abs(CDELT1) * image_width_px`.

### Filtering

- **Size threshold:** Skip objects where `radius_fraction < 0.02` (smaller than 2% of image width — invisible at normal zoom)
- **Position threshold:** Skip objects where `x` or `y` falls outside `[0, 1]` (off-frame)
- **Catalog filter:** NGC, IC, Messier (M), Sharpless (Sh 2-), LDN, LBN, Barnard, Caldwell, Abell, UGC, PGC

---

## 2. Frontend Rendering

### Circle overlays (annotations with `radius`)

Circle annotations use OSD's `addOverlay()` with a viewport `Rect` instead of a point. The div has `border-radius: 50%` and OSD handles scaling during zoom/pan.

**Coordinate handling:** `imageToViewportRectangle` converts image-pixel coordinates to OSD's viewport coordinate system (where 1.0 = image width in both axes). By passing equal width and height in pixels, the resulting viewport Rect is a visual square — and `border-radius: 50%` makes it a circle. No manual aspect correction is needed.

**Important:** `ann.radius` is a fraction of image **width**, while `ann.y` is a fraction of image **height**. These are different units — you cannot simply subtract `radius` from `y`. The radius must be converted to pixels first, then subtracted from the pixel-space center position.

**Overlay creation:**

```js
// Convert the width-fraction radius to pixels.
// Both the circle's width and height in pixels are the same (it's a circle).
var rx_px = ann.radius * imgSize.x;

var rect = viewer.viewport.imageToViewportRectangle(
    ann.x * imgSize.x - rx_px,    // left edge in pixels
    ann.y * imgSize.y - rx_px,    // top edge in pixels
    rx_px * 2,                     // width in pixels
    rx_px * 2                      // height in pixels (same = circle)
);
viewer.addOverlay({ element: circleEl, location: rect });
```

### Point overlays (annotations without `radius`)

Unchanged from current behavior: zero-size div + 7px dot + label, positioned at a viewport point via `imageToViewportCoordinates()`.

### Element structure

```html
<!-- Circle annotation -->
<div class="osd-annotation osd-annotation--hidden osd-annotation-circle"
     data-annotation-type="circle">
  <span class="osd-annotation-label">NGC 6992</span>
</div>

<!-- Point annotation -->
<div class="osd-annotation osd-annotation--hidden"
     data-annotation-type="point">
  <span class="osd-annotation-dot"></span>
  <span class="osd-annotation-label">NGC 6992 — Eastern Veil</span>
</div>
```

### CSS additions

```css
.osd-annotation-circle {
    border: 1.5px solid rgba(100, 215, 225, 0.5);
    border-radius: 50%;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
}

.osd-annotation-circle .osd-annotation-label {
    left: 50%;
    transform: translateX(-50%);
    top: -20px;
}
```

### Toggle behavior

Both point and circle annotations share the same `--hidden` / `--fade-out` classes. The existing Objects button toggles all annotations as one group. The `data-annotation-type` attribute enables future per-type filtering (see Future Work).

### Flash-on-first-open

The existing flash behavior (show annotations for 2 seconds on first lightbox open, then fade out) applies to all annotation types equally. No changes needed.

---

## 3. Ingest Pipeline Integration

### Overview

The existing pipeline sky branch (pipeline.js lines 196-267) already runs ASTAP and queries Simbad. The changes extend this flow to return circle annotations.

### Modified module: `lib/simbad.js`

The existing `simbadSearch()` function is extended to also SELECT angular size columns:

**Added to ADQL SELECT:**
```sql
galdim_majaxis AS major_axis_arcmin,
galdim_minaxis AS minor_axis_arcmin,
galdim_angle AS position_angle
```

**Updated return shape:**
```js
{
  name: string,
  ra_deg: number,
  dec_deg: number,
  type: string,
  major_axis_arcmin: number | null,
  minor_axis_arcmin: number | null,
  position_angle: number | null
}
```

**Additional changes:**
- Update URL from `simbad.u-strasbg.fr` to `simbad.cds.unistra.fr` (canonical domain, matches CSP)
- Add `Number.isFinite()` guards on RA, Dec, and radius parameters before ADQL interpolation
- Increase `TOP 80` to `TOP 200` (the 2% size filter handles display volume, but the query should return enough candidates to filter from; 200 is generous without being excessive for a single TAP request)

### New function in `lib/platesolve.js`: `buildAnnotations()`

```
buildAnnotations(simbadResults, wcs, imgW, imgH, fovWDeg)
  -> Array<annotation objects>
```

For each Simbad result:
1. `skyToPixelFrac(ra, dec, wcs, imgW, imgH)` to get `{x, y}`
2. `radius = (major_axis_arcmin / 60) / fovWDeg` (null if no angular size data)
3. Filter: `radius !== null && radius < 0.02` -> skip (below 2% threshold)
4. Filter: `x` or `y` outside `[0, 1]` -> skip (off-frame)
5. Return annotation object with all fields, `source: "simbad"`

### Modified: `lib/pipeline.js` (sky branch, ~line 249)

After `simbadSearch()` returns results:

1. Call `buildAnnotations()` to get filtered, positioned annotation objects
2. **Merge with manual annotations:**
   - Manual annotations (from form POST) get `source: "manual"` if not set
   - Deduplication: if a Simbad annotation's name matches a manual annotation's name (case-insensitive, ignoring suffixes after " — "), the manual one keeps its `x`, `y`, and `name`, but gains `radius`, `type`, and raw arcminute fields from Simbad
   - Non-matching annotations from both sources are kept
   - Order: Simbad annotations first, manual annotations last (manual renders on top)
3. Write the merged array to `variant.annotations[]`

### ASTAP CLI configuration

The ingest tool's Settings panel must be updated to point to:
- `astap_bin`: `/usr/local/bin/astap_cli`
- `astap_db_dir`: `/usr/share/astap/`

The `-sip` flag should be added to the ASTAP invocation for better wide-field accuracy (pipeline.js line ~215).

---

## 4. Re-Processing Existing Images

### Images with existing WCS data (8 images)

These already have plate solutions in `variant.sky`. Re-processing through the ingest pipeline (or a standalone script) would:
1. Read existing WCS from `variant.sky`
2. Query Simbad cone search
3. Build circle annotations
4. Merge with any existing manual annotations
5. Write updated `variant.annotations[]`

### Images without WCS data (3 images)

`omega-nebula`, `flaming-star-nebula`, and `rosette-nebula` have `sky: null` (remote telescope images, never plate-solved). Re-processing these requires their source TIF/JPG files to be plate-solved first. ASTAP CLI can do this:

```bash
astap_cli -f image.jpg -fov <hint> -d /usr/share/astap -wcs -sip
```

Plate solving simultaneously provides the WCS needed for coordinate conversion AND the FOV needed for radius computation.

### Solar image

`solar-ha-prominence` should be excluded from plate solving (no star field).

---

## 5. Security Considerations

Per the security audit (2026-04-07):

| Concern | Status |
|---|---|
| ADQL injection | Mitigated: `parseFloat()` upstream + explicit `Number.isFinite()` guard |
| SSRF | None: hardcoded Simbad URL |
| Response handling | Clean: `dumpSafe` at build time + `textContent` at render time |
| Rate limiting | Acceptable: 1-5 queries per ingest session |
| Simbad domain | Fix: update `u-strasbg.fr` to `cds.unistra.fr` |

---

## 6. Future Work

Tracked in memory (`project_annotation_type_filters.md`):

- **Per-type toggle controls** — filter annotations by Simbad object type (nebulae, galaxies, star clusters)
- **Circle vs. label toggle** — show circles without labels, or labels without circles
- **Color coding by type** — different border colors per object category
- **Ellipse rendering** — use `minor_axis_arcmin` and `position_angle` for elliptical overlays (data is stored but unused in v1)
- **SIP distortion correction** — polynomial correction for more accurate edge positions on wide-field images

---

## Files Modified

| File | Change |
|---|---|
| `ingest/lib/simbad.js` | Extend ADQL query, update URL, add `Number.isFinite()` guards |
| `ingest/lib/platesolve.js` | Add `buildAnnotations()` function |
| `ingest/lib/pipeline.js` | Add annotation building + merge logic in sky branch, add `-sip` flag |
| `src/assets/js/detail.js` | Branch `addAnnotations()` for circle vs. point overlays |
| `src/assets/css/main.css` | Add `.osd-annotation-circle` styles |
| `src/_data/images.json` | Annotations extended with new fields (per-image, during re-processing) |
| `src/_data/images.schema.md` | Document new annotation fields |
