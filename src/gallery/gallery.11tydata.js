/**
 * Directory data file for src/gallery/
 *
 * In 11ty, a file named [dirname].11tydata.js applies to every template
 * in that directory. Here we use it to set computed front matter for the
 * image detail pages — things like the page title and OG image, which
 * depend on which image is being rendered.
 *
 * `eleventyComputed` takes functions that receive the full data cascade
 * (`data`) and return a value. For image detail pages, `data.image` is
 * the current image object (set by the pagination alias in image.njk).
 */

/**
 * Returns the primary variant for a target — the one marked `primary: true`,
 * or the first variant as fallback. Used for gallery tiles, OG tags, and
 * JSON-LD structured data — anywhere a single representative image is needed.
 *
 * @param {object} image - An image/target object from images.json
 * @returns {object|null} The primary variant object, or null
 */
function getPrimaryVariant(image) {
	if (!image || !image.variants) return null;
	return image.variants.find(function (v) { return v.primary; })
		|| image.variants[0];
}

module.exports = {
	eleventyComputed: {
		// Page <title> — "Orion Nebula | DUST·IN·SPACE"
		title: (data) => (data.image ? data.image.title : "Gallery"),

		// Meta description for search engines / social sharing
		description: (data) =>
			data.image && data.image.description
				? data.image.description.slice(0, 160)
				: "Astrophotography gallery by Dustin K.",

		// OG image for social sharing cards — uses primary variant's thumbnail
		ogImage: (data) => {
			var pv = data.image ? getPrimaryVariant(data.image) : null;
			return pv ? pv.thumbnail : null;
		},

		// Whether this target has more than one variant (controls UI elements)
		hasMultipleVariants: (data) => {
			return data.image && data.image.variants && data.image.variants.length > 1;
		},

		// Primary variant object — available as `primaryVariant` in templates
		primaryVariant: (data) => data.image ? getPrimaryVariant(data.image) : null,
	},
};
