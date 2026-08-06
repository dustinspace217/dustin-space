/**
 * tests/gallery-promotion.test.js — final-revision promotion onto the parent
 * variant (ingest/lib/gallery.js addRevision), pinning the null-propagation
 * semantics of preview_1200_url (QA 2026-08-06, re-review CR-4).
 *
 * The regression this exists to catch: promotion used a TRUTHINESS check on
 * preview_1200_url, so a sub-1200px final revision (which the pipeline now
 * persists with preview_1200_url: null — the whirlpool fix) copied its narrow
 * preview_width onto the variant while SKIPPING the null, leaving the
 * variant's stale wide-source 1200 URL paired with width ≤ 1200. The
 * validator's cross-field rule then (correctly) rejected the pair — and the
 * whole legitimate revision write hard-failed inside the mutex. The fix is a
 * presence check: null is a legitimate value and must REPLACE the old URL.
 *
 * gallery.js reads INGEST_IMAGES_JSON at require time, so this file sets the
 * env BEFORE requiring it — node:test runs each test file in its own process,
 * so this can't leak into other suites.
 */

'use strict';

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

// Point gallery.js at an isolated temp images.json BEFORE requiring it —
// the module resolves the path once at load.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-promo-'));
const imagesPath = path.join(tmpDir, 'images.json');
process.env.INGEST_IMAGES_JSON = imagesPath;

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const gallery  = require('../ingest/lib/gallery');

/** Seed: one target whose variant is a WIDE source with a real 1200 URL. */
function seed() {
	fs.writeFileSync(imagesPath, JSON.stringify([
		{
			slug: 'alpha', title: 'Alpha',
			variants: [{
				id: 'default',
				preview_url: '/assets/img/gallery/alpha-preview.webp',
				preview_1200_url: '/assets/img/gallery/alpha-preview-1200.webp',
				preview_width: 2400,
				preview_height: 1600,
				revisions: [],
			}],
		},
	], null, '\t'));
	gallery.invalidateCache && gallery.invalidateCache();
}

test('final revision with null preview_1200_url replaces the variant\'s stale URL', async () => {
	seed();
	// A sub-1200px reprocess promoted to final: the pipeline persists the real
	// narrow dims and preview_1200_url: null. Promotion must carry the null
	// through — pre-fix, this exact call threw the validator's cross-field
	// error ("preview_1200_url is set but preview_width (803) is not > 1200").
	await gallery.addRevision('alpha', 'default', {
		id: 'v2-narrow',
		is_final: true,
		preview_url: '/assets/img/gallery/alpha-v2-preview.webp',
		preview_1200_url: null,
		preview_width: 803,
		preview_height: 1072,
	});

	const written = JSON.parse(fs.readFileSync(imagesPath, 'utf8'));
	const v = written[0].variants[0];
	assert.equal(v.preview_1200_url, null,
		'the null must REPLACE the stale wide-source 1200 URL on the variant');
	assert.equal(v.preview_width, 803, 'the narrow width must be promoted');
	assert.equal(v.revisions[0].id, 'v2-narrow', 'the revision itself must be recorded');
});

test('final revision with a real 1200 URL still promotes it (no over-fire)', async () => {
	seed();
	await gallery.addRevision('alpha', 'default', {
		id: 'v2-wide',
		is_final: true,
		preview_url: '/assets/img/gallery/alpha-v2-preview.webp',
		preview_1200_url: '/assets/img/gallery/alpha-v2-preview-1200.webp',
		preview_width: 2400,
		preview_height: 1600,
	});

	const written = JSON.parse(fs.readFileSync(imagesPath, 'utf8'));
	assert.equal(written[0].variants[0].preview_1200_url,
		'/assets/img/gallery/alpha-v2-preview-1200.webp',
		'a wide final revision must still promote its real 1200 URL');
});
