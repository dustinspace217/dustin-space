/**
 * pipeline.js — Ingest pipeline orchestrator with targeting mode support
 *
 * Processes one ingest job end-to-end. Supports three targeting modes:
 *   new-target   — creates a new top-level gallery entry
 *   add-variant  — adds a variant to an existing target
 *   add-revision — adds a revision to an existing variant
 *
 * Progress is streamed to the browser via SSE events through jobEmit().
 *
 * Performance improvements over the original inline pipeline:
 *   1. Preview + thumbnail WebP generation run in parallel (Promise.all)
 *   2. WebP generation overlaps with the plate-solve + Simbad chain
 *      (both branches run concurrently, results joined with Promise.all)
 *
 * Exports:
 *   runPipeline(jobId, files, body) — the main pipeline function
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { getConfig }    = require('./config');
// exec is required as a NAMESPACE (not destructured) for the same reason the
// three side-effect modules below are: runPipeline binds function-local
// overridable copies of run/runOrThrow (the DI seam), and `const run = deps.run
// || run` would self-reference and throw in the temporal dead zone.
const execLib = require('./exec');
const { jobEmit, isCancelled, CancelledError } = require('./jobs');
const { raToStr, decToStr } = require('./coordinates');
const { parseXisfWcs, isWcsDegenerate, solveWithAstrometry, skyToPixelFrac, buildAnnotations } = require('./platesolve');
const { simbadSearch }      = require('./simbad');
const { loadCatalog, lookupSize } = require('./catalog');
// These three modules hold every side-effecting dependency the pipeline can be
// run against a fake in tests (see the DI seam at the top of runPipeline). They
// are required as NAMESPACES so runPipeline can bind function-local overridable
// copies WITHOUT a same-name temporal-dead-zone clash (`const foo = deps.foo ||
// foo` self-references and throws). The non-injectable constants (the R2 URLs,
// the images.json path) are pulled out directly here since nothing overrides them.
const imagesLib  = require('./images');
const r2Lib      = require('./r2');
const galleryLib = require('./gallery');
const { R2_BASE_URL, R2_BUCKET } = r2Lib;
const { IMAGES_JSON }            = galleryLib;
// Namespace require (see the exec note above): validateBuild is injectable via
// the runPipeline deps seam so tests can force a passing/failing build gate.
const validateBuildLib = require('./validateBuild');

// Human-readable reasons for a failed XISF plate-solve read. parseXisfWcs (W3)
// returns { wcs, reason }; this maps the machine `reason` to a message the owner
// can act on — an I/O failure ("re-export the file") reads differently from a
// file that was simply never plate-solved ("solve it in PixInsight first").
const XISF_FAIL_REASONS = {
	io_error:    'the file could not be read (missing or permission denied)',
	no_solution: 'it was never plate-solved (no PLTSOLVD / TAN marker)',
	no_wcs:      'it is marked solved but carries no CD/CDELT scale keywords',
	invalid_wcs: 'its WCS keywords were present but not finite numbers',
};

// ─── paths ──────────────────────────────────────────────────────────────────
// The dustin-space project root is two levels up from lib/ (lib → ingest → project root).
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const GALLERY_DIR  = path.join(PROJECT_ROOT, 'src/assets/img/gallery');

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
		.replace(/\s+-\s+.*$/, '')          // strip suffix after " - " (e.g. " — Eastern Veil")
		.trim()
		.toLowerCase();
}

/**
 * runPipeline — process one ingest job end-to-end.
 *
 * @param {string} jobId — UUID string from POST /api/process
 * @param {object} files — req.files from multer: { jpg: [File], tif: [File], xisf: [File] }
 * @param {object} body  — req.body form fields. Mode-specific fields:
 *
 *   All modes:
 *     slug, title, date, telescope, camera, mount, guider, filterList,
 *     location, software, filterName[], filterFrames[], filterMinutes[],
 *     platesolve, simbad, dzi, gitpush, fov_hint, annotations
 *
 *   new-target only:
 *     catalog, tags, catalogs, featured, description, astrobin_id, ra_deg, dec_deg
 *
 *   add-variant:
 *     mode='add-variant', parentSlug, variantId, variantLabel
 *
 *   add-revision:
 *     mode='add-revision', parentSlug, parentVariantId, revisionId,
 *     revisionLabel, revisionNote, isFinal
 */
async function runPipeline(jobId, files, body, deps) {
	// ── dependency-injection seam (W2/W7) ────────────────────────────────────────
	// The optional 4th `deps` argument lets tests exercise the whole orchestrator
	// without touching R2, vips, git, or the checked-in images.json: each member
	// OVERRIDES the real module function when present, otherwise the real import is
	// used. Bound as function-local consts so every existing call site below
	// resolves to the injected fake with no per-call changes. The tests detect this
	// seam by runPipeline's declared arity (>= 4) — so `deps` has NO default value
	// (a defaulted trailing param is excluded from Function.length, which would
	// read 3 and keep the tests skipped); it's normalized to {} on the next line.
	deps = deps || {};
	const getImageDimensions   = deps.getImageDimensions   || imagesLib.getImageDimensions;
	const generatePreviewWebp  = deps.generatePreviewWebp  || imagesLib.generatePreviewWebp;
	const generateThumbWebp    = deps.generateThumbWebp    || imagesLib.generateThumbWebp;
	const generateDzi          = deps.generateDzi          || imagesLib.generateDzi;
	const uploadDziToR2        = deps.uploadDziToR2         || r2Lib.uploadDziToR2;
	const addTarget            = deps.addTarget            || galleryLib.addTarget;
	const addVariant           = deps.addVariant           || galleryLib.addVariant;
	const addRevision          = deps.addRevision          || galleryLib.addRevision;
	const findTarget           = deps.findTarget           || galleryLib.findTarget;
	const slugExists           = deps.slugExists           || galleryLib.slugExists;
	// The 1200px generator is newer (W6) than the DI test contract, so a caller
	// that injects the 2400px preview generator (a fake/test context) but not the
	// 1200 one falls back to that injected 2400 generator rather than the real
	// vips call — which would fail on a fake/empty source. Production (no deps)
	// still uses the real 1200 generator. Explicit deps.generatePreview1200Webp
	// wins over both when a test wants to assert on it specifically.
	const generatePreview1200Webp = deps.generatePreview1200Webp || deps.generatePreviewWebp || imagesLib.generatePreview1200Webp;
	// exec + build-gate seam (W2). run drives exiftool; runOrThrow drives the git
	// add/commit/push; validateBuild is the pre-push production-build gate. Injected
	// so the gitpush-path tests can fake the build result and capture git calls
	// WITHOUT spawning real git or Eleventy. Production (no deps) uses the reals.
	const run          = deps.run          || execLib.run;
	const runOrThrow   = deps.runOrThrow   || execLib.runOrThrow;
	const validateBuild = deps.validateBuild || validateBuildLib.validateBuild;

	const emit = (type, message) => jobEmit(jobId, { type, message });

	const step = msg => emit('step',     msg);
	const ok   = msg => emit('ok',       msg);
	const warn = msg => emit('warn',     msg);
	const prog = msg => emit('progress', msg);
	// fail() emits both an error event and a done event so the frontend
	// always receives a terminal event. Without the done event, early
	// returns (missing JPG, duplicate slug, etc.) would deadlock the UI:
	// publish button stays disabled, timer counts forever, status stuck.
	const fail = msg => {
		emit('error', msg);
		jobEmit(jobId, { type: 'done', slug: null, error: msg });
	};

	const tmpDir = path.join(os.tmpdir(), `ingest-${jobId}`);
	fs.mkdirSync(tmpDir, { recursive: true });

	// Temp WebP paths (jobId-prefixed) live in the outer scope so the finally
	// block can always clean them up on cancel/failure/dup-slug, even if an
	// error fires before the mode-specific rename runs. Set once filePrefix is
	// known (below). Issue #67.
	let previewTmpPath = null, thumbTmpPath = null, preview1200TmpPath = null;

	// Tracks R2 upload state so the cancel handler (catch block below) can tell
	// the owner which tiles are orphaned. R2 has no transactional rollback — a
	// cancel after tiles are uploaded leaves them in the bucket. Null until the
	// DZI upload starts, then { prefix, uploadedCount }. Issue #73.
	let r2OrphanInfo = null;

	try {
		// ── 0. determine mode and validate inputs ────────────────────────────
		const mode = body.mode || 'new-target';
		const jpgFile  = files.jpg?.[0];
		const tifFile  = files.tif?.[0];
		const xisfFile = files.xisf?.[0];

		if (!jpgFile) {
			fail('No JPG file provided. JPG is required for preview, thumbnail, and plate-solve.');
			return;
		}

		// Slug is the target slug for new-target, or the parent slug for add-variant/add-revision.
		const slug = mode === 'new-target'
			? (body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
			: (body.parentSlug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
		const title = (body.title || 'Untitled').trim();

		if (!slug) {
			fail(mode === 'new-target' ? 'No slug provided.' : 'No parent slug provided.');
			return;
		}

		// Mode-specific IDs and validation.
		let variantId, revisionId;

		if (mode === 'new-target') {
			step(`Starting pipeline for "${title}" (${slug})`);
			if (slugExists(slug)) {
				fail(`Slug "${slug}" already exists in images.json. Choose a unique slug.`);
				return;
			}
		} else if (mode === 'add-variant') {
			variantId = (body.variantId || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
			if (!variantId) { fail('No variant ID provided.'); return; }
			const target = findTarget(slug);
			if (!target) { fail(`Target "${slug}" not found in images.json.`); return; }
			if (target.variants.some(v => v.id === variantId)) {
				fail(`Variant "${variantId}" already exists on target "${slug}".`);
				return;
			}
			step(`Adding variant "${variantId}" to "${target.title}" (${slug})`);
		} else if (mode === 'add-revision') {
			// Sanitize parentVariantId the same way as other IDs.
			const parentVariantId = (body.parentVariantId || 'default').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
			revisionId = (body.revisionId || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
			if (!revisionId) { fail('No revision ID provided.'); return; }
			const target = findTarget(slug);
			if (!target) { fail(`Target "${slug}" not found in images.json.`); return; }
			const variant = target.variants.find(v => v.id === parentVariantId);
			if (!variant) {
				fail(`Variant "${parentVariantId}" not found on target "${slug}".`);
				return;
			}
			// Array.isArray guard: legacy variants predate revisions[] and may have it
			// undefined, so a bare `.some` here throws a raw TypeError before the mutex
			// even runs. Mirrors the advisory re-check at line ~549 and the authoritative
			// normalization in gallery.js addRevision. A missing revisions[] means zero
			// existing revisions, so the dup-check is simply skipped. Issue W3/SOL-CONF.
			if (Array.isArray(variant.revisions) && variant.revisions.some(r => r.id === revisionId)) {
				fail(`Revision "${revisionId}" already exists on variant "${parentVariantId}".`);
				return;
			}
			variantId = parentVariantId; // used for context in messages
			step(`Adding revision "${revisionId}" to "${target.title}" / ${parentVariantId}`);
		} else {
			fail(`Unknown mode: "${mode}". Expected new-target, add-variant, or add-revision.`);
			return;
		}

		// File prefix determines output filenames for WebP, DZI, and R2 keys.
		// new-target:   slug                    → horsehead-nebula-preview.webp
		// add-variant:  slug-variantId           → horsehead-nebula-widefield-preview.webp
		// add-revision: slug-revisionId          → horsehead-nebula-v2-preview.webp
		const filePrefix = mode === 'new-target'   ? slug
			: mode === 'add-variant'  ? `${slug}-${variantId}`
			:                           `${slug}-${revisionId}`;

		// Assign the jobId-prefixed temp WebP paths now that filePrefix is known.
		// The jobId makes them unique per run so two concurrent same-slug jobs
		// never collide on the temp files either; the ".tmp-" prefix marks them
		// as transient scratch files (the finally block always clears them). Issue #67.
		previewTmpPath     = path.join(GALLERY_DIR, `.tmp-${jobId}-${filePrefix}-preview.webp`);
		preview1200TmpPath = path.join(GALLERY_DIR, `.tmp-${jobId}-${filePrefix}-preview-1200.webp`);
		thumbTmpPath       = path.join(GALLERY_DIR, `.tmp-${jobId}-${filePrefix}-thumb.webp`);

		// Plate-solve and Simbad are skipped for revisions — the data is
		// inherited from the parent variant (same target, same field of view).
		const doPlatesolve = mode !== 'add-revision' && body.platesolve === 'true';
		const doSimbad     = mode !== 'add-revision' && body.simbad === 'true';

		// ── init event: total step count for the progress bar ────────────────
		{
			let totalSteps = 2; // start + images.json write
			if (tifFile)                          totalSteps += 1; // EXIF
			if (doPlatesolve)                     totalSteps += 1; // plate-solve (XISF or astrometry.net)
			if (doPlatesolve && doSimbad)          totalSteps += 1; // Simbad
			totalSteps += 1; // WebP generation (preview + thumb run in parallel, count as 1)
			if (tifFile && body.dzi === 'true')   totalSteps += 2; // DZI + R2
			if (body.gitpush === 'true')          totalSteps += 2; // build validation + git push
			jobEmit(jobId, { type: 'init', totalSteps });
		}

		// ── 1. read FITS/EXIF metadata from TIF (optional) ──────────────────
		if (tifFile) {
			step('Reading FITS/EXIF metadata from TIF...');
			const { stdout, error } = await run('exiftool', ['-j', '-a', tifFile.path]);
			if (!error && stdout.trim()) {
				try {
					const parsed = JSON.parse(stdout);
					ok(`Metadata read: ${Object.keys(parsed[0] || {}).length} fields`);
				} catch {
					warn('Could not parse exiftool output; skipping metadata autofill.');
				}
			} else {
				warn('exiftool not installed or returned no data.');
			}
		}

		if (isCancelled(jobId)) throw new CancelledError();

		// ── 2-3. plate-solve + Simbad (parallel with WebP generation) ────────
		// These two branches run concurrently:
		//   skyBranch:  plate-solve (XISF or astrometry.net) → Simbad cone-search → sky data
		//   webpBranch: preview WebP + thumbnail WebP in parallel
		// The branches are joined before DZI generation.

		// --- sky branch (plate-solve + Simbad) ---
		const skyBranch = (async () => {
			let wcs = null;
			let imgW = null, imgH = null;
			let annotations = [];
			// annotations_status is hoisted to skyBranch scope so the return
			// statement always carries it (defaults to 'no_simbad' when the
			// Simbad step is skipped entirely; gets reassigned inside the
			// `if (wcs && doSimbad)` block when Simbad runs). Issue #85.
			let annotationsStatus = 'no_simbad';
				try {
					annotations = JSON.parse(body.annotations || '[]');
				} catch {
					warn('Could not parse annotations JSON; starting with empty list.');
					annotations = [];
				}

			// Read image dimensions once — used by both plate-solve and Simbad.
			// Done early so we can pass them to solveWithAstrometry if needed.
			if (doPlatesolve || doSimbad) {
				const dims = await getImageDimensions(jpgFile.path);
				imgW = dims.width;
				imgH = dims.height;
				if (!imgW || !imgH) {
					warn(`Could not read image dimensions from JPG — plate-solve and Simbad may be inaccurate.`);
				}
			}

			if (doPlatesolve) {
				// Strategy: use uploaded companion XISF first (PixInsight plate
				// solution), then fall back to the astrometry.net API.
				const fovHint = parseFloat(body.fov_hint || '0') || 3.0;

				// ── Try 1: Uploaded XISF companion from PixInsight ──
				if (xisfFile) {
					step('Reading plate solution from uploaded XISF...');
					// parseXisfWcs now returns { wcs, reason } (W3 contract change) —
					// destructure so `wcs` gets the inner solution (or null), not the
					// always-truthy wrapper object that would make `if (wcs)` fire on a
					// failed read and then dereference an undefined ra_deg. `xisfReason`
					// feeds the human failure message in the else branch below.
					const { wcs: xisfWcs, reason: xisfReason } = parseXisfWcs(xisfFile.path);
					wcs = xisfWcs;

					if (wcs) {
						ok(`XISF plate-solve: RA=${wcs.ra_deg.toFixed(4)}° Dec=${wcs.dec_deg.toFixed(4)}° scale=${wcs.pixScaleArcsec.toFixed(2)}"/px`);
					} else {
						warn(`XISF uploaded but no usable plate solution: ${XISF_FAIL_REASONS[xisfReason] || xisfReason}.`);
					}
				}

				// ── Try 2: astrometry.net API fallback ──
				if (!wcs) {
					const apiKey = (getConfig().astrometry_api_key || '').trim();
					if (apiKey) {
						if (!imgW || !imgH) {
							warn('Cannot run astrometry.net without image dimensions — skipping.');
						} else {
							step('Falling back to astrometry.net plate-solve...');
							try {
								wcs = await solveWithAstrometry(
									jpgFile.path, apiKey,
									imgW, imgH,
									fovHint,
									msg => prog(msg),
									() => isCancelled(jobId)
								);
								if (wcs) {
									ok(`astrometry.net solve: RA=${wcs.ra_deg.toFixed(4)}° Dec=${wcs.dec_deg.toFixed(4)}° scale=${wcs.pixScaleArcsec.toFixed(2)}"/px`);
								} else {
									warn('astrometry.net could not solve the field.');
								}
							} catch (err) {
								warn(`astrometry.net error: ${err.message}`);
							}
						}
					} else {
						warn('No astrometry.net API key configured — skipping fallback solve. Set it in Settings or ingest/config.json.');
					}
				}
			}

			// W3: a degenerate CD matrix (determinant ≈ 0, non-invertible) can't
			// project sky→pixel, so every Simbad annotation would silently drop
			// inside buildAnnotations. Detect it ONCE here, flag the whole solution
			// as wcs_degenerate, warn the owner, and skip the projection — rather
			// than discovering it row-by-row in a server-console-only log. The enum
			// value is registered in validateImages.js so the write isn't rejected.
			const wcsDegenerate = isWcsDegenerate(wcs);
			if (wcs && wcsDegenerate) {
				warn('Plate solution is degenerate (non-invertible CD matrix) — annotations cannot be projected. Marking annotations_status = wcs_degenerate.');
				annotationsStatus = 'wcs_degenerate';
			}

			if (wcs && doSimbad && !wcsDegenerate) {
				step('Querying Simbad for objects in field of view...');
				const effImgW = imgW || 6000;
				const effImgH = imgH || 4000;
				if (!imgW || !imgH) {
					warn(`Could not read image dimensions — using defaults (${effImgW}×${effImgH}). Simbad search radius and annotation positions may be inaccurate.`);
				}
				const fovW = effImgW * wcs.pixScaleDeg;
				const fovH = effImgH * wcs.pixScaleDeg;
				const searchRadius = Math.sqrt(fovW * fovW + fovH * fovH) / 2;

				// Step 1: Query Simbad for objects in the FOV.
				let objects = [];
				// Optimistic default — flip to 'simbad_failed' on catch so the
				// status field on the variant tells "Simbad returned zero" apart
				// from "Simbad failed silently." Issue #85.
				annotationsStatus = 'ok';
				try {
					objects = await simbadSearch(wcs.ra_deg, wcs.dec_deg, searchRadius);
					ok(`Simbad found ${objects.length} non-stellar objects in field`);
				} catch (err) {
					warn(`Simbad search failed: ${err.message}`);
					annotationsStatus = 'simbad_failed';
				}

				// Step 2: Enrich Simbad results with angular sizes from local catalogs.
				// Simbad's galdim_majaxis is galaxy-only; the local CSVs cover all types.
				if (objects.length > 0) {
					try {
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
					} catch (err) {
						warn(`Local catalog lookup failed: ${err.message}`);
					}

					// Step 3: Build filtered annotation objects with radius fractions.
					const fromSimbad = buildAnnotations(objects, wcs, effImgW, effImgH, fovW);
					ok(`${fromSimbad.length} in-frame objects with pixel coordinates`);

					// Step 4: Merge with manual annotations (dedup by normalized name).
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
							// enrich with catalog data (only fill null fields).
							if (manual.radius == null)            manual.radius             = sAnn.radius;
							if (manual.type == null)              manual.type               = sAnn.type;
							if (manual.major_axis_arcmin == null) manual.major_axis_arcmin  = sAnn.major_axis_arcmin;
							if (manual.minor_axis_arcmin == null) manual.minor_axis_arcmin  = sAnn.minor_axis_arcmin;
							if (manual.position_angle == null)    manual.position_angle     = sAnn.position_angle;
							manualByName.delete(key); // consumed — don't add again below
						} else {
							merged.push(sAnn);
						}
					}
					// Simbad annotations first, then remaining manual annotations on top.
					annotations = [...merged, ...manualByName.values()];
				}
			}

			return { wcs, imgW, imgH, annotations, annotationsStatus };
		})();

		// --- WebP branch (preview + thumbnail in parallel) ---
		const webpBranch = (async () => {
			await fs.promises.mkdir(GALLERY_DIR, { recursive: true });

			step('Generating WebP preview + thumbnail...');
			const previewPath     = path.join(GALLERY_DIR, `${filePrefix}-preview.webp`);
			const preview1200Path = path.join(GALLERY_DIR, `${filePrefix}-preview-1200.webp`);
			const thumbPath       = path.join(GALLERY_DIR, `${filePrefix}-thumb.webp`);

			// Generate to temp paths first; the final rename happens inside the
			// images.json mutex (via the addTarget/addVariant/addRevision onCommit
			// hook below) so the file placement is atomic with the dup-slug check.
			// Writing straight to previewPath/thumbPath here let two concurrent
			// same-slug jobs overwrite each other's files before the check. Issue #67.
			// Run preview (2400 + 1200) and thumbnail generation in parallel — all
			// three read the same JPG but write to different outputs. vips is safe here.
			// The 1200px rendition (W6) is the small member of the detail-hero srcset
			// so phones don't download the full 2400px hero.
			await Promise.all([
				generatePreviewWebp(jpgFile.path, previewTmpPath),
				generatePreview1200Webp(jpgFile.path, preview1200TmpPath),
				// Revisions don't need a new thumbnail — the variant's existing
				// thumbnail stays. But we generate one anyway in case the user
				// wants to update it (it's cheap and avoids a missing file).
				generateThumbWebp(jpgFile.path, thumbTmpPath),
			]);
			ok('WebP preview (2400 + 1200) + thumbnail generated');

			// W6: read the REAL pixel dimensions of the generated 2400px preview so
			// the detail template can set explicit width/height and eliminate the
			// hero layout shift (CLS). LOUD fail (throw) if they can't be read — a
			// persisted null would silently reintroduce the very CLS this rendition
			// exists to fix, and the template's srcset/aspect math would emit NaN.
			const dims = await getImageDimensions(previewTmpPath);
			if (!dims.width || !dims.height) {
				throw new Error('Could not read preview dimensions after WebP generation — aborting before images.json write so the entry is not persisted with null dimensions (would reintroduce hero layout shift).');
			}

			return { previewPath, preview1200Path, thumbPath, previewWidth: dims.width, previewHeight: dims.height };
		})();

		// Join both branches.
		const [skyResult, webpResult] = await Promise.all([skyBranch, webpBranch]);
		const { wcs, imgW, imgH, annotations, annotationsStatus } = skyResult;
		const { previewPath, preview1200Path, thumbPath, previewWidth, previewHeight } = webpResult;

		if (isCancelled(jobId)) throw new CancelledError();

		// ── 6-7. generate DZI + upload to R2 ────────────────────────────────
		let dziUrl = null;
		if (tifFile && body.dzi === 'true') {
			step('Generating DZI tile tree from TIF...');
			const dziTmp    = path.join(tmpDir, 'dzi');
			const dziTarget = path.join(dziTmp, filePrefix);
			fs.mkdirSync(dziTmp, { recursive: true });

			await generateDzi(tifFile.path, dziTarget);
			ok('DZI tiles generated');

			// SOL-CONF item 4 — advisory slug/target re-check immediately before the
			// R2 upload. R2 keys derive from filePrefix (slug-based), so a concurrent
			// same-slug job would upload to the SAME keys and clobber. This best-effort
			// check reads the in-memory cache (kept warm by other jobs' mutex writes,
			// which loadGallery() inside the mutex) and aborts the common case early.
			// It is NOT the enforcement layer: addTarget/addVariant/addRevision re-check
			// inside the images.json mutex, which is authoritative. Residual window — a
			// concurrent job can still publish between this read and that mutex; that
			// case is caught by the mutex re-check (which throws + rolls back local
			// assets), leaving only orphan R2 tiles (harmless, overwritten on re-run).
			if (mode === 'new-target' && slugExists(slug)) {
				throw new Error(`Slug "${slug}" was published by a concurrent job — aborting before R2 upload to avoid clobbering its tiles.`);
			} else if (mode === 'add-variant') {
				const t = findTarget(slug);
				if (t && t.variants.some(v => v.id === variantId)) {
					throw new Error(`Variant "${variantId}" on "${slug}" was published by a concurrent job — aborting before R2 upload.`);
				}
			} else if (mode === 'add-revision') {
				const t = findTarget(slug);
				const v = t && t.variants.find(x => x.id === variantId);
				if (v && Array.isArray(v.revisions) && v.revisions.some(r => r.id === revisionId)) {
					throw new Error(`Revision "${revisionId}" was published by a concurrent job — aborting before R2 upload.`);
				}
			}

			step('Uploading DZI tiles to Cloudflare R2...');
			// Record the R2 prefix before uploading so a cancel detected right
			// after the upload can report exactly what was orphaned. Issue #73.
			r2OrphanInfo = { prefix: filePrefix, uploadedCount: 0 };
			const { uploadedKeys, failed } = await uploadDziToR2(dziTmp, prog);
			r2OrphanInfo.uploadedCount = uploadedKeys.length;
			// W2: abort the publish if ANY tile failed to upload after retries.
			// Writing dziUrl into images.json with an incomplete tile tree would
			// deploy a detail page whose deep-zoom viewer 404s mid-pan. Throwing here
			// (before dziUrl / images.json / git push) is the gate. The tiles that DID
			// upload orphan in R2 (reported in the message); a re-run overwrites them.
			if (failed.length > 0) {
				throw new Error(`R2 upload incomplete: ${failed.length} of ${uploadedKeys.length + failed.length} tile object(s) failed after retries. Aborting before images.json write so no entry with a broken tile tree is published. The ${uploadedKeys.length} uploaded object(s) under "${filePrefix}_files/" are now orphaned in R2 — re-run to overwrite, or delete via the Cloudflare dashboard.`);
			}
			dziUrl = `${R2_BASE_URL}/${filePrefix}.dzi`;
			ok(`DZI live at ${dziUrl}`);
		}

		if (isCancelled(jobId)) throw new CancelledError();

		// ── 8. build sky data ────────────────────────────────────────────────
		// Parse filter rows from the form.
		const filterNames   = [].concat(body.filterName   || []);
		const filterFrames  = [].concat(body.filterFrames || []);
		const filterMinutes = [].concat(body.filterMinutes || []);
		const filters = filterNames
			.map((name, i) => ({
				name:    name.trim(),
				frames:  parseInt(filterFrames[i], 10) || null,
				minutes: parseInt(filterMinutes[i], 10) || null,
			}))
			.filter(f => f.name);

		// Use Number.isFinite instead of || null — parseFloat("0") || null
		// would discard RA=0 (vernal equinox) and Dec=0 (celestial equator),
		// which are valid sky coordinates.
		const rawRa   = parseFloat(body.ra_deg);
		const rawDec  = parseFloat(body.dec_deg);
		const rawFovW = parseFloat(body.fov_w);
		const rawFovH = parseFloat(body.fov_h);
		const manualRa   = Number.isFinite(rawRa)   ? rawRa   : null;
		const manualDec  = Number.isFinite(rawDec)   ? rawDec  : null;
		const manualFovW = Number.isFinite(rawFovW)  ? rawFovW : null;
		const manualFovH = Number.isFinite(rawFovH)  ? rawFovH : null;

		const finalRa  = wcs?.ra_deg  ?? manualRa;
		const finalDec = wcs?.dec_deg ?? manualDec;

		let skyData = null;
		if (finalRa != null && finalDec != null) {
			let fovW = manualFovW;
			let fovH = manualFovH;
			if (wcs && (!fovW || !fovH) && imgW && imgH) {
				fovW = imgW * wcs.pixScaleDeg;
				fovH = imgH * wcs.pixScaleDeg;
			}
			skyData = {
				ra:            raToStr(finalRa),
				dec:           decToStr(finalDec),
				fov_deg:       (fovW > 0 || fovH > 0) ? parseFloat(Math.max(fovW || 0, fovH || 0).toFixed(3)) : null,
				aladin_target: (body.catalog || '').split('/')[0].trim() || null,
				ra_deg:        parseFloat(finalRa.toFixed(4)),
				dec_deg:       parseFloat(finalDec.toFixed(4)),
				fov_w:         fovW ? parseFloat(fovW.toFixed(3)) : null,
				fov_h:         fovH ? parseFloat(fovH.toFixed(3)) : null,
			};
		}

		// ── 9. build and write the entry ─────────────────────────────────────
		step('Writing images.json entry...');

		// commitWebp — moves the temp WebP files into their final paths. Passed
		// to addTarget/addVariant/addRevision so the rename runs INSIDE the
		// images.json mutex, after the dup-slug/variant/revision check passes.
		// This makes file placement atomic with the entry write: the job that
		// loses the dup-check throws before this runs and never overwrites the
		// winner's files (the finally block clears its temp files). Issue #67.
		const commitWebp = async () => {
			fs.renameSync(previewTmpPath, previewPath);
			fs.renameSync(preview1200TmpPath, preview1200Path);
			fs.renameSync(thumbTmpPath, thumbPath);
		};

		// rollbackWebp — undo commitWebp. Passed as the onRollback hook to
		// addTarget/addVariant/addRevision (W2): if the images.json write fails
		// AFTER commitWebp already renamed the files into place (a validation error
		// or a disk error), this deletes the just-placed WebPs so a failed publish
		// doesn't leave orphan preview/1200/thumb files pointing at an entry that
		// was never written. Best-effort — force:true makes a missing file a no-op;
		// a delete failure is logged but must not mask the original write error the
		// caller needs to see (gallery.js commitOrRollback wraps this in its own
		// try/catch for exactly that reason).
		const rollbackWebp = async () => {
			for (const p of [previewPath, preview1200Path, thumbPath]) {
				try {
					fs.rmSync(p, { force: true });
				} catch (rmErr) {
					console.error(`[pipeline] Asset rollback failed for ${p}:`, rmErr.message);
				}
			}
		};

		// Equipment object — shared by new-target and add-variant modes.
		const equipment = {
			telescope: (body.telescope || '').trim() || null,
			camera:    (body.camera    || '').trim() || null,
			mount:     (body.mount     || '').trim() || null,
			guider:    (body.guider    || '').trim() || null,
			filters:   (body.filterList|| '').trim() || null,
			location:  (body.location  || '').trim() || null,
			software:  (body.software  || '').trim() || null,
		};

		if (mode === 'new-target') {
			const tags     = (body.tags || '').split(',').map(t => t.trim()).filter(Boolean);
			const catalogs = [].concat(body.catalogs || []).filter(Boolean);
			const astrobinId = (body.astrobin_id || '').trim() || null;

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
				variants: [{
					id:                'default',
					label:             null,
					primary:           true,
					date:              body.date || new Date().toISOString().slice(0, 10),
					thumbnail:         `/assets/img/gallery/${filePrefix}-thumb.webp`,
					preview_url:       `/assets/img/gallery/${filePrefix}-preview.webp`,
					// W6 detail-hero srcset: the 1200px rendition + the 2400px
					// preview's REAL dimensions (measured above, never assumed) so the
					// template can serve a smaller hero to phones and reserve exact
					// space to kill the layout shift.
					preview_1200_url:  `/assets/img/gallery/${filePrefix}-preview-1200.webp`,
					preview_width:     previewWidth,
					preview_height:    previewHeight,
					full_url:          null,
					dzi_url:           dziUrl,
					annotated_dzi_url: null,
					annotated_url:     null,
					annotations:       annotations.length ? annotations : [],
					// Records why annotations[] is what it is — distinguishes
					// genuine empty FOV ('ok') from skipped Simbad step
					// ('no_simbad') from network failure ('simbad_failed'), or a
					// degenerate WCS ('wcs_degenerate'). Issue #85 / W3.
					annotations_status: annotationsStatus,
					equipment,
					acquisition: filters.length ? { filters } : { filters: [] },
					sky:         skyData,
					revisions:   [],
				}],
			};
			await addTarget(newEntry, commitWebp, rollbackWebp);

		} else if (mode === 'add-variant') {
			const newVariant = {
				id:                variantId,
				label:             (body.variantLabel || '').trim() || null,
				primary:           false,
				date:              body.date || new Date().toISOString().slice(0, 10),
				thumbnail:         `/assets/img/gallery/${filePrefix}-thumb.webp`,
				preview_url:       `/assets/img/gallery/${filePrefix}-preview.webp`,
				// W6 detail-hero srcset — see the new-target variant above.
				preview_1200_url:  `/assets/img/gallery/${filePrefix}-preview-1200.webp`,
				preview_width:     previewWidth,
				preview_height:    previewHeight,
				full_url:          null,
				dzi_url:           dziUrl,
				annotated_dzi_url: null,
				annotated_url:     null,
				annotations:       annotations.length ? annotations : [],
				annotations_status: annotationsStatus,
				equipment,
				acquisition: filters.length ? { filters } : { filters: [] },
				sky:         skyData,
				revisions:   [],
			};
			await addVariant(slug, newVariant, commitWebp, rollbackWebp);

		} else if (mode === 'add-revision') {
			const parentVariantId = (body.parentVariantId || 'default').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
			const newRevision = {
				id:                revisionId,
				label:             (body.revisionLabel || '').trim() || null,
				date:              body.date || new Date().toISOString().slice(0, 10),
				is_final:          body.isFinal === 'true',
				// thumbnail (W2): the pipeline always generates a thumb (thumbTmpPath)
				// and commitWebp renames it into place, but the revision object never
				// referenced it — so gallery.js's is_final promotion had no thumbnail
				// to lift onto the variant. Attach it here. preview_1200_url + real
				// dims (W6) so a final revision promoted to the variant carries a
				// working hero srcset too.
				thumbnail:         `/assets/img/gallery/${filePrefix}-thumb.webp`,
				preview_url:       `/assets/img/gallery/${filePrefix}-preview.webp`,
				preview_1200_url:  `/assets/img/gallery/${filePrefix}-preview-1200.webp`,
				preview_width:     previewWidth,
				preview_height:    previewHeight,
				dzi_url:           dziUrl,
				annotated_dzi_url: null,
				note:              (body.revisionNote || '').trim() || null,
			};
			await addRevision(slug, parentVariantId, newRevision, commitWebp, rollbackWebp);
		}

		ok('images.json updated');

		// ── 10. git add / commit / push ──────────────────────────────────────
		if (body.gitpush === 'true') {
			// W2: prove the site still BUILDS with the new entry before the
			// irreversible push. The pre-write validator (validateImages) caught
			// SHAPE corruption; this catches a structurally-valid value that trips a
			// template at build time (a date a Nunjucks filter chokes on, a missing
			// referenced asset). Runs AFTER the images.json write — the build must
			// see the real file — but BEFORE commit/push, so a build break stops here
			// with the entry only on the local working tree, never deployed.
			step('Validating: production build before push...');
			const build = await validateBuild(PROJECT_ROOT, prog);
			if (!build.ok) {
				throw new Error(`Production build failed — NOT pushing. images.json was updated on the local working tree but the site does not build:\n${build.error}`);
			}
			ok('Production build passed');

			step('Committing and pushing to GitHub...');

			// Stage images.json, both preview renditions, and the thumbnail.
			// Revision thumbnails are generated too (in case the user wants to
			// update the variant's thumbnail) so always stage them.
			const gitFiles = [IMAGES_JSON, previewPath, preview1200Path, thumbPath];

			await runOrThrow('git', ['-C', PROJECT_ROOT, 'add', ...gitFiles]);

			const commitLabel = mode === 'new-target' ? `Add image: ${title}`
				: mode === 'add-variant' ? `Add variant ${variantId} to ${slug}`
				: `Add revision ${revisionId} to ${slug}`;
			const msgFile = path.join(tmpDir, 'commit-msg.txt');
			fs.writeFileSync(msgFile, `${commitLabel}\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`);
			await runOrThrow('git', ['-C', PROJECT_ROOT, 'commit', '-F', msgFile]);
			try {
				await runOrThrow('git', ['-C', PROJECT_ROOT, 'push']);
				ok('Pushed to GitHub');
			} catch (pushErr) {
				// The commit succeeded but the push failed — images.json is already
				// updated locally. Tell the user how to recover instead of crashing.
				warn(`Git push failed: ${pushErr.message}. The commit is local — run "git -C ${PROJECT_ROOT} push" manually to retry.`);
			}
		}

		// ── done ─────────────────────────────────────────────────────────────
		jobEmit(jobId, { type: 'done', slug, title });

	} catch (err) {
		if (err instanceof CancelledError) {
			// If DZI tiles reached R2 before the cancel, they're orphaned — R2
			// has no rollback, so tell the owner exactly what to remove. Only
			// the single .dzi descriptor can be deleted with `wrangler r2 object
			// delete`; the tile tree under <prefix>_files/ holds many objects
			// that wrangler can't prefix-delete in one command (dashboard or an
			// S3-compatible bulk tool). Issue #73 (Option 2: report, don't auto-delete).
			if (r2OrphanInfo) {
				const orphanMsg =
					`Cancelled after uploading ${r2OrphanInfo.uploadedCount} tile object(s) to R2 — these are now orphaned. `
					+ `To clean up, delete the descriptor: `
					+ `wrangler r2 object delete ${R2_BUCKET}/${r2OrphanInfo.prefix}.dzi --remote  `
					+ `and remove the tile tree under the "${r2OrphanInfo.prefix}_files/" prefix `
					+ `(via the Cloudflare dashboard or an S3-compatible bulk delete).`;
				warn(orphanMsg);
				console.warn(`[pipeline] ${orphanMsg}`);
			}
			jobEmit(jobId, { type: 'done', slug: null, cancelled: true });
		} else {
			// fail() already emits both 'error' and 'done', so no separate
			// done event needed here.
			fail(`Pipeline error: ${err.message}`);
		}
	} finally {
		// Cleanup: remove temp directory, temp WebPs, and uploaded input files.
		// W3: collect every failure into ONE aggregated browser warning instead of
		// N console-only lines, so the owner sees leftover scratch files in the UI.
		// Each removal is individually guarded so one failure doesn't abort the rest.
		const cleanupErrors = [];

		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch (cleanupErr) {
			cleanupErrors.push(`temp dir ${path.basename(tmpDir)}: ${cleanupErr.message}`);
		}

		// Remove any leftover temp WebP files. After a successful commit the
		// rename consumed them, so force:true makes this a no-op; on cancel,
		// failure, or a lost dup-slug check it clears the orphaned temps. Issue #67.
		for (const p of [previewTmpPath, preview1200TmpPath, thumbTmpPath]) {
			if (!p) continue;
			try {
				fs.rmSync(p, { force: true });
			} catch (cleanupErr) {
				cleanupErrors.push(`temp WebP ${path.basename(p)}: ${cleanupErr.message}`);
			}
		}

		// Uploaded input files. Switched from the old async fs.rm (fire-and-forget,
		// console-only) to sync fs.rmSync so a failure joins the aggregate below and
		// is surfaced to the owner rather than lost to the server log.
		for (const key of Object.keys(files)) {
			for (const f of files[key]) {
				try {
					fs.rmSync(f.path, { force: true });
				} catch (cleanupErr) {
					cleanupErrors.push(`upload ${path.basename(f.path)}: ${cleanupErr.message}`);
				}
			}
		}

		// Surface all cleanup failures as one warning. This runs after the terminal
		// 'done' event, so the client may have already settled — the warn is
		// best-effort for the UI but always logged server-side. These are scratch
		// files under the OS temp dir / gallery temp prefix; the published entry is
		// unaffected, so they're safe to remove by hand.
		if (cleanupErrors.length > 0) {
			const msg = `Post-run cleanup left ${cleanupErrors.length} item(s) behind: ${cleanupErrors.join('; ')}. Safe to delete manually.`;
			warn(msg);
			console.error(`[pipeline] ${msg}`);
		}
	}
}

module.exports = { runPipeline };
