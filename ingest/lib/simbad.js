/**
 * simbad.js — Simbad TAP service queries for the ingest pipeline
 *
 * Queries the Simbad astronomical database (CDS, Strasbourg) for non-stellar
 * objects within a given field of view. Used by the pipeline after plate-solving
 * to find annotation candidates (nebulae, galaxies, clusters, etc.) that can
 * be shown as a toggleable overlay in the OpenSeadragon viewer.
 *
 * Uses the TAP (Table Access Protocol) endpoint with ADQL (Astronomical Data
 * Query Language) — a SQL-like language standardized by the IVOA (International
 * Virtual Observatory Alliance).
 *
 * Exports:
 *   simbadSearch(raDeg, decDeg, radiusDeg) — cone search for non-stellar objects
 */

'use strict';

/**
 * STELLAR_OTYPES — Simbad short-code object types for stellar objects.
 *
 * Used to exclude stars and star-like objects from the cone search.
 * These are the common stellar otype codes from the Simbad classification
 * hierarchy. The list covers the most frequent types; rare subtypes that
 * slip through are filtered downstream by buildAnnotations (allowlist + size).
 */
const STELLAR_OTYPES = [
	'*', '**', 'V*', 'EB*', 'SB*', 'RB*', 'PM*', 'HB*', 'WR*', 'Be*',
	'WD*', 'WD?', 'LP*', 'RS*', 'BY*', 'Em*', 'S*?', 'cC*', 'bL*',
	'RR*', 'RR?', 'Ce*', 'cv*', 'Mi*', 'AB*', 'AB?', 'TT*', 'Pe*',
	'Pu*', 'No*', 'HS*', 'HS?', 'C*', 'OH*', 'LM*', 'BD*', 'BD?',
	'dS*', 'gD*', 'El*', 'RG*', 'Y*?', 'LM?',
];

/**
 * NOISE_OTYPES — Non-stellar types that produce no visible annotation.
 *
 * Radio, UV, X-ray, gamma-ray, and far-IR point sources have no
 * visual counterpart in optical astrophotography images. Excluding
 * them prevents crowded galactic fields (like the Cygnus Loop) from
 * filling the TOP limit with invisible background detections.
 */
const NOISE_OTYPES = [
	'Rad', 'UV', 'FIR', 'IR', 'X', 'gam', 'gB', 'rB', 'mul', '?',
];

/**
 * simbadSearch — query Simbad TAP for non-stellar objects within a cone.
 *
 * Sends an ADQL query to Simbad's synchronous TAP endpoint. The query:
 *   1. Selects the top 500 objects within the given radius
 *   2. Filters out stars and non-visual noise sources (radio, UV, X-ray, etc.)
 *
 * The column `otype` (short code) is used instead of the deprecated `otype_txt`
 * which no longer supports NOT LIKE in the CDS TAP parser (as of ~2026).
 * Similarly, DISTANCE is now a reserved ADQL word, so results are unordered.
 *
 * @param {number} raDeg      — center right ascension in decimal degrees (0–360)
 * @param {number} decDeg     — center declination in decimal degrees (-90 to +90)
 * @param {number} radiusDeg  — search radius in decimal degrees (typically half
 *                               the diagonal of the image's field of view)
 * @returns {Promise<Array<{name: string, ra_deg: number, dec_deg: number, type: string, major_axis_arcmin: number|null, minor_axis_arcmin: number|null, position_angle: number|null}>>}
 *   Array of objects found. Each has:
 *     name    — Simbad main identifier (e.g. "M 42", "NGC 2024")
 *     ra_deg  — object RA in decimal degrees
 *     dec_deg — object Dec in decimal degrees
 *     type    — Simbad object type short code (e.g. "HII", "GlC", "SNR")
 * @throws {Error} if the HTTP request fails or Simbad returns a non-200 status
 */
async function simbadSearch(raDeg, decDeg, radiusDeg) {
	// Guard against non-finite parameters — these would produce broken ADQL
	// and could cause unexpected Simbad behavior.
	if (!Number.isFinite(raDeg) || !Number.isFinite(decDeg) || !Number.isFinite(radiusDeg)) {
		throw new Error(`simbadSearch: non-finite parameter (ra=${raDeg}, dec=${decDeg}, radius=${radiusDeg})`);
	}

	// Build the NOT IN exclusion list: all stellar types + non-visual noise types.
	// Quoted for ADQL: ('*','**','V*', ..., 'Rad','UV','X', ...)
	const allExcluded = [...STELLAR_OTYPES, ...NOISE_OTYPES];
	const notInList = allExcluded.map(t => `'${t}'`).join(',');

	// ADQL query using `otype` (short code column, not the deprecated `otype_txt`).
	// TOP 500 handles crowded galactic fields where nebulae/clusters get pushed
	// past TOP 200 by hundreds of faint background detections.
	// DISTANCE is reserved in the CDS ADQL parser, so we omit ORDER BY.
	const adql = [
		`SELECT TOP 500 main_id, ra, dec, otype, galdim_majaxis, galdim_minaxis, galdim_angle`,
		`FROM basic`,
		`WHERE CONTAINS(POINT('ICRS',ra,dec), CIRCLE('ICRS',${raDeg},${decDeg},${radiusDeg}))=1`,
		`AND otype NOT IN (${notInList})`,
	].join(' ');

	// Build the TAP request URL. Simbad's synchronous endpoint returns
	// results immediately (vs. async TAP which returns a job URL to poll).
	const url = new URL('https://simbad.cds.unistra.fr/simbad/sim-tap/sync');
	url.searchParams.set('REQUEST', 'doQuery');
	url.searchParams.set('LANG',    'ADQL');
	url.searchParams.set('FORMAT',  'json');
	url.searchParams.set('QUERY',   adql);

	// AbortSignal.timeout(60000): cancel the request after 60 seconds.
	// Simbad can be slow during peak hours; 60s is generous but prevents hangs.
	const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(60000) });
	if (!resp.ok) throw new Error(`Simbad HTTP ${resp.status}`);

	// Simbad TAP JSON format:
	//   { metadata: [{name, datatype}, ...], data: [[val,...], ...] }
	// Column order matches our SELECT: main_id, ra, dec, otype,
	// galdim_majaxis, galdim_minaxis, galdim_angle.
	const body = await resp.json();
	return (body.data || []).map(row => {
		const ra  = Number(row[1]);
		const dec = Number(row[2]);
		// Skip rows with non-finite coordinates (corrupt Simbad data).
		if (!Number.isFinite(ra) || !Number.isFinite(dec)) return null;

		// galdim_majaxis is galaxy-only — returns null for nebulae, clusters, etc.
		// The pipeline supplements this with local CSV data from PixInsight's catalogs.
		// Guard: Number(null) = 0, which would falsely indicate "has size data".
		// Check row[n] != null first so missing Simbad fields stay null.
		const maj = row[4] != null ? Number(row[4]) : NaN;
		const min = row[5] != null ? Number(row[5]) : NaN;
		const pa  = row[6] != null ? Number(row[6]) : NaN;

		return {
			name:                String(row[0]).trim(),
			ra_deg:              ra,
			dec_deg:             dec,
			type:                String(row[3] || '').trim(),
			major_axis_arcmin:   Number.isFinite(maj) && maj > 0 ? maj : null,
			minor_axis_arcmin:   Number.isFinite(min) && min > 0 ? min : null,
			position_angle:      Number.isFinite(pa)  ? pa  : null,
		};
	}).filter(Boolean);
}

module.exports = { simbadSearch };
