/**
 * gallery-filter-logic.js — PURE gallery-filter logic, extracted from
 * gallery.js so it can be unit-tested without a DOM (issue #118 / Fix Wave 2
 * W7, Sol ruling 1). NOTHING in this file touches document/window — every
 * function takes plain data and returns plain data. gallery.js owns all DOM
 * reads/writes and calls into these.
 *
 * Why extract at all: the three-axis AND matching, the toggle semantics, the
 * URL parse/validate/restore, and the count math were previously buried inside
 * a DOMContentLoaded handler, unreachable to node:test. A stale-link regression
 * or a broken toggle could only be caught by a browser probe. Pulling the pure
 * math out lets the fast unit suite pin it (combined filters, clearing, invalid
 * URL state, counts, empty state) with zero browser cost.
 *
 * UMD wrapper: the SAME file works in the browser (attaches to
 * window.GalleryFilterLogic) and under Node's require() (module.exports), so
 * the site loads it as a plain <script> and tests/gallery-filter.test.js
 * require()s it. No bundler — the project is deliberately vanilla JS.
 *
 * LOAD ORDER: this file MUST be loaded BEFORE gallery.js in the browser —
 * gallery.js reads window.GalleryFilterLogic at DOMContentLoaded. See base.njk
 * (the <script> for this file precedes the gallery.js <script>).
 *
 * Model: three independent filter dimensions combined with AND —
 *   type  (object type: galaxy, emission-nebula, …)
 *   cat   (collection: messier, caldwell)
 *   eq    (equipment: personal, itelescope, solar)
 * "all" in a dimension means "no constraint in that dimension".
 */
(function (root, factory) {
	// UMD: use CommonJS export when module.exports exists (Node / node:test),
	// otherwise hang a global off the browser window. `factory()` builds the
	// API object once; both environments share the identical implementation.
	if (typeof module === "object" && module.exports) {
		module.exports = factory();
	} else {
		root.GalleryFilterLogic = factory();
	}
})(typeof self !== "undefined" ? self : this, function () {
	"use strict";

	// The wildcard sentinel. A dimension set to ALL imposes no constraint.
	var ALL = "all";

	/**
	 * cardMatches — does one card pass ALL three active filter dimensions?
	 * @param {string[]} cardTags — the card's subject tags AND catalog slugs
	 *   (both live in the same data-tags list for backward compat, e.g.
	 *   ["emission-nebula", "messier"]).
	 * @param {string} cardEq — the card's single equipment-category slug.
	 * @param {{type:string,cat:string,eq:string}} state — active filter values;
	 *   ALL in a dimension is a wildcard that always matches.
	 * @returns {boolean} true iff the card matches type AND cat AND eq.
	 */
	function cardMatches(cardTags, cardEq, state) {
		var matchesType = state.type === ALL || cardTags.indexOf(state.type) !== -1;
		var matchesCat  = state.cat  === ALL || cardTags.indexOf(state.cat)  !== -1;
		var matchesEq   = state.eq   === ALL || cardEq === state.eq;
		return matchesType && matchesCat && matchesEq;
	}

	/**
	 * toggleType — next value for the Object Type dimension, which has an
	 * explicit "All" button. Clicking "all" clears the dimension; clicking the
	 * already-active value toggles it back to ALL; clicking any other value
	 * selects it.
	 * @param {string} current — the dimension's current value
	 * @param {string} clicked — the value on the clicked button
	 * @returns {string} the dimension's next value
	 */
	function toggleType(current, clicked) {
		if (clicked === ALL) return ALL;
		return current === clicked ? ALL : clicked;
	}

	/**
	 * toggleDimension — next value for a dimension WITHOUT an explicit "All"
	 * button (Collection, Equipment). Clicking the active value clears it
	 * (returns ALL), otherwise selects the clicked value.
	 */
	function toggleDimension(current, clicked) {
		return current === clicked ? ALL : clicked;
	}

	/**
	 * validateValue — a URL-supplied filter value is only honored if it is one
	 * of the known button values for that dimension; anything else (a stale
	 * shared link, hand-typed junk, or a since-removed tag) falls back to ALL.
	 * `raw` may be null/undefined (param absent), which also maps to ALL.
	 * @param {string|null|undefined} raw
	 * @param {string[]} validValues — the dimension's known button values
	 * @returns {string} a safe value: raw if valid, else ALL
	 */
	function validateValue(raw, validValues) {
		if (raw == null) return ALL;
		return validValues.indexOf(raw) !== -1 ? raw : ALL;
	}

	/**
	 * parseState — build a validated {type,cat,eq} from raw URL params plus the
	 * valid-value lists for each dimension. Every dimension is validated
	 * independently, so one bad param can't poison the others.
	 * @param {{type?:*,cat?:*,eq?:*}} params — raw param values (null where absent)
	 * @param {{types:string[],cats:string[],eqs:string[]}} valid
	 * @returns {{type:string,cat:string,eq:string}}
	 */
	function parseState(params, valid) {
		return {
			type: validateValue(params.type, valid.types),
			cat:  validateValue(params.cat,  valid.cats),
			eq:   validateValue(params.eq,   valid.eqs),
		};
	}

	/**
	 * isFiltered — is ANY dimension constrained (i.e. not ALL)? Drives the
	 * "Showing N of M" vs "Showing all M" count label.
	 */
	function isFiltered(state) {
		return state.type !== ALL || state.cat !== ALL || state.eq !== ALL;
	}

	/**
	 * paramOps — how the URL query string should reflect a filter state. For
	 * each dimension it returns the value to SET, or null meaning DELETE the
	 * param (so an unconstrained dimension leaves a clean URL). gallery.js walks
	 * this list to update the real URL via URLSearchParams.
	 * @returns {{param:string, value:(string|null)}[]}
	 */
	function paramOps(state) {
		return [
			{ param: "type", value: state.type === ALL ? null : state.type },
			{ param: "cat",  value: state.cat  === ALL ? null : state.cat  },
			{ param: "eq",   value: state.eq   === ALL ? null : state.eq   },
		];
	}

	/**
	 * applyState — the pure core of gallery.js's applyFilters: given plain card
	 * descriptors and a filter state, return per-card visibility (aligned with
	 * the input order) plus the visible count. No DOM — gallery.js maps the
	 * boolean array back onto the real card elements.
	 * @param {{tags:string[], eq:string}[]} cards
	 * @param {{type:string,cat:string,eq:string}} state
	 * @returns {{visibility:boolean[], visibleCount:number}}
	 */
	function applyState(cards, state) {
		var visibility = [];
		var visibleCount = 0;
		// Bounded by the in-memory card list (the gallery is a fixed, small set).
		for (var i = 0; i < cards.length; i++) {
			var visible = cardMatches(cards[i].tags, cards[i].eq, state);
			visibility.push(visible);
			if (visible) visibleCount++;
		}
		return { visibility: visibility, visibleCount: visibleCount };
	}

	/**
	 * countLabel — the "Showing …" summary text for a filter state. Unfiltered
	 * reads "Showing all M images"; any active filter reads "Showing N of M".
	 */
	function countLabel(visibleCount, total, state) {
		return isFiltered(state)
			? "Showing " + visibleCount + " of " + total + " images"
			: "Showing all " + total + " images";
	}

	return {
		ALL: ALL,
		cardMatches: cardMatches,
		toggleType: toggleType,
		toggleDimension: toggleDimension,
		validateValue: validateValue,
		parseState: parseState,
		isFiltered: isFiltered,
		paramOps: paramOps,
		applyState: applyState,
		countLabel: countLabel,
	};
});
