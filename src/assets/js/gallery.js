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
 * URL persistence:
 * - The active filter is written to the ?filter= query parameter via
 *   history.replaceState() — no page reload, just a URL update.
 * - On page load the URL is read first, so a shared link like
 *   /gallery/?filter=messier opens with that filter already applied.
 * - replaceState (not pushState) is used so clicking through filters
 *   doesn't bloat the browser history stack. The back button takes you
 *   back to wherever you came from, not to a previous filter state.
 *
 * Zero-result empty state:
 * - If a filter matches no cards, a message is shown instead of a blank grid.
 *
 * No framework needed — vanilla JS is fine for this.
 */
(function () {
	"use strict";

	// Wait until the page's HTML is fully parsed before running.
	// This ensures the gallery cards and buttons exist in the DOM.
	document.addEventListener("DOMContentLoaded", function () {

		// Grab all the filter buttons, gallery cards, and the grid container.
		// querySelectorAll returns a NodeList — we spread it into an array
		// so we can use array methods like .forEach() on it.
		const filterButtons = [...document.querySelectorAll(".filter-btn")];
		const galleryCards  = [...document.querySelectorAll(".gallery-card")];
		const grid          = document.querySelector(".gallery-grid");
		const countEl       = document.querySelector(".filter-count");

		// If there's no gallery on this page, exit early.
		if (filterButtons.length === 0) return;

		// ── Empty state element ───────────────────────────────────────────────
		// The <p class="gallery-empty"> is present in the static HTML so screen
		// readers register its aria-live region at page load. Dynamically
		// injected aria-live elements are frequently ignored by NVDA/JAWS.
		// We just find the existing element and show/hide it.
		const emptyState = grid ? grid.querySelector(".gallery-empty") : null;

		/**
		 * Apply a filter — show cards matching `tag`, hide the rest.
		 * Updates the URL query parameter and the active button state.
		 * Shows an empty-state message if no cards match.
		 *
		 * @param {string} tag - A tag slug (e.g. "galaxy"), or "all" to show everything.
		 */
		function applyFilter(tag) {
			var visibleCount = 0;

			galleryCards.forEach(function (card) {
				// data-tags is a space-separated list of tag slugs on each card.
				// Split it into an array so we can check membership with .includes().
				const cardTags = (card.getAttribute("data-tags") || "").split(" ");
				const matches  = (tag === "all" || cardTags.includes(tag));

				// "hidden" class sets display:none via CSS
				card.classList.toggle("hidden", !matches);
				if (matches) visibleCount++;
			});

			// Show or hide the empty state message
			if (emptyState) {
				emptyState.classList.toggle("hidden", visibleCount > 0);
			}

			// ── Stagger-in animation ───────────────────────────────────────
			// Remove the entering class from all cards first, then re-add it
			// to the newly-visible ones with increasing delays.
			// requestAnimationFrame lets the browser process the removal
			// before re-adding, so the animation re-fires even when the same
			// cards were visible before the filter change.
			galleryCards.forEach(function (c) { c.classList.remove("is-entering"); });
			requestAnimationFrame(function () {
				var i = 0;
				galleryCards.forEach(function (card) {
					if (!card.classList.contains("hidden")) {
						// 45ms between each card; last card (11th) enters at ~450ms
						card.style.animationDelay = (i * 45) + "ms";
						card.classList.add("is-entering");
						i++;
					}
				});
			});

			// Update the result count line above the grid.
			// Shows "Showing all N images" when unfiltered, or "Showing X of N" when filtered.
			if (countEl) {
				var total = galleryCards.length;
				countEl.textContent = (tag === "all")
					? "Showing all " + total + " images"
					: "Showing " + visibleCount + " of " + total + " images";
			}

			// Update which button looks active.
			// aria-pressed="true/false" lets screen readers announce the active state
			// without relying only on the visual .active class.
			filterButtons.forEach(function (btn) {
				var isActive = btn.getAttribute("data-filter") === tag;
				btn.classList.toggle("active", isActive);
				btn.setAttribute("aria-pressed", isActive ? "true" : "false");
			});

			// ── Persist the active filter in the URL ─────────────────────────
			// URLSearchParams and history.replaceState are supported in all
			// modern browsers. replaceState updates the URL bar without
			// triggering a page load and without adding a history entry.
			const url = new URL(window.location.href);
			if (tag === "all") {
				// Clean URL — remove the parameter entirely when showing all
				url.searchParams.delete("filter");
			} else {
				url.searchParams.set("filter", tag);
			}
			// replaceState(state, unused title, new URL)
			history.replaceState(null, "", url.toString());
		}

		// Attach a click listener to each button
		filterButtons.forEach(function (btn) {
			btn.addEventListener("click", function () {
				const filter = btn.getAttribute("data-filter");
				applyFilter(filter);
			});
		});

		// ── Read initial filter from the URL on page load ────────────────────
		// If someone navigates to /gallery/?filter=messier, apply that filter
		// immediately. Falls back to "all" if no parameter is present, or if
		// the value in the URL doesn't match any filter button (e.g. stale link).
		const params        = new URLSearchParams(window.location.search);
		const urlFilter     = params.get("filter") || "all";
		const validFilters  = filterButtons.map(function (btn) {
			return btn.getAttribute("data-filter");
		});
		const initialFilter = validFilters.includes(urlFilter) ? urlFilter : "all";
		applyFilter(initialFilter);
	});
})();
