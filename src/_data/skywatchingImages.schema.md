# Skywatching Images Schema

This file documents the shape of entries in `skywatchingImages.json`. Each entry is a single skywatching photograph — atmospheric/wide-field content that's astrophotography-adjacent but not deep-sky (auroras, sunsets, skylines, Milky Way landscapes, etc.).

This is a parallel schema to `images.json` (which is for deep-sky targets with catalog IDs, variants, DZI tiles, plate solutions). Skywatching images don't need any of that — they're single-frame wide-field captures with simpler metadata.

## Schema

```jsonc
{
  // URL-safe identifier — used in the rendered DOM (data attributes) and any
  // future per-image permalinks. Format suggestion: <category>-<YYYY-MM-DD>-<HHMM>
  // for sortable chronological order with no collisions.
  "slug": "aurora-2024-05-11-0156",

  // One of: "aurora", "sunset", "skyline". Drives which sub-section the image
  // renders into on /skywatching/. Add a new value here to add a new sub-section.
  "category": "aurora",

  // Short display title — appears under the thumbnail.
  "title": "Coronal Aurora Overhead",

  // ISO 8601 date the photo was taken (YYYY-MM-DD). Used for the date display
  // and (when sorted) chronological ordering within a sub-section.
  "date": "2024-05-11",

  // Human-readable location — appears under the title. Keep it short:
  // "Pacific Northwest" rather than "47.6062° N, 122.3321° W".
  "location": "Pacific Northwest",

  // One- or two-sentence description. Shown on hover (desktop) and on the
  // detail/lightbox view. Voice: same as gallery — write for both the
  // astronomer audience and the layperson.
  "description": "The rare 'coronal aurora' — magnetic field lines projected from directly overhead, creating a starburst pattern of light radiating from the zenith.",

  // Web-optimized 600px-on-long-edge WebP (Q=80). Shown in the grid.
  "thumbnail": "/assets/img/skywatching/aurora-2024-05-11-0156-thumb.webp",

  // Web-optimized 2400px-on-long-edge WebP (Q=82). Shown in the lightbox /
  // detail view. No DZI deep-zoom tiles — wide-field content doesn't need them.
  "preview": "/assets/img/skywatching/aurora-2024-05-11-0156-preview.webp",

  // Optional capture metadata. Use `null` (not empty string) when unknown,
  // so the template can skip rendering the field cleanly.
  "camera":   "Samsung Galaxy S24 Ultra",
  "exposure": "3s, ISO 1600",

  // Aurora-only field. Geomagnetic activity index at capture time (Kp 0–9).
  // Use `null` for non-aurora categories. Helps astronomers contextualize the
  // event ("Kp 9" = once-in-decades G5 storm).
  "kp_index": 9
}
```

## Image processing workflow

For each new skywatching photograph:

```bash
# Thumbnail — 600px on long edge, Q=80
vips thumbnail SOURCE.jpg 'src/assets/img/skywatching/<slug>-thumb.webp[Q=80,strip=true]' 600

# Preview — 2400px on long edge, Q=82
vips thumbnail SOURCE.jpg 'src/assets/img/skywatching/<slug>-preview.webp[Q=82,strip=true]' 2400
```

`strip=true` removes EXIF and any embedded color profile — same reasoning as the hero WebPs (see `src/assets/img/hero-bg-veil-srgb.webp` history). Both browsers render raw sRGB pixel values identically without an embedded profile that they might interpret differently.

## Why this schema is separate from images.json

The deep-sky gallery's schema has:
- `variants[]` (multiple equipment/session runs per target)
- `acquisition` blocks broken out by filter (L, R, G, B, Ha, OIII, SII)
- `catalog` (Messier/NGC/IC numbers)
- `distance_display` (light-years)
- `dzi_url` (deep-zoom tile pyramid)
- `astrobin_id` (external cross-link)
- Plate-solving + Simbad annotations

None of these apply to skywatching photography. Forcing this content into the deep-sky schema would mean either bloating the schema with mostly-`null` fields or putting placeholder values that read as awkward on the rendered page. A separate schema lets each content type be honest about what data it actually has.
