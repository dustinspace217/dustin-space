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
 * simbadSearch — query Simbad TAP for non-stellar objects within a cone.
 *
 * Sends an ADQL query to Simbad's synchronous TAP endpoint. The query:
 *   1. Selects the top 80 objects within the given radius
 *   2. Filters out stars and star-like objects (otype_txt starting with '*')
 *   3. Orders by angular distance from the center
 *
 * @param {number} raDeg      — center right ascension in decimal degrees (0–360)
 * @param {number} decDeg     — center declination in decimal degrees (-90 to +90)
 * @param {number} radiusDeg  — search radius in decimal degrees (typically half
 *                               the diagonal of the image's field of view)
 * @returns {Promise<Array<{name: string, ra_deg: number, dec_deg: number, type: string}>>}
 *   Array of objects found. Each has:
 *     name    — Simbad main identifier (e.g. "M 42", "NGC 2024")
 *     ra_deg  — object RA in decimal degrees
 *     dec_deg — object Dec in decimal degrees
 *     type    — Simbad object type string (e.g. "HII", "GlC", "SNR")
 * @throws {Error} if the HTTP request fails or Simbad returns a non-200 status
 */
async function simbadSearch(raDeg, decDeg, radiusDeg) {
	// ADQL query: select non-stellar objects within the FOV radius.
	// otype_txt strings that indicate stars start with '*'.
	// The explicit NOT IN list catches common stellar subtypes that slip
	// through the NOT LIKE '%Star%' filter.
	const adql = [
		`SELECT TOP 80 main_id, ra, dec, otype_txt`,
		`FROM basic`,
		`WHERE CONTAINS(POINT('ICRS',ra,dec), CIRCLE('ICRS',${raDeg},${decDeg},${radiusDeg}))=1`,
		`AND otype_txt NOT LIKE '%Star%'`,
		`AND otype_txt NOT IN ('*','**','V*','EB*','SB*','RB*','PM*','HB*','WR*','Be*')`,
		`ORDER BY DISTANCE(POINT('ICRS',ra,dec),POINT('ICRS',${raDeg},${decDeg}))`,
	].join(' ');

	// Build the TAP request URL. Simbad's synchronous endpoint returns
	// results immediately (vs. async TAP which returns a job URL to poll).
	const url = new URL('https://simbad.u-strasbg.fr/simbad/sim-tap/sync');
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
	// Column order matches our SELECT: main_id, ra, dec, otype_txt.
	const body = await resp.json();
	return (body.data || []).map(row => ({
		name:    String(row[0]).trim(),
		ra_deg:  Number(row[1]),
		dec_deg: Number(row[2]),
		type:    String(row[3]).trim(),
	}));
}

module.exports = { simbadSearch };
