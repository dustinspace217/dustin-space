/**
 * astapCatalog.js — read ASTAP's bundled deep-sky catalog for annotations.
 *
 * `/opt/astap/deep_sky.csv` is a ~30,000-row text catalog bundled with
 * ASTAP, derived from SAC81 + Wolfgang Steinicke's revised NGC/IC +
 * HyperLeda galaxies + Sharpless 2 + VdB + HCG + LDN + Barnard dark
 * nebulae + IAU-named stars. It's the catalog PixInsight / ASTAP
 * annotate against, and it's the source of *common names* (Pickering's
 * Triangle, Witch Head Nebula, Lagoon Nebula) that Simbad's `basic`
 * table keeps only as `NAME`-prefixed aliases we filter out.
 *
 * Why we parse it ourselves instead of invoking ASTAP: our heavily
 * processed images (SHO + BlurX + NoiseX) don't solve reliably in ASTAP
 * — the star centroids are washed out. But the catalog is just a flat
 * file; with our own astrometry.net-derived WCS we can project any row
 * to pixel coords ourselves.
 *
 * Format (from the catalog's own header line, 2026-01-03 version):
 *   col 0: RA in 0.1 seconds of time,   range 0..864000 → RA_deg = col0 / 2400
 *   col 1: Dec in 0.1 arcseconds,       range -324000..324000 → Dec_deg = col1 / 3600
 *   col 2: name(s), slash-separated aliases (underscores replace spaces)
 *   col 3: length (major axis) in 0.1 arcmin → maj_arcmin = col3 / 10
 *   col 4: width  (minor axis) in 0.1 arcmin → min_arcmin = col4 / 10
 *   col 5: orientation in degrees (position angle, may be missing)
 *
 * The last three columns are sometimes absent for unsized objects.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// Default ASTAP data dir on Linux installs; override with ASTAP_DATA_DIR.
const DEFAULT_ASTAP_DIR = '/opt/astap';
const CATALOG_PATH = path.join(process.env.ASTAP_DATA_DIR || DEFAULT_ASTAP_DIR, 'deep_sky.csv');

/**
 * NAME_RENAMES — hand-curated cosmetic name fixups applied after the
 * underscore-to-space conversion. ASTAP's CSV strips apostrophes (and a
 * few other punctuation marks) because the format can't quote fields.
 * This map adds them back for specifically-known possessive proper
 * nouns. Surveyed the catalog for `^[A-Z][a-z]+s [A-Z][a-z]+` patterns;
 * "Pickerings Triangle" is the only real possessive missing its apostrophe.
 * Others matching that shape (Asellus Australis, Kaus Borealis, Polaris
 * Australis) are Latin binomials, not possessives.
 *
 * Matching is exact (case-sensitive) against the post-underscore-conversion
 * display name. Extend as more missing apostrophes show up in future
 * gallery entries.
 */
const NAME_RENAMES = {
	'Pickerings Triangle': "Pickering's Triangle",
};

// Module-scoped cache. Populated once on first call to loadAstapCatalog()
// and reused across all subsequent searches. ~30k rows = ~8MB in memory,
// trivial for a short-lived Node script.
let _catalog = null;

/**
 * parseRow — parse one CSV line of the ASTAP catalog into a normalized
 * object. Returns null for malformed / header rows so the loader can
 * skip them without aborting.
 *
 * Cleanup rules:
 *   - Aliases are slash-separated in column 3; we keep them as an array.
 *   - ASTAP uses underscores as space substitutes inside name tokens so
 *     the CSV stays single-word-per-field. We convert underscores → spaces
 *     in the human-facing name but keep the token-matching version too.
 *   - Size columns default to null when absent; downstream buildAnnotations
 *     treats null as "unsized" and renders a point instead of a circle.
 *
 * @param {string} line — one CSV line, comma-separated
 * @returns {{name:string, aliases:string[], ra_deg:number, dec_deg:number,
 *   major_axis_arcmin:number|null, minor_axis_arcmin:number|null,
 *   position_angle:number|null}|null}
 */
function parseRow(line) {
	const cols = line.split(',');
	if (cols.length < 3) return null;
	const ra10s   = Number(cols[0]);
	const dec10as = Number(cols[1]);
	if (!Number.isFinite(ra10s) || !Number.isFinite(dec10as)) return null;

	const raDeg  = ra10s  / 2400;      // 0.1 s of time → degrees
	const decDeg = dec10as / 3600;     // 0.1 arcsec   → degrees
	// Sanity: the catalog contains pole sentinels (NP_2000, SP_2000) at
	// Dec ±90°. Drop them — they're calibration helpers, not viewable DSOs.
	if (Math.abs(decDeg) >= 89.99) return null;

	// Column 2 is a slash-separated list of aliases. Split + clean.
	const rawNames = String(cols[2] || '').split('/').map(s => s.trim()).filter(Boolean);
	if (!rawNames.length) return null;
	// Two cleanups applied in order:
	//   1. Underscore → space (ASTAP's space-substitute for CSV safety)
	//   2. Apply NAME_RENAMES for known-missing apostrophes etc.
	// The rename map is tiny; .hasOwnProperty check keeps iteration O(1).
	const aliases = rawNames.map(n => {
		const spaced = n.replace(/_/g, ' ');
		return Object.prototype.hasOwnProperty.call(NAME_RENAMES, spaced) ? NAME_RENAMES[spaced] : spaced;
	});

	// Size / PA columns are optional — some rows stop at 3 fields.
	const maj = cols.length > 3 && cols[3] !== '' ? Number(cols[3]) / 10 : null;
	const min = cols.length > 4 && cols[4] !== '' ? Number(cols[4]) / 10 : null;
	const pa  = cols.length > 5 && cols[5] !== '' ? Number(cols[5]) : null;

	return {
		name:                aliases[0],       // primary display name
		aliases,                               // all known names
		ra_deg:              raDeg,
		dec_deg:             decDeg,
		major_axis_arcmin:   Number.isFinite(maj) && maj > 0 ? maj : null,
		minor_axis_arcmin:   Number.isFinite(min) && min > 0 ? min : null,
		position_angle:      Number.isFinite(pa)  ? pa  : null,
	};
}

/**
 * loadAstapCatalog — read the catalog into memory (idempotent).
 *
 * Cheap to call repeatedly; returns the cached array on subsequent calls.
 * Returns an empty array (not an error) if the catalog file is missing,
 * so downstream code can gracefully degrade to Simbad-only annotations
 * on systems without ASTAP installed.
 *
 * @returns {Array<object>} parsed catalog rows
 */
// Tracks WHY _catalog ended up empty so callers can distinguish "no
// ASTAP installed" from "catalog parsed to zero usable rows" from
// "catalog has thousands of rows and they're all in cache." Issue #85.
let _catalogStatus = 'unloaded'; // 'unloaded' | 'ok' | 'missing' | 'empty'

function loadAstapCatalog() {
	if (_catalog !== null) return _catalog;
	if (!fs.existsSync(CATALOG_PATH)) {
		console.warn(`ASTAP catalog not found at ${CATALOG_PATH} — skipping`);
		_catalog = [];
		_catalogStatus = 'missing';
		return _catalog;
	}

	const text = fs.readFileSync(CATALOG_PATH, 'utf8');
	// Strip UTF-8 BOM if present (the file ships with one).
	const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
	const lines = clean.split(/\r?\n/);

	const rows = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;
		// Skip the two header lines (only once each — they're always first).
		if (i < 2) continue;
		const row = parseRow(line);
		if (row) rows.push(row);
	}
	_catalog = rows;
	if (rows.length === 0) {
		// File existed but every row was malformed / sentinel — strong
		// signal of catalog format drift after an ASTAP update. Loud warn.
		console.warn(`ASTAP catalog at ${CATALOG_PATH} parsed to zero rows — possible format change?`);
		_catalogStatus = 'empty';
	} else {
		_catalogStatus = 'ok';
	}
	return _catalog;
}

/**
 * astapCatalogStatus — observability hook for callers that need to
 * distinguish "no ASTAP installed" from "no objects in this cone."
 * Returns 'unloaded' before the first loadAstapCatalog() call.
 * Issue #85.
 *
 * @returns {'unloaded' | 'ok' | 'missing' | 'empty'}
 */
function astapCatalogStatus() {
	return _catalogStatus;
}

/**
 * astapSearch — cone search against the ASTAP catalog.
 *
 * Uses the small-angle approximation (flat-sphere at cone center): a row
 * is in the cone if √((ΔRA·cosDec)² + ΔDec²) < radius. Accurate to well
 * under 1 arcsec for FOVs under 10°, which covers every image in this
 * gallery. Faster than the full haversine for a linear scan of 30k rows.
 *
 * @param {number} raDeg     — cone center RA in decimal degrees
 * @param {number} decDeg    — cone center Dec in decimal degrees
 * @param {number} radiusDeg — cone radius in decimal degrees
 * @returns {Array<object>} matching catalog rows (same shape as Simbad)
 */
function astapSearch(raDeg, decDeg, radiusDeg) {
	const catalog = loadAstapCatalog();
	if (!catalog.length) return [];

	const cosDec = Math.cos(decDeg * Math.PI / 180);
	const rSq = radiusDeg * radiusDeg;
	const hits = [];
	for (const row of catalog) {
		// Wrap-aware RA delta (handles the 0h/24h boundary).
		let dRA = row.ra_deg - raDeg;
		if (dRA > 180) dRA -= 360;
		else if (dRA < -180) dRA += 360;
		const dRAcos = dRA * cosDec;
		const dDec   = row.dec_deg - decDeg;
		if (dRAcos * dRAcos + dDec * dDec > rSq) continue;
		hits.push(row);
	}
	return hits;
}

module.exports = {
	loadAstapCatalog,
	astapSearch,
	astapCatalogStatus,
	// Exported for unit tests (issue #87) — pure parsing function.
	parseRow,
};
