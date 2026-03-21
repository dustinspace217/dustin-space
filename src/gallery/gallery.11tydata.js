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
module.exports = {
	eleventyComputed: {
		// Page <title> — "Orion Nebula | DUST·IN·SPACE"
		title: (data) => (data.image ? data.image.title : "Gallery"),

		// Meta description for search engines / social sharing
		description: (data) =>
			data.image && data.image.description
				? data.image.description.slice(0, 160)
				: "Astrophotography gallery by Dustin K.",

		// OG image for social sharing cards
		ogImage: (data) => (data.image ? data.image.thumbnail : null),
	},
};
