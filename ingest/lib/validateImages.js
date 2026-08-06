/**
 * validateImages.js — structural validator for src/_data/images.json
 *
 * A single source of truth for "is this images.json shape safe to publish?"
 * Called in two places (W2 publish-integrity work):
 *   1. gallery.js writeGallery() — pre-write gate so the ingest pipeline
 *      never persists an array that would break the Eleventy build.
 *   2. The CI schema test (agent G) — requires this module and asserts the
 *      committed images.json validates, catching hand-edits that drift.
 *
 * Design choice — validate structure, not content. This checks the shape the
 * templates and pipeline hard-depend on (array of targets, each with a slug +
 * variants[], each variant with an id and correctly-typed optional fields). It
 * deliberately does NOT enforce presence of every optional field, because the
 * existing gallery legitimately omits many of them (most variants have no
 * `annotations_status`; some have `preview_url: null`). Over-strict validation
 * would reject valid live data. The rule: require what would break the build
 * or violate a hard invariant; for everything else, validate the type only
 * when the field is present.
 *
 * Exports:
 *   ANNOTATIONS_STATUS_VALUES — the allowed annotations_status enum
 *   validateImages(data)      — returns { valid: boolean, errors: string[] }
 *   assertValidImages(data)   — throws Error(joined errors) when invalid
 */

'use strict';

// Allowed values for a variant's annotations_status field. Set by the ingest
// pipeline (lib/pipeline.js) to record WHY annotations[] is what it is:
//   ok             — Simbad ran and returned a result (possibly empty FOV)
//   no_simbad      — the Simbad step was skipped entirely
//   simbad_failed  — Simbad was attempted but the network call threw
//   wcs_degenerate — the plate solution's CD matrix is non-invertible, so
//                    every annotation would project to nothing. Added in the
//                    W3 platesolve fix; listed here so the pre-write validator
//                    doesn't reject a legitimately-degenerate entry. The two
//                    stores (this enum + pipeline.js) must stay in sync — a new
//                    status value goes in BOTH or the pipeline write gets
//                    rejected by its own validator.
const ANNOTATIONS_STATUS_VALUES = ['ok', 'no_simbad', 'simbad_failed', 'wcs_degenerate'];

/**
 * isPlainObject — true only for non-null, non-array objects. Used because
 * `typeof null === 'object'` and arrays are objects too, and neither is a
 * valid target/variant record.
 *
 * @param {*} v — value to test
 * @returns {boolean}
 */
function isPlainObject(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * validateVariant — validate one variant object, pushing any problems onto
 * the shared errors array with a path prefix for locateability.
 *
 * @param {*} variant — the candidate variant
 * @param {string} where — human-readable path prefix (e.g. 'target "veil"[0]')
 * @param {string[]} errors — accumulator; problems are pushed here
 */
function validateVariant(variant, where, errors) {
	if (!isPlainObject(variant)) {
		errors.push(`${where}: variant is not an object`);
		return;
	}
	// id is the only hard-required variant field — the templates key off it
	// (URL fragments, revision lookups). Everything else is optional-with-type.
	if (typeof variant.id !== 'string' || variant.id.length === 0) {
		errors.push(`${where}: variant.id must be a non-empty string`);
	}
	// Optional-but-typed fields. Only checked when present so legacy records
	// that omit them (e.g. preview_url: null on DZI-only or solar entries) pass.
	if ('preview_url' in variant && variant.preview_url !== null && typeof variant.preview_url !== 'string') {
		errors.push(`${where}: variant.preview_url must be a string or null`);
	}
	if ('dzi_url' in variant && variant.dzi_url !== null && typeof variant.dzi_url !== 'string') {
		errors.push(`${where}: variant.dzi_url must be a string or null`);
	}
	if ('annotations' in variant && !Array.isArray(variant.annotations)) {
		errors.push(`${where}: variant.annotations must be an array`);
	}
	// revisions[] is optional on legacy variants (see the addRevision guard in
	// gallery.js). When present it must be an array.
	if ('revisions' in variant && !Array.isArray(variant.revisions)) {
		errors.push(`${where}: variant.revisions must be an array`);
	}
	if ('annotations_status' in variant &&
		!ANNOTATIONS_STATUS_VALUES.includes(variant.annotations_status)) {
		errors.push(
			`${where}: variant.annotations_status "${variant.annotations_status}" ` +
			`is not one of ${ANNOTATIONS_STATUS_VALUES.join(', ')}`
		);
	}
	// W6 rendition fields — when the ingest pipeline / backfill has populated
	// them, they must be the right type so the template's srcset/dimension math
	// doesn't emit NaN. All three are optional (older entries lack them).
	if ('preview_1200_url' in variant && variant.preview_1200_url !== null && typeof variant.preview_1200_url !== 'string') {
		errors.push(`${where}: variant.preview_1200_url must be a string or null`);
	}
	if ('preview_width' in variant && variant.preview_width !== null &&
		!(typeof variant.preview_width === 'number' && variant.preview_width > 0)) {
		errors.push(`${where}: variant.preview_width must be a positive number or null`);
	}
	if ('preview_height' in variant && variant.preview_height !== null &&
		!(typeof variant.preview_height === 'number' && variant.preview_height > 0)) {
		errors.push(`${where}: variant.preview_height must be a positive number or null`);
	}
	// Cross-field rule (QA 2026-08-06, issue #135.1): a non-null 1200 rendition
	// URL only makes sense when the source is actually wider than 1200px —
	// `--size down` never upscales, so a sub-1200 source's "-1200" file would be
	// a same-width duplicate and its "1200w" srcset descriptor a lie (the
	// whirlpool bug). Enforcing it HERE means both the ingest write gate and CI
	// fail loudly if any path (pipeline, backfill, hand edit) tries to persist
	// the inconsistent pair, instead of relying on the template guard alone.
	if (variant.preview_1200_url != null &&
		!(typeof variant.preview_width === 'number' && variant.preview_width > 1200)) {
		errors.push(
			`${where}: variant.preview_1200_url is set but preview_width ` +
			`(${variant.preview_width}) is not > 1200 — a 1200 rendition of a ` +
			`sub-1200px source is a same-width duplicate with a lying srcset descriptor`
		);
	}
}

/**
 * validateImages — check that `data` is a well-formed images.json array.
 *
 * @param {*} data — the parsed images.json (expected: array of targets)
 * @returns {{ valid: boolean, errors: string[] }} valid=true with empty errors
 *   when the shape is safe to publish; otherwise valid=false and errors lists
 *   every problem found (all problems, not just the first — so a hand-edit can
 *   be fixed in one pass).
 */
function validateImages(data) {
	const errors = [];

	if (!Array.isArray(data)) {
		return { valid: false, errors: ['images.json root must be an array'] };
	}

	// Slug uniqueness is a hard invariant — two targets with the same slug
	// collide on the generated detail-page URL, and slugExists() would silently
	// resolve to the first. Track seen slugs to catch a duplicate before write.
	const seenSlugs = new Set();

	for (let i = 0; i < data.length; i++) {
		const target = data[i];
		const where = `target[${i}]`;
		if (!isPlainObject(target)) {
			errors.push(`${where}: entry is not an object`);
			continue;
		}
		if (typeof target.slug !== 'string' || target.slug.length === 0) {
			errors.push(`${where}: slug must be a non-empty string`);
		} else {
			if (seenSlugs.has(target.slug)) {
				errors.push(`${where}: duplicate slug "${target.slug}"`);
			}
			seenSlugs.add(target.slug);
		}
		if (typeof target.title !== 'string' || target.title.length === 0) {
			errors.push(`${where} (${target.slug || '?'}): title must be a non-empty string`);
		}
		if (!Array.isArray(target.variants) || target.variants.length === 0) {
			errors.push(`${where} (${target.slug || '?'}): variants must be a non-empty array`);
			continue; // can't validate variants of a non-array
		}
		for (let j = 0; j < target.variants.length; j++) {
			validateVariant(target.variants[j], `${where} (${target.slug || '?'}).variants[${j}]`, errors);
		}
	}

	return { valid: errors.length === 0, errors };
}

/**
 * assertValidImages — throw when `data` fails validation, otherwise return it.
 *
 * Convenience wrapper for call sites (gallery.js writeGallery) that want a
 * hard stop rather than a result object. The thrown message joins every error
 * so the pipeline's SSE `error` event tells the owner exactly what's wrong.
 *
 * @param {*} data — parsed images.json
 * @returns {*} data (unchanged) when valid
 * @throws {Error} listing all validation errors when invalid
 */
function assertValidImages(data) {
	const { valid, errors } = validateImages(data);
	if (!valid) {
		throw new Error(`images.json failed validation:\n  - ${errors.join('\n  - ')}`);
	}
	return data;
}

module.exports = { ANNOTATIONS_STATUS_VALUES, validateImages, assertValidImages };
