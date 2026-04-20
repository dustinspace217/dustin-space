/**
 * Gallery filter — three independent filter dimensions combined with AND logic.
 *
 * Dimensions:
 *   1. Object Type  — subject tags (galaxy, emission-nebula, etc.)
 *   2. Collection   — catalog membership (messier, caldwell)
 *   3. Equipment    — imaging setup (personal, itelescope, solar)
 *
 * A card is visible only when it matches ALL active filters. "all" (or no
 * selection) in a dimension means no constraint in that dimension.
 *
 * Each dimension has its own data attribute on the filter buttons:
 *   data-filter-type, data-filter-cat, data-filter-eq
 *
 * Each gallery card carries:
 *   data-tags="emission-nebula messier" — space-separated list of subject
 *     tags AND catalog slugs (both stored together for backward compat)
 *   data-equipment="personal" — single equipment category slug
 *
 * Toggle behavior: clicking the already-active button in any dimension
 * deactivates it (returns to "all"). The Object Type row also has an
 * explicit "All" button that clears that dimension.
 *
 * URL persistence:
 *   ?type=galaxy&cat=messier&eq=personal
 *   history.replaceState() avoids bloating the back button stack.
 *
 * Why three dimensions instead of two:
 *   Object type and collection are independent axes. "Galaxy" is what
 *   the object IS; "Messier" is which catalog it belongs to. A user
 *   should be able to ask "show me Messier galaxies shot on my rig"
 *   — that requires three independent filters, not two.
 */
(function () {
	"use strict";

	document.addEventListener("DOMContentLoaded", function () {

		// Grab filter buttons by their dimension-specific data attributes.
		// Each dimension is independent — its own buttons, its own state.
		var typeButtons = [...document.querySelectorAll("[data-filter-type]")];
		var catButtons  = [...document.querySelectorAll("[data-filter-cat]")];
		var eqButtons   = [...document.querySelectorAll("[data-filter-eq]")];
		var galleryCards  = [...document.querySelectorAll(".gallery-card")];
		var grid          = document.querySelector(".gallery-grid");
		var countEl       = document.querySelector(".filter-count");

		// Exit early if there's no gallery on this page.
		if (typeButtons.length === 0 && catButtons.length === 0 && eqButtons.length === 0) return;

		// ── Filter state ─────────────────────────────────────────────────
		// "all" means no constraint in that dimension.
		var activeType = "all";   // Object type (galaxy, emission-nebula, etc.)
		var activeCat  = "all";   // Collection (messier, caldwell)
		var activeEq   = "all";   // Equipment (personal, itelescope, solar)

		// ── Empty state element ───────────────────────────────────────────
		var emptyState = grid ? grid.querySelector(".gallery-empty") : null;

		/**
		 * Apply all three filter dimensions — show cards matching ALL active
		 * filters, hide the rest. Updates URL, button states, and result count.
		 */
		function applyFilters() {
			var visibleCount = 0;

			galleryCards.forEach(function (card) {
				// data-tags is a space-separated list containing both subject tags
				// and catalog slugs (e.g. "emission-nebula messier caldwell").
				// Both object type and collection filters check against this list.
				var cardTags = (card.getAttribute("data-tags") || "").split(" ");
				var cardEq   = card.getAttribute("data-equipment") || "";

				// AND logic: card must pass ALL three dimensions
				var matchesType = (activeType === "all" || cardTags.includes(activeType));
				var matchesCat  = (activeCat === "all"  || cardTags.includes(activeCat));
				var matchesEq   = (activeEq === "all"   || cardEq === activeEq);

				card.classList.toggle("hidden", !(matchesType && matchesCat && matchesEq));
				if (matchesType && matchesCat && matchesEq) visibleCount++;
			});

			// Show or hide empty state
			if (emptyState) {
				emptyState.classList.toggle("hidden", visibleCount > 0);
			}

			// ── Stagger-in animation ───────────────────────────────────────
			var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			galleryCards.forEach(function (c) { c.classList.remove("is-entering"); });
			if (!reducedMotion) {
				requestAnimationFrame(function () {
					var i = 0;
					galleryCards.forEach(function (card) {
						if (!card.classList.contains("hidden")) {
							card.style.animationDelay = (i * 45) + "ms";
							card.classList.add("is-entering");
							i++;
						}
					});
				});
			}

			// ── Result count ─────────────────────────────────────────────
			if (countEl) {
				var total = galleryCards.length;
				var isFiltered = (activeType !== "all" || activeCat !== "all" || activeEq !== "all");
				countEl.textContent = isFiltered
					? "Showing " + visibleCount + " of " + total + " images"
					: "Showing all " + total + " images";
			}

			// ── Update button active states ──────────────────────────────
			updateButtonStates(typeButtons, "data-filter-type", activeType);
			updateButtonStates(catButtons, "data-filter-cat", activeCat);
			updateButtonStates(eqButtons, "data-filter-eq", activeEq);

			// ── Persist all filters in URL ────────────────────────────────
			var url = new URL(window.location.href);
			setOrDelete(url, "type", activeType);
			setOrDelete(url, "cat", activeCat);
			setOrDelete(url, "eq", activeEq);
			history.replaceState(null, "", url.toString());
		}

		/**
		 * Update active/pressed state on a group of filter buttons.
		 * @param {Array} buttons — the button elements for this dimension
		 * @param {string} attr — the data attribute name (e.g. "data-filter-type")
		 * @param {string} activeValue — the currently active filter value
		 */
		function updateButtonStates(buttons, attr, activeValue) {
			buttons.forEach(function (btn) {
				var isActive = btn.getAttribute(attr) === activeValue;
				btn.classList.toggle("active", isActive);
				btn.setAttribute("aria-pressed", isActive ? "true" : "false");
			});
		}

		/**
		 * Set or delete a URL search parameter based on filter value.
		 * "all" deletes the param (clean URL when no filter is active).
		 */
		function setOrDelete(url, param, value) {
			if (value === "all") {
				url.searchParams.delete(param);
			} else {
				url.searchParams.set(param, value);
			}
		}

		// ── Click handlers ───────────────────────────────────────────────
		// Object type: has an explicit "All" button. Clicking any button
		// sets that type; clicking the active one returns to "all".
		typeButtons.forEach(function (btn) {
			btn.addEventListener("click", function () {
				var value = btn.getAttribute("data-filter-type");
				// Toggle: clicking active button clears it (except "all" which stays)
				if (value === "all") {
					activeType = "all";
				} else {
					activeType = (activeType === value) ? "all" : value;
				}
				applyFilters();
			});
		});

		// Collection: no "All" button — toggle behavior (click to set, click again to clear).
		catButtons.forEach(function (btn) {
			btn.addEventListener("click", function () {
				var value = btn.getAttribute("data-filter-cat");
				activeCat = (activeCat === value) ? "all" : value;
				applyFilters();
			});
		});

		// Equipment: same toggle behavior as collection.
		eqButtons.forEach(function (btn) {
			btn.addEventListener("click", function () {
				var value = btn.getAttribute("data-filter-eq");
				activeEq = (activeEq === value) ? "all" : value;
				applyFilters();
			});
		});

		// ── Restore filters from URL on page load ────────────────────────
		var params = new URLSearchParams(window.location.search);

		// Validate each dimension against its button values
		var urlType = params.get("type") || "all";
		var validTypes = typeButtons.map(function (btn) { return btn.getAttribute("data-filter-type"); });
		activeType = validTypes.includes(urlType) ? urlType : "all";

		var urlCat = params.get("cat") || "all";
		var validCats = catButtons.map(function (btn) { return btn.getAttribute("data-filter-cat"); });
		activeCat = validCats.includes(urlCat) ? urlCat : "all";

		var urlEq = params.get("eq") || "all";
		var validEqs = eqButtons.map(function (btn) { return btn.getAttribute("data-filter-eq"); });
		activeEq = validEqs.includes(urlEq) ? urlEq : "all";

		applyFilters();
	});
})();
