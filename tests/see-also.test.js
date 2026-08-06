/**
 * tests/see-also.test.js — unit tests for the `relatedImages` computed prop
 * behind the detail pages' "See Also" ("Continue Exploring") section.
 * Run with `npm test`.
 *
 * QA review 2026-08-06 (Discussion #145, findings TA-2/TA-3/CR-4): most of
 * relatedImages' behavior is invisible to a build against the real data —
 * the exact-target tier is DORMANT (no two published targets share a
 * `target` value; the variant system absorbed the same-object case), the
 * date tie-break silently decides card order wherever every candidate ties
 * at one shared tag, and the cap only binds on pages with 4+ candidates.
 * A synthetic fixture is the only coverage those paths can have.
 *
 * relatedImages is a pure function of the Eleventy data cascade — no
 * Eleventy runtime needed, so these tests run in milliseconds.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const relatedImages =
	require('../src/gallery/gallery.11tydata.js').eleventyComputed.relatedImages;

/**
 * Builds a minimal images.json-shaped target entry. Only the fields
 * relatedImages actually reads: slug, target, tags, and variants (for the
 * primary variant's date in the tie-break).
 */
function entry(slug, target, tags, date) {
	return {
		slug: slug,
		target: target,
		tags: tags,
		variants: [{ primary: true, date: date || '2024-01-01' }],
	};
}

/** Wraps a page entry + pool into the data-cascade shape the prop receives. */
function data(image, publishedImages) {
	return { image: image, publishedImages: publishedImages };
}

/** The slugs of a relatedImages result, for order-sensitive assertions. */
function slugs(result) {
	return result.map(function (t) { return t.slug; });
}

// ── Tier 1: exact-target matches ─────────────────────────────────────────────

test('relatedImages: exact-target match outranks tag-overlap siblings', () => {
	const self = entry('m42-wide', 'M42', ['emission-nebula'], '2024-06-01');
	const pool = [
		self,
		// Shares TWO tags but is a different object — must rank below the
		// same-object entry despite the higher tag score.
		entry('rosette', 'NGC 2237', ['emission-nebula', 'widefield'], '2026-01-01'),
		// Same astronomical object, zero shared tags — tier 1 regardless.
		entry('m42-core', 'M42', ['closeup'], '2020-01-01'),
	];
	assert.deepEqual(slugs(relatedImages(data(self, pool))),
		['m42-core', 'rosette']);
});

test('relatedImages: target matching is case- and whitespace-insensitive', () => {
	// The tier is dormant in real data, so a hand-entered variant spelling
	// ("M 42" vs "M42") would otherwise silently never match (CR-4).
	const self = entry('a', 'M 42', ['x'], '2024-01-01');
	const pool = [self, entry('b', 'm42', ['y'], '2024-01-01')];
	assert.deepEqual(slugs(relatedImages(data(self, pool))), ['b']);
});

// ── Tier 2: tag overlap, ranking, and the cap ────────────────────────────────

test('relatedImages: more shared tags beat a newer date', () => {
	const self = entry('self', 'T0', ['a', 'b'], '2024-01-01');
	const pool = [
		self,
		entry('two-tags-old', 'T1', ['a', 'b'], '2020-01-01'),
		entry('one-tag-new',  'T2', ['a'],      '2026-01-01'),
	];
	assert.deepEqual(slugs(relatedImages(data(self, pool))),
		['two-tags-old', 'one-tag-new']);
});

test('relatedImages: equal shared counts tie-break newest primary date first', () => {
	// Load-bearing in production: on pages whose candidates all share one tag,
	// this comparator alone decides which cards render and in what order
	// (TA-2b) — a flipped sign would silently show the oldest siblings.
	const self = entry('self', 'T0', ['a'], '2024-01-01');
	const pool = [
		self,
		entry('oldest', 'T1', ['a'], '2020-05-05'),
		entry('newest', 'T2', ['a'], '2026-03-03'),
		entry('middle', 'T3', ['a'], '2023-07-07'),
	];
	assert.deepEqual(slugs(relatedImages(data(self, pool))),
		['newest', 'middle', 'oldest']);
});

test('relatedImages: caps the result at 3', () => {
	const self = entry('self', 'T0', ['a'], '2024-01-01');
	const pool = [self];
	for (let i = 0; i < 6; i++) {
		pool.push(entry('sib' + i, 'T' + (i + 1), ['a'], '2024-01-0' + (i + 1)));
	}
	assert.equal(relatedImages(data(self, pool)).length, 3);
});

// ── Exclusions and guards ────────────────────────────────────────────────────

test('relatedImages: never returns the page itself', () => {
	// Same slug AND same target — the strongest possible self-match bait.
	const self = entry('self', 'M42', ['a'], '2024-01-01');
	const pool = [self, entry('other', 'M42', ['a'], '2024-01-01')];
	assert.deepEqual(slugs(relatedImages(data(self, pool))), ['other']);
});

test('relatedImages: no shared tags and no shared target yields empty', () => {
	// The live Veil case: sole tag shared with nothing → section hidden.
	const self = entry('veil', 'NGC 6992', ['supernova-remnant'], '2024-01-01');
	const pool = [self, entry('m31', 'M31', ['galaxy'], '2024-01-01')];
	assert.deepEqual(relatedImages(data(self, pool)), []);
});

test('relatedImages: missing image or pool yields empty, never throws', () => {
	assert.deepEqual(relatedImages({ publishedImages: [] }), []);
	assert.deepEqual(relatedImages({ image: entry('a', 'T', ['x']) }), []);
	// Entries missing tags entirely are skipped, not crashed on.
	const self = entry('self', 'T0', ['a'], '2024-01-01');
	const tagless = { slug: 'tagless', target: 'T9', variants: [{ primary: true, date: '2024-01-01' }] };
	assert.deepEqual(relatedImages(data(self, [self, tagless])), []);
});

test('relatedImages: reads publishedImages, never the raw images list', () => {
	// Falsifies the sitewide failure class from TA-2d: if the pool reference
	// ever silently switched to the unfiltered `images` data, drafts would
	// leak into cross-links. The draft sibling here only exists in `images`.
	const self = entry('self', 'T0', ['a'], '2024-01-01');
	const draft = entry('draft-sibling', 'T1', ['a'], '2024-01-01');
	const d = {
		image: self,
		publishedImages: [self],
		images: [self, draft],
	};
	assert.deepEqual(relatedImages(d), []);
});
