/**
 * Gallery filter — lets visitors filter images by tag.
 *
 * How it works:
 * - Each gallery card has a `data-tags` attribute: a space-separated list of
 *   tag slugs (e.g. data-tags="emission-nebula dark-nebula"). Images with
 *   multiple tags appear under every matching filter.
 * - Each filter button has a `data-filter` attribute matching a tag slug value.
 * - Clicking a button hides all cards whose tag list doesn't include the filter.
 * - "all" shows everything.
 *
 * No framework needed — vanilla JS is fine for this.
 */
(function () {
	"use strict";

	// Wait until the page's HTML is fully parsed before running.
	// This ensures the gallery cards and buttons exist in the DOM.
	document.addEventListener("DOMContentLoaded", function () {

		// Grab all the filter buttons and gallery cards.
		// querySelectorAll returns a NodeList — we spread it into an array
		// so we can use array methods like .forEach() on it.
		const filterButtons = [...document.querySelectorAll(".filter-btn")];
		const galleryCards  = [...document.querySelectorAll(".gallery-card")];

		// If there's no gallery on this page, exit early.
		if (filterButtons.length === 0) return;

		/**
		 * Apply a filter — show cards that include `tag` in their tag list, hide the rest.
		 * @param {string} tag - A tag slug (e.g. "galaxy"), or "all" to show everything.
		 */
		function applyFilter(tag) {
			galleryCards.forEach(function (card) {
				// data-tags is a space-separated list of tag slugs on each card.
				// Split it into an array so we can check membership with .includes().
				const cardTags = (card.getAttribute("data-tags") || "").split(" ");
				const matches = (tag === "all" || cardTags.includes(tag));

				// "hidden" class sets display:none via CSS
				card.classList.toggle("hidden", !matches);
			});

			// Update which button looks active
			filterButtons.forEach(function (btn) {
				btn.classList.toggle("active", btn.getAttribute("data-filter") === tag);
			});
		}

		// Attach a click listener to each button
		filterButtons.forEach(function (btn) {
			btn.addEventListener("click", function () {
				const filter = btn.getAttribute("data-filter");
				applyFilter(filter);
			});
		});

		// Start with "all" selected
		applyFilter("all");
	});
})();
