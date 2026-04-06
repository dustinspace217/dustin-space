/**
 * server.js — Image ingestion pipeline server for dustin-space
 *
 * Accepts a JPG + TIF pair, runs a full pipeline:
 *   1. Read FITS/EXIF metadata from TIF (via exiftool, optional)
 *   2. Plate-solve the JPG with ASTAP
 *   3. Simbad cone-search for annotation points
 *   4. vips: create 2400px preview WebP + 600px thumbnail WebP
 *   5. vips: generate DZI tile tree from TIF
 *   6. @aws-sdk/client-s3: upload DZI tiles to Cloudflare R2 (bucket: dustinspace)
 *   7. Update src/_data/images.json with the new entry
 *   8. git add / commit / push to GitHub
 *
 * Progress is streamed to the browser via Server-Sent Events (SSE).
 * The client POSTs files + form data to /api/process, receives a jobId,
 * then connects to /api/progress/:jobId to receive the SSE stream.
 *
 * Run: node server.js
 * Open: http://localhost:3333
 */

'use strict';

const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
// execFileSync: synchronous binary execution used for startup checks only.
// Async execution (run/runOrThrow) is now in lib/exec.js.
// Neither invokes a shell — arguments go directly to the OS, no injection risk.
const { execFileSync } = require('child_process');
const crypto     = require('crypto');

// S3Client is the main SDK class. It holds the connection pool and auth config.
// PutObjectCommand is the command object for uploading a single object.
// Both are imported from the S3-compatible AWS SDK package (@aws-sdk/client-s3).
// Credentials are loaded from config.json (gitignored) — see CONFIG_DEFAULTS below.
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// ─── config ───────────────────────────────────────────────────────────────────
// Manages instance-specific settings (ASTAP paths, R2 credentials, port) in
// ingest/config.json (gitignored). See lib/config.js for full docs.
const { loadConfig, saveConfig, getConfig, setConfig, CONFIG_DEFAULTS, CONFIG_PATH } = require('./lib/config');

// Load config once at startup. getConfig() returns the current in-memory copy;
// setConfig()/saveConfig() update it at runtime (e.g. via POST /api/settings).
loadConfig();

// ─── paths ────────────────────────────────────────────────────────────────────

// The dustin-space project root is one level up from this ingest/ directory.
const PROJECT_ROOT  = path.resolve(__dirname, '..');
const IMAGES_JSON   = path.join(PROJECT_ROOT, 'src/_data/images.json');
const GALLERY_DIR   = path.join(PROJECT_ROOT, 'src/assets/img/gallery');

// Cloudflare R2 bucket name (the 'dustinspace' bucket is at tiles.dustin.space).
const R2_BUCKET   = 'dustinspace';
const R2_BASE_URL = 'https://tiles.dustin.space';

// S3Client instance — created once at startup using credentials from config.json.
// endpoint: R2's S3-compatible URL, formed from your account ID.
// region: R2 requires the literal string "auto" — it doesn't use AWS regions.
// credentials: loaded from config.json via getConfig(), NOT hardcoded in source.
const r2Client = new S3Client({
	endpoint: `https://${getConfig().r2_account_id}.r2.cloudflarestorage.com`,
	region:   'auto',
	credentials: {
		accessKeyId:     getConfig().r2_access_key_id,
		secretAccessKey: getConfig().r2_secret_access_key,
	},
});

// ─── express + multer setup ───────────────────────────────────────────────────

const app    = express();
// limits.fileSize caps individual uploads at 500 MB — large enough for TIF
// source files, small enough to prevent a runaway upload from filling the disk.
const upload = multer({
	dest: os.tmpdir() + '/ingest-uploads/',
	limits: { fileSize: 500 * 1024 * 1024 },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── in-memory job store + SSE events ─────────────────────────────────────────
// Jobs Map, SSE event emitter, cancellation signaling, and images.json mutex.
// See lib/jobs.js for full docs.
const { jobs, withImagesMutex, jobEmit, isCancelled, CancelledError } = require('./lib/jobs');

// ─── safe child process helpers ───────────────────────────────────────────────
// Wraps execFile (no shell) so external binaries can't be shell-injected.
// See lib/exec.js for full docs.
const { run, runOrThrow } = require('./lib/exec');

// ─── recursive directory walker ───────────────────────────────────────────────
// Yields { local, rel } pairs for every file in a tree. See lib/walk.js.
const { walkDir } = require('./lib/walk');

// ─── RA/Dec formatting ────────────────────────────────────────────────────────
// Converts decimal degrees (from ASTAP WCS) to sexagesimal strings. See lib/coordinates.js.
const { raToStr, decToStr } = require('./lib/coordinates');

// ─── helper: parse ASTAP .ini solution file ───────────────────────────────────
// ASTAP writes key=value pairs. Returns null if PLTSOLVD is not T.
function parseAstapIni(iniPath) {
	if (!fs.existsSync(iniPath)) return null;
	const kv = {};
	for (const line of fs.readFileSync(iniPath, 'utf8').split('\n')) {
		const m = line.match(/^(\w+)\s*=\s*(.+)$/);
		if (m) kv[m[1].trim()] = m[2].trim();
	}
	if (kv.PLTSOLVD !== 'T') return null;

	// CD matrix: [[CD1_1, CD1_2], [CD2_1, CD2_2]]
	// CDELT1/CDELT2 are the pixel scale in degrees/pixel (CDELT1 is typically negative).
	const cd11 = parseFloat(kv.CD1_1 || kv.CDELT1 || 0);
	const cd12 = parseFloat(kv.CD1_2 || 0);
	const cd21 = parseFloat(kv.CD2_1 || 0);
	const cd22 = parseFloat(kv.CD2_2 || kv.CDELT2 || 0);

	// Pixel scale in degrees/pixel (use the magnitude of the CD column vectors).
	const pixScaleDeg = Math.sqrt(cd11 * cd11 + cd21 * cd21);

	return {
		ra_deg:       parseFloat(kv.CRVAL1),
		dec_deg:      parseFloat(kv.CRVAL2),
		crpix1:       parseFloat(kv.CRPIX1),
		crpix2:       parseFloat(kv.CRPIX2),
		cd11, cd12, cd21, cd22,
		pixScaleDeg,
		pixScaleArcsec: pixScaleDeg * 3600,
		crota2:       parseFloat(kv.CROTA2 || 0),
	};
}

// ─── helper: convert sky RA/Dec → fractional pixel position ──────────────────
// Given WCS solution from ASTAP and the image pixel dimensions, returns
// { x, y } as fractions [0..1] from the top-left corner.
// Uses the inverse CD matrix to go from sky → pixel.
function skyToPixelFrac(raDeg, decDeg, wcs, imgW, imgH) {
	const { ra_deg, dec_deg, crpix1, crpix2, cd11, cd12, cd21, cd22 } = wcs;

	// RA offset, corrected for cos(Dec) foreshortening.
	const dRA  = (raDeg - ra_deg) * Math.cos(dec_deg * Math.PI / 180);
	const dDec = decDeg - dec_deg;

	// Inverse of the CD matrix (2×2).
	// Guard against degenerate matrices (e.g. unsolved fields that yielded CD=0).
	const det  = cd11 * cd22 - cd12 * cd21;
	if (Math.abs(det) < 1e-20) return { x: -1, y: -1 };
	const dx   = ( cd22 * dRA - cd12 * dDec) / det;
	const dy   = (-cd21 * dRA + cd11 * dDec) / det;

	// FITS pixels are 1-indexed; crpix1/crpix2 are 1-based center pixels.
	const xPx  = crpix1 - 1 + dx;   // convert to 0-based
	const yPx  = crpix2 - 1 + dy;

	return {
		x: xPx / imgW,
		y: yPx / imgH,
	};
}

// ─── helper: query Simbad TAP for objects in field of view ───────────────────
// Returns an array of { name, ra_deg, dec_deg, type }.
// Filters out plain stars and unclassified faint sources.
async function simbadSearch(raDeg, decDeg, radiusDeg) {
	// ADQL query: select non-stellar objects within the FOV radius.
	// otype_txt strings that indicate stars start with '*'.
	const adql = [
		`SELECT TOP 80 main_id, ra, dec, otype_txt`,
		`FROM basic`,
		`WHERE CONTAINS(POINT('ICRS',ra,dec), CIRCLE('ICRS',${raDeg},${decDeg},${radiusDeg}))=1`,
		`AND otype_txt NOT LIKE '%Star%'`,
		`AND otype_txt NOT IN ('*','**','V*','EB*','SB*','RB*','PM*','HB*','WR*','Be*')`,
		`ORDER BY DISTANCE(POINT('ICRS',ra,dec),POINT('ICRS',${raDeg},${decDeg}))`,
	].join(' ');

	const url = new URL('https://simbad.u-strasbg.fr/simbad/sim-tap/sync');
	url.searchParams.set('REQUEST', 'doQuery');
	url.searchParams.set('LANG',    'ADQL');
	url.searchParams.set('FORMAT',  'json');
	url.searchParams.set('QUERY',   adql);

	const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(60000) });
	if (!resp.ok) throw new Error(`Simbad HTTP ${resp.status}`);

	// Response: { metadata: [{name, datatype}, ...], data: [[val,...], ...] }
	const body = await resp.json();
	return (body.data || []).map(row => ({
		name:    String(row[0]).trim(),
		ra_deg:  Number(row[1]),
		dec_deg: Number(row[2]),
		type:    String(row[3]).trim(),
	}));
}

// ─── helper: upload a single file to R2 via @aws-sdk/client-s3 ───────────────
// localPath — absolute path on disk to the file to upload
// r2Key     — the key (path) it will have in the R2 bucket, e.g. "slug/dzi/0/0_0.jpg"
//
// PutObjectCommand sends one HTTP PUT to R2 using the shared r2Client connection.
// No process is spawned — this is a direct HTTP call, much faster than wrangler CLI.
function uploadOneToR2(localPath, r2Key) {
	const ext = path.extname(localPath).toLowerCase();
	const contentTypes = {
		'.dzi':  'application/xml',
		'.jpg':  'image/jpeg',
		'.jpeg': 'image/jpeg',
		'.png':  'image/png',
		'.webp': 'image/webp',
	};
	const ct   = contentTypes[ext] || 'application/octet-stream';
	// fs.createReadStream reads the file in chunks — avoids loading the whole
	// file into memory at once (important for large tile sets).
	const body = fs.createReadStream(localPath);
	const cmd  = new PutObjectCommand({
		Bucket:      R2_BUCKET,
		Key:         r2Key,
		Body:        body,
		ContentType: ct,
	});
	// r2Client.send() returns a Promise that resolves when R2 confirms the upload.
	return r2Client.send(cmd);
}

// ─── helper: upload an entire DZI directory to R2 ────────────────────────────
// dziOutputDir — local directory containing the .dzi file and _files/ folder
// emitFn       — called with progress strings that appear in the ingest UI log
//
// Uploads CONCURRENCY files at a time using Promise.all(). Since there's no
// process-spawn overhead, we can safely push more concurrent requests than before.
async function uploadDziToR2(dziOutputDir, emitFn) {
	const allFiles = [...walkDir(dziOutputDir)];
	const total    = allFiles.length;
	emitFn(`Uploading ${total} DZI files to R2...`);

	// 50 concurrent uploads — higher than the old 20 because SDK uploads share
	// one HTTP/2 connection and have no process-spawn overhead.
	const CONCURRENCY = 50;
	let uploaded = 0;
	for (let i = 0; i < allFiles.length; i += CONCURRENCY) {
		const batch = allFiles.slice(i, i + CONCURRENCY);
		await Promise.all(batch.map(f => uploadOneToR2(f.local, f.rel)));
		uploaded += batch.length;
		emitFn(`R2 upload: ${uploaded}/${total}`);
	}
}

// ─── main pipeline ────────────────────────────────────────────────────────────
// Processes one ingest job end-to-end and streams progress back via SSE.
//
// jobId  — UUID string; used to look up the job in the `jobs` Map and route
//           events to the right SSE listeners
// files  — the req.files object from multer: { jpg: [File], tif: [File] }
//           tif is optional; if absent, DZI generation and tile upload are skipped
// body   — the req.body form fields (strings/arrays), including slug, title,
//           catalog, tags, date, featured, telescope, camera, mount, guider,
//           filterList, location, software, filterName[], filterFrames[],
//           filterMinutes[], description, platesolve, simbad, dzi, gitpush,
//           ra_deg, dec_deg, fov_hint, astrobin_id, annotations (JSON string)
//
// Does not return a value — all output is emitted as SSE events via jobEmit().
// Event shapes:
//   { type: 'step',    message }  — starting a named step
//   { type: 'ok',      message }  — step succeeded
//   { type: 'warn',    message }  — non-fatal warning
//   { type: 'progress',message }  — sub-step progress
//   { type: 'done',    slug }     — all done; slug is the published image slug
//   { type: 'error',   message }  — fatal error, pipeline stops
async function runPipeline(jobId, files, body) {
	const emit = (type, message) => jobEmit(jobId, { type, message });

	// Helper wrappers for cleaner call sites below.
	const step  = msg => emit('step',     msg);
	const ok    = msg => emit('ok',       msg);
	const warn  = msg => emit('warn',     msg);
	const prog  = msg => emit('progress', msg);
	const fail  = msg => { emit('error', msg); };

	// Temp directory for this job — cleaned up on success.
	const tmpDir = path.join(os.tmpdir(), `ingest-${jobId}`);
	fs.mkdirSync(tmpDir, { recursive: true });

	try {
		// ── 0. validate inputs ───────────────────────────────────────────────
		const jpgFile = files.jpg?.[0];
		const tifFile = files.tif?.[0];

		if (!jpgFile) {
			fail('No JPG file provided. JPG is required for preview, thumbnail, and plate-solve.');
			return;
		}

		const slug  = (body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
		const title = (body.title || 'Untitled').trim();

		if (!slug) {
			fail('No slug provided.');
			return;
		}

		step(`Starting pipeline for "${title}" (${slug})`);

		// Fast-fail if slug already exists — avoids running the full pipeline.
		// The definitive duplicate check happens inside the mutex at step 9 to
		// prevent a race between two jobs that both passed this check concurrently.
		{
			const fastCheck = JSON.parse(fs.readFileSync(IMAGES_JSON, 'utf8'));
			if (fastCheck.some(e => e.slug === slug)) {
				fail(`Slug "${slug}" already exists in images.json. Choose a unique slug.`);
				return;
			}
		}

		// ── init event: total step count for the progress bar ────────────────
		// Calculated up front based on which options are enabled so the client
		// can show a meaningful bar from the start.
		//   Always:                slug-start (1) + images.json write (1) = 2 base
		//   If tif present:        +1 (EXIF read)
		//   If platesolve=true:    +1 (ASTAP)
		//   If simbad=true:        +1 (only if platesolve is also true)
		//   Always:                +2 (preview WebP + thumbnail WebP)
		//   If tif + dzi=true:     +2 (DZI generation + R2 upload)
		//   If gitpush=true:       +1
		{
			let totalSteps = 2; // slug-start + images.json
			if (tifFile)                                       totalSteps += 1; // EXIF
			if (body.platesolve === 'true')                    totalSteps += 1; // ASTAP
			if (body.platesolve === 'true' && body.simbad === 'true') totalSteps += 1; // Simbad
			totalSteps += 2;  // preview + thumbnail WebP
			if (tifFile && body.dzi === 'true')                totalSteps += 2; // DZI + R2
			if (body.gitpush === 'true')                       totalSteps += 1; // git push
			// Emit the init event — the client uses totalSteps to size the bar.
			jobEmit(jobId, { type: 'init', totalSteps });
		}

		// ── 1. read FITS/EXIF metadata from TIF (optional, via exiftool) ────
		let exifMeta = {};
		if (tifFile) {
			step('Reading FITS/EXIF metadata from TIF...');
			const { stdout, error } = await run('exiftool', ['-j', '-a', tifFile.path]);
			if (!error && stdout.trim()) {
				try {
					const parsed = JSON.parse(stdout);
					exifMeta = parsed[0] || {};
					ok(`Metadata read: ${Object.keys(exifMeta).length} fields`);
				} catch {
					warn('Could not parse exiftool output; skipping metadata autofill.');
				}
			} else {
				warn('exiftool not installed or returned no data. Install with: sudo dnf install perl-Image-ExifTool');
			}
		}

		// ── cancellation check after step 1 ──────────────────────────────────
		if (isCancelled(jobId)) throw new CancelledError();

		// ── 2. plate-solve the JPG with ASTAP ────────────────────────────────
		let wcs = null;
		if (body.platesolve === 'true') {
			step('Running ASTAP plate-solve...');
			const jpgCopy = path.join(tmpDir, `${slug}.jpg`);
			fs.copyFileSync(jpgFile.path, jpgCopy);

			// -fov: approximate field of view in degrees (helps ASTAP narrow the search).
			// -z 2: downsample by 2× for speed (acceptable for centroid matching).
			// -r 30: search radius of 30 degrees if no initial position hint.
			// -d: path to the star database (D80 files in /opt/astap/).
			const fovHint = parseFloat(body.fov_hint || '0') || 3.0;
			// getConfig().astap_bin and .astap_db_dir are loaded at startup from
			// config.json and can be changed at runtime via POST /api/settings.
			// timeout: 60s — ASTAP can hang indefinitely on difficult fields;
			// this caps the wait and lets the pipeline continue without a solve.
			const { error: astapErr, stderr } = await run(
				getConfig().astap_bin,
				['-f', jpgCopy, '-fov', String(fovHint), '-z', '2', '-r', '30', '-d', getConfig().astap_db_dir],
				{ cwd: tmpDir, timeout: 60000 }
			);

			const iniPath = jpgCopy.replace(/\.jpg$/i, '.ini');
			wcs = parseAstapIni(iniPath);

			if (wcs) {
				ok(`Plate-solve: RA=${wcs.ra_deg.toFixed(4)}° Dec=${wcs.dec_deg.toFixed(4)}° scale=${wcs.pixScaleArcsec.toFixed(2)}\"/px`);
			} else {
				warn(`ASTAP could not solve the field. Continuing without WCS. (${stderr.trim().split('\n').pop() || 'no detail'})`);
			}
		}

		// ── cancellation check after step 2 (plate-solve) ────────────────────
		if (isCancelled(jobId)) throw new CancelledError();

		// ── 2b. get image pixel dimensions (used in Simbad + sky FOV calculation) ──
		// Called once here so both step 3 and step 8 can share the result without
		// spawning a second vips process on the same file.
		let imgW = null, imgH = null;
		if (wcs) {
			try {
				const dimOut = await runOrThrow('vips', ['header', jpgFile.path]);
				const wMatch = dimOut.match(/width:\s*(\d+)/);
				const hMatch = dimOut.match(/height:\s*(\d+)/);
				imgW = wMatch ? parseInt(wMatch[1]) : null;
				imgH = hMatch ? parseInt(hMatch[1]) : null;
			} catch { /* use null — callers fall back to defaults */ }
		}

		// ── 3. Simbad cone-search for annotation candidates ──────────────────
		let annotations = [];
		// Use any manually entered annotations from the form as the starting point.
		try {
			annotations = JSON.parse(body.annotations || '[]');
		} catch { annotations = []; }

		if (wcs && body.simbad === 'true') {
			step('Querying Simbad for objects in field of view...');
			try {
				// Use the pixel dimensions fetched in step 2b (fall back to common defaults).
				const effImgW = imgW || 6000;
				const effImgH = imgH || 4000;

				// Search radius = half the diagonal of the FOV.
				const fovW = effImgW * wcs.pixScaleDeg;
				const fovH = effImgH * wcs.pixScaleDeg;
				const radius = Math.sqrt(fovW * fovW + fovH * fovH) / 2;

				const objects = await simbadSearch(wcs.ra_deg, wcs.dec_deg, radius);
				ok(`Simbad found ${objects.length} non-stellar objects in field`);

				// Convert each object's sky position to image pixel fractions.
				// Only keep objects that fall within the image bounds (0..1).
				const fromSimbad = objects
					.map(obj => {
						const pos = skyToPixelFrac(obj.ra_deg, obj.dec_deg, wcs, effImgW, effImgH);
						return { name: obj.name, x: pos.x, y: pos.y, type: obj.type };
					})
					.filter(a => a.x >= 0 && a.x <= 1 && a.y >= 0 && a.y <= 1);

				// Merge: Simbad objects go first; any form-entered annotations are appended.
				annotations = [...fromSimbad, ...annotations];
				ok(`${fromSimbad.length} in-frame objects with pixel coordinates`);
			} catch (err) {
				warn(`Simbad search failed: ${err.message}`);
			}
		}

		// ── cancellation check after step 3 (Simbad) ─────────────────────────
		if (isCancelled(jobId)) throw new CancelledError();

		// Ensure the gallery output directory exists. Safe to call if it already exists.
		// On a fresh clone this directory is absent and vips thumbnail would fail silently.
		fs.mkdirSync(GALLERY_DIR, { recursive: true });

		// ── 4. generate preview WebP (2400px wide) from JPG ──────────────────
		step('Creating 2400px preview WebP...');
		const previewPath = path.join(GALLERY_DIR, `${slug}-preview.webp`);
		await runOrThrow(
			'vips', ['thumbnail', jpgFile.path, `${previewPath}[Q=82]`, '2400', '--size', 'down']
		);
		ok(`Preview WebP: ${previewPath}`);

		// ── 5. generate thumbnail WebP (600px wide) from JPG ─────────────────
		step('Creating 600px thumbnail WebP...');
		const thumbPath = path.join(GALLERY_DIR, `${slug}-thumb.webp`);
		await runOrThrow(
			'vips', ['thumbnail', jpgFile.path, `${thumbPath}[Q=80]`, '600', '--size', 'down']
		);
		ok(`Thumbnail WebP: ${thumbPath}`);

		// ── cancellation check after steps 4+5 (WebP generation) ────────────
		if (isCancelled(jobId)) throw new CancelledError();

		// ── 6. generate DZI tile tree from TIF (if TIF provided) ─────────────
		let dziUrl = null;
		if (tifFile && body.dzi === 'true') {
			step('Generating DZI tile tree from TIF (this may take a few minutes)...');
			const dziTmp    = path.join(tmpDir, 'dzi');
			const dziTarget = path.join(dziTmp, slug);
			fs.mkdirSync(dziTmp, { recursive: true });

			// vips dzsave creates:
			//   {dziTarget}.dzi  — the XML descriptor
			//   {dziTarget}_files/ — the tile directory tree
			// --tile-size 256: standard OSD tile size
			// --overlap 1: 1-pixel overlap (OSD default)
			// --depth onepixel: include a 1×1 top-level tile
			// --suffix .jpg[Q=90]: JPEG tiles at Q=90
			await runOrThrow(
				'vips',
				['dzsave', tifFile.path, dziTarget,
					'--tile-size', '256', '--overlap', '1',
					'--depth', 'onepixel', '--suffix', '.jpg[Q=90]'],
				{ timeout: 20 * 60 * 1000 }  // 20 min timeout for large TIFs
			);
			ok('DZI tiles generated');

			// ── 7. upload DZI to R2 ──────────────────────────────────────────
			step('Uploading DZI tiles to Cloudflare R2...');
			await uploadDziToR2(dziTmp, prog);
			dziUrl = `${R2_BASE_URL}/${slug}.dzi`;
			ok(`DZI live at ${dziUrl}`);
		}

		// ── cancellation check after step 6+7 (DZI + R2) ─────────────────────
		if (isCancelled(jobId)) throw new CancelledError();

		// ── 8. build the new images.json entry ───────────────────────────────
		step('Building images.json entry...');

		// Parse filter rows from the form.
		// The form sends filterName[], filterFrames[], filterMinutes[] arrays.
		const filterNames   = [].concat(body.filterName   || []);
		const filterFrames  = [].concat(body.filterFrames || []);
		const filterMinutes = [].concat(body.filterMinutes || []);
		const filters = filterNames
			.map((name, i) => ({
				name:    name.trim(),
				frames:  parseInt(filterFrames[i]) || null,
				minutes: parseInt(filterMinutes[i]) || null,
			}))
			.filter(f => f.name);

		// Parse tags (comma-separated string from the form).
		const tags = (body.tags || '').split(',').map(t => t.trim()).filter(Boolean);

		// Parse catalogs array (checkboxes).
		const catalogs = [].concat(body.catalogs || []).filter(Boolean);

		// Build sky data from WCS or manually entered values.
		const manualRa    = parseFloat(body.ra_deg)  || null;
		const manualDec   = parseFloat(body.dec_deg) || null;
		const manualFovW  = parseFloat(body.fov_w)   || null;
		const manualFovH  = parseFloat(body.fov_h)   || null;

		const finalRa    = wcs?.ra_deg  ?? manualRa;
		const finalDec   = wcs?.dec_deg ?? manualDec;

		let skyData = null;
		if (finalRa != null && finalDec != null) {
			// Use pixel dimensions from step 2b to compute FOV if not manually supplied.
			let fovW = manualFovW;
			let fovH = manualFovH;
			if (wcs && (!fovW || !fovH) && imgW && imgH) {
				fovW = imgW * wcs.pixScaleDeg;
				fovH = imgH * wcs.pixScaleDeg;
			}

			skyData = {
				ra:            raToStr(finalRa),
				dec:           decToStr(finalDec),
				fov_deg:       (fovW > 0 || fovH > 0) ? parseFloat((Math.max(fovW || 0, fovH || 0)).toFixed(3)) : null,
				aladin_target: (body.catalog || '').split('/')[0].trim() || null,
				ra_deg:        parseFloat(finalRa.toFixed(4)),
				dec_deg:       parseFloat(finalDec.toFixed(4)),
				fov_w:         fovW ? parseFloat(fovW.toFixed(3)) : null,
				fov_h:         fovH ? parseFloat(fovH.toFixed(3)) : null,
			};
		}

		// astrobin_id links to the image on AstroBin (used in image.njk for the "View on AstroBin" link).
		// It is optional — null means no AstroBin link is rendered.
		const astrobinId = (body.astrobin_id || '').trim() || null;

		// Build the new images.json entry using the variant schema.
		// Top level: target metadata shared across all variants.
		// variants[]: array with one "default" variant containing all per-session
		// data (equipment, acquisition, sky, image URLs, annotations).
		// See VARIANT-REVISION-PLAN.md for full schema documentation.
		//
		// target: the primary astronomical object name, derived from the first
		// slash-separated segment of the catalog field (e.g. "NGC 2070 / 30 Doradus"
		// → target "NGC 2070"). Used by the frontend for "See Also" cross-links
		// when multiple images share the same target.
		const newEntry = {
			slug,
			title,
			target:      (body.catalog || '').split('/')[0].trim() || null,
			catalog:     (body.catalog || '').trim() || null,
			tags,
			catalogs:    catalogs.length ? catalogs : [],
			featured:    body.featured === 'true',
			astrobin_id: astrobinId,
			description: (body.description || '').trim() || null,
			// variants[]: each variant represents a distinct imaging session —
			// different equipment, acquisition parameters, or field of view.
			// A new ingest always creates one "default" variant.
			// Future variants (e.g. widefield, narrowband) are added via the
			// "add-variant" targeting mode.
			variants: [{
				id:                'default',
				label:             null,
				primary:           true,
				date:              body.date || new Date().toISOString().slice(0, 10),
				thumbnail:         `/assets/img/gallery/${slug}-thumb.webp`,
				preview_url:       `/assets/img/gallery/${slug}-preview.webp`,
				full_url:          null,
				dzi_url:           dziUrl,
				annotated_dzi_url: null,
				annotated_url:     null,
				annotations:       annotations.length ? annotations : [],
				equipment: {
					telescope: (body.telescope || '').trim() || null,
					camera:    (body.camera    || '').trim() || null,
					mount:     (body.mount     || '').trim() || null,
					guider:    (body.guider    || '').trim() || null,
					filters:   (body.filterList|| '').trim() || null,
					location:  (body.location  || '').trim() || null,
					software:  (body.software  || '').trim() || null,
				},
				acquisition: filters.length ? { filters } : { filters: [] },
				sky:         skyData,
				// revisions[]: reprocessed versions of the same data.
				// Empty on first ingest; added later via "add-revision" mode.
				revisions:   [],
			}],
		};

		// ── 9. prepend entry to images.json ──────────────────────────────────
		// Wrapped in a mutex so concurrent pipeline runs are serialised — the
		// read-modify-write is atomic from the perspective of other jobs on this
		// server process, preventing silent data loss from races.
		await withImagesMutex(async () => {
			const existing = JSON.parse(fs.readFileSync(IMAGES_JSON, 'utf8'));
			// Definitive duplicate check inside the mutex — the fast-fail at the
			// top of the pipeline catches the common case, but two jobs could both
			// pass that check before either reaches here.
			if (existing.some(e => e.slug === slug)) {
				throw new Error(`Slug "${slug}" already exists in images.json. Choose a unique slug.`);
			}
			existing.unshift(newEntry);
			fs.writeFileSync(IMAGES_JSON, JSON.stringify(existing, null, '\t'), 'utf8');
		});
		ok('images.json updated');

		// ── 10. git add / commit / push ───────────────────────────────────────
		if (body.gitpush === 'true') {
			step('Committing and pushing to GitHub...');

			// Pass each file path as a separate array element — execFile sends them
			// directly to git with no shell interpretation, so no quoting needed.
			await runOrThrow('git', ['-C', PROJECT_ROOT, 'add', IMAGES_JSON, previewPath, thumbPath]);

			// Write the commit message to a temp file. With execFile the -F flag is
			// safe regardless, but this also keeps the message out of the process
			// argument list (visible in `ps`) for any future sensitive content.
			const msgFile = path.join(tmpDir, 'commit-msg.txt');
			fs.writeFileSync(msgFile, `Add image: ${title}\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`);
			await runOrThrow('git', ['-C', PROJECT_ROOT, 'commit', '-F', msgFile]);
			await runOrThrow('git', ['-C', PROJECT_ROOT, 'push']);
			ok('Pushed to GitHub');
		}

		// ── done ──────────────────────────────────────────────────────────────
		jobEmit(jobId, { type: 'done', slug, title });

	} catch (err) {
		if (err instanceof CancelledError) {
			// User cancelled — not an error. The DELETE route already emitted the
			// 'cancelled' event; just close the stream with a done event (no slug).
			jobEmit(jobId, { type: 'done', slug: null, cancelled: true });
		} else {
			fail(`Pipeline error: ${err.message}`);
			jobEmit(jobId, { type: 'done', slug: null, error: err.message });
		}
	} finally {
		// Clean up temp files.
		fs.rmSync(tmpDir, { recursive: true, force: true });
		// Also remove the multer temp uploads.
		for (const key of Object.keys(files)) {
			for (const f of files[key]) {
				fs.rm(f.path, () => {});
			}
		}
	}
}

// ─── route: POST /api/process ─────────────────────────────────────────────────
// Accepts multipart form data with files (jpg, tif) and form fields.
// Returns { jobId } immediately; client connects to /api/progress/:jobId for SSE.
app.post('/api/process',
	upload.fields([
		{ name: 'jpg', maxCount: 1 },
		{ name: 'tif', maxCount: 1 },
	]),
	(req, res) => {
		const jobId = crypto.randomUUID();
		// cancelled — set to true by DELETE /api/jobs/:jobId; checked between
		// pipeline steps so the run can exit cleanly without treating it as an error.
		jobs.set(jobId, { events: [], listeners: [], status: 'running', cancelled: false });

		// Start the pipeline asynchronously so we can return the jobId immediately.
		runPipeline(jobId, req.files || {}, req.body)
			.then(() => {
				const job = jobs.get(jobId);
				if (job) job.status = 'done';
			})
			.catch(err => {
				jobEmit(jobId, { type: 'error', message: err.message });
			})
			.finally(() => {
				// Remove the job from memory after 30 minutes.
				// The client receives all events well before then; this prevents
				// the jobs Map from growing indefinitely across many ingest runs.
				setTimeout(() => jobs.delete(jobId), 30 * 60 * 1000);
			});

		res.json({ jobId });
	}
);

// ─── route: GET /api/progress/:jobId ─────────────────────────────────────────
// Server-Sent Events stream for pipeline progress.
// Replays any buffered events so the client can reconnect and catch up.
app.get('/api/progress/:jobId', (req, res) => {
	const job = jobs.get(req.params.jobId);
	if (!job) return res.status(404).json({ error: 'Job not found' });

	res.setHeader('Content-Type',  'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Connection',    'keep-alive');
	res.flushHeaders();

	// Replay buffered events for reconnecting clients.
	job.events.forEach(line => res.write(line));

	if (job.status === 'done') {
		return res.end();
	}

	// Register as a live listener for future events.
	const listener = line => res.write(line);
	job.listeners.push(listener);

	// Remove this listener when the client disconnects.
	req.on('close', () => {
		const idx = job.listeners.indexOf(listener);
		if (idx >= 0) job.listeners.splice(idx, 1);
	});
});

// ─── route: DELETE /api/jobs/:jobId ──────────────────────────────────────────
// Marks a job as cancelled so runPipeline exits cleanly between steps.
// The pipeline reads isCancelled() after each step; when true it throws
// CancelledError, which the catch block handles without emitting an error event.
// Response: { ok: true }
app.delete('/api/jobs/:jobId', (req, res) => {
	const job = jobs.get(req.params.jobId);
	if (!job) return res.status(404).json({ error: 'Job not found' });

	job.cancelled = true;
	// Emit the cancellation event so the SSE client can update the UI immediately
	// (the pipeline may still be mid-step and not see the flag yet).
	jobEmit(req.params.jobId, { type: 'cancelled', message: 'Job cancelled by user.' });
	res.json({ ok: true });
});

// ─── route: GET /api/check-slug ───────────────────────────────────────────────
// Checks whether a slug already exists in images.json.
// Query param: ?slug=horsehead-nebula
// Response: { exists: true|false }
// Used by the ingest UI to validate slugs before starting the pipeline.
app.get('/api/check-slug', (req, res) => {
	const slug = (req.query.slug || '').trim().toLowerCase();
	if (!slug) return res.json({ exists: false });
	try {
		const images = JSON.parse(fs.readFileSync(IMAGES_JSON, 'utf8'));
		res.json({ exists: images.some(img => img.slug === slug) });
	} catch {
		// If images.json can't be read, fail open so the pipeline can give the
		// definitive error when it runs the mutex-protected duplicate check.
		res.json({ exists: false });
	}
});

// ─── route: POST /api/metadata ────────────────────────────────────────────────
// Reads FITS/EXIF metadata from an uploaded TIF file.
// Returns a flat JSON object of potentially useful fields.
// Called by the frontend immediately when a TIF is selected, before the full pipeline.
app.post('/api/metadata',
	upload.single('tif'),
	async (req, res) => {
		if (!req.file) return res.json({});
		try {
			const { stdout } = await run('exiftool', ['-j', '-a', req.file.path]);
			if (!stdout.trim()) return res.json({});
			const parsed = JSON.parse(stdout);
			const raw = parsed[0] || {};

			// Extract fields that we can use to pre-populate the form.
			// Different astrophotography apps write these in different ways.
			const result = {
				// N.I.N.A. / FITS-derived fields (may appear under fits:* XMP namespace).
				object:    raw['fits:OBJECT']    || raw['FITS_OBJECT']  || raw['XMP:fits.OBJECT']  || null,
				telescop:  raw['fits:TELESCOP']  || raw['FITS_TELESCOP']|| null,
				instrume:  raw['fits:INSTRUME']  || raw['FITS_INSTRUME']|| null,
				dateObs:   raw['fits:DATE-OBS']  || raw['FITS_DATE-OBS']|| raw['DateTimeOriginal'] || null,
				ra:        raw['fits:RA']        || raw['FITS_RA']      || null,
				dec:       raw['fits:DEC']       || raw['FITS_DEC']     || null,
				filter:    raw['fits:FILTER']    || raw['FITS_FILTER']  || null,
				exptime:   raw['fits:EXPTIME']   || raw['FITS_EXPTIME'] || null,
				software:  raw['fits:SWCREATE']  || raw['Software']     || null,
				// Generic EXIF/IPTC fields.
				imageDesc: raw['ImageDescription'] || raw['Description'] || null,
			};

			// Remove nulls before sending.
			Object.keys(result).forEach(k => result[k] == null && delete result[k]);
			res.json(result);
		} catch (err) {
			res.json({});
		} finally {
			fs.rm(req.file.path, () => {});
		}
	}
);

// ─── route: GET /api/equipment ───────────────────────────────────────────────
// Returns the equipment presets from equipment.json.
app.get('/api/equipment', (req, res) => {
	try {
		const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'equipment.json'), 'utf8'));
		res.json(data);
	} catch {
		res.json({ personal: [], itelescope: [] });
	}
});

// ─── route: GET /api/settings ─────────────────────────────────────────────────
// Returns the current operational settings (from config.json loaded at startup).
// R2 credentials are intentionally excluded from the API response — they are
// sensitive and should only be edited directly in config.json, not exposed over HTTP.
// Response: { astap_bin, astap_db_dir, port }
app.get('/api/settings', (req, res) => {
	const cfg = getConfig();
	res.json({
		astap_bin:    cfg.astap_bin,
		astap_db_dir: cfg.astap_db_dir,
		port:         cfg.port,
	});
});

// ─── route: POST /api/settings ────────────────────────────────────────────────
// Accepts { astap_bin, astap_db_dir, port }, validates, writes to config.json,
// and updates the in-memory config for the current session.
// Port changes require a restart — the response includes restartRequired: true
// if the port value differs from what the server is currently listening on.
// Response: { ok: true, config: { astap_bin, astap_db_dir, port }, restartRequired? }
app.post('/api/settings', (req, res) => {
	const { astap_bin, astap_db_dir, port } = req.body;

	// Validate: all three fields must be present.
	if (!astap_bin || typeof astap_bin !== 'string' || !astap_bin.trim()) {
		return res.status(400).json({ error: 'astap_bin must be a non-empty string.' });
	}
	if (!astap_db_dir || typeof astap_db_dir !== 'string' || !astap_db_dir.trim()) {
		return res.status(400).json({ error: 'astap_db_dir must be a non-empty string.' });
	}
	if (port === undefined || port === null || port === '') {
		return res.status(400).json({ error: 'port must be provided.' });
	}
	const portNum = parseInt(port, 10);
	if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
		return res.status(400).json({ error: 'port must be a number between 1 and 65535.' });
	}

	// Was the port changed? Check BEFORE saving so we compare against the old value.
	const restartRequired = portNum !== getConfig().port;

	// saveConfig() merges the patch into the existing config (preserving R2
	// credentials and any other keys not in the patch), writes to config.json,
	// and updates the in-memory config for the current session.
	let newConfig;
	try {
		newConfig = saveConfig({
			astap_bin:    astap_bin.trim(),
			astap_db_dir: astap_db_dir.trim(),
			port:         portNum,
		});
	} catch (err) {
		return res.status(500).json({ error: `Could not write config.json: ${err.message}` });
	}

	const response = { ok: true, config: newConfig };
	if (restartRequired) response.restartRequired = true;
	res.json(response);
});

// ─── startup checks ───────────────────────────────────────────────────────────
console.log('\n── dustin-space ingest server ──────────────────────────────');

// Check for required external tools and warn about optional ones.
// Each entry has bin (the executable) and args (argument array) — passed directly
// to execFileSync so no shell is involved, same as the rest of the codebase.
const checks = [
	{ bin: 'vips',     args: ['--version'],       name: 'vips',     required: true  },
	// Check that the configured ASTAP binary actually exists on disk.
	// getConfig().astap_bin is loaded from config.json by loadConfig() above.
	{ bin: 'ls',       args: [getConfig().astap_bin],  name: 'astap',    required: false },
	// wrangler no longer required for R2 uploads — SDK handles it directly.
	{ bin: 'wrangler', args: ['--version'],        name: 'wrangler', required: false },
	{ bin: 'git',      args: ['--version'],        name: 'git',      required: true  },
	{ bin: 'exiftool', args: ['-ver'],             name: 'exiftool', required: false },
];

for (const check of checks) {
	try {
		execFileSync(check.bin, check.args, { stdio: 'pipe', timeout: 5000 });
		console.log(`  ✓ ${check.name}`);
	} catch {
		const flag = check.required ? '✗ (REQUIRED)' : '○ (optional)';
		console.log(`  ${flag} ${check.name}`);
		if (check.name === 'exiftool') {
			console.log('    → Install: sudo dnf install perl-Image-ExifTool');
		}
	}
}

console.log(`\n  Project root : ${PROJECT_ROOT}`);
console.log(`  images.json  : ${IMAGES_JSON}`);
console.log(`  Gallery dir  : ${GALLERY_DIR}`);
console.log(`  R2 bucket    : ${R2_BUCKET}`);

// Warn if R2 credentials are still the placeholder strings from config.json.
// DZI tile uploads will fail at runtime until all three are replaced.
if (
	getConfig().r2_account_id.startsWith('FILL_IN') ||
	getConfig().r2_access_key_id.startsWith('FILL_IN') ||
	getConfig().r2_secret_access_key.startsWith('FILL_IN')
) {
	console.log('\n  ⚠  R2 credentials not set — DZI tile uploads will fail.');
	console.log('     Edit ingest/config.json and replace the three FILL_IN values.');
	console.log('     See the config comment in server.js for the click path.\n');
}

console.log('\n────────────────────────────────────────────────────────────\n');

// getConfig().port is loaded from config.json by loadConfig() above.
// Port changes written via POST /api/settings only take effect on the next restart.
// Bind to 127.0.0.1 (localhost only) instead of the default 0.0.0.0 (all interfaces).
// Without the explicit host, anyone on your LAN could reach the ingest UI.
app.listen(getConfig().port, '127.0.0.1', () => {
	console.log(`  Ready → http://localhost:${getConfig().port}\n`);
});
