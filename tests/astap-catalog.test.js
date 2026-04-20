/**
 * tests/astap-catalog.test.js — unit tests for ASTAP catalog parsing.
 *
 * Issue #87 / Phase A test-analyzer rank #1: parseRow is the highest-
 * value untested surface in the ingest pipeline. A silent regression
 * here lands wrong overlays in published images.json that ship to
 * production. These tests pin the parsing contract.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { parseRow } = require('../ingest/lib/astapCatalog');

// Header reference (from /opt/astap/deep_sky.csv):
//   col 0: RA in 0.1 seconds of time, range 0..864000
//          → RA_deg = col0 / 2400
//   col 1: Dec in 0.1 arcsec, range -324000..324000
//          → Dec_deg = col1 / 3600
//   col 2: name(s), slash-separated aliases (underscores for spaces)
//   col 3: length (major axis) 0.1 arcmin
//   col 4: width (minor axis)  0.1 arcmin
//   col 5: orientation degrees

// ── Happy paths ──────────────────────────────────────────────────────────────

test('parseRow: full 6-column row for M42', () => {
	// M42 sits near RA 5h35m17s = 83.821° → 201170 in 0.1s of time
	// Dec -5°23′28″ ≈ -19408 in 0.1 arcsec
	const row = parseRow('201170,-19408,M_42/NGC_1976/Orion_Nebula,5400,3000,30');
	assert.equal(row.name, 'M 42');
	assert.deepEqual(row.aliases, ['M 42', 'NGC 1976', 'Orion Nebula']);
	assert.ok(Math.abs(row.ra_deg - 83.82) < 0.01);
	assert.ok(Math.abs(row.dec_deg - -5.39) < 0.01);
	assert.equal(row.major_axis_arcmin, 540);
	assert.equal(row.minor_axis_arcmin, 300);
	assert.equal(row.position_angle, 30);
});

test('parseRow: 3-column row produces null sizes', () => {
	const row = parseRow('747670,110480,NGC_6960');
	assert.equal(row.name, 'NGC 6960');
	assert.equal(row.major_axis_arcmin, null);
	assert.equal(row.minor_axis_arcmin, null);
	assert.equal(row.position_angle, null);
});

test('parseRow: empty size fields produce null (not zero)', () => {
	const row = parseRow('747670,110480,NGC_6960,,,');
	assert.equal(row.major_axis_arcmin, null);
	assert.equal(row.minor_axis_arcmin, null);
	assert.equal(row.position_angle, null);
});

test('parseRow: length-only row (typical for unsized PGC entries)', () => {
	const row = parseRow('754300,112440,NGC_6995,120');
	assert.equal(row.name, 'NGC 6995');
	assert.equal(row.major_axis_arcmin, 12); // 120 / 10
	assert.equal(row.minor_axis_arcmin, null);
});

test('parseRow: slash-separated aliases produce multi-element array', () => {
	const row = parseRow('747670,110480,NGC_6960/Veil_Nebula_west,700,200,350');
	assert.equal(row.aliases.length, 2);
	assert.equal(row.aliases[0], 'NGC 6960');
	assert.equal(row.aliases[1], 'Veil Nebula west');
});

// ── Unit conversions ────────────────────────────────────────────────────────

test('parseRow: RA conversion respects 0.1-s-of-time scale', () => {
	// 864000 units = 24 hours = 360°. So 36000 units = 1 hour = 15°.
	const row = parseRow('36000,0,test_obj');
	assert.ok(Math.abs(row.ra_deg - 15) < 1e-9);
});

test('parseRow: Dec conversion respects 0.1-arcsec scale', () => {
	// 3600 units = 1° (3600 × 0.1″ = 360″ wait... actually 3600 × 0.1″ = 360″ = 6′. That's wrong.)
	// Re-derive: catalog says Dec range is -324000..324000 covering ±90°.
	// So 324000 units = 90°, i.e. 3600 units = 1°. Confirmed.
	const row = parseRow('0,3600,test_obj');
	assert.ok(Math.abs(row.dec_deg - 1) < 1e-9);
});

// ── Sentinel handling ───────────────────────────────────────────────────────

test('parseRow: pole sentinel SP_2000 is dropped', () => {
	// Dec = -324000 → -90° (south pole sentinel)
	assert.equal(parseRow('432057,-324000,SP_2000'), null);
});

test('parseRow: pole sentinel NP_2000 is dropped', () => {
	assert.equal(parseRow('57,324000,NP_2000'), null);
});

// ── Malformed rows ──────────────────────────────────────────────────────────

test('parseRow: too-few-column row returns null', () => {
	assert.equal(parseRow('747670,110480'), null);
});

test('parseRow: malformed RA returns null', () => {
	assert.equal(parseRow('abc,0,M_42'), null);
});

test('parseRow: malformed Dec returns null', () => {
	assert.equal(parseRow('747670,xyz,M_42'), null);
});

test('parseRow: empty alias list returns null', () => {
	assert.equal(parseRow('747670,110480,'), null);
});

// ── NAME_RENAMES post-processing ────────────────────────────────────────────

test("parseRow: Pickerings_Triangle gets apostrophe via NAME_RENAMES", () => {
	const row = parseRow('749086,113750,Pickerings_Triangle,650,420,0');
	assert.equal(row.name, "Pickering's Triangle");
});
