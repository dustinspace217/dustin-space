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
 * The cache is loaded lazily on first access and re-read on the next
 * getGallery() after each write (loadGallery() runs inside every write's mutex).
 *
 * Exports:
 *   loadGallery()                              — read images.json into cache
 *   getGallery()                               — return cached copy (auto-loads if needed)
 *   findTarget(slug)                           — find a target by slug
 *   findVariant(slug, variantId)               — find a variant within a target
 *   slugExists(slug)                           — fast check from cache
 *   addTarget(targetObj, onCommit, onRollback)              — prepend new target (mutex-protected)
 *   addVariant(slug, variantObj, onCommit, onRollback)      — push variant to existing target
 *   addRevision(slug, variantId, revisionObj, onCommit, onRollback) — push revision to existing variant
 *   IMAGES_JSON                                 — absolute path to images.json
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { withImagesMutex } = require('./jobs');
const { assertValidImages } = require('./validateImages');

// Absolute path to images.json — the single source of truth for gallery data.
// Located in the site's _data directory, one level up from ingest/.
//
// INGEST_IMAGES_JSON overrides the path so a test can point the whole
// read-modify-write (loadGallery + writeGallery) at a throwaway temp file
// instead of the checked-in gallery data. This is a path redirect, not a
// behavioral branch — the code path is identical either way; only the target
// file changes. It exists specifically for the pre-write-validation gate test,
// which drives the REAL addTarget → validateImages path and must never risk
// touching the real images.json. Production never sets it, so the default path
// is used.
const IMAGES_JSON = process.env.INGEST_IMAGES_JSON
	|| path.join(__dirname, '..', '..', 'src', '_data', 'images.json');

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
 * This is the primary read method. It auto-loads on first call and whenever
 * the cache has been cleared. Returns the cached reference, so callers should
 * NOT mutate the returned array — use the write methods instead.
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
 * writeGallery — validate then write the current cache to disk.
 *
 * Internal helper called by the write methods after modifying the cache.
 * Writes with tab indentation to match the project's JSON formatting convention.
 *
 * Two guarantees, and one deliberate limit:
 *   - PRE-WRITE VALIDATION (W2): assertValidImages() runs before any bytes hit
 *     disk. A structurally broken cache (bad variant type, duplicate slug,
 *     invalid annotations_status) throws here and never reaches images.json, so
 *     the pipeline can't publish an array that breaks the Eleventy build. The
 *     validator is shared with the CI schema test — one definition of "valid".
 *   - SINGLE-FILE ATOMICITY: temp-file write + rename means a crash mid-write
 *     can't leave images.json empty or truncated. rename(2) is atomic on the
 *     same filesystem.
 *   - NOT a transaction across steps: this atomicity is per-file only. The
 *     surrounding publish (rename WebP assets, then write this JSON, then git
 *     commit/push) is SERIALIZED by withImagesMutex, which is not the same as
 *     transactional — the mutex only stops two runs interleaving, it does not
 *     roll back a partial publish. The add* callers below add explicit asset
 *     rollback for the write-failure case; a hard crash between the WebP rename
 *     and this JSON write is the documented residual (leaves an orphan WebP with
 *     no entry — harmless, overwritten on the next same-slug run).
 */
function writeGallery() {
	assertValidImages(cache);
	const tmpPath = IMAGES_JSON + '.tmp';
	fs.writeFileSync(tmpPath, JSON.stringify(cache, null, '\t'), 'utf8');
	fs.renameSync(tmpPath, IMAGES_JSON);
}

/**
 * commitOrRollback — run writeGallery(); on failure, invalidate the cache and
 * roll back committed asset files, then re-throw.
 *
 * Shared by addTarget/addVariant/addRevision so the write-failure recovery is
 * defined once. Two things happen on failure:
 *   1. cache = null — the in-memory cache was already mutated (unshift/push) by
 *      the caller; since writeGallery() did NOT persist it, the cache now
 *      disagrees with disk. Null forces the next getGallery() to reload from
 *      disk, so a subsequent slugExists() check doesn't see a phantom entry.
 *   2. onRollback() — the pipeline's asset-cleanup hook (delete the WebPs that
 *      onCommit already renamed into place). Without this, a validation or disk
 *      failure would leave orphan preview/thumb files referencing an entry that
 *      was never written. Wrapped in its own try/catch so a rollback failure is
 *      logged but does not mask the original write error the caller needs to see.
 *
 * @param {function} [onRollback] — optional async asset-cleanup hook
 * @throws {Error} always re-throws the original writeGallery() error
 */
async function commitOrRollback(onRollback) {
	try {
		writeGallery();
	} catch (writeErr) {
		cache = null;
		if (onRollback) {
			try {
				await onRollback();
			} catch (rollbackErr) {
				console.error('[gallery] Asset rollback after failed write also failed:', rollbackErr.message);
			}
		}
		throw writeErr;
	}
}

/**
 * addTarget — prepend a new target entry to images.json.
 *
 * Wrapped in withImagesMutex so concurrent pipeline runs are serialized.
 * The target is prepended (unshift) so the newest images appear first
 * in the gallery grid.
 *
 * @param {object} targetObj — the complete target object with variants[]
 * @param {function} [onCommit] — optional async hook run INSIDE the mutex,
 *   after the dup-slug check passes and before the write. The pipeline uses
 *   it to move temp WebP files into their final paths, SERIALIZED with the
 *   images.json write by the mutex, so two concurrent same-slug jobs can't
 *   overwrite each other's preview/thumb files (the file write used to happen
 *   before this check, leaving a TOCTOU window). Issue #67. "Serialized" is
 *   not "transactional" — see onRollback for the write-failure path.
 * @param {function} [onRollback] — optional async hook run when writeGallery()
 *   throws (validation failure or disk error) AFTER onCommit already placed the
 *   asset files. The pipeline uses it to delete the just-renamed WebPs so a
 *   failed publish doesn't leave orphan assets pointing at an entry that was
 *   never written. Restores the pre-publish state as far as the local FS allows.
 * @returns {Promise<void>} resolves after the write completes
 * @throws {Error} if the slug already exists (checked inside the mutex
 *   to prevent races between two concurrent pipelines)
 */
function addTarget(targetObj, onCommit, onRollback) {
	return withImagesMutex(async () => {
		// Re-read inside the mutex to get the freshest state.
		// Two pipelines may have both passed the fast-fail slug check
		// before either reached this point.
		loadGallery();
		if (slugExists(targetObj.slug)) {
			throw new Error(`Slug "${targetObj.slug}" already exists in images.json.`);
		}
		if (onCommit) await onCommit();
		cache.unshift(targetObj);
		await commitOrRollback(onRollback);
	});
}

/**
 * addVariant — add a variant to an existing target.
 *
 * Wrapped in withImagesMutex for concurrency safety.
 *
 * @param {string} slug       — the target's slug
 * @param {object} variantObj — the variant object to add
 * @param {function} [onCommit] — optional async hook run inside the mutex,
 *   after the variant-exists check passes and before the write. Same TOCTOU
 *   fix as addTarget — moves temp WebP files into place, serialized (not
 *   transactional) with the write by the mutex. Issue #67.
 * @param {function} [onRollback] — optional async asset-cleanup hook run when
 *   the write fails after onCommit placed the files. See addTarget.
 * @returns {Promise<void>}
 * @throws {Error} if the target doesn't exist or the variant ID already exists
 */
function addVariant(slug, variantObj, onCommit, onRollback) {
	return withImagesMutex(async () => {
		loadGallery();
		const target = findTarget(slug);
		if (!target) {
			throw new Error(`Target "${slug}" not found in images.json.`);
		}
		if (target.variants.some(v => v.id === variantObj.id)) {
			throw new Error(`Variant "${variantObj.id}" already exists on target "${slug}".`);
		}
		if (onCommit) await onCommit();
		target.variants.push(variantObj);
		await commitOrRollback(onRollback);
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
 * @param {function} [onCommit] — optional async hook run inside the mutex,
 *   after the revision-exists check passes and before the write. Same TOCTOU
 *   fix as addTarget — moves temp WebP files into place, serialized (not
 *   transactional) with the write by the mutex. Issue #67.
 * @param {function} [onRollback] — optional async asset-cleanup hook run when
 *   the write fails after onCommit placed the files. See addTarget.
 * @returns {Promise<void>}
 * @throws {Error} if target, variant, or revision ID problems
 */
function addRevision(slug, variantId, revisionObj, onCommit, onRollback) {
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
		// Legacy-variant guard (W3): older variants may predate the revisions[]
		// field and have it undefined. `.some`/`.unshift` on undefined would throw
		// a raw TypeError mid-mutex, masking the real cause. Normalize to [] so an
		// add-revision onto a legacy variant works instead of crashing HERE. This is
		// the authoritative backstop, not the only guard: the pipeline's earlier
		// duplicate fast-fail (pipeline.js ~217) and pre-upload re-check (~549) each
		// guard the same undefined-revisions access separately — a crash is fully
		// prevented only with all three, so don't read this as sole protection.
		if (!Array.isArray(variant.revisions)) {
			variant.revisions = [];
		}
		if (variant.revisions.some(r => r.id === revisionObj.id)) {
			throw new Error(`Revision "${revisionObj.id}" already exists on variant "${variantId}".`);
		}
		if (onCommit) await onCommit();

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
			// Promote the W6 hero srcset fields too (1200px rendition + real
			// dimensions) so the detail hero for a promoted final revision serves
			// the right small image and reserves exact space (no layout shift).
			// Kept in lockstep with the thumbnail/preview promotion above — a final
			// revision that updated the hero must update every hero-derived field.
			if (revisionObj.preview_1200_url) variant.preview_1200_url = revisionObj.preview_1200_url;
			if (revisionObj.preview_width)    variant.preview_width    = revisionObj.preview_width;
			if (revisionObj.preview_height)   variant.preview_height   = revisionObj.preview_height;
		}

		// Prepend so the newest revision appears first in the filmstrip.
		variant.revisions.unshift(revisionObj);
		await commitOrRollback(onRollback);
	});
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
	IMAGES_JSON,
};
