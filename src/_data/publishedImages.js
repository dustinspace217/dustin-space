/**
 * publishedImages — derived data file.
 *
 * Returns the same array as `images.json` minus any entries marked
 * `"published": false`. The original `images` global stays available
 * for tooling that needs the full catalog (the ingest tool, future
 * admin/preview views), but every public-facing template (gallery,
 * home, feed, detail-page pagination) iterates over THIS array so
 * unpublished entries never reach the deployed site.
 *
 * Why a derived data file instead of a Nunjucks filter:
 *   The pagination directive `data: images` in src/gallery/image.njk
 *   is resolved at front-matter parse time, before any Nunjucks filter
 *   can run on the value. The 11ty-native way to filter a pagination
 *   source is to point it at a different data variable — which is
 *   exactly what this file is. Same shape, same loop semantics, no
 *   new mental model for templates.
 *
 * Default behavior:
 *   `published` is OPTIONAL in the schema. Missing field === published.
 *   Only `published: false` (explicit boolean) hides an entry. This
 *   preserves the existing behavior of every entry that doesn't yet
 *   carry the field.
 *
 * Usage in templates:
 *   {% for image in publishedImages | sortByDate %}    (gallery, home, feed)
 *   pagination: { data: publishedImages, size: 1 }     (image.njk front matter)
 *
 * Filename convention: 11ty exposes any file under src/_data/ as a
 * template variable named after the file (without extension). So
 * `src/_data/publishedImages.js` becomes the `publishedImages`
 * variable available in every template. The .js extension means
 * 11ty runs the file at build time and uses module.exports as the
 * data — that's how we get the filtered derivation.
 */
const images = require("./images.json");

module.exports = images.filter(function (image) {
	// Treat any non-explicit-false value as published.
	// This means: missing field = published, true = published,
	// only explicit `published: false` hides the entry.
	return image.published !== false;
});
