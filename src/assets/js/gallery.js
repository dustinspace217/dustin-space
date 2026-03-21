/**
 * Gallery filter — lets visitors filter images by category.
 *
 * How it works:
 * - Each gallery card has a `data-category` attribute (e.g. data-category="nebula")
 * - Each filter button has a `data-filter` attribute matching those values
 * - Clicking a button hides all cards that don't match and shows those that do
 * - "all" shows everything
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
		 * Apply a filter — show cards matching `category`, hide the rest.
		 * @param {string} category - The category to show, or "all" to show everything.
		 */
		function applyFilter(category) {
			galleryCards.forEach(function (card) {
				// data-category is the HTML attribute on each card element
				const cardCategory = card.getAttribute("data-category");
				const matches = (category === "all" || cardCategory === category);

				// "hidden" class sets display:none via CSS
				card.classList.toggle("hidden", !matches);
			});

			// Update which button looks active
			filterButtons.forEach(function (btn) {
				btn.classList.toggle("active", btn.getAttribute("data-filter") === category);
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
