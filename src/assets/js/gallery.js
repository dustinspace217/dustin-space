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
 *
 * Split: all the PURE matching/toggle/URL/count math lives in
 * gallery-filter-logic.js (window.GalleryFilterLogic) so it can be unit-tested
 * without a DOM (issue #118). THIS file keeps only DOM reads/writes, event
 * wiring, and the stagger-in animation. That module MUST be loaded first —
 * base.njk emits its <script> before this one.
 */
(function () {
	"use strict";

	document.addEventListener("DOMContentLoaded", function () {

		// The pure logic module, loaded by an earlier <script> (see base.njk).
		// If it's missing the page can't filter correctly, so fail loudly in the
		// console rather than throwing an uncaught TypeError on first use.
		var FL = window.GalleryFilterLogic;
		if (!FL) {
			console.error("gallery.js: window.GalleryFilterLogic is not loaded — gallery-filter-logic.js must load before gallery.js.");
			return;
		}

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
			// Read each card's tags/equipment into a plain descriptor and hand the
			// whole set to the pure logic — all matching + counting happens there
			// (gallery-filter-logic.js), keeping this function to DOM I/O only.
			// data-tags is a space-separated list containing both subject tags and
			// catalog slugs (e.g. "emission-nebula messier caldwell"), so both the
			// type and collection filters check against it; data-equipment is a
			// single slug.
			var state = { type: activeType, cat: activeCat, eq: activeEq };
			var descriptors = galleryCards.map(function (card) {
				return {
					tags: (card.getAttribute("data-tags") || "").split(" "),
					eq:   card.getAttribute("data-equipment") || "",
				};
			});
			var result = FL.applyState(descriptors, state);
			var visibleCount = result.visibleCount;

			// Map the pure visibility array back onto the real card elements
			// (same order as galleryCards, guaranteed by applyState).
			galleryCards.forEach(function (card, i) {
				card.classList.toggle("hidden", !result.visibility[i]);
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
				countEl.textContent = FL.countLabel(visibleCount, galleryCards.length, state);
			}

			// ── Update button active states ──────────────────────────────
			updateButtonStates(typeButtons, "data-filter-type", activeType);
			updateButtonStates(catButtons, "data-filter-cat", activeCat);
			updateButtonStates(eqButtons, "data-filter-eq", activeEq);

			// ── Persist all filters in URL ────────────────────────────────
			// paramOps returns {param, value}: value===null means delete the param
			// (clean URL for an unconstrained dimension), otherwise set it.
			var url = new URL(window.location.href);
			FL.paramOps(state).forEach(function (op) {
				if (op.value === null) {
					url.searchParams.delete(op.param);
				} else {
					url.searchParams.set(op.param, op.value);
				}
			});
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

		// ── Click handlers ───────────────────────────────────────────────
		// Object type: has an explicit "All" button. toggleType handles the
		// three cases (click "all" → clear, click active → clear, else select).
		typeButtons.forEach(function (btn) {
			btn.addEventListener("click", function () {
				var value = btn.getAttribute("data-filter-type");
				activeType = FL.toggleType(activeType, value);
				applyFilters();
			});
		});

		// Collection: no "All" button — toggleDimension (click to set, click the
		// active value again to clear).
		catButtons.forEach(function (btn) {
			btn.addEventListener("click", function () {
				var value = btn.getAttribute("data-filter-cat");
				activeCat = FL.toggleDimension(activeCat, value);
				applyFilters();
			});
		});

		// Equipment: same toggle behavior as collection.
		eqButtons.forEach(function (btn) {
			btn.addEventListener("click", function () {
				var value = btn.getAttribute("data-filter-eq");
				activeEq = FL.toggleDimension(activeEq, value);
				applyFilters();
			});
		});

		// ── Restore filters from URL on page load ────────────────────────
		// parseState validates each URL param against that dimension's known
		// button values — a stale/hand-typed value falls back to "all".
		var params = new URLSearchParams(window.location.search);
		var valid = {
			types: typeButtons.map(function (btn) { return btn.getAttribute("data-filter-type"); }),
			cats:  catButtons.map(function (btn) { return btn.getAttribute("data-filter-cat"); }),
			eqs:   eqButtons.map(function (btn) { return btn.getAttribute("data-filter-eq"); }),
		};
		var restored = FL.parseState(
			{ type: params.get("type"), cat: params.get("cat"), eq: params.get("eq") },
			valid
		);
		activeType = restored.type;
		activeCat  = restored.cat;
		activeEq   = restored.eq;

		applyFilters();
	});
})();
