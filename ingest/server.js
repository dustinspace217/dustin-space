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

// ─── config ───────────────────────────────────────────────────────────────────
// Manages instance-specific settings (ASTAP paths, R2 credentials, port) in
// ingest/config.json (gitignored). See lib/config.js for full docs.
const { loadConfig, getConfig } = require('./lib/config');

// Load config once at startup. getConfig() returns the current in-memory copy;
// setConfig()/saveConfig() update it at runtime (e.g. via POST /api/settings).
loadConfig();

// ─── paths ────────────────────────────────────────────────────────────────────

// The dustin-space project root is one level up from this ingest/ directory.
const PROJECT_ROOT  = path.resolve(__dirname, '..');
const IMAGES_JSON   = path.join(PROJECT_ROOT, 'src/_data/images.json');
const GALLERY_DIR   = path.join(PROJECT_ROOT, 'src/assets/img/gallery');

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
const { withImagesMutex, jobEmit, isCancelled, CancelledError } = require('./lib/jobs');

// ─── safe child process helpers ───────────────────────────────────────────────
// Wraps execFile (no shell) so external binaries can't be shell-injected.
// See lib/exec.js for full docs.
const { run, runOrThrow } = require('./lib/exec');

// ─── RA/Dec formatting ────────────────────────────────────────────────────────
// Converts decimal degrees (from ASTAP WCS) to sexagesimal strings. See lib/coordinates.js.
const { raToStr, decToStr } = require('./lib/coordinates');

// ─── plate-solving helpers ───────────────────────────────────────────────────
// ASTAP .ini parser and sky→pixel coordinate converter. See lib/platesolve.js.
const { parseAstapIni, skyToPixelFrac } = require('./lib/platesolve');

// ─── Simbad TAP queries ──────────────────────────────────────────────────────
// Cone search for non-stellar objects in the field of view. See lib/simbad.js.
const { simbadSearch } = require('./lib/simbad');

// ─── vips image processing ───────────────────────────────────────────────────
// WebP preview/thumbnail generation, DZI tiling, and dimension reading. See lib/images.js.
const { generatePreviewWebp, generateThumbWebp, generateDzi, getImageDimensions } = require('./lib/images');

// ─── R2 uploads ──────────────────────────────────────────────────────────────
// Lazy S3Client, single-file upload, and DZI directory upload. See lib/r2.js.
const { R2_BUCKET, R2_BASE_URL, uploadDziToR2 } = require('./lib/r2');

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
			const dims = await getImageDimensions(jpgFile.path);
			imgW = dims.width;
			imgH = dims.height;
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
		await generatePreviewWebp(jpgFile.path, previewPath);
		ok(`Preview WebP: ${previewPath}`);

		// ── 5. generate thumbnail WebP (600px wide) from JPG ─────────────────
		step('Creating 600px thumbnail WebP...');
		const thumbPath = path.join(GALLERY_DIR, `${slug}-thumb.webp`);
		await generateThumbWebp(jpgFile.path, thumbPath);
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

			// generateDzi wraps vips dzsave — creates {dziTarget}.dzi (XML descriptor)
			// and {dziTarget}_files/ (tile tree). See lib/images.js for all options.
			await generateDzi(tifFile.path, dziTarget);
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

// ─── route mounting ──────────────────────────────────────────────────────────
// Each route group is an Express Router in routes/*.js.
// Factory routers receive dependencies (upload, runPipeline, paths) as arguments.
// All routes are mounted under /api/ so the Router paths are relative (e.g. /process).

const createProcessRouter  = require('./routes/process');
const createMetadataRouter = require('./routes/metadata');
const createMiscRouter     = require('./routes/misc');
const settingsRouter       = require('./routes/settings');

app.use('/api', createProcessRouter({ upload, runPipeline }));
app.use('/api', createMetadataRouter({ upload }));
app.use('/api', createMiscRouter({ IMAGES_JSON }));
app.use('/api', settingsRouter);

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
