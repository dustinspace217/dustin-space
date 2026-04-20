/**
 * platesolve.js — WCS extraction from PixInsight XISF and astrometry.net API
 *
 * Two WCS sources, tried in order:
 *   1. Companion XISF — a PixInsight XISF file sitting next to the TIF,
 *      containing a plate solution embedded as FITSKeyword XML elements.
 *   2. astrometry.net API — blind plate-solve via the public web service.
 *      Requires an API key stored in ingest/config.json.
 *
 * Also retains parseAstapIni() for backwards compatibility with existing
 * .ini files from prior ASTAP runs (used by compute-from-raw-wcs.js).
 *
 * Exports:
 *   parseXisfWcs(xisfPath)                          — parse WCS from XISF file
 *   solveWithAstrometry(jpgPath, apiKey, w, h, fov, onProgress) — astrometry.net
 *   parseAstapIni(iniPath)                          — legacy ASTAP .ini parser
 *   skyToPixelFrac(raDeg, decDeg, wcs, w, h)        — sky coords → pixel fractions
 *   buildAnnotations(simbadResults, wcs, w, h, fov) — Simbad → annotation objects
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── XISF companion parser ──────────────────────────────────────────────────

/**
 * parseXisfWcs — extract a WCS plate solution from a PixInsight XISF file.
 *
 * XISF files start with an XML header containing metadata, including plate
 * solutions stored as <FITSKeyword> elements. We only read the first 64KB —
 * that's more than enough for all metadata, and avoids loading the full
 * multi-hundred-megabyte image data.
 *
 * The FITSKeyword elements look like:
 *   <FITSKeyword name="CRVAL1" value="312.876" comment="..."/>
 *
 * @param {string} xisfPath — absolute path to the .xisf file
 * @returns {object|null} WCS solution object (same shape as parseAstapIni),
 *   or null if the file doesn't exist, isn't readable, or lacks WCS keywords.
 */
function parseXisfWcs(xisfPath) {
	// Read only the first 64KB — the XML header lives at the start of the file.
	// The image pixel data follows and can be hundreds of megabytes.
	// Wrapped in try-catch so permission errors, missing files, and I/O failures
	// return null (consistent with the function's contract) instead of throwing.
	let header;
	try {
		const fd = fs.openSync(xisfPath, 'r');
		try {
			const buf = Buffer.alloc(65536);
			const bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
			header = buf.toString('utf8', 0, bytesRead);
		} finally {
			fs.closeSync(fd);
		}
	} catch (err) {
		// ENOENT (missing), EACCES (permission denied), EMFILE (too many fds), etc.
		return null;
	}

	// Extract all FITSKeyword elements into a key-value map.
	// Regex matches: <FITSKeyword name="KEY" value="VALUE" ... />
	// The value attribute contains the FITS-formatted value (may have quotes
	// for strings, plain numbers for numerics).
	const kv = {};
	const re = /<FITSKeyword\s+name="([^"]+)"\s+value="([^"]*)"/g;
	let match;
	while ((match = re.exec(header)) !== null) {
		// FITS string values are wrapped in single quotes with padding:
		//   value="'T       '" → strip quotes and whitespace to get "T"
		// Numeric values are plain: value="312.876"
		const key = match[1].trim();
		let val   = match[2].trim();
		if (val.startsWith("'") && val.endsWith("'")) {
			val = val.slice(1, -1).trim();
		}
		kv[key] = val;
	}

	// Check for a successful plate solution.
	// PixInsight sets PLTSOLVD=T when the image has been plate-solved.
	// Some versions use CTYPE1/CTYPE2 instead — check both.
	const hasSolve = kv.PLTSOLVD === 'T' ||
		(kv.CTYPE1 && kv.CTYPE1.includes('TAN'));
	if (!hasSolve) return null;

	// CD matrix: the four elements that map pixel offsets to sky offsets.
	// If the full CD matrix isn't present, fall back to CDELT + CROTA2.
	let cd11, cd12, cd21, cd22;

	if (kv.CD1_1 != null) {
		// Full CD matrix available — use it directly.
		cd11 = parseFloat(kv.CD1_1);
		cd12 = parseFloat(kv.CD1_2 || '0');
		cd21 = parseFloat(kv.CD2_1 || '0');
		cd22 = parseFloat(kv.CD2_2);
	} else if (kv.CDELT1 != null) {
		// CDELT + CROTA2 — construct the CD matrix from these.
		// CD = [[CDELT1*cos(θ), -CDELT2*sin(θ)],
		//       [CDELT1*sin(θ),  CDELT2*cos(θ)]]
		const cdelt1 = parseFloat(kv.CDELT1);
		const cdelt2 = parseFloat(kv.CDELT2 || kv.CDELT1);
		const crota  = parseFloat(kv.CROTA2 || '0') * Math.PI / 180;
		cd11 = cdelt1 * Math.cos(crota);
		cd12 = -cdelt2 * Math.sin(crota);
		cd21 = cdelt1 * Math.sin(crota);
		cd22 = cdelt2 * Math.cos(crota);
	} else {
		// No WCS scale information at all — can't use this solution.
		return null;
	}

	const ra_deg  = parseFloat(kv.CRVAL1);
	const dec_deg = parseFloat(kv.CRVAL2);
	const crpix1  = parseFloat(kv.CRPIX1);
	const crpix2  = parseFloat(kv.CRPIX2);

	// All four critical WCS fields must be valid numbers.
	if (!Number.isFinite(ra_deg) || !Number.isFinite(dec_deg) ||
		!Number.isFinite(crpix1) || !Number.isFinite(crpix2) ||
		!Number.isFinite(cd11) || !Number.isFinite(cd22)) {
		return null;
	}

	const pixScaleDeg = Math.sqrt(cd11 * cd11 + cd21 * cd21);

	return {
		ra_deg, dec_deg, crpix1, crpix2,
		cd11, cd12, cd21, cd22,
		pixScaleDeg,
		pixScaleArcsec: pixScaleDeg * 3600,
		crota2:         parseFloat(kv.CROTA2 || '0'),
	};
}

// ─── astrometry.net API solver ───────────────────────────────────────────────

/**
 * ASTROMETRY_BASE — base URL for the astrometry.net API.
 * The public server is at nova.astrometry.net. This is the same service
 * used by the astrometry.net web UI, but accessed programmatically.
 */
const ASTROMETRY_BASE = 'https://nova.astrometry.net/api';

/**
 * astrometryPost — send a POST request to the astrometry.net API.
 *
 * The astrometry.net API uses a non-standard format: form-encoded body with
 * a "request-json" field containing a JSON string. Responses are JSON.
 *
 * @param {string} endpoint — API endpoint path (e.g. '/login')
 * @param {object} payload  — JSON payload to send in the request-json field
 * @returns {object} parsed JSON response from the server
 * @throws {Error} if the request fails or returns status !== 'success'
 */
async function astrometryPost(endpoint, payload) {
	const body = new URLSearchParams();
	body.append('request-json', JSON.stringify(payload));

	const resp = await fetch(`${ASTROMETRY_BASE}${endpoint}`, {
		method: 'POST',
		body,
	});

	if (!resp.ok) {
		// Include a snippet of the response body in the error so a 401/403
		// (rotated API key) doesn't look identical to a 500 in the logs.
		// Truncated to avoid leaking large HTML error pages into stdout.
		// Issue #85.
		let bodySnippet = '';
		try {
			bodySnippet = (await resp.text()).slice(0, 200).replace(/\s+/g, ' ');
		} catch { /* fetch already drained or unavailable; ignore */ }
		throw new Error(
			`astrometry.net ${endpoint} HTTP ${resp.status}` +
			(bodySnippet ? ` — body: ${bodySnippet}` : '')
		);
	}

	const data = await resp.json();
	if (data.status !== 'success') {
		// astrometry.net uses both 'errormessage' and 'error_message' in different endpoints.
		const detail = data.errormessage || data.error_message || data.status;
		throw new Error(`astrometry.net ${endpoint}: ${detail}`);
	}
	return data;
}

/**
 * astrometryUpload — upload an image to astrometry.net for plate-solving.
 *
 * Uses multipart/form-data with two fields:
 *   - request-json: JSON string with session key, solve parameters, etc.
 *   - file: the actual image file
 *
 * The scale_units/scale_lower/scale_upper constrain the solver to a
 * reasonable pixel scale range, which dramatically speeds up the solve.
 * Without hints, the solver tries every possible scale from 0.1" to 180°/px.
 *
 * @param {string} sessionKey — session key from login
 * @param {string} jpgPath   — absolute path to the JPG file to upload
 * @param {number} imgW      — image width in pixels (for accurate scale hints)
 * @param {number} fovHint   — expected FOV in degrees (used to bound the search)
 * @returns {number} submission ID for polling
 */
async function astrometryUpload(sessionKey, jpgPath, imgW, fovHint) {
	// Use fs.openAsBlob (Node 22) to memory-map the file instead of loading
	// the entire JPG into a Buffer. Astrophotography JPGs can be 50-200MB;
	// readFileSync would double-copy (Buffer + File) consuming 100-400MB.
	const { openAsBlob } = require('fs');
	const blob     = await openAsBlob(jpgPath, { type: 'image/jpeg' });
	const fileName = path.basename(jpgPath);
	const file     = new File([blob], fileName, { type: 'image/jpeg' });

	// Build the request-json payload with scale hints.
	// scale_lower and scale_upper bracket the expected pixel scale.
	// We allow 50% tolerance above and below.
	const requestJson = {
		session:           sessionKey,
		allow_commercial_use: 'n',
		allow_modifications:  'n',
		publicly_visible:     'n',
	};

	// If we have a FOV hint and image width, provide scale bounds to speed up the solve.
	if (fovHint > 0 && imgW > 0) {
		// Pixel scale in arcsec/px = FOV in arcsec / image width in px.
		const estimatedScale = (fovHint * 3600) / imgW;
		requestJson.scale_units = 'arcsecperpix';
		requestJson.scale_lower = estimatedScale * 0.5;
		requestJson.scale_upper = estimatedScale * 2.0;
		requestJson.scale_type  = 'ul';
	}

	// Build multipart form with the image file and JSON metadata.
	const form = new FormData();
	form.append('request-json', JSON.stringify(requestJson));
	form.append('file', file);

	const resp = await fetch(`${ASTROMETRY_BASE}/upload`, {
		method: 'POST',
		body: form,
	});

	if (!resp.ok) {
		throw new Error(`astrometry.net upload HTTP ${resp.status}`);
	}

	const data = await resp.json();
	if (data.status !== 'success') {
		throw new Error(`astrometry.net upload: ${data.errormessage || data.status}`);
	}

	// The response contains a submission ID that we poll to get the job ID.
	return data.subid;
}

/**
 * solveWithAstrometry — full plate-solve via the astrometry.net API.
 *
 * Flow: login → upload → poll submission → poll job → fetch calibration.
 *
 * The polling has two phases:
 *   1. Submission polling: wait for the server to assign a job ID to the upload
 *   2. Job polling: wait for the plate-solve to complete (success or failure)
 *
 * Typical solve times: 30-120 seconds depending on server load and image size.
 *
 * @param {string} jpgPath     — absolute path to the JPG to solve
 * @param {string} apiKey      — astrometry.net API key from config.json
 * @param {number} imgW        — image width in pixels (for CD matrix construction)
 * @param {number} imgH        — image height in pixels
 * @param {number} fovHint      — expected FOV in degrees (0 = no hint)
 * @param {function} onProgress  — callback for status updates: (message) => void
 * @param {function} shouldCancel — optional callback returning true if the job was
 *   cancelled by the user. Checked at the top of each poll iteration so
 *   cancellation takes effect within 5 seconds (one poll interval).
 * @returns {object|null} WCS solution object (same shape as parseXisfWcs), or null
 * @throws {Error} on network/auth failures (not on solve failure — that returns null)
 */
async function solveWithAstrometry(jpgPath, apiKey, imgW, imgH, fovHint, onProgress, shouldCancel) {
	const log = onProgress || (() => {});
	const cancelled = shouldCancel || (() => false);

	// Step 1: Authenticate with the API key.
	log('Logging in to astrometry.net...');
	const loginResp = await astrometryPost('/login', { apikey: apiKey });
	const session   = loginResp.session;

	// Step 2: Upload the image.
	log('Uploading image to astrometry.net...');
	const subId = await astrometryUpload(session, jpgPath, imgW, fovHint);
	log(`Submission ${subId} created, waiting for solve...`);

	// Step 3: Poll the submission until a job ID appears.
	// The server queues uploads and assigns job IDs when processing begins.
	// Typical wait: 5-30 seconds depending on server load.
	let jobId = null;
	const maxSubmissionPolls = 60;  // 5 minutes max wait for job assignment
	for (let i = 0; i < maxSubmissionPolls; i++) {
		await new Promise(r => setTimeout(r, 5000)); // 5-second intervals

		if (cancelled()) {
			log('Plate-solve cancelled by user');
			return null;
		}

		const resp = await fetch(`${ASTROMETRY_BASE}/submissions/${subId}`);
		// Transient HTTP errors (502, 503, 429) are common with the public server
		// under load. Log and retry instead of crashing the entire solve.
		if (!resp.ok) {
			log(`Submission poll HTTP ${resp.status} — retrying...`);
			continue;
		}
		let data;
		try { data = await resp.json(); } catch { log('Submission poll: invalid JSON — retrying...'); continue; }

		// jobs array is populated once the server starts processing.
		if (data.jobs && data.jobs.length > 0 && data.jobs[0] != null) {
			jobId = data.jobs[0];
			log(`Job ${jobId} assigned, solving...`);
			break;
		}

		// job_calibrations being non-empty means it already solved.
		if (data.job_calibrations && data.job_calibrations.length > 0) {
			jobId = data.job_calibrations[0][0];
			log(`Job ${jobId} already solved`);
			break;
		}
	}

	if (!jobId) {
		log('Timed out waiting for astrometry.net to assign a job');
		return null;
	}

	// Step 4: Poll the job until it completes.
	// The job processes: source extraction → index lookup → verification.
	const maxJobPolls = 120;  // 10 minutes max for the solve itself
	let solved = false;
	for (let i = 0; i < maxJobPolls; i++) {
		await new Promise(r => setTimeout(r, 5000));

		if (cancelled()) {
			log('Plate-solve cancelled by user');
			return null;
		}

		const resp = await fetch(`${ASTROMETRY_BASE}/jobs/${jobId}`);
		if (!resp.ok) {
			log(`Job poll HTTP ${resp.status} — retrying...`);
			continue;
		}
		let data;
		try { data = await resp.json(); } catch { log('Job poll: invalid JSON — retrying...'); continue; }

		if (data.status === 'success') {
			solved = true;
			break;
		}
		if (data.status === 'failure') {
			log('astrometry.net could not solve the field');
			return null;
		}
		// status === 'solving' — keep polling
		if (i % 6 === 0) log(`Still solving... (${(i * 5 / 60).toFixed(0)}min)`);
	}

	if (!solved) {
		log('Timed out waiting for astrometry.net solve');
		return null;
	}

	// Step 5: Fetch the calibration data.
	// The calibration contains: ra, dec (center), radius (field radius),
	// pixscale (arcsec/px), orientation (degrees E of N), parity.
	const calResp = await fetch(`${ASTROMETRY_BASE}/jobs/${jobId}/calibration`);
	if (!calResp.ok) {
		log(`Calibration fetch failed: HTTP ${calResp.status}`);
		return null;
	}
	const cal = await calResp.json();

	// Validate that all critical calibration fields are present and numeric.
	// Without this, NaN values would silently flow into images.json.
	if (!Number.isFinite(cal.ra) || !Number.isFinite(cal.dec) ||
		!Number.isFinite(cal.pixscale) || !Number.isFinite(cal.orientation)) {
		log('astrometry.net returned incomplete calibration data');
		return null;
	}

	// Reconstruct the CD matrix from calibration parameters.
	// orientation = angle from North to "up" in the image, measured East.
	// parity: negative means the image is mirrored (flipped horizontally).
	const ra_deg  = cal.ra;
	const dec_deg = cal.dec;
	const scale   = cal.pixscale / 3600;  // arcsec/px → degrees/px
	const theta   = cal.orientation * Math.PI / 180;  // orientation in radians

	// Parity determines the sign convention.
	// Negative parity (common for camera images) means RA increases leftward.
	const parity = (cal.parity != null && cal.parity < 0) ? -1 : 1;

	// CD matrix construction:
	// For parity = -1 (normal camera):
	//   CD1_1 = -scale * cos(θ)   CD1_2 = scale * sin(θ)
	//   CD2_1 = -scale * sin(θ)   CD2_2 = -scale * cos(θ)
	// For parity = +1 (mirrored):
	//   CD1_1 = scale * cos(θ)    CD1_2 = scale * sin(θ)
	//   CD2_1 = scale * sin(θ)    CD2_2 = -scale * cos(θ)
	const cd11 = parity * (-scale * Math.cos(theta));
	const cd12 = scale * Math.sin(theta);
	const cd21 = parity * (-scale * Math.sin(theta));
	const cd22 = -scale * Math.cos(theta);

	// Reference pixel is the image center (standard for astrometry.net).
	const crpix1 = (imgW + 1) / 2;
	const crpix2 = (imgH + 1) / 2;

	const pixScaleDeg = scale;
	log(`Solved: RA=${ra_deg.toFixed(4)}° Dec=${dec_deg.toFixed(4)}° scale=${(scale * 3600).toFixed(2)}"/px`);

	return {
		ra_deg, dec_deg, crpix1, crpix2,
		cd11, cd12, cd21, cd22,
		pixScaleDeg,
		pixScaleArcsec: pixScaleDeg * 3600,
		crota2: cal.orientation,
	};
}

// ─── legacy ASTAP .ini parser ────────────────────────────────────────────────

/**
 * parseAstapIni — parse an ASTAP .ini plate-solve result file.
 *
 * Kept for backwards compatibility with existing .ini files (e.g. the Veil
 * Nebula raw sub-frame solve). Not used by the ingest pipeline anymore —
 * XISF companion and astrometry.net are the active solvers.
 *
 * @param {string} iniPath — absolute path to the .ini file
 * @returns {object|null} WCS solution object on success, null if unsolved.
 */
function parseAstapIni(iniPath) {
	if (!fs.existsSync(iniPath)) return null;

	const kv = {};
	for (const line of fs.readFileSync(iniPath, 'utf8').split('\n')) {
		const m = line.match(/^(\w+)\s*=\s*(.+)$/);
		if (m) kv[m[1].trim()] = m[2].trim();
	}

	if (kv.PLTSOLVD !== 'T') return null;

	const cd11 = parseFloat(kv.CD1_1 || kv.CDELT1 || 0);
	const cd12 = parseFloat(kv.CD1_2 || 0);
	const cd21 = parseFloat(kv.CD2_1 || 0);
	const cd22 = parseFloat(kv.CD2_2 || kv.CDELT2 || 0);

	const pixScaleDeg = Math.sqrt(cd11 * cd11 + cd21 * cd21);

	const ra_deg  = parseFloat(kv.CRVAL1);
	const dec_deg = parseFloat(kv.CRVAL2);
	const crpix1  = parseFloat(kv.CRPIX1);
	const crpix2  = parseFloat(kv.CRPIX2);

	if (!Number.isFinite(ra_deg) || !Number.isFinite(dec_deg) ||
		!Number.isFinite(crpix1) || !Number.isFinite(crpix2)) {
		return null;
	}

	return {
		ra_deg, dec_deg, crpix1, crpix2,
		cd11, cd12, cd21, cd22,
		pixScaleDeg,
		pixScaleArcsec: pixScaleDeg * 3600,
		crota2:         parseFloat(kv.CROTA2 || 0),
	};
}

// ─── WCS coordinate conversion ──────────────────────────────────────────────

/**
 * skyToPixelFrac — convert sky RA/Dec to fractional pixel position in the image.
 *
 * Given a WCS solution and the image pixel dimensions, returns { x, y } as
 * fractions [0..1] from the top-left corner. Values outside 0..1 indicate the
 * sky position falls outside the image frame.
 *
 * Uses the inverse of the CD matrix to go from sky offsets → pixel offsets.
 * The RA offset is corrected for cos(Dec) foreshortening.
 *
 * @param {number} raDeg  — target right ascension in decimal degrees
 * @param {number} decDeg — target declination in decimal degrees
 * @param {object} wcs    — WCS solution object from parseXisfWcs/parseAstapIni
 * @param {number} imgW   — image width in pixels
 * @param {number} imgH   — image height in pixels
 * @returns {{ x: number, y: number } | null} fractional position (0..1 = in
 *   frame), or null when the CD matrix is degenerate (the inverse doesn't
 *   exist). Callers MUST treat null distinctly from "out of frame" — see
 *   buildAnnotations() which counts and warns on null returns.
 *
 * Why null instead of the previous {x:-1,y:-1} sentinel: buildAnnotations'
 * in-bounds filter (`pos.x < 0 || pos.x > 1`) was masking the sentinel as
 * "off-frame," so a degenerate CD matrix silently dropped every annotation
 * with no warning. Issue #79.
 */
function skyToPixelFrac(raDeg, decDeg, wcs, imgW, imgH) {
	const { ra_deg, dec_deg, crpix1, crpix2, cd11, cd12, cd21, cd22 } = wcs;

	// RA offset in degrees, corrected for cos(Dec) foreshortening.
	let rawDRA = raDeg - ra_deg;
	if (rawDRA > 180) rawDRA -= 360;
	if (rawDRA < -180) rawDRA += 360;
	const dRA  = rawDRA * Math.cos(dec_deg * Math.PI / 180);
	const dDec = decDeg - dec_deg;

	// Inverse of the 2×2 CD matrix. Return null on degenerate (matches
	// the browser-side contract in detail.js skyToPixelFrac).
	const det  = cd11 * cd22 - cd12 * cd21;
	if (Math.abs(det) < 1e-20) return null;

	const dx   = ( cd22 * dRA - cd12 * dDec) / det;
	const dy   = (-cd21 * dRA + cd11 * dDec) / det;

	// FITS pixels are 1-indexed; subtract 1 to convert to 0-based.
	const xPx  = crpix1 - 1 + dx;
	const yPx  = crpix2 - 1 + dy;

	return {
		x: xPx / imgW,
		y: yPx / imgH,
	};
}

// ─── annotation builder ─────────────────────────────────────────────────────

/**
 * CATALOG_ALLOWLIST — string prefixes for catalogs whose IDs are
 * recognizable enough to render as standalone point dots. Each entry is
 * matched as a literal prefix against the uppercased + space-normalized
 * alias.
 *
 * Issue #84: the previous list included bare `'B '` and `'C '` for
 * Barnard / Caldwell. Two characters is too permissive — any catalog
 * whose IDs start with `B ` or `C ` would slip through (Bonner
 * Durchmusterung adjacent forms, hypothetical `C 1234` from a non-
 * Caldwell catalog). Tightened: rely on the spelled-out forms
 * (`'BARNARD '`, `'CALDWELL '`) which both Simbad and ASTAP emit, and
 * use `CATALOG_REGEX_ALLOWLIST` below for cases that genuinely need a
 * short prefix bounded to digits (`Sh 2-NN` etc.).
 */
const CATALOG_ALLOWLIST = [
	'NGC', 'IC ', 'M ', 'SH2-', 'SH 2-', 'LDN ', 'LBN ',
	'BARNARD ', 'CALDWELL ', 'ABELL ', 'UGC ', 'PGC ',
	// ASTAP-only prefixes (not in Simbad basic or differently-formatted):
	'VDB ', 'HCG ', 'PK ', 'DWB', 'SH2 ', 'CR ', 'MEL ', 'STOCK ',
];

/**
 * CATALOG_REGEX_ALLOWLIST — patterns for short catalog prefixes that
 * MUST be bounded to digits to avoid matching arbitrary names. Issue #84.
 * Currently catches Barnard short-form (`B 33` for Horsehead) and
 * Caldwell short-form (`C 14` for Double Cluster) without false-positive
 * matching on `Betelgeuse`, `Bode's Galaxy`, etc.
 */
const CATALOG_REGEX_ALLOWLIST = [
	/^B \d+$/i,
	/^C \d+$/i,
];

// Proper-name terminology that signals a human-recognizable common name.
// Used as a secondary pass for ASTAP rows that don't match a catalog
// prefix but carry a well-known colloquial name (e.g. "Pickerings Triangle",
// "Witch Head Nebula", "North America Nebula"). Match is case-insensitive
// and substring-based against any alias on the row.
const COMMON_NAME_TOKENS = [
	'NEBULA', 'GALAXY', 'CLUSTER', 'TRIANGLE', 'WITCH', 'HEAD',
	'HORSEHEAD', 'FLAME', 'PICKERING', 'CYGNUS LOOP', 'CYG LOOP',
	'NORTH AMERICA', 'PELICAN', 'DUMBBELL', 'RING', 'HELIX',
	'CRESCENT', 'SOUL', 'HEART', 'ROSETTE', 'EAGLE', 'TRIFID',
	'LAGOON', 'OMEGA', 'SWAN', 'TARANTULA', 'ORION', 'PLEIADES',
	'WHIRLPOOL', 'ANDROMEDA', 'PINWHEEL', 'VEIL', 'FLAMING STAR',
	'IRIS', 'BUBBLE', 'CAVE', 'COCOON', 'ELEPHANT', 'GHOST',
	'JELLYFISH', 'OWL', 'PACMAN', 'SKULL', 'SOUL', 'WITCH HEAD',
	'CALIFORNIA', 'SEAGULL', 'FISHHEAD', 'CHRISTMAS TREE',
	'HUBBLE', 'SEYFERT', 'HICKSON', 'ARP ', 'MARKARIAN',
];

/**
 * nameMatchesAllowlist — check if any alias on an object matches a
 * known catalog prefix OR a recognizable common-name token.
 *
 * Accepts either a single name string (Simbad-shape) or an array of
 * aliases (ASTAP-shape). Whitespace is normalized (collapsed to single
 * spaces) before matching so Simbad's inconsistent formatting ("M  42"
 * vs "M 42", "SH  2-279" vs "SH 2-279") all match the same prefix
 * entry. Without this, the double-space variants fell through the
 * allowlist and landed in overlays.
 *
 * @param {string|string[]} nameOrAliases
 * @returns {boolean} true if at least one alias matches
 */
function nameMatchesAllowlist(nameOrAliases) {
	const list = Array.isArray(nameOrAliases) ? nameOrAliases : [nameOrAliases];
	for (const name of list) {
		if (!name) continue;
		const upper = String(name).replace(/\s+/g, ' ').toUpperCase();
		if (CATALOG_ALLOWLIST.some(prefix => upper.startsWith(prefix))) return true;
		// Bounded short-prefix patterns (Barnard `B 33`, Caldwell `C 14`).
		// Run on the trimmed normalized form so trailing whitespace doesn't
		// break the anchored regex. Issue #84.
		if (CATALOG_REGEX_ALLOWLIST.some(re => re.test(upper.trim()))) return true;
		if (COMMON_NAME_TOKENS.some(tok => upper.includes(tok))) return true;
	}
	return false;
}

/**
 * buildAnnotations — convert Simbad results + WCS into annotation objects.
 *
 * For each Simbad result:
 *   1. Convert sky coordinates to pixel fractions via WCS
 *   2. Compute radius fraction from angular size and FOV
 *   3. Apply size/position filters (and catalog allowlist for DSOs)
 *   4. Return annotation objects ready for images.json
 *
 * @param {Array} simbadResults — objects from simbadSearch() or simbadSearchStars()
 * @param {object} wcs    — WCS solution from parseXisfWcs/parseAstapIni
 * @param {number} imgW   — image width in pixels
 * @param {number} imgH   — image height in pixels
 * @param {number} fovWDeg — horizontal field of view in degrees
 * @param {object} [options]
 * @param {boolean} [options.skipAllowlist=false] — bypass the named-catalog
 *        filter. Set true for pre-filtered result sets like simbadSearchStars
 *        (Bayer-designated + magnitude-capped), where the allowlist would
 *        reject every row because "* zet Ori" doesn't match M/NGC/IC prefixes.
 * @param {string} [options.source='simbad'] — source tag recorded on each
 *        annotation (e.g. 'simbad-star' for bright-star hits). Detail.js can
 *        branch on this later if stars warrant different rendering.
 * @param {number} [options.minRadius=0.02] — minimum radius fraction below
 *        which sized objects are dropped. Stars pass through even at 0 since
 *        radius stays null (point source).
 * @returns {Array<object>} annotation objects for images.json
 */
function buildAnnotations(simbadResults, wcs, imgW, imgH, fovWDeg, options) {
	if (!Number.isFinite(fovWDeg) || fovWDeg <= 0) return [];

	options = options || {};
	const skipAllowlist = options.skipAllowlist === true;
	const source        = options.source || 'simbad';
	const minRadius     = Number.isFinite(options.minRadius) ? options.minRadius : 0.02;

	const annotations = [];
	// Counter for null returns from skyToPixelFrac (degenerate CD matrix).
	// If this is non-zero at the end of the loop, the WCS is broken — every
	// row was silently dropped before. Issue #79.
	let degenerateCount = 0;

	for (const obj of simbadResults) {
		const pos = skyToPixelFrac(obj.ra_deg, obj.dec_deg, wcs, imgW, imgH);

		// pos === null signals a degenerate WCS; treat as "all rows broken"
		// rather than "this single row off-frame". Count + warn after the loop.
		if (pos === null) { degenerateCount++; continue; }
		if (pos.x < 0 || pos.x > 1 || pos.y < 0 || pos.y > 1) continue;

		let radius = null;
		if (obj.major_axis_arcmin != null && Number.isFinite(obj.major_axis_arcmin) && obj.major_axis_arcmin > 0) {
			radius = (obj.major_axis_arcmin / 60 / 2) / fovWDeg;

			if (radius < minRadius) continue;
			if (radius > 0.5) radius = 0.5;
		}

		// Apply the catalog allowlist to ALL DSO annotations (sized + unsized).
		// Famous fields like Orion + Andromeda return hundreds of large-faint
		// survey-catalog entries ([NS2019]X, [SKM2015]Y, TGU HXXXX) that no
		// human visitor recognizes; restricting to NGC/IC/M/Sh2/PGC etc. names
		// keeps annotations to objects a viewer might actually identify.
		// Worth: drop a handful of legitimate non-allowlisted catalog entries
		// in exchange for radically cleaner overlays. Extend CATALOG_ALLOWLIST
		// if a target you care about uses an unusual catalog prefix.
		// Stars (source='simbad-star') pass skipAllowlist=true because the
		// Bayer LIKE + V magnitude filter in simbadSearchStars already enforces
		// the equivalent "recognizable only" guarantee on that query.
		//
		// ASTAP rows carry an `aliases` array (slash-split names); Simbad
		// rows only have `obj.name`. Pass whichever is available so common
		// names like "Pickerings Triangle" match even when the primary
		// display name doesn't start with a catalog prefix.
		if (!skipAllowlist && !nameMatchesAllowlist(obj.aliases || obj.name)) continue;

		annotations.push({
			name:               obj.name,
			x:                  pos.x,
			y:                  pos.y,
			radius:             radius,
			type:               obj.type || null,
			major_axis_arcmin:  obj.major_axis_arcmin ?? null,
			minor_axis_arcmin:  obj.minor_axis_arcmin ?? null,
			position_angle:     obj.position_angle ?? null,
			source:             source,
			// vmag is present on star results; preserve it so the renderer
			// can eventually size/cull stars by brightness. For DSOs this
			// silently drops (obj.vmag is undefined).
			vmag:               obj.vmag ?? undefined,
		});
	}

	// Visibility for degenerate-WCS drops. If we silently dropped any row
	// because skyToPixelFrac couldn't invert the CD matrix, surface it
	// loudly — the WCS is unusable and the resulting overlay will be empty
	// not because the field is empty but because the math broke.
	if (degenerateCount > 0) {
		const det = wcs.cd11 * wcs.cd22 - wcs.cd12 * wcs.cd21;
		console.warn(
			`buildAnnotations: degenerate WCS dropped ${degenerateCount} of ${simbadResults.length} rows ` +
			`(det = ${det.toExponential(3)}, threshold 1e-20). All annotations will be empty until WCS is re-solved.`
		);
	}

	return annotations;
}

module.exports = {
	parseXisfWcs,
	solveWithAstrometry,
	parseAstapIni,
	skyToPixelFrac,
	buildAnnotations,
};
