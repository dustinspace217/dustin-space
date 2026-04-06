/**
 * routes/misc.js — Miscellaneous utility routes
 *
 * Lightweight endpoints that support the ingest form UI:
 *   GET /api/check-slug — check if a slug already exists in images.json
 *   GET /api/equipment  — return equipment presets from equipment.json
 *
 * @param {object} opts — dependencies injected from server.js:
 *   IMAGES_JSON — absolute path to src/_data/images.json
 */

'use strict';

const { Router } = require('express');
const fs   = require('fs');
const path = require('path');

/**
 * createMiscRouter — factory function that returns an Express Router.
 *
 * Uses a factory pattern because check-slug needs the IMAGES_JSON path,
 * which is derived from the project root in server.js.
 *
 * @param {object} opts
 * @param {string} opts.IMAGES_JSON — absolute path to images.json
 * @returns {Router} Express Router with GET /check-slug and GET /equipment
 */
function createMiscRouter({ IMAGES_JSON }) {
	const router = Router();

	// ─── GET /check-slug ─────────────────────────────────────────────────────
	// Checks whether a slug already exists in images.json.
	// Query param: ?slug=horsehead-nebula
	// Response: { exists: true|false }
	// Used by the ingest UI to validate slugs before starting the pipeline.
	router.get('/check-slug', (req, res) => {
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

	// ─── GET /equipment ──────────────────────────────────────────────────────
	// Returns the equipment presets from equipment.json.
	// The frontend uses these to populate equipment dropdowns/presets.
	// __dirname here is routes/, so we go up one level to ingest/.
	router.get('/equipment', (req, res) => {
		try {
			const data = JSON.parse(
				fs.readFileSync(path.join(__dirname, '..', 'equipment.json'), 'utf8')
			);
			res.json(data);
		} catch {
			res.json({ personal: [], itelescope: [] });
		}
	});

	return router;
}

module.exports = createMiscRouter;
