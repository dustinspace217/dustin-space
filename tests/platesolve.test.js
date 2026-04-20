/**
 * tests/platesolve.test.js — unit tests for platesolve helpers.
 *
 * Pins the behavior of nameMatchesAllowlist after the #84 tightening
 * (regex-bounded short prefixes for B/C) and the skyToPixelFrac null-on-
 * degenerate contract from #79.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const {
	nameMatchesAllowlist,
	skyToPixelFrac,
	buildAnnotations,
} = require('../ingest/lib/platesolve');

// ── nameMatchesAllowlist ─────────────────────────────────────────────────────

test('nameMatchesAllowlist: M 42 passes (Messier prefix)', () => {
	assert.equal(nameMatchesAllowlist('M 42'), true);
});

test('nameMatchesAllowlist: double-spaced M  42 still matches via normalization', () => {
	assert.equal(nameMatchesAllowlist('M  42'), true);
});

test('nameMatchesAllowlist: NGC 6992 passes', () => {
	assert.equal(nameMatchesAllowlist('NGC 6992'), true);
});

test('nameMatchesAllowlist: array of aliases — match on any element', () => {
	assert.equal(nameMatchesAllowlist(['NGC 6960', 'Veil Nebula west']), true);
});

test('nameMatchesAllowlist: empty / null / undefined return false', () => {
	assert.equal(nameMatchesAllowlist(''),        false);
	assert.equal(nameMatchesAllowlist(null),      false);
	assert.equal(nameMatchesAllowlist(undefined), false);
	assert.equal(nameMatchesAllowlist([]),        false);
});

test('nameMatchesAllowlist: survey-prefixed entries rejected', () => {
	assert.equal(nameMatchesAllowlist('[HL2008] 42'),         false);
	assert.equal(nameMatchesAllowlist('NAME OMC-2 FIR 3N'),   false);
	assert.equal(nameMatchesAllowlist('TGU H1234'),           false);
});

test('nameMatchesAllowlist: common-name token catches Pickering', () => {
	assert.equal(nameMatchesAllowlist("Pickering's Triangle"), true);
	assert.equal(nameMatchesAllowlist('Witch Head Nebula'),    true);
	assert.equal(nameMatchesAllowlist('North America Nebula'), true);
});

// ── Issue #84 regression tests ──────────────────────────────────────────────
// The previous bare 'B '/'C ' prefixes matched any name starting with those
// two characters. The regex tightening requires digits.

test('#84 regression: B 33 (Barnard 33 / Horsehead) still passes', () => {
	assert.equal(nameMatchesAllowlist('B 33'), true);
});

test('#84 regression: C 14 (Caldwell 14 / Double Cluster) still passes', () => {
	assert.equal(nameMatchesAllowlist('C 14'), true);
});

test('#84 regression: Betelgeuse no longer false-matches B-prefix', () => {
	// Previous code matched any name starting with 'B ' (had bare 'B ' in
	// CATALOG_ALLOWLIST). Betelgeuse doesn't have a space after the B but
	// 'B 1234' from arbitrary catalogs would have slipped through.
	assert.equal(nameMatchesAllowlist('B abc'),  false);
	assert.equal(nameMatchesAllowlist('B foo'),  false);
});

test('#84 regression: C abc no longer false-matches Caldwell-prefix', () => {
	assert.equal(nameMatchesAllowlist('C foo'),  false);
});

// ── skyToPixelFrac null-on-degenerate (issue #79) ───────────────────────────

test('#79 regression: degenerate WCS (zero CD matrix) returns null', () => {
	const wcs = {
		ra_deg: 100, dec_deg: 0,
		crpix1: 1000, crpix2: 1000,
		cd11: 0, cd12: 0, cd21: 0, cd22: 0,
	};
	assert.equal(skyToPixelFrac(100, 0, wcs, 2000, 2000), null);
});

test('#79 regression: well-conditioned WCS returns a fractional position', () => {
	// Identity-ish WCS: 1 pixel = 1 degree, image center is reference pixel.
	const wcs = {
		ra_deg: 0, dec_deg: 0,
		crpix1: 1000, crpix2: 1000,
		cd11: 1, cd12: 0, cd21: 0, cd22: 1,
	};
	const pos = skyToPixelFrac(0, 0, wcs, 2000, 2000);
	assert.ok(pos !== null);
	// crpix1=1000 is 0-indexed pixel 999.5? Actually FITS 1-indexed; the
	// fraction at the reference pixel is (crpix1 - 1) / imgW = 999/2000.
	assert.ok(Math.abs(pos.x - 0.4995) < 0.001);
	assert.ok(Math.abs(pos.y - 0.4995) < 0.001);
});

test('#79 regression: buildAnnotations warns on degenerate WCS', () => {
	const degenerate = {
		ra_deg: 100, dec_deg: 0,
		crpix1: 1000, crpix2: 1000,
		cd11: 0, cd12: 0, cd21: 0, cd22: 0,
	};
	const rows = [
		{ name: 'NGC 1', ra_deg: 100, dec_deg: 0, type: 'G', major_axis_arcmin: 5 },
		{ name: 'NGC 2', ra_deg: 101, dec_deg: 0, type: 'G', major_axis_arcmin: 5 },
	];
	// Capture console.warn
	const origWarn = console.warn;
	let warned = '';
	console.warn = (msg) => { warned += String(msg) + '\n'; };
	try {
		const annotations = buildAnnotations(rows, degenerate, 2000, 2000, 5);
		assert.equal(annotations.length, 0);
		assert.match(warned, /degenerate WCS/);
		assert.match(warned, /2 of 2 rows/);
	} finally {
		console.warn = origWarn;
	}
});
