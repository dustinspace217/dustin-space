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
 *
 * Also filtered: molecular clouds (MoC), star-forming regions (SFR),
 * and generic Cloud (Cld). These types are almost always either:
 *   (a) duplicates of the same HII region under a survey-catalog name
 *       that no human recognizes ([ABB2014] WISE Gxxx.xxx-yy.yyy),
 *   (b) enormous 1°+ regions like "NAME Ori A" (420') that dominate
 *       the size-DESC TOP-N ranking and displace the named nebulae
 *       and galaxies the viewer actually cares about.
 *
 * NOT filtered: 'sh' (source-of-hydrogen / HII region). It looked
 * noise-ish at first glance but Simbad actually tags well-known named
 * supernova-remnant and HII features with it — NGC 6992 and NGC 6995
 * (Eastern / Western Veil) both come back as otype 'sh'. The named-
 * catalog allowlist in simbadSearch already blocks unnamed survey
 * entries; excluding 'sh' there was redundant and cost Veil its
 * headline annotations.
 *
 * DNe (dark nebula) is retained because Barnard-catalog objects use
 * that type and DO render meaningfully (Horsehead is Barnard 33 DNe).
 */
const NOISE_OTYPES = [
	'Rad', 'UV', 'FIR', 'IR', 'X', 'gam', 'gB', 'rB', 'mul',
	'MoC', 'SFR', 'Cld',
	// '?' (ambiguous classification) was previously here. Removed because
	// Simbad uses '?' for many legitimate but unclassified named NGC entries
	// — e.g. NGC 6974 (a knot in the Veil) is otype '?'. The named-catalog
	// allowlist downstream already filters non-recognizable entries; '?'
	// was filtering more good than bad.
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
	//
	// SIZE FILTER + ORDER BY are essential when imaging extragalactic targets.
	// Simbad has thousands of catalog entries within nearby galaxies (M51's
	// [HL2008] HII regions, PAWS molecular clouds, etc.) — without a size
	// floor, those flood the TOP 500 and displace the host galaxy itself
	// out of the result set.
	//
	// Constraints:
	//   - galdim_majaxis IS NOT NULL: only objects with measured angular size
	//   - galdim_majaxis > 0.2 (arcmin): filter sub-resolution noise. Anything
	//     under 0.2' renders smaller than 1px even at narrow-field FOVs and
	//     gets filtered by buildAnnotations() downstream anyway.
	//   - ORDER BY galdim_majaxis DESC: largest physical objects first, so
	//     named galaxies/nebulae always win the TOP-N race over crowded
	//     intra-galactic catalog entries.
	//
	// CDS ADQL is minimal: DISTANCE is reserved, NULLS LAST/FIRST is rejected,
	// CASE and COALESCE are rejected. Plain ORDER BY on a non-NULL filtered
	// column reference is the only working approach.
	//
	// TRADEOFF: this loses unsized allowlist-matched objects (e.g. some
	// nebular features Simbad lists without galdim_majaxis like Pickering's
	// Triangle). For a portfolio of named DSO targets that's acceptable;
	// add a second query for unsized objects if/when needed.
	// NAMED-CATALOG FILTER — restrict to catalogs a human viewer would actually
	// recognize. Without this, famous fields return hundreds of survey-derived
	// designations ([ABB2014] WISE Gxxx.xxx, TGU Hxxxx, [INS2019] xx, PLCKECC
	// Gxxx.xx) that dominate the size-DESC TOP-N and leave no room for the
	// named objects visitors care about. The % wildcard in ADQL LIKE patterns
	// tolerates the inconsistent whitespace Simbad uses between catalog prefix
	// and number ("M  42" vs "M 42" vs "SH  2-279" vs "SH 2-279"). Extending
	// this list is cheap — add more LIKE clauses as needed.
	//
	// Catalogs kept:
	//   M / Messier   — the 110 most famous DSOs
	//   NGC / IC      — New General Catalogue + Index Catalogue (~13500 objects)
	//   Sh2- / SH 2-  — Sharpless catalogue of HII regions (313 objects)
	//   LDN / LBN     — Lynds Dark / Bright Nebulae
	//   Barnard / B   — Barnard dark nebulae (Barnard 33 = Horsehead)
	//   C / Caldwell  — Patrick Moore's Caldwell catalogue (109 objects)
	//   Abell         — Abell clusters of galaxies + planetary nebulae
	//   Mel / Melotte — open-cluster catalogue (M45 = Melotte 22)
	//   Collinder     — open-cluster catalogue
	//   UGC / PGC     — galaxy catalogues for companion galaxies
	// Explicit named-catalog allowlist. No 'NAME%' — Simbad uses that prefix
	// for every colloquial/informal designation, which mostly surfaces noise
	// ("NAME OMC-2 FIR 3N", "NAME Super Water Maser") and only occasionally
	// surfaces genuinely iconic features ("NAME Ori Trapezium"). Trade-off
	// favors clean overlays; any missing iconic name can be added by hand
	// to images.json per-variant annotations after the fact.
	const nameLikes = [
		`main_id LIKE 'M %'`,       // Messier
		`main_id LIKE 'NGC %'`,     // New General Catalogue
		`main_id LIKE 'IC %'`,      // Index Catalogue
		`main_id LIKE 'Sh %'`,      // Sharpless variants
		`main_id LIKE 'SH%'`,
		`main_id LIKE 'LDN %'`,     // Lynds Dark Nebula
		`main_id LIKE 'LBN %'`,     // Lynds Bright Nebula
		`main_id LIKE 'Barnard%'`,  // Barnard dark nebula
		`main_id LIKE 'B %'`,
		`main_id LIKE 'Caldwell%'`, // Caldwell catalog (Patrick Moore)
		`main_id LIKE 'C %'`,
		`main_id LIKE 'Abell%'`,    // Abell clusters / PN
		`main_id LIKE 'ACO %'`,
		`main_id LIKE 'Mel %'`,     // Melotte open clusters (M45 = Mel 22)
		`main_id LIKE 'Melotte%'`,
		`main_id LIKE 'Collinder%'`, // Collinder open clusters
		`main_id LIKE 'UGC %'`,     // Uppsala Galaxy Catalogue
		`main_id LIKE 'PGC %'`,     // Principal Galaxies Catalogue
	].join(' OR ');

	// TOP 1000 keeps plenty of headroom. No galdim_majaxis size filter here —
	// Simbad has NULL size for plenty of well-known objects (M 43, NGC 1977,
	// NGC 1975 all come back with galdim_majaxis=null despite being major
	// visual targets). The local catalog enrichment in the ingest pipeline
	// fills sizes in for those, and buildAnnotations applies the < 0.02
	// FOV-radius cutoff downstream to drop anything too small to render.
	// IMPORTANT — SQL NULL semantics: `NULL NOT IN (...)` evaluates to NULL,
	// not TRUE, so a bare `otype NOT IN (...)` predicate silently drops every
	// row with otype=null. That filtered out e.g. NGC 6995 (Western Veil) and
	// other legitimate named catalog entries that Simbad hasn't classified.
	// Wrapping with `OR otype IS NULL` keeps unclassified-but-named rows;
	// the named-catalog allowlist downstream still gates them.
	const adql = [
		`SELECT TOP 1000 main_id, ra, dec, otype, galdim_majaxis, galdim_minaxis, galdim_angle`,
		`FROM basic`,
		`WHERE CONTAINS(POINT('ICRS',ra,dec), CIRCLE('ICRS',${raDeg},${decDeg},${radiusDeg}))=1`,
		`AND (otype NOT IN (${notInList}) OR otype IS NULL)`,
		`AND (${nameLikes})`,
		`ORDER BY galdim_majaxis DESC`,
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

/**
 * simbadSearchStars — cone search for NAMED bright stars within the FOV.
 *
 * Companion to simbadSearch (which excludes stars). Returns Bayer-designated
 * stars brighter than maxVmag so iconic anchors like 52 Cygni (Veil), Alnitak
 * (Horsehead/Flame), and Deneb/Sadr (Cygnus wide field) appear alongside the
 * deep-sky annotations.
 *
 * Why a separate query instead of loosening simbadSearch's STELLAR_OTYPES
 * filter: flooding a DSO-dense field (e.g. Orion, Cygnus) with every detected
 * star point would crowd the overlay and bury the galaxies/nebulae. Restricting
 * to Bayer-designated + magnitude-floored hits keeps the star set small and
 * visually meaningful.
 *
 * ADQL: joins `basic` (main_id, ra, dec, otype) with `flux` (V-band apparent
 * magnitude). Simbad's `flux` table stores one row per filter per object —
 * `filter = 'V'` selects the Johnson V band. 'Flux' here is a misnomer; the
 * value is apparent magnitude in the conventional astronomical sense (lower
 * number = brighter).
 *
 * Name filter: `main_id LIKE '* %'` matches Bayer designations ("* zet Ori",
 * "* 52 Cyg", "* alf Lyr"). `** %` adds double stars (rarely used as main_id
 * but harmless to include).
 *
 * @param {number} raDeg      — center RA in decimal degrees
 * @param {number} decDeg     — center Dec in decimal degrees
 * @param {number} radiusDeg  — search radius in decimal degrees
 * @param {number} [maxVmag]  — brightness cutoff, V-band magnitude (default 4.5)
 * @returns {Promise<Array<{name:string, ra_deg:number, dec_deg:number, type:string, major_axis_arcmin:null, minor_axis_arcmin:null, position_angle:null, vmag:number}>>}
 */
async function simbadSearchStars(raDeg, decDeg, radiusDeg, maxVmag) {
	if (!Number.isFinite(raDeg) || !Number.isFinite(decDeg) || !Number.isFinite(radiusDeg)) {
		throw new Error(`simbadSearchStars: non-finite parameter (ra=${raDeg}, dec=${decDeg}, radius=${radiusDeg})`);
	}
	const magCutoff = Number.isFinite(maxVmag) ? maxVmag : 4.5;

	// TOP 200 covers wide fields with multiple V-band rows per star — Simbad
	// stores one flux row per filter per measurement campaign, so a single
	// star like Vega returns 5+ rows here. We dedupe by main_id below
	// (keeping the brightest = lowest-mag row per star).
	//
	// CDS ADQL quirk: ORDER BY does NOT accept table-qualified column
	// references like `f.flux`. Using the `AS vmag` alias in ORDER BY
	// avoids the parser bailing out with "Encountered '.'". (Verified
	// 2026-04-20 with bisection probe.)
	const adql = [
		`SELECT TOP 200 b.main_id, b.ra, b.dec, b.otype, f.flux AS vmag`,
		`FROM basic AS b JOIN flux AS f ON f.oidref = b.oid`,
		`WHERE CONTAINS(POINT('ICRS', b.ra, b.dec), CIRCLE('ICRS', ${raDeg}, ${decDeg}, ${radiusDeg})) = 1`,
		`AND f.filter = 'V'`,
		`AND f.flux < ${magCutoff}`,
		`AND (b.main_id LIKE '* %' OR b.main_id LIKE '** %')`,
		`ORDER BY vmag ASC`,
	].join(' ');

	const url = new URL('https://simbad.cds.unistra.fr/simbad/sim-tap/sync');
	url.searchParams.set('REQUEST', 'doQuery');
	url.searchParams.set('LANG',    'ADQL');
	url.searchParams.set('FORMAT',  'json');
	url.searchParams.set('QUERY',   adql);

	const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(60000) });
	if (!resp.ok) throw new Error(`Simbad (stars) HTTP ${resp.status}`);

	const body = await resp.json();

	// Dedupe by main_id, keeping the brightest (lowest vmag) row per star.
	// Simbad's flux table holds one row per filter per measurement campaign;
	// a single star returns 5+ V-band rows from different surveys (Hipparcos,
	// Gaia, Tycho, etc.). The TOP 200 keeps us well above the per-star
	// duplicate count even for wide Cygnus-scale fields.
	const byName = new Map();
	for (const row of (body.data || [])) {
		const ra   = Number(row[1]);
		const dec  = Number(row[2]);
		const vmag = Number(row[4]);
		if (!Number.isFinite(ra) || !Number.isFinite(dec)) continue;
		const name = String(row[0]).trim();
		const existing = byName.get(name);

		// Keep the brightest entry per star. The previous compound condition
		// (`existing && Number.isFinite(existing.vmag) && Number.isFinite(vmag)
		// && existing.vmag <= vmag`) had two bugs:
		//   - if existing was finite and incoming was NaN, the test was
		//     false → NaN row REPLACED the good one;
		//   - if existing was non-finite (an earlier null-vmag row stuck via
		//     the `Number.isFinite(vmag) ? vmag : null` branch below) and
		//     incoming was finite, every later row overwrote prior ones,
		//     so the kept row was order-dependent rather than brightest.
		// The inverted form below treats finite-incoming-and-brighter as the
		// only reason to overwrite. Issue #81.
		const newBetter =
			Number.isFinite(vmag) &&
			(!existing || !Number.isFinite(existing.vmag) || vmag < existing.vmag);
		if (existing && !newBetter) continue;

		byName.set(name, {
			name:                name,
			ra_deg:              ra,
			dec_deg:             dec,
			type:                String(row[3] || '').trim(),
			major_axis_arcmin:   null,
			minor_axis_arcmin:   null,
			position_angle:      null,
			vmag:                Number.isFinite(vmag) ? vmag : null,
		});
	}
	return Array.from(byName.values());
}

module.exports = { simbadSearch, simbadSearchStars };
