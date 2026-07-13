/**
 * skywatching — derived data file.
 *
 * Returns the contents of `skywatchingImages.json` grouped by category, so
 * the page template can iterate each sub-section without filtering inline:
 *
 *   {% for img in skywatching.aurora %}  ...
 *   {% for img in skywatching.sunset %}  ...
 *   {% for img in skywatching.skyline %} ...
 *
 * Each group is sorted newest-first (descending date), matching the
 * gallery's reverse-chronological convention.
 *
 * Why a derived data file:
 *   Nunjucks lacks a built-in `groupby` filter — Eleventy ships some via
 *   `addFilter` but doing the grouping here keeps the template code
 *   simpler and surfaces empty categories as clean empty arrays (so the
 *   template can choose to render an "Aurora — coming soon" placeholder
 *   instead of an awkward empty grid). Same pattern as publishedImages.js.
 *
 * Filename convention: 11ty exposes any file under src/_data/ as a
 * template variable named after the file (without extension). So this
 * file is available as `skywatching` in every template.
 */
const all = require('./skywatchingImages.json');

// Categories we recognize. Adding a new category here AND in
// skywatchingImages.json's `category` field is the way to add a new
// section to the page — the template iterates this object's keys.
const CATEGORIES = ['aurora', 'sunset', 'skyline'];

function byDateDesc(a, b) {
	// Newest first — sort descending by ISO date string.
	// String comparison works correctly for YYYY-MM-DD dates.
	if (a.date > b.date) return -1;
	if (a.date < b.date) return 1;
	return 0;
}

const grouped = {};
for (const cat of CATEGORIES) {
	grouped[cat] = all
		.filter(img => img.category === cat)
		.sort(byDateDesc);
}

// Warn-and-degrade on unknown categories. The grouping above silently drops
// any entry whose `category` isn't in CATEGORIES — so a typo in
// skywatchingImages.json ("sunsets" vs "sunset") would make an image vanish
// from the page with no signal at all. Surface it as a build-time warning
// instead. Degrade, don't fail: the build still succeeds and every valid entry
// renders; the offending image just won't appear until the category is added
// (here + a template section) or the typo is fixed.
const known = new Set(CATEGORIES);
for (const img of all) {
	if (!known.has(img.category)) {
		console.warn(
			`[skywatching] "${img.title || 'untitled'}" has unknown category ` +
			`"${img.category}" — not in [${CATEGORIES.join(', ')}]; it will not ` +
			`appear on the page.`
		);
	}
}

module.exports = grouped;
