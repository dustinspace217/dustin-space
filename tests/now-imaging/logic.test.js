'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const L = require('../../src/assets/js/now-imaging-logic');

const T0 = Date.parse('2026-09-02T09:10:00Z');
const status = (over) => Object.assign({
	schemaVersion: 1, updatedAt: '2026-09-02T09:10:00.000Z',
	target: { raw: 'Veil Nebula', name: 'Veil Nebula', designation: 'NGC 6960' },
	frame: { url: 'https://live.dustin.space/now/x.jpg', width: 1256, height: 842, filter: 'Ha', exposureSeconds: 300, subsTonight: 23, hfr: 2.1, stars: 412 },
	equipment: { camera: 'QHY268M', telescope: 'Orion Eon 70', focalLengthMm: 350 },
}, over);

test('isLive: under max(20 min, 3×exposure) is live; 20-minute subs get a 60-minute window', () => {
	assert.equal(L.isLive(status(), T0 + 19 * 60000), true);
	assert.equal(L.isLive(status(), T0 + 21 * 60000), false);
	const long = status({ frame: Object.assign(status().frame, { exposureSeconds: 1200 }) });
	assert.equal(L.isLive(long, T0 + 55 * 60000), true);
	assert.equal(L.isLive(long, T0 + 61 * 60000), false);
	assert.equal(L.isLive(status({ updatedAt: 'garbage' }), T0), false);
});

test('nextFetchDelayMs: nextFrameExpectedAt wins when in the future (+20 s), never under the floor', () => {
	const s = status({ nextFrameExpectedAt: '2026-09-02T09:15:15.000Z' });
	assert.equal(L.nextFetchDelayMs(s, T0), 5 * 60000 + 15000 + 20000);
	assert.equal(L.nextFetchDelayMs(s, Date.parse('2026-09-02T09:15:10Z')), 60000, 'floor');
});

test('nextFetchDelayMs: live without nextFrameExpectedAt → updatedAt + exposure + 30 s; idle → 5 min', () => {
	assert.equal(L.nextFetchDelayMs(status(), T0 + 60000), 300000 + 30000 - 60000);
	assert.equal(L.nextFetchDelayMs(status(), T0 + 40 * 60000), 300000);
	// stale nextFrameExpectedAt (in the past) is ignored
	assert.equal(L.nextFetchDelayMs(status({ nextFrameExpectedAt: '2026-09-02T09:00:00Z' }), T0 + 40 * 60000), 300000);
});

test('caption: "Hα · 300 s · 23rd sub tonight"; filter names get their proper symbols', () => {
	assert.equal(L.caption(status()), 'Hα · 300 s · 23rd sub tonight');
	assert.equal(L.filterLabel('OIII'), 'OIII'); assert.equal(L.filterLabel('SII'), 'SII');
	assert.equal(L.filterLabel('Ha'), 'Hα'); assert.equal(L.filterLabel('H-alpha'), 'Hα'); assert.equal(L.filterLabel('L'), 'Luminance');
	// The two remaining forms the filterLabel header comment claims to cover.
	assert.equal(L.filterLabel('HA'), 'Hα'); assert.equal(L.filterLabel('Lum'), 'Luminance');
	assert.equal(L.ordinal(1), '1st'); assert.equal(L.ordinal(2), '2nd'); assert.equal(L.ordinal(3), '3rd');
	assert.equal(L.ordinal(11), '11th'); assert.equal(L.ordinal(12), '12th'); assert.equal(L.ordinal(23), '23rd'); assert.equal(L.ordinal(112), '112th');
	assert.equal(L.caption(status({ frame: Object.assign(status().frame, { exposureSeconds: 0.5, subsTonight: 1 }) })), 'Hα · 0.5 s · 1st sub tonight');
	// A caption asked for before the document is validated returns '', never throws.
	assert.equal(L.caption(null), '');
});

test('relativeAge: uses Intl.RelativeTimeFormat with the largest sensible unit', () => {
	const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
	assert.equal(L.relativeAge('2026-09-02T09:10:00Z', T0 + 6 * 3600000, rtf), '6 hours ago');
	assert.equal(L.relativeAge('2026-09-02T09:10:00Z', T0 + 3 * 86400000, rtf), '3 days ago');
	assert.equal(L.relativeAge('2026-09-02T09:10:00Z', T0 + 40 * 60000, rtf), '40 minutes ago');
	// An unparseable updatedAt is the same input isLive() calls idle, and idle is
	// the branch that renders this label — so it must return '', not throw.
	assert.equal(L.relativeAge('garbage', T0, rtf), '');
});
