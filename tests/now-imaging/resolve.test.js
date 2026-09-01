/**
 * tests/now-imaging/resolve.test.js — pins for the target-name resolver in
 * now-imaging/lib/resolve.js. The VEIL_IDS string below is the REAL identifier
 * list Simbad returned on 2026-09-01 for `d.id='Veil Nebula'`, padding and
 * alias order included, so the pure-picker pins are anchored to the service's
 * actual output rather than to a tidied-up guess. Network tests inject a fake
 * fetch; no test in this file touches Simbad.
 */
'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');
const { createResolver, pickFromIds, normalizeKey } = require('../../now-imaging/lib/resolve');

const VEIL_IDS = 'LBN   191|LBN 074.53-08.42|NAME Cirrus Nebula|NAME Filamentary Nebula|NGC  6960|NAME Veil Nebula';

test('normalizeKey: case-insensitive, whitespace-collapsed', () => {
	assert.equal(normalizeKey('  veil   NEBULA '), 'veil nebula');
	assert.equal(normalizeKey('NGC  6960'), 'ngc 6960');
});

test('pickFromIds: raw is a NAME → that name (Simbad casing), designation by catalog priority', () => {
	assert.deepEqual(pickFromIds('veil nebula', 'NGC  6960', VEIL_IDS), { name: 'Veil Nebula', designation: 'NGC 6960' });
});

test('pickFromIds: raw is a designation → first NAME entry becomes the name', () => {
	assert.deepEqual(pickFromIds('NGC 6960', 'NGC  6960', VEIL_IDS), { name: 'Cirrus Nebula', designation: 'NGC 6960' });
});

test('pickFromIds: Messier beats NGC; no NAME entry → name is the designation', () => {
	const ids = 'NGC  1976|M  42|LBN   974';
	assert.deepEqual(pickFromIds('orion', 'M  42', ids), { name: 'M 42', designation: 'M 42' });
});

test('pickFromIds: nothing in the priority list → designation is main_id, whitespace-normalized', () => {
	assert.deepEqual(pickFromIds('x', 'Cl Melotte   20', 'Cl Melotte   20|NAME Alpha Persei Cluster'),
		{ name: 'Alpha Persei Cluster', designation: 'Cl Melotte 20' });
});

function tmpCache() {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-')), 'cache.json');
}

test('resolve: override wins and never touches the network', async () => {
	let calls = 0;
	const r = createResolver({
		overrides: { 'Veil Nebula': { name: 'Veil Nebula (West)', designation: 'NGC 6960' } },
		cachePath: tmpCache(), fetchImpl: async () => { calls++; throw new Error('no network'); },
	});
	assert.deepEqual(await r.resolve('veil nebula'), { name: 'Veil Nebula (West)', designation: 'NGC 6960' });
	assert.equal(calls, 0);
});

test('resolve: Simbad hit is cached to disk; second call skips the network', async () => {
	let calls = 0;
	const fetchImpl = async () => {
		calls++;
		return { ok: true, json: async () => ({ data: [['NGC  6960', VEIL_IDS]] }) };
	};
	const cachePath = tmpCache();
	const r = createResolver({ overrides: {}, cachePath, fetchImpl });
	assert.deepEqual(await r.resolve('Veil Nebula'), { name: 'Veil Nebula', designation: 'NGC 6960' });
	assert.equal(calls, 1);
	const r2 = createResolver({ overrides: {}, cachePath, fetchImpl });
	assert.deepEqual(await r2.resolve('veil  nebula'), { name: 'Veil Nebula', designation: 'NGC 6960' });
	assert.equal(calls, 1, 'second resolver instance must read the disk cache');
});

test('resolve: Simbad failure or empty result → raw name, null designation, NOT cached', async () => {
	const cachePath = tmpCache();
	const r = createResolver({ overrides: {}, cachePath, fetchImpl: async () => ({ ok: false, status: 503 }) });
	assert.deepEqual(await r.resolve('Mystery Blob'), { name: 'Mystery Blob', designation: null });
	assert.equal(fs.existsSync(cachePath) ? Object.keys(JSON.parse(fs.readFileSync(cachePath, 'utf8'))).length : 0, 0);
	const r2 = createResolver({ overrides: {}, cachePath, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }) });
	assert.deepEqual(await r2.resolve('Mystery Blob'), { name: 'Mystery Blob', designation: null });
});

test('resolve: the ADQL escapes a single quote in the raw name', async () => {
	let url = '';
	const r = createResolver({ overrides: {}, cachePath: tmpCache(), fetchImpl: async (u) => { url = String(u); return { ok: true, json: async () => ({ data: [] }) }; } });
	await r.resolve("Barnard's Loop");
	// Read the parameter back through URLSearchParams rather than
	// decodeURIComponent: the resolver builds the query string with
	// URLSearchParams, which form-encodes spaces as "+", and
	// decodeURIComponent leaves a "+" alone — so a raw decode of the whole URL
	// yields "Barnard''s+Loop" and hides the doubled quote we are pinning
	// behind an unrelated mismatch. Parsing with the same contract that wrote
	// it gives the literal ADQL Simbad will receive.
	assert.match(new URL(url).searchParams.get('query'), /Barnard''s Loop/);
});
