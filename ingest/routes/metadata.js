/**
 * routes/metadata.js — FITS/EXIF metadata extraction route
 *
 * Reads metadata from an uploaded TIF file using exiftool and returns
 * a flat JSON object of fields useful for pre-populating the ingest form.
 *
 * Called by the frontend immediately when a TIF is selected (before the
 * full pipeline runs), so the user can see auto-populated values.
 *
 * Route:
 *   POST /api/metadata — upload a TIF, get metadata back
 *
 * @param {object} opts — dependencies injected from server.js:
 *   upload — multer instance (configured with dest + fileSize limit)
 */

'use strict';

const { Router } = require('express');
const fs = require('fs');
const { run } = require('../lib/exec');

/**
 * createMetadataRouter — factory function that returns an Express Router.
 *
 * Uses a factory pattern because the router needs access to the multer
 * instance configured in server.js.
 *
 * @param {object} opts
 * @param {object} opts.upload — multer instance for file uploads
 * @returns {Router} Express Router with POST /metadata
 */
function createMetadataRouter({ upload }) {
	const router = Router();

	// ─── POST /metadata ──────────────────────────────────────────────────────
	// Reads FITS/EXIF metadata from an uploaded TIF file via exiftool.
	// Returns a flat JSON object of potentially useful fields.
	// The uploaded file is cleaned up in the finally block.
	router.post('/metadata',
		upload.single('tif'),
		async (req, res) => {
			if (!req.file) return res.json({});
			try {
				// exiftool -j: output as JSON array. -a: include duplicate tags.
				const { stdout } = await run('exiftool', ['-j', '-a', req.file.path]);
				if (!stdout.trim()) return res.json({});
				const parsed = JSON.parse(stdout);
				const raw = parsed[0] || {};

				// Extract fields that we can use to pre-populate the form.
				// Different astrophotography apps (N.I.N.A., PixInsight, etc.)
				// write FITS headers in different ways — we try multiple key patterns.
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

				// Remove nulls before sending — only return fields we actually found.
				Object.keys(result).forEach(k => result[k] == null && delete result[k]);
				res.json(result);
			} catch (err) {
				// exiftool failed or output wasn't valid JSON — return empty object
				// so the form still works, but log the error for debugging.
				console.warn(`[metadata] exiftool/parse failed: ${err.message}`);
				res.json({});
			} finally {
				// Clean up the temp upload file.
				fs.rm(req.file.path, err => {
					if (err) console.error(`[metadata] Failed to remove temp file ${req.file.path}:`, err.message);
				});
			}
		}
	);

	return router;
}

module.exports = createMetadataRouter;
