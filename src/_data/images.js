/**
 * Image data loader with variant compatibility shim.
 *
 * Reads the raw image data from images-raw.json (which uses the variant
 * schema: each image has a `variants` array) and flattens the primary
 * variant's fields onto each image object. This lets existing templates
 * read `image.thumbnail`, `image.equipment`, etc. without modification.
 *
 * 11ty treats .js files in _data/ identically to .json files — the
 * exported value becomes the `images` template variable. Templates,
 * pagination, and filters all see the same array they always did.
 *
 * PHASE 1 COMPATIBILITY LAYER — remove this file and rename
 * images-raw.json back to images.json in Phase 3, when templates
 * are rewritten to read from `image.variants[]` directly.
 */

// Node.js built-in — reads the JSON file relative to this script
const rawImages = require("./images-raw.json");

/**
 * Finds the primary variant in a target's variants array.
 * Falls back to the first variant if none is marked primary.
 *
 * @param {object} image - A target object from images-raw.json
 * @returns {object|null} The primary variant, or null if no variants
 */
function getPrimaryVariant(image) {
	if (!image.variants || image.variants.length === 0) return null;
	return image.variants.find(function (v) { return v.primary; })
		|| image.variants[0];
}

// Fields that moved from the target level into variants[] during migration.
// These are copied from the primary variant onto the image object so that
// templates can still access them as `image.thumbnail`, `image.sky`, etc.
const VARIANT_FIELDS = [
	"date", "thumbnail", "preview_url", "full_url",
	"dzi_url", "annotated_dzi_url", "annotated_url",
	"annotations", "equipment", "acquisition", "sky"
];

// Flatten primary variant fields onto each image, then export the array
module.exports = rawImages.map(function (image) {
	var pv = getPrimaryVariant(image);
	if (!pv) return image;

	// Shallow-copy the image so we don't mutate the require() cache
	var merged = Object.assign({}, image);

	VARIANT_FIELDS.forEach(function (field) {
		// Only copy variant fields that aren't already at the target level.
		// Target-level fields (title, description, tags, etc.) are never overwritten.
		if (!(field in merged) || merged[field] === undefined) {
			merged[field] = pv[field];
		}
	});

	return merged;
});
