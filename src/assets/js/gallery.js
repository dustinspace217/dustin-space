/**
 * Gallery filter — lets visitors filter images by tag and equipment category.
 *
 * Two independent filter dimensions combined with AND logic:
 *   1. Tag filter — subject type (galaxy, emission-nebula, etc.) or catalog (messier, caldwell)
 *   2. Equipment filter — equipment category (personal, itelescope, solar)
 *
 * A card is visible only when it matches BOTH the active tag filter AND the
 * active equipment filter. "all" in either dimension means no constraint.
 *
 * How it works:
 * - Each gallery card has a `data-tags` attribute: a space-separated list of
 *   tag slugs (e.g. data-tags="emission-nebula dark-nebula messier").
 * - Each gallery card has a `data-equipment` attribute: a single equipment
 *   category slug (e.g. data-equipment="personal").
 * - Tag filter buttons have `data-filter` matching a tag slug.
 * - Equipment filter buttons have `data-filter-eq` matching an equipment slug.
 * - Clicking a button in one dimension doesn't reset the other dimension.
 *
 * URL persistence:
 * - Both filters are written to query parameters: ?filter=messier&eq=personal
 * - history.replaceState() is used so filters don't bloat the back button stack.
 * - On page load the URL is read to restore both filters from shared links.
 *
 * No framework needed — vanilla JS is fine for this.
 */
(function () {
	"use strict";

	// Wait until the page's HTML is fully parsed before running.
	// This ensures the gallery cards and buttons exist in the DOM.
	document.addEventListener("DOMContentLoaded", function () {

		// Grab all the filter buttons (both types), gallery cards, and the grid container.
		// querySelectorAll returns a NodeList — we spread it into an array
		// so we can use array methods like .forEach() on it.
		var tagButtons = [...document.querySelectorAll(".filter-btn[data-filter]")];
		var eqButtons  = [...document.querySelectorAll(".filter-btn[data-filter-eq]")];
		var galleryCards  = [...document.querySelectorAll(".gallery-card")];
		var grid          = document.querySelector(".gallery-grid");
		var countEl       = document.querySelector(".filter-count");

		// If there's no gallery on this page, exit early.
		if (tagButtons.length === 0 && eqButtons.length === 0) return;

		// ── Filter state ─────────────────────────────────────────────────
		// Each dimension tracks its own active value independently.
		// "all" means no constraint in that dimension.
		var activeTagFilter = "all";
		var activeEqFilter  = "all";

		// ── Empty state element ───────────────────────────────────────────
		// The <p class="gallery-empty"> is present in the static HTML so screen
		// readers register its aria-live region at page load. Dynamically
		// injected aria-live elements are frequently ignored by NVDA/JAWS.
		// We just find the existing element and show/hide it.
		var emptyState = grid ? grid.querySelector(".gallery-empty") : null;

		/**
		 * Apply both filter dimensions — show cards matching BOTH the active
		 * tag filter AND the active equipment filter, hide the rest.
		 * Updates the URL query parameters, active button states, and the
		 * result count. Shows an empty-state message if no cards match.
		 */
		function applyFilters() {
			var visibleCount = 0;

			galleryCards.forEach(function (card) {
				// data-tags is a space-separated list of tag slugs on each card.
				// Split into an array so we can check membership with .includes().
				var cardTags = (card.getAttribute("data-tags") || "").split(" ");
				// data-equipment is a single slug (e.g. "personal", "itelescope", "solar")
				var cardEq   = card.getAttribute("data-equipment") || "";

				// AND logic: card must pass BOTH dimensions to be visible
				var matchesTag = (activeTagFilter === "all" || cardTags.includes(activeTagFilter));
				var matchesEq  = (activeEqFilter === "all" || cardEq === activeEqFilter);

				// "hidden" class sets display:none via CSS
				card.classList.toggle("hidden", !(matchesTag && matchesEq));
				if (matchesTag && matchesEq) visibleCount++;
			});

			// Show or hide the empty state message
			if (emptyState) {
				emptyState.classList.toggle("hidden", visibleCount > 0);
			}

			// ── Stagger-in animation ───────────────────────────────────────
			// Skip the animation entirely for users who have requested reduced motion
			// in their OS accessibility settings. Cards appear instantly instead.
			var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

			// Remove the entering class from all cards first, then re-add it
			// to the newly-visible ones with increasing delays.
			// requestAnimationFrame lets the browser process the removal
			// before re-adding, so the animation re-fires even when the same
			// cards were visible before the filter change.
			galleryCards.forEach(function (c) { c.classList.remove("is-entering"); });
			if (!reducedMotion) {
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
			}

			// Update the result count line above the grid.
			// Shows "Showing all N images" when both filters are unset,
			// or "Showing X of N" when any filter is active.
			if (countEl) {
				var total = galleryCards.length;
				var isFiltered = (activeTagFilter !== "all" || activeEqFilter !== "all");
				countEl.textContent = isFiltered
					? "Showing " + visibleCount + " of " + total + " images"
					: "Showing all " + total + " images";
			}

			// ── Update active state on tag filter buttons ─────────────────
			// aria-pressed="true/false" lets screen readers announce the active
			// state without relying only on the visual .active class.
			tagButtons.forEach(function (btn) {
				var isActive = btn.getAttribute("data-filter") === activeTagFilter;
				btn.classList.toggle("active", isActive);
				btn.setAttribute("aria-pressed", isActive ? "true" : "false");
			});

			// ── Update active state on equipment filter buttons ───────────
			eqButtons.forEach(function (btn) {
				// Equipment buttons with no active equipment filter → none active
				// When an eq filter is active, the matching button gets .active
				var isActive = btn.getAttribute("data-filter-eq") === activeEqFilter;
				btn.classList.toggle("active", isActive);
				btn.setAttribute("aria-pressed", isActive ? "true" : "false");
			});

			// ── Persist both filters in the URL ──────────────────────────
			// URLSearchParams and history.replaceState are supported in all
			// modern browsers. replaceState updates the URL bar without
			// triggering a page load and without adding a history entry.
			var url = new URL(window.location.href);

			// Tag filter → ?filter= param
			if (activeTagFilter === "all") {
				url.searchParams.delete("filter");
			} else {
				url.searchParams.set("filter", activeTagFilter);
			}

			// Equipment filter → ?eq= param
			if (activeEqFilter === "all") {
				url.searchParams.delete("eq");
			} else {
				url.searchParams.set("eq", activeEqFilter);
			}

			// replaceState(state, unused title, new URL)
			history.replaceState(null, "", url.toString());
		}

		// ── Tag filter button click handlers ─────────────────────────────
		tagButtons.forEach(function (btn) {
			btn.addEventListener("click", function () {
				activeTagFilter = btn.getAttribute("data-filter");
				applyFilters();
			});
		});

		// ── Equipment filter button click handlers ───────────────────────
		// Toggle behavior: clicking the already-active equipment button
		// deactivates it (returns to "all"), since there's no explicit
		// "All" button in the equipment row. This feels natural — click
		// to filter, click again to clear.
		eqButtons.forEach(function (btn) {
			btn.addEventListener("click", function () {
				var value = btn.getAttribute("data-filter-eq");
				// Toggle: if already active, clicking again clears the filter
				activeEqFilter = (activeEqFilter === value) ? "all" : value;
				applyFilters();
			});
		});

		// ── Read initial filters from the URL on page load ───────────────
		// If someone navigates to /gallery/?filter=messier&eq=personal,
		// apply both filters immediately. Falls back to "all" if no
		// parameter is present, or if the value doesn't match any button.
		var params = new URLSearchParams(window.location.search);

		// Validate the tag filter from the URL
		var urlTag    = params.get("filter") || "all";
		var validTags = tagButtons.map(function (btn) {
			return btn.getAttribute("data-filter");
		});
		activeTagFilter = validTags.includes(urlTag) ? urlTag : "all";

		// Validate the equipment filter from the URL
		var urlEq    = params.get("eq") || "all";
		var validEqs = eqButtons.map(function (btn) {
			return btn.getAttribute("data-filter-eq");
		});
		activeEqFilter = validEqs.includes(urlEq) ? urlEq : "all";

		// Apply both filters on initial load
		applyFilters();
	});
})();
