/**
 * tests/wcs.test.js — unit tests for the extracted WCS/formatting module.
 *
 * Covers the five fixture classes the council (2026-07-13, W7) called for:
 *   1. well-conditioned  — north-up field, round-trip + reference-pixel identity
 *   2. rotated           — CD matrix with a rotation, round-trip still holds
 *   3. degenerate         — det(CD) ~ 0 → skyToPixelFrac returns null, flag set
 *   4. RA-wrap            — query across the 0h/24h seam stays finite + symmetric
 *   5. sexagesimal rollover — toFixed pushing a unit to 60 carries correctly
 *
 * The module is pure (no DOM / OSD), so it requires straight into Node's
 * built-in test runner. The UMD wrapper's CommonJS branch gives us the
 * exports object directly.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const DSWcs    = require('../src/assets/js/wcs.js');

// ── Fixture builders ─────────────────────────────────────────────────────────

// Build a fresh wcs each time — precomputeWcs mutates the object with cached
// `_*` fields, so tests must not share a single instance across cases.
function wellConditioned() {
	// 2 arcsec/pixel, north-up, RA increasing to image-left (cd11 negative).
	var scale = 2 / 3600; // deg per pixel
	return {
		raDeg: 180, decDeg: 0,
		crpix1: 500.5, crpix2: 400.5,
		cd11: -scale, cd12: 0,
		cd21: 0,      cd22: scale,
		imgW: 1000, imgH: 800,
	};
}

function rotated(angleDeg) {
	// Same scale, rotated by angleDeg. A rotation mixes RA/Dec into both axes,
	// which the plain fovW/fovH approximation could not represent — this is
	// exactly the case the CD-matrix path exists for.
	var scale = 2 / 3600;
	var t = angleDeg * Math.PI / 180;
	var c = Math.cos(t), s = Math.sin(t);
	return {
		raDeg: 83.6, decDeg: 22.0,
		crpix1: 512, crpix2: 512,
		cd11: -scale * c, cd12: -scale * s,
		cd21:  scale * s, cd22:  scale * c,
		imgW: 1024, imgH: 1024,
	};
}

function degenerate() {
	// Rank-deficient CD matrix: both rows identical → det = 0.
	return {
		raDeg: 10, decDeg: 10,
		crpix1: 100, crpix2: 100,
		cd11: 1e-4, cd12: 1e-4,
		cd21: 1e-4, cd22: 1e-4,
		imgW: 200, imgH: 200,
	};
}

// RA reference sitting exactly on the 0h/24h seam so symmetric queries land on
// opposite sides of the wrap branch.
function raSeam() {
	var scale = 2 / 3600;
	return {
		raDeg: 0, decDeg: 0,
		crpix1: 500.5, crpix2: 500.5,
		cd11: -scale, cd12: 0,
		cd21: 0,      cd22: scale,
		imgW: 1000, imgH: 1000,
	};
}

// ── 1. well-conditioned ──────────────────────────────────────────────────────

test('well-conditioned: reference pixel projects to (raDeg, decDeg)', () => {
	var wcs = wellConditioned();
	// The reference pixel in fraction terms is (crpix1-1)/imgW, (crpix2-1)/imgH.
	var fx = (wcs.crpix1 - 1) / wcs.imgW;
	var fy = (wcs.crpix2 - 1) / wcs.imgH;
	var sky = DSWcs.pixelFracToSky(fx, fy, wcs);
	assert.ok(Math.abs(sky.ra - wcs.raDeg) < 1e-9, 'ra at ref pixel');
	assert.ok(Math.abs(sky.dec - wcs.decDeg) < 1e-9, 'dec at ref pixel');
});

test('well-conditioned: skyToPixelFrac ∘ pixelFracToSky is identity', () => {
	var wcs = wellConditioned();
	var fx = 0.3, fy = 0.7;
	var sky = DSWcs.pixelFracToSky(fx, fy, wcs);
	var back = DSWcs.skyToPixelFrac(sky.ra, sky.dec, wcs);
	assert.ok(back, 'round-trip returns a point');
	assert.ok(Math.abs(back.x - fx) < 1e-9, 'x round-trips');
	assert.ok(Math.abs(back.y - fy) < 1e-9, 'y round-trips');
});

// ── 2. rotated ───────────────────────────────────────────────────────────────

test('rotated: round-trip holds for a 30° field rotation', () => {
	var wcs = rotated(30);
	var fx = 0.2, fy = 0.85;
	var sky = DSWcs.pixelFracToSky(fx, fy, wcs);
	var back = DSWcs.skyToPixelFrac(sky.ra, sky.dec, wcs);
	assert.ok(back, 'round-trip returns a point');
	assert.ok(Math.abs(back.x - fx) < 1e-9, 'x round-trips under rotation');
	assert.ok(Math.abs(back.y - fy) < 1e-9, 'y round-trips under rotation');
});

// ── 3. degenerate ────────────────────────────────────────────────────────────

test('degenerate: skyToPixelFrac returns null (not NaN/Infinity)', () => {
	var wcs = degenerate();
	assert.equal(DSWcs.skyToPixelFrac(10, 10, wcs), null);
});

test('degenerate: precomputeWcs marks _degenerate and stays idempotent', () => {
	var wcs = degenerate();
	DSWcs.precomputeWcs(wcs);
	assert.equal(wcs._degenerate, true);
	assert.equal(wcs._cached, true);
	// Cached fields are non-enumerable so JSON.stringify stays clean (issue #82).
	assert.equal(Object.keys(wcs).indexOf('_degenerate'), -1);
	// Second call is a no-op — must not throw or re-define.
	assert.doesNotThrow(() => DSWcs.precomputeWcs(wcs));
});

// ── 4. RA-wrap ───────────────────────────────────────────────────────────────

test('RA-wrap: queries straddling the 0h seam stay finite and symmetric', () => {
	var wcs = raSeam();
	// ra=359 wraps to a −1° offset; ra=1 is a +1° offset. With cd11 negative
	// (RA increasing left) these must land symmetric about the reference x.
	var left  = DSWcs.skyToPixelFrac(359, 0, wcs);
	var right = DSWcs.skyToPixelFrac(1,   0, wcs);
	assert.ok(left && right, 'both project to finite points');
	assert.ok(Number.isFinite(left.x) && Number.isFinite(right.x), 'x finite');
	var refX = (wcs.crpix1 - 1) / wcs.imgW;
	// Equal magnitude, opposite side of the reference pixel.
	assert.ok(Math.abs((refX - left.x) - (right.x - refX)) < 1e-12, 'symmetric across seam');
});

// ── 5. sexagesimal rollover ──────────────────────────────────────────────────

test('formatRA: plain values format without carry', () => {
	assert.equal(DSWcs.formatRA(0),   'RA 0h 00m 00.0s');
	assert.equal(DSWcs.formatRA(180), 'RA 12h 00m 00.0s');
});

test('formatRA: seconds rounding to 60 carries into minutes/hours', () => {
	// 89.99999° ≈ 5h 59m 59.998s → seconds render "60.0" → 6h 00m 00.0s
	assert.equal(DSWcs.formatRA(89.99999), 'RA 6h 00m 00.0s');
});

test('formatRA: carry at 24h wraps back to 0h', () => {
	// 359.9999° ≈ 23h 59m 59.98s → carries all the way to 0h
	assert.equal(DSWcs.formatRA(359.9999), 'RA 0h 00m 00.0s');
});

test('formatDec: negative sign uses U+2212 and no carry on plain values', () => {
	assert.equal(DSWcs.formatDec(-5.5), 'Dec −5° 30′ 00″');
});

test('formatDec: seconds rounding to 60 carries into arcminutes', () => {
	// 41.4999° → 41° 29′ 59.64″ → seconds render "60" → 41° 30′ 00″
	assert.equal(DSWcs.formatDec(41.4999), 'Dec +41° 30′ 00″');
});

test('formatRaShort: minutes rounding to 60 carries into hours', () => {
	// 89.9925° = 5.9995h → 59.97m → "60.0" → 6h00.0m
	assert.equal(DSWcs.formatRaShort(89.9925), '6h00.0m');
	assert.equal(DSWcs.formatRaShort(0),       '0h00.0m');
});

test('formatDecShort: arcminutes rounding to 60 carries into degrees', () => {
	// 41.9995° → 59.97′ → "60.0" → +42°00.0′
	assert.equal(DSWcs.formatDecShort(41.9995), '+42°00.0′');
	assert.equal(DSWcs.formatDecShort(0),       '+0°00.0′');
});

// ── pickGridSpacing ──────────────────────────────────────────────────────────

test('pickGridSpacing: ~10 lines across a 1° range picks 10 arcmin', () => {
	// rangeMin = 60, ideal = 6 → first "nice" step ≥ 6 is 10 arcmin.
	assert.ok(Math.abs(DSWcs.pickGridSpacing(1) - 10 / 60) < 1e-12);
});

test('pickGridSpacing: enormous range clamps to the coarsest step (10°)', () => {
	assert.ok(Math.abs(DSWcs.pickGridSpacing(1000) - 600 / 60) < 1e-12);
});
