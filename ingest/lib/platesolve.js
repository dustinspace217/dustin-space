/**
 * platesolve.js — ASTAP plate-solving helpers for the ingest pipeline
 *
 * Parses the .ini file that ASTAP writes after a plate-solve attempt, and
 * converts sky coordinates (RA/Dec) to fractional pixel positions using the
 * WCS (World Coordinate System) solution.
 *
 * ASTAP (Astrometric STAcking Program) runs locally via execFile (no shell).
 * It writes results to a .ini file alongside the input image:
 *   myimage.jpg → myimage.ini
 *
 * The WCS solution uses the CD matrix (or CDELT fallback) to map between
 * sky coordinates and pixel coordinates. This is the standard FITS WCS
 * representation defined by Calabretta & Greisen (2002).
 *
 * Exports:
 *   parseAstapIni(iniPath)                      — parse ASTAP solution file
 *   skyToPixelFrac(raDeg, decDeg, wcs, w, h)    — sky coords → pixel fractions
 */

'use strict';

const fs = require('fs');

/**
 * parseAstapIni — parse an ASTAP .ini plate-solve result file.
 *
 * ASTAP writes key=value pairs, one per line. The critical key is PLTSOLVD:
 *   PLTSOLVD=T means the solve succeeded.
 *   PLTSOLVD=F (or absent) means it failed.
 *
 * @param {string} iniPath — absolute path to the .ini file
 *   (e.g. /tmp/ingest-<jobId>/slug.ini, created by ASTAP next to the input JPG)
 * @returns {object|null} WCS solution object on success, null if unsolved.
 *   Returned object shape:
 *     ra_deg         — center RA in decimal degrees (CRVAL1)
 *     dec_deg        — center Dec in decimal degrees (CRVAL2)
 *     crpix1, crpix2 — reference pixel (1-based FITS convention)
 *     cd11, cd12, cd21, cd22 — CD matrix elements (degrees/pixel)
 *     pixScaleDeg    — pixel scale in degrees/pixel
 *     pixScaleArcsec — pixel scale in arcseconds/pixel
 *     crota2         — rotation angle in degrees
 */
function parseAstapIni(iniPath) {
	if (!fs.existsSync(iniPath)) return null;

	// Parse key=value lines into a flat object.
	const kv = {};
	for (const line of fs.readFileSync(iniPath, 'utf8').split('\n')) {
		const m = line.match(/^(\w+)\s*=\s*(.+)$/);
		if (m) kv[m[1].trim()] = m[2].trim();
	}

	// PLTSOLVD=T indicates a successful solve.
	if (kv.PLTSOLVD !== 'T') return null;

	// CD matrix: [[CD1_1, CD1_2], [CD2_1, CD2_2]]
	// Falls back to CDELT1/CDELT2 if the full CD matrix is absent (older ASTAP versions).
	// CDELT1 is typically negative (RA increases leftward in standard orientation).
	const cd11 = parseFloat(kv.CD1_1 || kv.CDELT1 || 0);
	const cd12 = parseFloat(kv.CD1_2 || 0);
	const cd21 = parseFloat(kv.CD2_1 || 0);
	const cd22 = parseFloat(kv.CD2_2 || kv.CDELT2 || 0);

	// Pixel scale in degrees/pixel — magnitude of the first CD column vector.
	// For non-rotated images cd12=cd21=0, so this reduces to |cd11|.
	const pixScaleDeg = Math.sqrt(cd11 * cd11 + cd21 * cd21);

	const ra_deg  = parseFloat(kv.CRVAL1);
	const dec_deg = parseFloat(kv.CRVAL2);
	const crpix1  = parseFloat(kv.CRPIX1);
	const crpix2  = parseFloat(kv.CRPIX2);

	// If any critical WCS field is NaN (missing or unparseable in the .ini),
	// treat the solve as failed. NaN coordinates would bypass the off-frame
	// filter in buildAnnotations and write corrupt data to images.json.
	if (!Number.isFinite(ra_deg) || !Number.isFinite(dec_deg) ||
		!Number.isFinite(crpix1) || !Number.isFinite(crpix2)) {
		return null;
	}

	return {
		ra_deg, dec_deg, crpix1, crpix2,
		cd11, cd12, cd21, cd22,
		pixScaleDeg,
		pixScaleArcsec: pixScaleDeg * 3600,
		crota2:       parseFloat(kv.CROTA2 || 0),
	};
}

/**
 * skyToPixelFrac — convert sky RA/Dec to fractional pixel position in the image.
 *
 * Given a WCS solution from ASTAP and the image pixel dimensions, returns
 * { x, y } as fractions [0..1] from the top-left corner. Values outside
 * 0..1 indicate the sky position falls outside the image frame.
 *
 * Uses the inverse of the CD matrix to go from sky offsets → pixel offsets.
 * The RA offset is corrected for cos(Dec) foreshortening — RA degrees shrink
 * toward the poles because lines of constant RA converge.
 *
 * @param {number} raDeg  — target right ascension in decimal degrees
 * @param {number} decDeg — target declination in decimal degrees
 * @param {object} wcs    — WCS solution object from parseAstapIni()
 * @param {number} imgW   — image width in pixels
 * @param {number} imgH   — image height in pixels
 * @returns {{ x: number, y: number }} fractional position (0..1 = in frame)
 */
function skyToPixelFrac(raDeg, decDeg, wcs, imgW, imgH) {
	const { ra_deg, dec_deg, crpix1, crpix2, cd11, cd12, cd21, cd22 } = wcs;

	// RA offset in degrees, corrected for cos(Dec) foreshortening.
	// At the equator cos(0°)=1, so 1° RA = 1° on sky.
	// At dec=60°, cos(60°)=0.5, so 1° RA = 0.5° on sky.
	// The modular arithmetic handles the 0/360 wraparound — an object at
	// RA=1° with a center at RA=359° is 2° away, not 358°.
	let rawDRA = raDeg - ra_deg;
	if (rawDRA > 180) rawDRA -= 360;
	if (rawDRA < -180) rawDRA += 360;
	const dRA  = rawDRA * Math.cos(dec_deg * Math.PI / 180);
	const dDec = decDeg - dec_deg;

	// Inverse of the 2×2 CD matrix: [cd11 cd12; cd21 cd22]
	// det = cd11*cd22 - cd12*cd21
	// Guard against degenerate matrices (e.g. unsolved fields that yielded CD=0).
	const det  = cd11 * cd22 - cd12 * cd21;
	if (Math.abs(det) < 1e-20) return { x: -1, y: -1 };

	// Pixel offset from the reference pixel (CRPIX).
	const dx   = ( cd22 * dRA - cd12 * dDec) / det;
	const dy   = (-cd21 * dRA + cd11 * dDec) / det;

	// FITS pixels are 1-indexed; crpix1/crpix2 are 1-based center pixels.
	// Subtract 1 to convert to 0-based before dividing by image size.
	const xPx  = crpix1 - 1 + dx;
	const yPx  = crpix2 - 1 + dy;

	return {
		x: xPx / imgW,
		y: yPx / imgH,
	};
}

/**
 * CATALOG_ALLOWLIST — name prefixes for objects that render as point dots
 * when they have no angular size data.
 *
 * Objects with radius: null from Simbad are only kept if their name starts
 * with one of these prefixes. This prevents hundreds of faint PGC/UGC entries
 * from cluttering the image with tiny unlabeled dots.
 */
const CATALOG_ALLOWLIST = [
	'NGC', 'IC', 'M ', 'SH2-', 'SH 2-', 'LDN', 'LBN',
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
		// major_axis_arcmin is the angular DIAMETER in arcminutes; fovWDeg is in degrees.
		// radius_fraction = (diameter_arcmin / 60 / 2) / fov_degrees
		// The /2 converts diameter to radius.
		let radius = null;
		if (obj.major_axis_arcmin != null && Number.isFinite(obj.major_axis_arcmin) && obj.major_axis_arcmin > 0) {
			radius = (obj.major_axis_arcmin / 60 / 2) / fovWDeg;

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
			major_axis_arcmin:  obj.major_axis_arcmin ?? null,
			minor_axis_arcmin:  obj.minor_axis_arcmin ?? null,
			position_angle:     obj.position_angle ?? null,
			source:             'simbad',
		});
	}

	return annotations;
}

module.exports = { parseAstapIni, skyToPixelFrac, buildAnnotations };
