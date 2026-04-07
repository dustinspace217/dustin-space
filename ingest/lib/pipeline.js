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
const { run, runOrThrow } = require('./exec');
const { jobEmit, isCancelled, CancelledError } = require('./jobs');
const { raToStr, decToStr } = require('./coordinates');
const { parseAstapIni, skyToPixelFrac, buildAnnotations } = require('./platesolve');
const { simbadSearch }      = require('./simbad');
const { loadCatalog, lookupSize } = require('./catalog');
const { generatePreviewWebp, generateThumbWebp, generateDzi, getImageDimensions } = require('./images');
const { R2_BASE_URL, uploadDziToR2 } = require('./r2');
const { slugExists, findTarget, addTarget, addVariant, addRevision, IMAGES_JSON } = require('./gallery');

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
		.replace(/\s*-\s*.*$/, '')          // strip suffix after " - " (e.g. " — Eastern Veil")
		.trim()
		.toLowerCase();
}

/**
 * runPipeline — process one ingest job end-to-end.
 *
 * @param {string} jobId — UUID string from POST /api/process
 * @param {object} files — req.files from multer: { jpg: [File], tif: [File] }
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
async function runPipeline(jobId, files, body) {
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

	try {
		// ── 0. determine mode and validate inputs ────────────────────────────
		const mode = body.mode || 'new-target';
		const jpgFile = files.jpg?.[0];
		const tifFile = files.tif?.[0];

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
			if (variant.revisions.some(r => r.id === revisionId)) {
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

		// Plate-solve and Simbad are skipped for revisions — the data is
		// inherited from the parent variant (same target, same field of view).
		const doPlatesolve = mode !== 'add-revision' && body.platesolve === 'true';
		const doSimbad     = mode !== 'add-revision' && body.simbad === 'true';

		// ── init event: total step count for the progress bar ────────────────
		{
			let totalSteps = 2; // start + images.json write
			if (tifFile)                          totalSteps += 1; // EXIF
			if (doPlatesolve)                     totalSteps += 1; // ASTAP
			if (doPlatesolve && doSimbad)          totalSteps += 1; // Simbad
			totalSteps += 1; // WebP generation (preview + thumb run in parallel, count as 1)
			if (tifFile && body.dzi === 'true')   totalSteps += 2; // DZI + R2
			if (body.gitpush === 'true')          totalSteps += 1; // git push
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
		//   skyBranch:  ASTAP plate-solve → Simbad cone-search → sky data
		//   webpBranch: preview WebP + thumbnail WebP in parallel
		// The branches are joined before DZI generation.

		// --- sky branch (plate-solve + Simbad) ---
		const skyBranch = (async () => {
			let wcs = null;
			let imgW = null, imgH = null;
			let annotations = [];
			try {
			annotations = JSON.parse(body.annotations || '[]');
		} catch {
			warn('Could not parse annotations JSON; starting with empty list.');
			annotations = [];
		}

			if (doPlatesolve) {
				step('Running ASTAP plate-solve...');
				const jpgCopy = path.join(tmpDir, `${filePrefix}.jpg`);
				// Async copy avoids blocking the event loop for large JPGs (50-100 MB).
				await fs.promises.copyFile(jpgFile.path, jpgCopy);

				const fovHint = parseFloat(body.fov_hint || '0') || 3.0;
				const { stderr } = await run(
					getConfig().astap_bin,
					['-f', jpgCopy, '-fov', String(fovHint), '-z', '2', '-r', '30',
						'-d', getConfig().astap_db_dir],
					{ cwd: tmpDir, timeout: 60000 }
				);

				const iniPath = jpgCopy.replace(/\.jpg$/i, '.ini');
				wcs = parseAstapIni(iniPath);

				if (wcs) {
					ok(`Plate-solve: RA=${wcs.ra_deg.toFixed(4)}° Dec=${wcs.dec_deg.toFixed(4)}° scale=${wcs.pixScaleArcsec.toFixed(2)}"/px`);
				} else {
					warn(`ASTAP could not solve the field. (${(stderr || '').trim().split('\n').pop() || 'no detail'})`);
				}
			}

			if (wcs) {
				const dims = await getImageDimensions(jpgFile.path);
				imgW = dims.width;
				imgH = dims.height;
			}

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

			return { wcs, imgW, imgH, annotations };
		})();

		// --- WebP branch (preview + thumbnail in parallel) ---
		const webpBranch = (async () => {
			await fs.promises.mkdir(GALLERY_DIR, { recursive: true });

			step('Generating WebP preview + thumbnail...');
			const previewPath = path.join(GALLERY_DIR, `${filePrefix}-preview.webp`);
			const thumbPath   = path.join(GALLERY_DIR, `${filePrefix}-thumb.webp`);

			// Run preview and thumbnail generation in parallel — both read the
			// same JPG but write to different outputs. vips handles this safely.
			await Promise.all([
				generatePreviewWebp(jpgFile.path, previewPath),
				// Revisions don't need a new thumbnail — the variant's existing
				// thumbnail stays. But we generate one anyway in case the user
				// wants to update it (it's cheap and avoids a missing file).
				generateThumbWebp(jpgFile.path, thumbPath),
			]);
			ok('WebP preview + thumbnail generated');

			return { previewPath, thumbPath };
		})();

		// Join both branches.
		const [skyResult, webpResult] = await Promise.all([skyBranch, webpBranch]);
		const { wcs, imgW, imgH, annotations } = skyResult;
		const { previewPath, thumbPath } = webpResult;

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

			step('Uploading DZI tiles to Cloudflare R2...');
			await uploadDziToR2(dziTmp, prog);
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

		const manualRa   = parseFloat(body.ra_deg)  || null;
		const manualDec  = parseFloat(body.dec_deg) || null;
		const manualFovW = parseFloat(body.fov_w)   || null;
		const manualFovH = parseFloat(body.fov_h)   || null;

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
					full_url:          null,
					dzi_url:           dziUrl,
					annotated_dzi_url: null,
					annotated_url:     null,
					annotations:       annotations.length ? annotations : [],
					equipment,
					acquisition: filters.length ? { filters } : { filters: [] },
					sky:         skyData,
					revisions:   [],
				}],
			};
			await addTarget(newEntry);

		} else if (mode === 'add-variant') {
			const newVariant = {
				id:                variantId,
				label:             (body.variantLabel || '').trim() || null,
				primary:           false,
				date:              body.date || new Date().toISOString().slice(0, 10),
				thumbnail:         `/assets/img/gallery/${filePrefix}-thumb.webp`,
				preview_url:       `/assets/img/gallery/${filePrefix}-preview.webp`,
				full_url:          null,
				dzi_url:           dziUrl,
				annotated_dzi_url: null,
				annotated_url:     null,
				annotations:       annotations.length ? annotations : [],
				equipment,
				acquisition: filters.length ? { filters } : { filters: [] },
				sky:         skyData,
				revisions:   [],
			};
			await addVariant(slug, newVariant);

		} else if (mode === 'add-revision') {
			const parentVariantId = (body.parentVariantId || 'default').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
			const newRevision = {
				id:                revisionId,
				label:             (body.revisionLabel || '').trim() || null,
				date:              body.date || new Date().toISOString().slice(0, 10),
				is_final:          body.isFinal === 'true',
				preview_url:       `/assets/img/gallery/${filePrefix}-preview.webp`,
				dzi_url:           dziUrl,
				annotated_dzi_url: null,
				note:              (body.revisionNote || '').trim() || null,
			};
			await addRevision(slug, parentVariantId, newRevision);
		}

		ok('images.json updated');

		// ── 10. git add / commit / push ──────────────────────────────────────
		if (body.gitpush === 'true') {
			step('Committing and pushing to GitHub...');

			// Stage images.json, the new preview, and the thumbnail.
			// Revision thumbnails are generated too (in case the user wants to
			// update the variant's thumbnail) so always stage them.
			const gitFiles = [IMAGES_JSON, previewPath, thumbPath];

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
			jobEmit(jobId, { type: 'done', slug: null, cancelled: true });
		} else {
			// fail() already emits both 'error' and 'done', so no separate
			// done event needed here.
			fail(`Pipeline error: ${err.message}`);
		}
	} finally {
		// Cleanup: remove temp directory and uploaded files.
		// Wrapped in try-catch so a cleanup failure doesn't mask the real error.
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch (cleanupErr) {
			console.error(`[pipeline] Failed to remove tmpDir ${tmpDir}:`, cleanupErr.message);
		}
		for (const key of Object.keys(files)) {
			for (const f of files[key]) {
				fs.rm(f.path, err => {
					if (err) console.error(`[pipeline] Failed to remove upload ${f.path}:`, err.message);
				});
			}
		}
	}
}

module.exports = { runPipeline };
