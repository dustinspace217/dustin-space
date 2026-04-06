/**
 * gallery.js — In-memory gallery data layer for the ingest pipeline
 *
 * Provides cached read/write access to src/_data/images.json with awareness
 * of the variant/revision hierarchy:
 *   target → variant → revision
 *
 * Read operations serve from an in-memory cache (invalidated after writes).
 * Write operations are mutex-protected via withImagesMutex() from lib/jobs.js
 * so concurrent pipeline runs don't clobber each other.
 *
 * The cache is loaded lazily on first access and can be force-invalidated
 * by calling invalidateCache() (e.g. after external edits to images.json).
 *
 * Exports:
 *   loadGallery()                              — read images.json into cache
 *   getGallery()                               — return cached copy (auto-loads if needed)
 *   findTarget(slug)                           — find a target by slug
 *   findVariant(slug, variantId)               — find a variant within a target
 *   slugExists(slug)                           — fast check from cache
 *   addTarget(targetObj)                        — prepend new target (mutex-protected)
 *   addVariant(slug, variantObj)                — push variant to existing target
 *   addRevision(slug, variantId, revisionObj)   — push revision to existing variant
 *   invalidateCache()                           — force re-read on next getGallery()
 *   IMAGES_JSON                                 — absolute path to images.json
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { withImagesMutex } = require('./jobs');

// Absolute path to images.json — the single source of truth for gallery data.
// Located in the site's _data directory, one level up from ingest/.
const IMAGES_JSON = path.join(__dirname, '..', '..', 'src', '_data', 'images.json');

// In-memory cache of the parsed images.json array.
// Set to null to trigger a reload on next getGallery() call.
let cache = null;

/**
 * loadGallery — read images.json from disk and store in the cache.
 *
 * @returns {Array} the parsed images array
 * @throws {Error} if images.json can't be read or parsed
 */
function loadGallery() {
	cache = JSON.parse(fs.readFileSync(IMAGES_JSON, 'utf8'));
	return cache;
}

/**
 * getGallery — return the cached images array, loading from disk if needed.
 *
 * This is the primary read method. It auto-loads on first call and after
 * invalidateCache() has been called. Returns the cached reference, so
 * callers should NOT mutate the returned array — use the write methods instead.
 *
 * @returns {Array} the images array
 */
function getGallery() {
	if (!cache) loadGallery();
	return cache;
}

/**
 * findTarget — find a target entry by slug.
 *
 * @param {string} slug — the target's slug (e.g. "horsehead-nebula")
 * @returns {object|undefined} the target object, or undefined if not found
 */
function findTarget(slug) {
	return getGallery().find(t => t.slug === slug);
}

/**
 * findVariant — find a variant within a target.
 *
 * @param {string} slug      — the target's slug
 * @param {string} variantId — the variant's id (e.g. "default", "widefield")
 * @returns {object|undefined} the variant object, or undefined if target or variant not found
 */
function findVariant(slug, variantId) {
	const target = findTarget(slug);
	if (!target) return undefined;
	return target.variants.find(v => v.id === variantId);
}

/**
 * slugExists — fast check whether a slug exists in images.json.
 *
 * Reads from the in-memory cache, avoiding a disk read on every keystroke
 * as the user types a slug in the ingest form.
 *
 * @param {string} slug — the slug to check
 * @returns {boolean} true if the slug exists
 */
function slugExists(slug) {
	return getGallery().some(t => t.slug === slug);
}

/**
 * writeGallery — write the current cache to disk.
 *
 * Internal helper called by the write methods after modifying the cache.
 * Writes with tab indentation to match the project's JSON formatting convention.
 */
function writeGallery() {
	// Atomic write: write to temp file, then rename. Prevents a crash or
	// power-loss mid-write from leaving images.json empty or truncated.
	const tmpPath = IMAGES_JSON + '.tmp';
	fs.writeFileSync(tmpPath, JSON.stringify(cache, null, '\t'), 'utf8');
	fs.renameSync(tmpPath, IMAGES_JSON);
}

/**
 * addTarget — prepend a new target entry to images.json.
 *
 * Wrapped in withImagesMutex so concurrent pipeline runs are serialized.
 * The target is prepended (unshift) so the newest images appear first
 * in the gallery grid.
 *
 * @param {object} targetObj — the complete target object with variants[]
 * @returns {Promise<void>} resolves after the write completes
 * @throws {Error} if the slug already exists (checked inside the mutex
 *   to prevent races between two concurrent pipelines)
 */
function addTarget(targetObj) {
	return withImagesMutex(async () => {
		// Re-read inside the mutex to get the freshest state.
		// Two pipelines may have both passed the fast-fail slug check
		// before either reached this point.
		loadGallery();
		if (slugExists(targetObj.slug)) {
			throw new Error(`Slug "${targetObj.slug}" already exists in images.json.`);
		}
		cache.unshift(targetObj);
		writeGallery();
	});
}

/**
 * addVariant — add a variant to an existing target.
 *
 * Wrapped in withImagesMutex for concurrency safety.
 *
 * @param {string} slug       — the target's slug
 * @param {object} variantObj — the variant object to add
 * @returns {Promise<void>}
 * @throws {Error} if the target doesn't exist or the variant ID already exists
 */
function addVariant(slug, variantObj) {
	return withImagesMutex(async () => {
		loadGallery();
		const target = findTarget(slug);
		if (!target) {
			throw new Error(`Target "${slug}" not found in images.json.`);
		}
		if (target.variants.some(v => v.id === variantObj.id)) {
			throw new Error(`Variant "${variantObj.id}" already exists on target "${slug}".`);
		}
		target.variants.push(variantObj);
		writeGallery();
	});
}

/**
 * addRevision — add a revision to an existing variant.
 *
 * If the revision has is_final: true, it also promotes the revision's
 * preview_url and dzi_url to the parent variant (so the variant's
 * hero image shows the latest final revision).
 *
 * Wrapped in withImagesMutex for concurrency safety.
 *
 * @param {string} slug        — the target's slug
 * @param {string} variantId   — the variant's id
 * @param {object} revisionObj — the revision object to add
 * @returns {Promise<void>}
 * @throws {Error} if target, variant, or revision ID problems
 */
function addRevision(slug, variantId, revisionObj) {
	return withImagesMutex(async () => {
		loadGallery();
		const target = findTarget(slug);
		if (!target) {
			throw new Error(`Target "${slug}" not found in images.json.`);
		}
		const variant = target.variants.find(v => v.id === variantId);
		if (!variant) {
			throw new Error(`Variant "${variantId}" not found on target "${slug}".`);
		}
		if (variant.revisions.some(r => r.id === revisionObj.id)) {
			throw new Error(`Revision "${revisionObj.id}" already exists on variant "${variantId}".`);
		}

		// If this revision is_final, demote any existing final revisions
		// and promote this one's URLs to the parent variant so the gallery
		// tile and variant hero show the latest final image.
		if (revisionObj.is_final) {
			variant.revisions.forEach(r => { r.is_final = false; });
			if (revisionObj.preview_url) variant.preview_url = revisionObj.preview_url;
			if (revisionObj.dzi_url)     variant.dzi_url     = revisionObj.dzi_url;
			// Also promote the thumbnail if the revision generated one.
			// The pipeline always generates a thumb, so this keeps the tile
			// in sync with the final revision's image.
			if (revisionObj.thumbnail)   variant.thumbnail   = revisionObj.thumbnail;
		}

		// Prepend so the newest revision appears first in the filmstrip.
		variant.revisions.unshift(revisionObj);
		writeGallery();
	});
}

/**
 * invalidateCache — force the next getGallery() call to re-read from disk.
 *
 * Call this if images.json was edited externally (e.g. manual edit,
 * git pull, or Eleventy build trigger).
 */
function invalidateCache() {
	cache = null;
}

module.exports = {
	loadGallery,
	getGallery,
	findTarget,
	findVariant,
	slugExists,
	addTarget,
	addVariant,
	addRevision,
	invalidateCache,
	IMAGES_JSON,
};
