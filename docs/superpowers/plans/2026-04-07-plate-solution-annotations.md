# Plate Solution Annotations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add AstroBin-style circle overlays to the OSD deep-zoom viewer, showing every cataloged object in the field of view sized proportionally to its angular extent.

**Architecture:** Simbad TAP provides object positions and types. PixInsight's local NGC-IC/Messier CSVs (`ingest/data/`) provide angular sizes. ASTAP provides plate solutions (WCS). At ingest time, these three sources are combined into annotation objects stored in `images.json`. The frontend reads these annotations and renders sized circles (for objects with `radius`) or point dots (for objects without) as OSD overlays.

**Tech Stack:** Node.js (ingest pipeline), vanilla JS (frontend), OpenSeadragon (deep-zoom viewer), ASTAP CLI (plate solving), Simbad TAP/ADQL (object identification), CSV parsing (angular sizes)

**Design Spec:** `docs/superpowers/specs/2026-04-07-plate-solution-annotations-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `ingest/lib/catalog.js` | CREATE | Parse NGC-IC.csv + Messier.csv into a Map; export `loadCatalog()` and `lookupSize(name)` |
| `ingest/lib/simbad.js` | MODIFY | Add angular size columns to ADQL SELECT; update Simbad URL; add `Number.isFinite()` guards |
| `ingest/lib/platesolve.js` | MODIFY | Add `buildAnnotations()` function with filtering, guards, and radius computation |
| `ingest/lib/pipeline.js` | MODIFY | Wire catalog lookup + `buildAnnotations()` into sky branch; add name-normalized dedup merge |
| `src/assets/js/detail.js` | MODIFY | Branch `addAnnotations()` for circle vs. point overlays; update `toggleObjects()` aria-label |
| `src/assets/css/main.css` | MODIFY | Add `.osd-annotation-circle` styles, `--hidden` circle fix, label text-shadow |
| `src/_data/images.json` | MODIFY | Re-process existing images with new annotation fields (manual, per-image) |
| `src/_data/images.schema.md` | MODIFY | Document new annotation fields |
| `ingest/data/NGC-IC.csv` | EXISTS | PixInsight's NGC/IC catalog — already copied |
| `ingest/data/Messier.csv` | EXISTS | PixInsight's Messier catalog — already copied |

---

## Task 1: Create `lib/catalog.js` — Local Angular Size Lookup

**Files:**
- Create: `ingest/lib/catalog.js`

This module parses the two PixInsight CSV files into an in-memory Map keyed by normalized object name (e.g. `"NGC6992"`, `"M42"`). The pipeline calls `lookupSize(name)` to get angular diameters for Simbad results.

- [ ] **Step 1: Create `ingest/lib/catalog.js`**

```js
/**
 * catalog.js — local angular size catalog from PixInsight CSV files
 *
 * Parses NGC-IC.csv and Messier.csv (in ingest/data/) into an in-memory Map
 * keyed by normalized object name. These CSVs are copied from PixInsight's
 * AnnotateImage script and contain angular diameters for ~98.8% of NGC/IC objects
 * and 109/110 Messier objects — covering nebulae, clusters, and galaxies.
 *
 * This is the same data pipeline used by Astrometry.net and PixInsight's own
 * annotation rendering.
 *
 * Exports:
 *   loadCatalog()     — parse both CSVs, return the combined Map
 *   lookupSize(name)  — find angular size data for a given object name
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// Module-level cache: populated by loadCatalog(), reused by lookupSize().
// Map<string, { diameter: number, axisRatio: number|null, posAngle: number|null }>
let catalog = null;

/**
 * normalizeName — strip spaces between prefix and number, uppercase.
 *
 * Simbad returns "NGC 6992" with a space; the CSV uses "NGC6992" without.
 * This normalizer handles both forms so lookups match regardless of source.
 *
 * Examples:
 *   "NGC 6992"     → "NGC6992"
 *   "IC 1340"      → "IC1340"
 *   "M 42"         → "M42"
 *   "NGC6992"      → "NGC6992"  (already normalized)
 *
 * @param {string} name — object designation from Simbad or CSV
 * @returns {string} normalized uppercase name with no spaces
 */
function normalizeName(name) {
	// Collapse all whitespace, uppercase for case-insensitive matching.
	return name.replace(/\s+/g, '').toUpperCase();
}

/**
 * parseCsv — parse a PixInsight catalog CSV file into records.
 *
 * CSV format (both NGC-IC.csv and Messier.csv):
 *   id,alpha,delta,magnitude,diameter,axisRatio,posAngle,Common name,...
 *
 * The "diameter" column is the angular major axis in arcminutes.
 * "axisRatio" is major/minor axis ratio (for future ellipse rendering).
 * "posAngle" is position angle in degrees.
 *
 * @param {string} csvPath — absolute path to the CSV file
 * @returns {Array<{ id: string, diameter: number|null, axisRatio: number|null, posAngle: number|null, commonName: string }>}
 */
function parseCsv(csvPath) {
	const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
	// First line is the header row — skip it.
	const records = [];
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;

		// Split on commas. The CSV does not use quoting for these fields.
		const fields = line.split(',');
		// fields[0] = id (e.g. "NGC6992", "M42")
		// fields[4] = diameter in arcminutes (may be empty)
		// fields[5] = axisRatio (may be empty)
		// fields[6] = posAngle (may be empty)
		// fields[7] = Common name (may be empty)
		const id = (fields[0] || '').trim();
		if (!id) continue;

		const diam = parseFloat(fields[4]);
		const ar   = parseFloat(fields[5]);
		const pa   = parseFloat(fields[6]);

		records.push({
			id,
			diameter:   Number.isFinite(diam) ? diam : null,
			axisRatio:  Number.isFinite(ar)   ? ar   : null,
			posAngle:   Number.isFinite(pa)   ? pa   : null,
			commonName: (fields[7] || '').trim(),
		});
	}
	return records;
}

/**
 * loadCatalog — parse NGC-IC.csv and Messier.csv into the module-level Map.
 *
 * Called once at pipeline startup. The Map is keyed by normalizeName(id).
 * Messier entries are indexed under both their "M" name and their NGC/IC
 * cross-reference (e.g. M42 → NGC1976), so lookups work from either name.
 *
 * @returns {Map} the populated catalog Map
 */
function loadCatalog() {
	if (catalog) return catalog;

	catalog = new Map();
	const dataDir = path.join(__dirname, '..', 'data');

	// Parse NGC-IC.csv first — this is the primary catalog.
	const ngcPath = path.join(dataDir, 'NGC-IC.csv');
	if (fs.existsSync(ngcPath)) {
		for (const rec of parseCsv(ngcPath)) {
			catalog.set(normalizeName(rec.id), rec);
		}
	}

	// Parse Messier.csv — add M-number aliases and fill in any gaps.
	// Messier.csv has a "NGC/IC" column (fields[8]) for cross-referencing.
	const messierPath = path.join(dataDir, 'Messier.csv');
	if (fs.existsSync(messierPath)) {
		const lines = fs.readFileSync(messierPath, 'utf8').split('\n');
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i].trim();
			if (!line) continue;
			const fields = line.split(',');
			const id = (fields[0] || '').trim();
			if (!id) continue;

			const diam = parseFloat(fields[4]);
			const ar   = parseFloat(fields[5]);
			const pa   = parseFloat(fields[6]);

			const rec = {
				id,
				diameter:   Number.isFinite(diam) ? diam : null,
				axisRatio:  Number.isFinite(ar)   ? ar   : null,
				posAngle:   Number.isFinite(pa)   ? pa   : null,
				commonName: (fields[7] || '').trim(),
			};

			// Index under the Messier name (e.g. "M42")
			catalog.set(normalizeName(id), rec);

			// Also index under the NGC/IC cross-reference if present.
			// This way, lookupSize("NGC 1976") finds M42's diameter.
			const ngcRef = (fields[8] || '').trim();
			if (ngcRef && !catalog.has(normalizeName(ngcRef))) {
				catalog.set(normalizeName(ngcRef), rec);
			}
		}
	}

	return catalog;
}

/**
 * lookupSize — find angular size data for a given object name.
 *
 * @param {string} name — object designation (e.g. "NGC 6992", "M 42", "IC 1340")
 * @returns {{ diameter: number, axisRatio: number|null, posAngle: number|null }|null}
 *   Returns null if the object is not in the catalog or has no diameter data.
 */
function lookupSize(name) {
	if (!catalog) loadCatalog();
	const key = normalizeName(name);
	const rec = catalog.get(key);
	if (!rec || rec.diameter === null) return null;
	return {
		diameter:  rec.diameter,
		axisRatio: rec.axisRatio,
		posAngle:  rec.posAngle,
	};
}

module.exports = { loadCatalog, lookupSize, normalizeName };
```

- [ ] **Step 2: Smoke-test the catalog module**

Run from the `ingest/` directory:

```bash
cd /home/dustin/Claude/dustin-space/ingest && node -e "
const { loadCatalog, lookupSize } = require('./lib/catalog');
loadCatalog();
console.log('NGC 6992:', lookupSize('NGC 6992'));
console.log('M 42:', lookupSize('M 42'));
console.log('IC 405:', lookupSize('IC 405'));
console.log('NGC 1976 (via M42 xref):', lookupSize('NGC 1976'));
console.log('Nonexistent:', lookupSize('NGC 99999'));
"
```

Expected output (approximate diameters from the CSV):
```
NGC 6992: { diameter: 60, axisRatio: null, posAngle: null }
M 42: { diameter: 66, axisRatio: null, posAngle: null }
IC 405: { diameter: 30, axisRatio: null, posAngle: null }
NGC 1976 (via M42 xref): { diameter: 66, axisRatio: null, posAngle: null }
Nonexistent: null
```

- [ ] **Step 3: Commit**

```bash
git add ingest/lib/catalog.js
git commit -m "feat: add local catalog module for angular size lookup

Parses PixInsight's NGC-IC.csv (9,935 objects) and Messier.csv (110 objects)
into an in-memory Map. Provides lookupSize(name) for the ingest pipeline to
get angular diameters without any network dependency."
```

---

## Task 2: Extend `lib/simbad.js` — Add Angular Size Columns + Guards

**Files:**
- Modify: `ingest/lib/simbad.js`

Three changes: (1) add `galdim_majaxis`, `galdim_minaxis`, `galdim_angle` to the ADQL SELECT (these will be non-null only for galaxies, but they're free data), (2) update the Simbad URL from `u-strasbg.fr` to `cds.unistra.fr`, (3) add `Number.isFinite()` guards on parameters, (4) increase `TOP 80` to `TOP 200`.

- [ ] **Step 1: Update `simbad.js`**

In `ingest/lib/simbad.js`, make these changes:

Replace the ADQL query (lines 44-51):

```js
	const adql = [
		`SELECT TOP 80 main_id, ra, dec, otype_txt`,
```

With:

```js
	const adql = [
		`SELECT TOP 200 main_id, ra, dec, otype_txt, galdim_majaxis, galdim_minaxis, galdim_angle`,
```

Replace the URL (line 55):

```js
	const url = new URL('https://simbad.u-strasbg.fr/simbad/sim-tap/sync');
```

With:

```js
	const url = new URL('https://simbad.cds.unistra.fr/simbad/sim-tap/sync');
```

Replace the return mapping (lines 70-75):

```js
	return (body.data || []).map(row => ({
		name:    String(row[0]).trim(),
		ra_deg:  Number(row[1]),
		dec_deg: Number(row[2]),
		type:    String(row[3]).trim(),
	}));
```

With:

```js
	return (body.data || []).map(row => {
		const ra  = Number(row[1]);
		const dec = Number(row[2]);
		// Skip rows with non-finite coordinates (corrupt Simbad data).
		if (!Number.isFinite(ra) || !Number.isFinite(dec)) return null;

		// galdim_majaxis is galaxy-only — returns null for nebulae, clusters, etc.
		// The pipeline supplements this with local CSV data from PixInsight's catalogs.
		const maj = Number(row[4]);
		const min = Number(row[5]);
		const pa  = Number(row[6]);

		return {
			name:                String(row[0]).trim(),
			ra_deg:              ra,
			dec_deg:             dec,
			type:                String(row[3]).trim(),
			major_axis_arcmin:   Number.isFinite(maj) ? maj : null,
			minor_axis_arcmin:   Number.isFinite(min) ? min : null,
			position_angle:      Number.isFinite(pa)  ? pa  : null,
		};
	}).filter(Boolean);
```

Add parameter guards at the top of `simbadSearch()`, before the ADQL string (after line 39):

```js
	// Guard against non-finite parameters — these would produce broken ADQL
	// and could cause unexpected Simbad behavior.
	if (!Number.isFinite(raDeg) || !Number.isFinite(decDeg) || !Number.isFinite(radiusDeg)) {
		throw new Error(`simbadSearch: non-finite parameter (ra=${raDeg}, dec=${decDeg}, radius=${radiusDeg})`);
	}
```

Update the JSDoc `@returns` to reflect the new fields:

```js
 * @returns {Promise<Array<{name: string, ra_deg: number, dec_deg: number, type: string, major_axis_arcmin: number|null, minor_axis_arcmin: number|null, position_angle: number|null}>>}
```

- [ ] **Step 2: Smoke-test the updated query**

This requires a live network connection. If offline, skip to Step 3.

```bash
cd /home/dustin/Claude/dustin-space/ingest && node -e "
const { simbadSearch } = require('./lib/simbad');
// Query the Veil Nebula field (RA ~311°, Dec ~31°, 2° radius)
simbadSearch(311.4, 31.0, 2.0).then(results => {
  console.log('Total results:', results.length);
  results.slice(0, 5).forEach(r => console.log(r));
}).catch(err => console.error('Error:', err.message));
"
```

Expected: ~20-50 results. Galaxy objects may have `major_axis_arcmin` populated; nebulae will have `null`.

- [ ] **Step 3: Commit**

```bash
git add ingest/lib/simbad.js
git commit -m "feat: extend Simbad query with angular size columns + guards

- Add galdim_majaxis/minaxis/angle to ADQL SELECT (galaxy-only data)
- Update URL to canonical simbad.cds.unistra.fr domain
- Add Number.isFinite() guards on RA/Dec/radius parameters
- Increase TOP 80 to TOP 200 for wider candidate pool
- Filter out rows with non-finite coordinates"
```

---

## Task 3: Add `buildAnnotations()` to `lib/platesolve.js`

**Files:**
- Modify: `ingest/lib/platesolve.js`

This function takes Simbad results (already enriched with catalog sizes) and a WCS solution, and produces the annotation objects that get stored in `images.json`.

- [ ] **Step 1: Add the catalog allowlist and `buildAnnotations()` function**

Append to `ingest/lib/platesolve.js`, before the `module.exports` line:

```js
/**
 * CATALOG_ALLOWLIST — name prefixes for objects that render as point dots
 * when they have no angular size data.
 *
 * Objects with radius: null from Simbad are only kept if their name starts
 * with one of these prefixes. This prevents hundreds of faint PGC/UGC entries
 * from cluttering the image with tiny unlabeled dots.
 */
const CATALOG_ALLOWLIST = [
	'NGC', 'IC', 'M', 'SH2-', 'SH 2-', 'LDN', 'LBN',
	'BARNARD', 'B ', 'CALDWELL', 'C ', 'ABELL', 'UGC', 'PGC',
];

/**
 * nameMatchesAllowlist — check if an object name starts with an allowed prefix.
 *
 * @param {string} name — Simbad main_id (e.g. "NGC 6992", "PGC 12345")
 * @returns {boolean} true if the name matches any allowed catalog prefix
 */
function nameMatchesAllowlist(name) {
	const upper = name.toUpperCase();
	return CATALOG_ALLOWLIST.some(prefix => upper.startsWith(prefix));
}

/**
 * buildAnnotations — convert Simbad results + WCS into annotation objects.
 *
 * For each Simbad result:
 *   1. Convert sky coordinates to pixel fractions via WCS
 *   2. Compute radius fraction from angular size and FOV
 *   3. Apply size/position filters
 *   4. Return annotation objects ready for images.json
 *
 * @param {Array} simbadResults — objects from simbadSearch(), with angular size
 *   data already merged from the local catalog (catalog.js)
 * @param {object} wcs    — WCS solution from parseAstapIni()
 * @param {number} imgW   — image width in pixels
 * @param {number} imgH   — image height in pixels
 * @param {number} fovWDeg — horizontal field of view in degrees
 * @returns {Array<object>} annotation objects for images.json
 */
function buildAnnotations(simbadResults, wcs, imgW, imgH, fovWDeg) {
	// Guard: degenerate WCS produces Infinity radius → browser crash.
	if (!Number.isFinite(fovWDeg) || fovWDeg <= 0) return [];

	const annotations = [];

	for (const obj of simbadResults) {
		// Convert RA/Dec to fractional pixel position (0-1).
		const pos = skyToPixelFrac(obj.ra_deg, obj.dec_deg, wcs, imgW, imgH);

		// Filter: off-frame objects (position outside 0-1 range).
		if (pos.x < 0 || pos.x > 1 || pos.y < 0 || pos.y > 1) continue;

		// Compute radius fraction from angular size.
		// major_axis_arcmin is in arcminutes; fovWDeg is in degrees.
		// radius_fraction = (arcmin / 60) / fov_degrees
		let radius = null;
		if (obj.major_axis_arcmin != null && Number.isFinite(obj.major_axis_arcmin)) {
			radius = (obj.major_axis_arcmin / 60) / fovWDeg;

			// Filter: too small to see (below 2% of image width).
			if (radius < 0.02) continue;

			// Cap: prevent one object from dominating the entire view.
			if (radius > 0.5) radius = 0.5;
		}

		// Filter: sizeless objects must match the catalog allowlist.
		// This prevents hundreds of faint PGC/UGC point dots.
		if (radius === null && !nameMatchesAllowlist(obj.name)) continue;

		annotations.push({
			name:               obj.name,
			x:                  pos.x,
			y:                  pos.y,
			radius:             radius,
			type:               obj.type || null,
			major_axis_arcmin:  obj.major_axis_arcmin || null,
			minor_axis_arcmin:  obj.minor_axis_arcmin || null,
			position_angle:     obj.position_angle || null,
			source:             'simbad',
		});
	}

	return annotations;
}
```

Update the `module.exports` line:

```js
module.exports = { parseAstapIni, skyToPixelFrac, buildAnnotations };
```

- [ ] **Step 2: Smoke-test `buildAnnotations()` with mock data**

```bash
cd /home/dustin/Claude/dustin-space/ingest && node -e "
const { buildAnnotations } = require('./lib/platesolve');

// Mock WCS for a 2° wide field centered on the Veil Nebula
const wcs = {
  ra_deg: 312.0, dec_deg: 31.0,
  crpix1: 3000, crpix2: 2000,
  cd11: -0.000333, cd12: 0, cd21: 0, cd22: 0.000333,
  pixScaleDeg: 0.000333
};

const results = [
  { name: 'NGC 6992', ra_deg: 314.08, dec_deg: 31.74, type: 'SNR',
    major_axis_arcmin: 60, minor_axis_arcmin: null, position_angle: null },
  { name: 'PGC 99999', ra_deg: 313.0, dec_deg: 31.5, type: 'G',
    major_axis_arcmin: null, minor_axis_arcmin: null, position_angle: null },
  { name: 'UNKNOWN 1', ra_deg: 313.0, dec_deg: 31.5, type: 'G',
    major_axis_arcmin: null, minor_axis_arcmin: null, position_angle: null },
];

const fovW = 6000 * 0.000333; // ~2.0 degrees
const anns = buildAnnotations(results, wcs, 6000, 4000, fovW);
console.log('Annotations:', JSON.stringify(anns, null, 2));
console.log('Count:', anns.length, '(expect 2: NGC kept, PGC kept as allowlist match, UNKNOWN filtered)');
"
```

- [ ] **Step 3: Commit**

```bash
git add ingest/lib/platesolve.js
git commit -m "feat: add buildAnnotations() with filtering and guards

Converts Simbad results + WCS into annotation objects for images.json.
Includes:
- FOV guard (prevents Infinity from degenerate WCS)
- Null-safe radius computation (prevents NaN propagation)
- 2% minimum size threshold + 0.5 cap
- Catalog allowlist for sizeless objects (prevents PGC/UGC clutter)
- Off-frame position filter"
```

---

## Task 4: Wire Pipeline — Catalog Lookup + Annotation Building + Dedup Merge

**Files:**
- Modify: `ingest/lib/pipeline.js` (sky branch, ~lines 196-267)

This is the integration task. The sky branch already runs ASTAP → Simbad. We add: (1) load local catalog, (2) merge sizes into Simbad results, (3) call `buildAnnotations()`, (4) normalized dedup merge with manual annotations.

- [ ] **Step 1: Add imports at the top of `pipeline.js`**

Near the existing `require` statements for `simbadSearch` and `parseAstapIni`/`skyToPixelFrac`, add:

```js
const { loadCatalog, lookupSize } = require('./catalog');
const { buildAnnotations } = require('./platesolve');
```

- [ ] **Step 2: Add the name normalization helper**

Add this function near the top of the file (before `runPipeline`), or in the sky branch scope:

```js
/**
 * normalizeAnnotationName — normalize an object name for dedup comparison.
 *
 * Collapses whitespace, converts all dash variants (em-dash, en-dash) to
 * hyphens, case-folds to lowercase, strips suffixes after " - ".
 * This handles Simbad quirks like "M  42" and manual annotations with
 * em-dashes like "NGC 6992 — Eastern Veil".
 *
 * @param {string} name — annotation name from Simbad or manual input
 * @returns {string} normalized name for comparison
 */
function normalizeAnnotationName(name) {
	return name
		.replace(/[\u2014\u2013]/g, '-')   // em-dash (—) and en-dash (–) to hyphen
		.replace(/\s+/g, ' ')              // collapse whitespace
		.replace(/\s*-\s*.*$/, '')          // strip suffix after " - " (e.g. " — Eastern Veil")
		.trim()
		.toLowerCase();
}
```

- [ ] **Step 3: Modify the sky branch to build circle annotations**

In the sky branch (the `if (wcs && doSimbad)` block, ~line 237), replace the existing Simbad handling code. The current code (lines 238-263) does this:

```js
if (wcs && doSimbad) {
    step('Querying Simbad for objects in field of view...');
    try {
        // ... FOV calculation, simbadSearch, skyToPixelFrac loop ...
        annotations = [...fromSimbad, ...annotations];
    } catch (err) {
        warn(`Simbad search failed: ${err.message}`);
    }
}
```

Replace the body of that `if` block with:

```js
if (wcs && doSimbad) {
	step('Querying Simbad for objects in field of view...');
	try {
		const effImgW = imgW || 6000;
		const effImgH = imgH || 4000;
		if (!imgW || !imgH) {
			warn(`Could not read image dimensions — using defaults (${effImgW}×${effImgH}) for Simbad FOV calculation.`);
		}
		const fovW = effImgW * wcs.pixScaleDeg;
		const fovH = effImgH * wcs.pixScaleDeg;
		const radius = Math.sqrt(fovW * fovW + fovH * fovH) / 2;

		const objects = await simbadSearch(wcs.ra_deg, wcs.dec_deg, radius);
		ok(`Simbad found ${objects.length} non-stellar objects in field`);

		// Enrich Simbad results with angular sizes from local catalogs.
		// Simbad's galdim_majaxis is galaxy-only; the local CSVs cover all types.
		loadCatalog();
		let enriched = 0;
		for (const obj of objects) {
			if (obj.major_axis_arcmin == null) {
				const size = lookupSize(obj.name);
				if (size) {
					obj.major_axis_arcmin = size.diameter;
					if (size.axisRatio != null) {
						// Derive minor axis from diameter and axis ratio.
						// axisRatio = major / minor, so minor = major / axisRatio.
						obj.minor_axis_arcmin = size.diameter / size.axisRatio;
					}
					if (size.posAngle != null) {
						obj.position_angle = size.posAngle;
					}
					enriched++;
				}
			}
		}
		ok(`Enriched ${enriched} objects with angular sizes from local catalog`);

		// Build filtered annotation objects with radius fractions.
		const fromSimbad = buildAnnotations(objects, wcs, effImgW, effImgH, fovW);
		ok(`${fromSimbad.length} in-frame objects with pixel coordinates`);

		// Merge with manual annotations (dedup by normalized name).
		// Manual annotations keep their hand-placed x/y but gain radius/type
		// from Simbad+catalog if a match is found.
		const manualByName = new Map();
		for (const ann of annotations) {
			ann.source = ann.source || 'manual';
			manualByName.set(normalizeAnnotationName(ann.name), ann);
		}

		const merged = [];
		for (const sAnn of fromSimbad) {
			const key = normalizeAnnotationName(sAnn.name);
			const manual = manualByName.get(key);
			if (manual) {
				// Manual annotation exists: keep hand-placed position and name,
				// enrich with catalog data.
				manual.radius             = sAnn.radius;
				manual.type               = sAnn.type;
				manual.major_axis_arcmin  = sAnn.major_axis_arcmin;
				manual.minor_axis_arcmin  = sAnn.minor_axis_arcmin;
				manual.position_angle     = sAnn.position_angle;
				manualByName.delete(key); // consumed — don't add again below
			} else {
				merged.push(sAnn);
			}
		}
		// Simbad annotations first, then remaining manual annotations on top.
		annotations = [...merged, ...manualByName.values()];
	} catch (err) {
		warn(`Simbad search failed: ${err.message}`);
	}
}
```

- [ ] **Step 4: Verify the ingest server starts**

```bash
cd /home/dustin/Claude/dustin-space/ingest && node -e "require('./lib/pipeline')" && echo "OK: pipeline.js loads without errors"
```

Expected: `OK: pipeline.js loads without errors`

- [ ] **Step 5: Commit**

```bash
git add ingest/lib/pipeline.js
git commit -m "feat: wire catalog lookup + annotation building into pipeline

Sky branch now:
1. Queries Simbad for object positions and types
2. Enriches results with angular sizes from local PixInsight catalogs
3. Calls buildAnnotations() with radius computation and filtering
4. Merges with manual annotations using name-normalized deduplication

Manual annotations keep hand-placed positions but gain circle data."
```

---

## Task 5: Frontend — Circle Overlay Rendering in `detail.js`

**Files:**
- Modify: `src/assets/js/detail.js` (~lines 498-533, 434-447)

The existing `addAnnotations()` creates point-marker overlays for every annotation. We branch on `ann.radius`: if present, create a circle overlay using `imageToViewportRectangle`; otherwise, create the existing point dot.

- [ ] **Step 1: Replace `addAnnotations()` body**

In `src/assets/js/detail.js`, replace the `addAnnotations` function (lines 498-533) with:

```js
		/**
		 * Creates OSD overlay elements for the given variant's annotations.
		 * Called after tiles load (via the 'open' handler) so getContentSize()
		 * returns the correct image dimensions.
		 *
		 * Annotations with a `radius` field render as sized circles (scaled by OSD
		 * during zoom/pan). Annotations without `radius` render as fixed-size point
		 * dots — unchanged from the original behavior.
		 *
		 * @param {Object} variant - Variant data with annotations array
		 */
		function addAnnotations(variant) {
			if (!variant.annotations || !variant.annotations.length) return;
			if (!viewer || !viewer.world.getItemAt(0)) return;

			// getContentSize() returns the pixel dimensions of the loaded image.
			// Used to convert fractional positions (0-1) to image-pixel coordinates.
			var imgSize = viewer.world.getItemAt(0).getContentSize();

			variant.annotations.forEach(function (ann) {
				if (ann.radius != null && ann.radius > 0) {
					// ── Circle annotation ──────────────────────────────────────
					// ann.radius is a fraction of image WIDTH.
					// Convert to pixels, build a square bounding box (OSD + border-radius:50% = circle).
					var el = document.createElement('div');
					el.className = 'osd-annotation osd-annotation--hidden osd-annotation-circle';
					el.setAttribute('data-annotation-type', 'circle');
					el.setAttribute('aria-hidden', 'true');

					var labelEl = document.createElement('span');
					labelEl.className = 'osd-annotation-label';
					labelEl.textContent = ann.name;
					el.appendChild(labelEl);

					// Convert the width-fraction radius to pixels.
					// Both the circle's width and height in pixels are the same (it's a circle).
					var rx_px = ann.radius * imgSize.x;

					// imageToViewportRectangle(x, y, w, h) takes image-pixel coordinates
					// and returns a viewport Rect. By passing equal width and height in pixels,
					// the resulting Rect is a visual square — border-radius:50% makes it a circle.
					// No manual aspect correction needed.
					var rect = viewer.viewport.imageToViewportRectangle(
						ann.x * imgSize.x - rx_px,    // left edge in pixels
						ann.y * imgSize.y - rx_px,    // top edge in pixels
						rx_px * 2,                     // width in pixels
						rx_px * 2                      // height in pixels (same = circle)
					);
					viewer.addOverlay({ element: el, location: rect });

				} else {
					// ── Point annotation ───────────────────────────────────────
					// Original behavior: zero-size div + 7px dot + label.
					var el = document.createElement('div');
					el.className = 'osd-annotation osd-annotation--hidden';
					el.setAttribute('data-annotation-type', 'point');
					el.setAttribute('aria-hidden', 'true');

					var dot = document.createElement('span');
					dot.className = 'osd-annotation-dot';
					var labelEl = document.createElement('span');
					labelEl.className = 'osd-annotation-label';
					labelEl.textContent = ann.name;
					el.appendChild(dot);
					el.appendChild(labelEl);

					// Convert 0-1 fraction -> image pixels -> OSD viewport coordinates.
					var vpPt = viewer.viewport.imageToViewportCoordinates(
						ann.x * imgSize.x,
						ann.y * imgSize.y
					);
					viewer.addOverlay({ element: el, location: vpPt });
				}

				annotationEls.push(el);
			});
		}
```

- [ ] **Step 2: Update `toggleObjects()` aria-label**

In the `toggleObjects()` function (line ~443-446), the `title` already toggles but `aria-label` is not set. Add it after the existing `title` update:

Replace:

```js
				objectsBtn.setAttribute('aria-pressed', showingObjects ? 'true' : 'false');
				objectsBtn.title = (showingObjects ? 'Hide' : 'Show') + ' Objects';
				objectsBtn.classList.toggle('osd-objects-btn--active', showingObjects);
```

With:

```js
				objectsBtn.setAttribute('aria-pressed', showingObjects ? 'true' : 'false');
				objectsBtn.title = (showingObjects ? 'Hide' : 'Show') + ' Objects';
				objectsBtn.setAttribute('aria-label', (showingObjects ? 'Hide' : 'Show') + ' Objects');
				objectsBtn.classList.toggle('osd-objects-btn--active', showingObjects);
```

- [ ] **Step 3: Verify the site builds**

```bash
cd /home/dustin/Claude/dustin-space && npm run build
```

Expected: Clean build with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/assets/js/detail.js
git commit -m "feat: add circle overlay rendering for plate solution annotations

addAnnotations() now branches on ann.radius:
- radius present: sized circle via imageToViewportRectangle + border-radius:50%
- radius absent: original point dot behavior (unchanged)

Also updates toggleObjects() aria-label for accessibility."
```

---

## Task 6: Frontend — CSS for Circle Overlays

**Files:**
- Modify: `src/assets/css/main.css` (~after line 1381)

- [ ] **Step 1: Add circle annotation styles**

In `src/assets/css/main.css`, after the `.osd-annotation-label` rule block (after line 1381), add:

```css

/* ── Circle annotations (plate-solved objects with angular size) ──────
   The parent div IS the circle — OSD sizes it via the viewport Rect.
   width/height:100% fills the Rect; border-radius:50% makes it round.
   ──────────────────────────────────────────────────────────────────── */
.osd-annotation-circle {
	border: 1.5px solid rgba(100, 215, 225, 0.5);
	border-radius: 50%;
	width: 100%;
	height: 100%;
	box-sizing: border-box;
}

/* Circle labels: centered above the circle instead of offset right */
.osd-annotation-circle .osd-annotation-label {
	left: 50%;
	transform: translateX(-50%);
	top: -20px;
	text-shadow: 0 0 3px rgba(0, 0, 0, 0.8);
}

/* Circle border is on the parent div itself, not a child element.
   The --hidden class only hides children (dot + label) by default,
   so circles need display:none to fully disappear. */
.osd-annotation--hidden.osd-annotation-circle {
	display: none;
}

/* Fade-out transition for circle annotations (matches point dot behavior) */
.osd-annotation--fade-out.osd-annotation-circle {
	opacity: 0;
	transition: opacity 0.6s ease-out;
}
```

- [ ] **Step 2: Verify the site builds**

```bash
cd /home/dustin/Claude/dustin-space && npm run build
```

Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add src/assets/css/main.css
git commit -m "feat: add CSS for circle annotation overlays

- .osd-annotation-circle: border + border-radius:50% for sized circles
- Centered label positioning above the circle
- --hidden fix: display:none on parent (border is on parent, not child)
- Fade-out transition matching point dot behavior
- Label text-shadow for contrast on bright nebula regions"
```

---

## Task 7: Update Schema Documentation

**Files:**
- Modify: `src/_data/images.schema.md`

- [ ] **Step 1: Update the annotations field documentation**

In `src/_data/images.schema.md`, replace the `annotations` row in the Variant table (line 40):

```
| annotations       | object[]       | no       | [{name, x, y}] — x/y are 0–1 fractions from top-left |
```

With:

```
| annotations       | object[]       | no       | See Annotations below |
```

Then, after the File Metadata section (after line 126), add a new section:

```markdown

## Annotations (inside `variant.annotations[]`)

Each annotation marks a cataloged object's position in the image.
Annotations with `radius` render as sized circles; those without render as point dots.

| Field             | Type           | Notes |
|-------------------|----------------|-------|
| name              | string         | Object designation (Simbad `main_id` or hand-written label) |
| x                 | number         | Horizontal position as fraction of image width (0–1) |
| y                 | number         | Vertical position as fraction of image height (0–1) |
| radius            | number or null | Circle radius as fraction of image width. null = point dot |
| type              | string or null | Simbad object type abbreviation: "SNR", "HII", "GiG", "EmN", etc. |
| major_axis_arcmin | number or null | Raw angular major axis in arcminutes (from local catalog or Simbad) |
| minor_axis_arcmin | number or null | Raw angular minor axis (stored for future ellipse support) |
| position_angle    | number or null | Position angle in degrees (stored for future ellipse support) |
| source            | string         | "simbad" for catalog annotations, "manual" for hand-placed |
```

- [ ] **Step 2: Commit**

```bash
git add src/_data/images.schema.md
git commit -m "docs: add annotation schema fields to images.schema.md

Documents radius, type, major/minor axis, position angle, and source
fields added by the plate solution feature."
```

---

## Task 8: Manual Test — Add Test Annotations to Veil Nebula

**Files:**
- Modify: `src/_data/images.json` (veil-nebula variant annotations)

This task manually adds circle annotation data to the Veil Nebula entry (which already has 3 manual annotations) to verify the frontend renders circles correctly. A full pipeline run is not required — we're testing the frontend rendering path only.

- [ ] **Step 1: Add test circle annotations to the Veil Nebula**

In `src/_data/images.json`, find the veil-nebula variant's `annotations` array (line ~284). The Veil Nebula's WCS data in `sky` shows `fov_w: 3.11` degrees. Using the known angular diameters:

- NGC 6992: 60 arcmin → radius = (60/60) / 3.11 ≈ 0.322
- NGC 6960: 70 arcmin → radius = (70/60) / 3.11 ≈ 0.375
- Pickering's Triangle: no catalog data → keep as point dot

Replace the existing annotations array with:

```json
"annotations": [
    {
        "name": "NGC 6992",
        "x": 0.75,
        "y": 0.22,
        "radius": 0.322,
        "type": "SNR",
        "major_axis_arcmin": 60.0,
        "minor_axis_arcmin": null,
        "position_angle": null,
        "source": "manual"
    },
    {
        "name": "NGC 6960",
        "x": 0.16,
        "y": 0.62,
        "radius": 0.375,
        "type": "SNR",
        "major_axis_arcmin": 70.0,
        "minor_axis_arcmin": null,
        "position_angle": null,
        "source": "manual"
    },
    {
        "name": "Pickering's Triangle",
        "x": 0.46,
        "y": 0.32,
        "source": "manual"
    }
]
```

- [ ] **Step 2: Start the dev server and verify visually**

```bash
cd /home/dustin/Claude/dustin-space && npm start
```

Open `http://localhost:8080/gallery/veil-nebula/` in a browser. Click the image to open the lightbox. Click the Objects button (or wait for the 2-second flash). Verify:

1. NGC 6992 and NGC 6960 render as **cyan circles** proportional to their angular size
2. Pickering's Triangle renders as the existing **point dot** with label
3. The Objects button toggles all three annotations (circles fully disappear, not just labels)
4. Zooming in/out scales the circles smoothly (OSD handles this via the viewport Rect)
5. Labels appear centered above circles, offset right for point dots

- [ ] **Step 3: Commit**

```bash
git add src/_data/images.json
git commit -m "test: add circle annotations to Veil Nebula for visual testing

NGC 6992 (60') and NGC 6960 (70') render as sized circles.
Pickering's Triangle remains a point dot (no catalog size data).
These are test values for frontend verification — will be replaced
by actual pipeline output during re-processing."
```

---

## Task 9: Add `-sip` Flag to ASTAP Invocation

**Files:**
- Modify: `ingest/lib/pipeline.js` (~line 214)

- [ ] **Step 1: Add `-sip` to the ASTAP args array**

In `ingest/lib/pipeline.js`, find the ASTAP invocation (~line 214):

```js
					const { stderr } = await run(
						getConfig().astap_bin,
						['-f', jpgCopy, '-fov', String(fovHint), '-z', '2', '-r', '30',
							'-d', getConfig().astap_db_dir],
						{ cwd: tmpDir, timeout: 60000 }
					);
```

Add `-sip` to the args array:

```js
					const { stderr } = await run(
						getConfig().astap_bin,
						['-f', jpgCopy, '-fov', String(fovHint), '-z', '2', '-r', '30',
							'-d', getConfig().astap_db_dir, '-sip'],
						{ cwd: tmpDir, timeout: 60000 }
					);
```

- [ ] **Step 2: Commit**

```bash
git add ingest/lib/pipeline.js
git commit -m "feat: add -sip flag to ASTAP for better wide-field accuracy

SIP (Simple Imaging Polynomial) distortion correction improves
annotation positions near image edges on wide-field images."
```

---

## Verification Checklist

After all tasks are complete:

- [ ] `cd ingest && node -e "require('./lib/catalog'); require('./lib/simbad'); require('./lib/platesolve'); require('./lib/pipeline')"` — all modules load without errors
- [ ] `cd ingest && node server.js` — ingest server starts on port 3333
- [ ] `npm run build` — Eleventy builds cleanly
- [ ] `npm start` — dev server starts, Veil Nebula page shows circle overlays
- [ ] Objects button toggles circles on/off (circles fully disappear, no border remnants)
- [ ] Zoom in/out: circles scale correctly with the image
- [ ] Point dots (Pickering's Triangle) still render as before

---

## Notes for Re-Processing Existing Images

After the pipeline is working, the 8 images with existing WCS data can be re-processed to generate circle annotations. This is a manual step per image via the ingest tool, not part of this implementation plan. The 3 images with `sky: null` need plate solving first (require source files).
