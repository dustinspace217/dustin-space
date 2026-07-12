/**
 * tests/nav-breakpoint.test.js — cross-file drift guard for the nav collapse
 * breakpoint.
 *
 * Issue #96: the width at which the header nav collapses to the hamburger is
 * encoded in TWO places that must stay in lockstep — a JS constant
 * (NAV_COLLAPSE_MAX in src/index.njk, which gates the menu-open title-snap
 * handler) and a CSS media query (main.css, which actually does the collapse).
 * When they drift, the JS handler fires on one side of the boundary while the
 * layout collapses on the other, producing the exact kind of near-boundary
 * overlap the #95 range-syntax fix was chasing. These files have no shared
 * source of truth, so this test IS the source of truth: it re-derives both
 * numbers from the real files and asserts they agree.
 *
 * The extraction doubles as a drift detector: each pattern must match EXACTLY
 * once. If a refactor renames the constant, reverts the media query to the old
 * max-width form, or duplicates either, the match count changes and the test
 * fails loudly rather than silently reading a stale or ambiguous value.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const INDEX_NJK = path.join(__dirname, '..', 'src', 'index.njk');
const MAIN_CSS  = path.join(__dirname, '..', 'src', 'assets', 'css', 'main.css');

// Read both files as plain text — we deliberately parse the source rather than
// evaluate it. Evaluating the JS would need a DOM, and parsing the CSS with a
// real parser would hide exactly the drift (comment vs. rule, old vs. new
// syntax) this guard exists to catch.
const indexText = fs.readFileSync(INDEX_NJK, 'utf8');
const cssText   = fs.readFileSync(MAIN_CSS,  'utf8');

/**
 * Pull a single integer out of `text` using `regex` (which must have one
 * capture group for the digits). Asserts the pattern matches exactly once —
 * that != 1 assertion is the drift detector, so a caller never silently reads
 * the wrong occurrence. Returns the captured number.
 */
function extractExactlyOne(text, regex, label) {
	// Collect every match so we can report the actual count on drift.
	const matches = [...text.matchAll(regex)];
	assert.equal(
		matches.length, 1,
		`${label}: expected exactly 1 occurrence, found ${matches.length} — ` +
		`the breakpoint encoding drifted (renamed, duplicated, or its media-query syntax changed).`
	);
	return Number(matches[0][1]);
}

test('nav breakpoint: JS gate and CSS collapse boundary stay in lockstep', () => {
	// JS side: `var NAV_COLLAPSE_MAX = 1299;` — the WIDEST width still collapsed.
	// Anchored on `var … =` so the two explanatory comments that also name the
	// constant (and its downstream `> NAV_COLLAPSE_MAX` use) don't get counted.
	const navGate = extractExactlyOne(
		indexText, /var NAV_COLLAPSE_MAX = (\d+)/g, 'NAV_COLLAPSE_MAX (src/index.njk)'
	);

	// CSS side (post-#95 range syntax): the collapse tier is `@media (width < 1300px)`.
	// Anchored on `@media (width < ` so the prose in comments that also mentions
	// `(width < 1300px)`, and the compact tier's trailing `(width < 1450px)`,
	// don't get counted.
	const collapseBoundary = extractExactlyOne(
		cssText, /@media \(width < (\d+)px\)/g, 'collapse-tier @media (main.css)'
	);

	// Compact tier just above the collapse point: `@media (width >= 1300px)`.
	const compactStart = extractExactlyOne(
		cssText, /@media \(width >= (\d+)px\)/g, 'compact-tier @media (main.css)'
	);

	// The collapse tier is `width < collapseBoundary`, so the widest COLLAPSED
	// integer width is collapseBoundary - 1 — and that is exactly what the JS
	// gate must equal (collapse applies below 1300 ⇔ NAV_COLLAPSE_MAX === 1299).
	assert.equal(
		navGate, collapseBoundary - 1,
		`NAV_COLLAPSE_MAX (${navGate}) must be one below the CSS collapse boundary ` +
		`(${collapseBoundary}); the JS handler and the layout would collapse on ` +
		`opposite sides of the boundary otherwise.`
	);

	// The compact tier must start EXACTLY where the collapse tier ends, so the
	// two intervals meet at one point with no gap or overlap — the whole reason
	// #95 moved to range syntax. Collapse ends at `collapseBoundary`; compact
	// begins at `width >= compactStart`.
	assert.equal(
		compactStart, collapseBoundary,
		`compact tier starts at ${compactStart} but collapse ends at ${collapseBoundary} ` +
		`— a gap or overlap at the boundary reopens the fractional-width fall-through #95 closed.`
	);
});
