/**
 * lib/filters.js — pure functions for Eleventy template filters.
 *
 * Extracted from `.eleventy.js` so they can be unit-tested with `node --test`
 * without spinning up the full Eleventy runtime. `.eleventy.js` requires
 * this module and registers each function via `eleventyConfig.addFilter`.
 *
 * Why a separate file: Eleventy filter callbacks are bound to the runtime's
 * filter context, and reading them out of `.eleventy.js` for testing
 * requires either stubbing the entire `eleventyConfig` API or re-running
 * the config function with a captured-filter shim. Both add fragility
 * proportional to how many filters there are. Separate-module extraction
 * is the boring choice and matches what every other 11ty starter does.
 *
 * NOTE: keep these as pure functions. Don't reach into `this` — Eleventy
 * does provide a `this.ctx` for filter callbacks, but our filters never
 * need it and depending on it would re-couple us to the runtime.
 */

'use strict';

/**
 * readableDate — format a date for human display.
 *
 * @param {string | Date} dateInput — "YYYY-MM-DD" string or Date object
 * @returns {string} e.g. "November 14, 2025"
 *
 * Accepts two shapes because Eleventy passes Date objects for collection
 * page dates (e.g. guides listing) but our images.json stores ISO date
 * strings. The string branch parses at noon UTC so a date like
 * "2025-11-14" doesn't roll back to the 13th in negative-offset zones.
 */
function readableDate(dateInput) {
	const date = dateInput instanceof Date
		? dateInput
		: new Date(dateInput + 'T12:00:00Z');
	return date.toLocaleDateString('en-US', {
		year:     'numeric',
		month:    'long',
		day:      'numeric',
		timeZone: 'UTC',
	});
}

/**
 * formatExposure — format an integration time as "Xh Ym".
 *
 * Accepts either a number of minutes, or an array of acquisition filter
 * objects each with a `.minutes` field (sums across the array). Returns
 * "—" for null / 0 / non-finite input — used on solar / lucky-imaging
 * entries where a total integration is meaningless.
 *
 * Defensive guards (issue #85 / copilot-recommendations):
 *   - Negative input: rejected (returns "—"). Negative integration time
 *     is meaningless and the previous code returned "-1h -10m" for -10.
 *   - Non-finite (NaN, Infinity): rejected.
 *   - Non-integer: floored to whole minutes for display.
 *
 * @param {number | Array<{minutes:number}>} input
 * @returns {string}
 */
function formatExposure(input) {
	// Sum an array of filter objects (acquisition rows on the detail page).
	if (Array.isArray(input)) {
		const total = input.reduce(function (sum, f) {
			const m = Number(f && f.minutes);
			return sum + (Number.isFinite(m) && m > 0 ? m : 0);
		}, 0);
		if (total === 0) return '—';
		input = total;
	}
	// Reject zero, null, undefined, NaN, Infinity, negative.
	const n = Number(input);
	if (!Number.isFinite(n) || n <= 0) return '—';
	const total = Math.floor(n);
	const h = Math.floor(total / 60);
	const m = total % 60;
	if (h === 0) return m + 'm';
	if (m === 0) return h + 'h';
	return h + 'h ' + m + 'm';
}

/**
 * dumpSafe — JSON-stringify a value and `<`-escape so it's safe to embed
 * in a `<script type="application/json">` block.
 *
 * Replacing `<` with `\u003c` defeats `</script>` breakout, `<!--`,
 * `<![CDATA[`, and any other `<`-initiated parser state transition.
 * Stronger than the common "just escape `</script>`" pattern.
 *
 * Returns the escaped string. Caller (.eleventy.js) wraps it in an
 * Eleventy SafeString so Nunjucks' autoescape doesn't double-encode.
 *
 * @param {*} value
 * @returns {string}
 */
function dumpSafe(value) {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

module.exports = { readableDate, formatExposure, dumpSafe };
