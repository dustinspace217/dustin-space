/**
 * routes/misc.js — Miscellaneous utility routes
 *
 * Lightweight endpoints that support the ingest form UI:
 *   GET /api/check-slug — check if a slug already exists in images.json
 *   GET /api/equipment  — return equipment presets from equipment.json
 */

'use strict';

const { Router } = require('express');
const fs   = require('fs');
const path = require('path');
const { slugExists } = require('../lib/gallery');

/**
 * createMiscRouter — factory function that returns an Express Router.
 *
 * @returns {Router} Express Router with GET /check-slug and GET /equipment
 */
function createMiscRouter() {
	const router = Router();

	// ─── GET /check-slug ─────────────────────────────────────────────────────
	// Checks whether a slug already exists in images.json.
	// Query param: ?slug=horsehead-nebula
	// Response: { exists: true|false }
	// Uses the in-memory gallery cache for fast lookups (no disk I/O per request).
	router.get('/check-slug', (req, res) => {
		const slug = (req.query.slug || '').trim().toLowerCase();
		if (!slug) return res.json({ exists: false });
		try {
			res.json({ exists: slugExists(slug) });
		} catch (err) {
			// If images.json can't be read, fail open so the pipeline can give the
			// definitive error when it runs the mutex-protected duplicate check.
			console.warn(`[check-slug] Could not check slug "${slug}":`, err.message);
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
		} catch (err) {
			console.warn('[equipment] Could not read equipment.json:', err.message);
			res.json({ personal: [], itelescope: [] });
		}
	});

	return router;
}

module.exports = createMiscRouter;
