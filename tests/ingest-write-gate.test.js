/**
 * tests/ingest-write-gate.test.js — the ingest MOUTH of the publish-integrity
 * gate: prove the REAL gallery write path (ingest/lib/gallery.js addTarget)
 * refuses an invalid target through the REAL shared validator, and does so
 * BEFORE any bytes reach images.json.
 *
 * Issue #118 (Fix Wave 2, stabilization): images-schema.test.js exercises the
 * validator in isolation; this file exercises it WIRED into the write path —
 * addTarget → commitOrRollback → writeGallery → assertValidImages. Together they
 * cover both mouths: the validator's own contract, and its enforcement at the
 * one place the pipeline persists gallery data.
 *
 * Isolation: gallery.js reads INGEST_IMAGES_JSON at module-load to pick its
 * images.json path (a test-only path redirect — see the comment there). We set
 * it to a throwaway temp file BEFORE requiring gallery, so the real checked-in
 * images.json is never at risk even if the validator regressed to always-accept.
 * `node --test` runs each test FILE in its own process, so this env override
 * never leaks into another suite.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

// Redirect the gallery read-modify-write at a temp file BEFORE the require below.
const TMP_DIR    = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-write-gate-'));
const TMP_IMAGES = path.join(TMP_DIR, 'images.json');
process.env.INGEST_IMAGES_JSON = TMP_IMAGES;

// Hard require (no skip): a revert of the gallery write path / validator wiring
// turns this suite RED rather than skipping it.
const gallery = require('../ingest/lib/gallery');

/**
 * resetGallery — write a known-good baseline to the temp file so cache AND disk
 * start each write test from the same clean, valid state. addTarget calls
 * loadGallery() first, which re-reads this file, so the cache follows the reset.
 * @param {Array} content — the images array to seed
 */
function resetGallery(content) {
	fs.writeFileSync(TMP_IMAGES, JSON.stringify(content, null, '\t'), 'utf8');
}

test('gallery write path is redirected to the temp images.json (seam present)', () => {
	// If the INGEST_IMAGES_JSON override were removed from gallery.js, this would
	// point at the real images.json and the assert goes RED — guarding the seam.
	assert.equal(gallery.IMAGES_JSON, TMP_IMAGES,
		'gallery.IMAGES_JSON must honor INGEST_IMAGES_JSON — the test seam is missing');
});

test('addTarget rejects an invalid target via the real validator BEFORE writing', async () => {
	resetGallery([]);
	const before = fs.readFileSync(TMP_IMAGES, 'utf8');

	// A structurally valid slug (so the dup-slug fast-path is passed) but a variant
	// whose id is the wrong type. The shared validator must reject this inside
	// writeGallery — which runs assertValidImages before fs.writeFileSync — so the
	// bad entry never reaches disk. A no-op validator would let addTarget write it.
	const badTarget = { slug: 'bad-entry', title: 'Bad', variants: [{ id: 42 }] };

	await assert.rejects(
		gallery.addTarget(badTarget),
		/variant\.id/,
		'addTarget must reject the invalid target with a message naming the field'
	);

	const after = fs.readFileSync(TMP_IMAGES, 'utf8');
	assert.equal(after, before,
		'images.json must be UNCHANGED — no write may happen when validation fails');
});

test('addTarget writes a valid target (positive control — validator is not always-throw)', async () => {
	resetGallery([]);
	const good = { slug: 'good-entry', title: 'Good', variants: [{ id: 'default' }] };

	await gallery.addTarget(good);

	const written = JSON.parse(fs.readFileSync(TMP_IMAGES, 'utf8'));
	assert.equal(written.length, 1, 'the valid target must have been written');
	assert.equal(written[0].slug, 'good-entry');
});

// Clean up the temp dir once all tests in this file have run.
test.after(() => {
	fs.rmSync(TMP_DIR, { recursive: true, force: true });
});
