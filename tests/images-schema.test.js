/**
 * tests/images-schema.test.js — schema guard for src/_data/images.json, run
 * through the SHARED validator the ingest pipeline uses before writing.
 *
 * Issue #118 (Fix Wave 2 W2/W7): W2 introduces one canonical images.json
 * validator (ingest/lib/validateImages.js) called pre-write in the ingest
 * gallery layer; W7 wires that SAME validator into CI so the checked-in
 * images.json can never drift from the shape the pipeline enforces. Sharing one
 * validator (rather than a second, parallel schema here) means the test and the
 * write path can't disagree — a change to the contract updates both at once.
 *
 * Wave-2 stabilization: the earlier version of this file SKIPPED when the
 * validator module was absent, and asserted nothing but "the real file passes".
 * A no-op validator would sail through that. This version now:
 *   1. HARD-requires the module and asserts its exports exist (no skip — a
 *      revert that deletes/breaks validateImages.js turns this suite RED, not
 *      skipped);
 *   2. adds mutation-style NEGATIVE cases — known-bad objects that assertValidImages
 *      must throw on, each check naming the offending field. A vacuous validator
 *      (always-accept) fails every one of these.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const IMAGES_JSON  = path.join(__dirname, '..', 'src', '_data', 'images.json');

// Hard require: no defensive skip. If the module is missing or fails to load,
// this require throws and the whole suite goes RED — which is exactly what a
// wholesale revert of the W2 validator should do. The seam is not optional.
const validator = require('../ingest/lib/validateImages');

test('validateImages module exports the shared validator API', () => {
	assert.equal(typeof validator.validateImages, 'function',
		'validateImages(data) must be exported');
	assert.equal(typeof validator.assertValidImages, 'function',
		'assertValidImages(data) must be exported');
	assert.ok(Array.isArray(validator.ANNOTATIONS_STATUS_VALUES),
		'ANNOTATIONS_STATUS_VALUES enum must be exported');
});

test('images.json passes the shared ingest validator', () => {
	const images = JSON.parse(fs.readFileSync(IMAGES_JSON, 'utf8'));
	const { valid, errors } = validator.validateImages(images);
	assert.ok(valid,
		`the checked-in images.json failed the shared validator:\n  ${errors.join('\n  ')}`);
});

// ── mutation-style negative cases ─────────────────────────────────────────────
// Each starts from a minimally-valid gallery and mutates ONE thing into a known
// bad state, then asserts assertValidImages THROWS with a message naming the
// offending field. A validator stubbed to always-accept fails every assert.throws
// below — that's the point: these de-vacuous the coverage.

/**
 * minimalValid — the smallest images.json array the validator accepts: one
 * target with a slug, a title, and one variant carrying only its required id.
 * Deep-cloned per call so a test can mutate its copy without leaking into the next.
 *
 * @returns {Array} a fresh, valid images array
 */
function minimalValid() {
	return [
		{ slug: 'alpha', title: 'Alpha', variants: [{ id: 'default' }] },
	];
}

test('validator rejects a target missing the required slug', () => {
	const bad = minimalValid();
	delete bad[0].slug;
	assert.throws(() => validator.assertValidImages(bad), /slug/,
		'a target with no slug must be rejected, naming slug');
});

test('validator rejects a target missing the required variants array', () => {
	const bad = minimalValid();
	delete bad[0].variants;
	assert.throws(() => validator.assertValidImages(bad), /variants/,
		'a target with no variants[] must be rejected, naming variants');
});

test('validator rejects a variant whose id is the wrong type', () => {
	const bad = minimalValid();
	bad[0].variants[0].id = 42; // must be a non-empty string
	assert.throws(() => validator.assertValidImages(bad), /variant\.id/,
		'a numeric variant.id must be rejected, naming variant.id');
});

test('validator rejects a wrongly-typed optional field (preview_url)', () => {
	const bad = minimalValid();
	bad[0].variants[0].preview_url = 123; // must be string or null when present
	assert.throws(() => validator.assertValidImages(bad), /preview_url/,
		'a numeric preview_url must be rejected, naming preview_url');
});

test('validator rejects a 1200 rendition URL on a sub-1200px source (cross-field)', () => {
	// The whirlpool bug (#135.1) at its data root: preview_1200_url non-null
	// with preview_width <= 1200 means a same-width duplicate file and a lying
	// "1200w" srcset descriptor. The cross-field rule makes both the ingest
	// write gate and CI fail loudly instead of leaning on the template guard.
	const bad = minimalValid();
	bad[0].variants[0].preview_1200_url = '/assets/img/gallery/alpha-preview-1200.webp';
	bad[0].variants[0].preview_width = 803;
	bad[0].variants[0].preview_height = 1072;
	assert.throws(() => validator.assertValidImages(bad), /preview_1200_url.*not > 1200/,
		'a 1200 URL paired with width <= 1200 must be rejected by the cross-field rule');
});

test('validator accepts the consistent pairs the cross-field rule must not over-fire on', () => {
	// Both legitimate states: null URL on a narrow source (whirlpool today),
	// and a real URL on a wide source (every other entry).
	const ok = minimalValid();
	ok[0].variants[0].preview_1200_url = null;
	ok[0].variants[0].preview_width = 803;
	validator.assertValidImages(ok);
	const ok2 = minimalValid();
	ok2[0].variants[0].preview_1200_url = '/assets/img/gallery/alpha-preview-1200.webp';
	ok2[0].variants[0].preview_width = 2400;
	validator.assertValidImages(ok2);
});

test('validator rejects an out-of-enum annotations_status', () => {
	const bad = minimalValid();
	bad[0].variants[0].annotations_status = 'definitely-not-a-status';
	assert.throws(() => validator.assertValidImages(bad), /annotations_status/,
		'an unknown annotations_status must be rejected, naming annotations_status');
});

test('validator rejects duplicate slugs across targets', () => {
	const bad = minimalValid();
	// A second target reusing the first's slug — collides on the generated
	// detail-page URL, which the validator treats as a hard invariant.
	bad.push({ slug: 'alpha', title: 'Alpha II', variants: [{ id: 'default' }] });
	assert.throws(() => validator.assertValidImages(bad), /duplicate slug/,
		'two targets with the same slug must be rejected, naming the duplicate');
});

test('validator accepts the minimal valid shape (guards against always-throw)', () => {
	// Symmetry check: a validator that throws on EVERYTHING would pass all the
	// negative cases above for the wrong reason. Assert the minimal valid array
	// does NOT throw, so the negatives are meaningful.
	assert.doesNotThrow(() => validator.assertValidImages(minimalValid()));
});
