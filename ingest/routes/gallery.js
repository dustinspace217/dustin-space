/**
 * routes/gallery.js — Gallery data endpoint
 *
 * Serves the gallery data from the in-memory cache so the browse UI
 * can display existing targets, variants, and revisions without
 * reading images.json from disk on every request.
 *
 * Route:
 *   GET /api/gallery — returns the full images.json array from cache
 */

'use strict';

const { Router } = require('express');
const { getGallery } = require('../lib/gallery');

const router = Router();

// ─── GET /gallery ────────────────────────────────────────────────────────────
// Returns the cached images.json array. The cache is populated on first access
// and invalidated after any write (addTarget/addVariant/addRevision), so this
// always reflects the latest state without a disk read per request.
router.get('/gallery', (req, res) => {
	try {
		res.json(getGallery());
	} catch (err) {
		res.status(500).json({ error: 'Could not load gallery data.' });
	}
});

module.exports = router;
