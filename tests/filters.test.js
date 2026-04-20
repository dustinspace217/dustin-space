/**
 * tests/filters.test.js — unit tests for Eleventy filter implementations
 * extracted to lib/filters.js. Run with `npm test`.
 *
 * Issue #87: pin the filter contracts so a future refactor doesn't
 * silently change rendered date strings or summed exposure times.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { readableDate, formatExposure, dumpSafe } = require('../lib/filters');

// ── readableDate ─────────────────────────────────────────────────────────────
test('readableDate: ISO date string formats to en-US long form', () => {
	assert.equal(readableDate('2025-11-14'), 'November 14, 2025');
});

test('readableDate: noon-UTC parsing avoids timezone day rollover', () => {
	// 2025-01-01 parsed as midnight UTC would shift to Dec 31 in PST.
	// Noon UTC keeps the date stable in any reasonable timezone.
	assert.equal(readableDate('2025-01-01'), 'January 1, 2025');
});

test('readableDate: Date object passes through unchanged', () => {
	const d = new Date('2024-03-15T12:00:00Z');
	assert.equal(readableDate(d), 'March 15, 2024');
});

// ── formatExposure ───────────────────────────────────────────────────────────
test('formatExposure: scalar minutes formats hours + minutes', () => {
	assert.equal(formatExposure(380), '6h 20m');
	assert.equal(formatExposure(60),  '1h');
	assert.equal(formatExposure(45),  '45m');
});

test('formatExposure: array of filter objects sums minutes', () => {
	const filters = [
		{ name: 'L', minutes: 60 },
		{ name: 'R', minutes: 45 },
		{ name: 'G', minutes: 45 },
		{ name: 'B', minutes: 30 },
	];
	assert.equal(formatExposure(filters), '3h');
});

test('formatExposure: returns dash for null / undefined / 0', () => {
	assert.equal(formatExposure(null),      '—');
	assert.equal(formatExposure(undefined), '—');
	assert.equal(formatExposure(0),         '—');
});

test('formatExposure: negative input returns dash (defensive)', () => {
	// Defensive guard — negative integration time is meaningless.
	// Previous implementation returned bizarre output like "-1h -10m".
	assert.equal(formatExposure(-10),  '—');
	assert.equal(formatExposure(-300), '—');
});

test('formatExposure: NaN and Infinity return dash', () => {
	assert.equal(formatExposure(NaN),      '—');
	assert.equal(formatExposure(Infinity), '—');
});

test('formatExposure: floating-point input floors to whole minutes', () => {
	// "6.5m" would surprise readers; floor to "6m".
	assert.equal(formatExposure(6.5),    '6m');
	assert.equal(formatExposure(380.7),  '6h 20m');
});

test('formatExposure: array with mixed valid + invalid filters', () => {
	// Skip null minutes / negative minutes / NaN, keep the rest.
	const filters = [
		{ name: 'L', minutes: 60 },
		{ name: 'R', minutes: null },
		{ name: 'G', minutes: -10 },
		{ name: 'B', minutes: 30 },
	];
	assert.equal(formatExposure(filters), '1h 30m');
});

test('formatExposure: array of all-zero minutes returns dash', () => {
	const filters = [{ name: 'L', minutes: 0 }, { name: 'R', minutes: 0 }];
	assert.equal(formatExposure(filters), '—');
});

// ── dumpSafe ─────────────────────────────────────────────────────────────────
test('dumpSafe: escapes < to \\u003c so </script> can\'t break out', () => {
	const result = dumpSafe({ name: '<script>alert(1)</script>' });
	// The unescaped < character must not appear; \u003c must.
	assert.ok(!result.includes('<'), 'output still contains literal <');
	assert.ok(result.includes('\\u003c'), 'output missing \\u003c escape');
});

test('dumpSafe: also defeats <!-- and <![CDATA[ parser transitions', () => {
	const result = dumpSafe({ a: '<!-- comment', b: '<![CDATA[' });
	assert.ok(!result.includes('<!'));
});

test('dumpSafe: preserves all non-< characters', () => {
	const obj = { name: 'NGC 6992', value: 42, list: [1, 2, 3] };
	const result = dumpSafe(obj);
	const parsed = JSON.parse(result.replace(/\\u003c/g, '<'));
	assert.deepEqual(parsed, obj);
});
