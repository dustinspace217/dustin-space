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

		/**
		 * "See Also" cross-links (VARIANT-REVISION-PLAN.md Phase 5, extended).
		 *
		 * Two tiers, concatenated in priority order:
		 *   1. Exact `target` match — the plan-as-written case: a separate gallery
		 *      target of the SAME astronomical object. Currently dormant (the
		 *      variant system absorbed same-object images into one target), but
		 *      kept per the plan so it lights up automatically if a same-object
		 *      target ever ships as its own entry.
		 *   2. Tag-overlap fallback — sibling objects of the same type (galaxy,
		 *      emission-nebula, ...), ranked by how many tags they share, newest
		 *      first on ties. This is what actually renders today; without it the
		 *      section would be invisible on every page (verified 2026-08-06:
		 *      all 14 targets have unique `target` values).
		 *
		 * Pool is `publishedImages` (not raw `images`) so drafts marked
		 * published:false never appear as cross-links — same rule as every other
		 * public surface. Capped at 3 so the strip stays compact (one row on
		 * desktop widths; the auto-fill grid wraps to two rows at two-column
		 * widths) and doesn't compete with the page's own content.
		 *
		 * Returns an array of target objects (same shape as publishedImages
		 * entries); the template resolves each one's primary variant for the card.
		 */
		relatedImages: (data) => {
			if (!data.image || !data.publishedImages) return [];
			var self = data.image;
			var pool = data.publishedImages.filter(function (t) {
				return t.slug !== self.slug;
			});

			// Tier 1 — same astronomical object published as a separate target.
			// Matching is normalized (case-folded, whitespace-removed) because
			// this tier is DORMANT: no build against real data can exercise it,
			// so a hand-entered "M 42" vs an existing "M42" would silently never
			// match and nothing would surface the miss. Whitespace is REMOVED,
			// not collapsed — catalog designations vary exactly that way, and no
			// two real catalog IDs differ only by spacing. The normalization is
			// pinned by tests/see-also.test.js — the only coverage a dormant
			// path can have.
			var normTarget = function (v) {
				return String(v).toLowerCase().replace(/\s+/g, "");
			};
			var selfTarget = self.target ? normTarget(self.target) : null;
			var exact = pool.filter(function (t) {
				return t.target && selfTarget && normTarget(t.target) === selfTarget;
			});

			// Tier 2 — same object type(s), by tag overlap. A Set makes the
			// per-candidate lookup O(1); the pool is tiny (~14) so this is about
			// clarity, not speed.
			var selfTags = new Set(self.tags || []);
			var scored = pool
				.filter(function (t) { return exact.indexOf(t) === -1; })
				.map(function (t) {
					var shared = (t.tags || []).filter(function (tag) {
						return selfTags.has(tag);
					}).length;
					return { target: t, shared: shared };
				})
				.filter(function (s) { return s.shared > 0; })
				.sort(function (a, b) {
					// More shared tags first; on ties, newer primary-variant
					// date first (ISO yyyy-mm-dd strings compare correctly).
					if (b.shared !== a.shared) return b.shared - a.shared;
					var da = (getPrimaryVariant(a.target) || {}).date || "";
					var db = (getPrimaryVariant(b.target) || {}).date || "";
					return db < da ? -1 : db > da ? 1 : 0;
				})
				.map(function (s) { return s.target; });

			return exact.concat(scored).slice(0, 3);
		},
	},
};
