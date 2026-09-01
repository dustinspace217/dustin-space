/**
 * tests/now-imaging/status.test.js — pins for the PURE status document builder
 * and its publish gate in now-imaging/lib/status.js. The entry below is a
 * synthetic NINA history row shaped like the real fixture rows (see
 * fixtures/history-2026-09-01.json) but with LIGHT-frame fields filled in, so
 * each pin controls its own data rather than depending on capture contents.
 */
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { buildStatus, validateStatus } = require('../../now-imaging/lib/status');

const entry = {
	ExposureTime: 300, ImageType: 'LIGHT', Filter: 'Ha', TargetName: 'Veil Nebula',
	Date: '2026-09-02T02:10:00.0000000-07:00', CameraName: 'QHY268M',
	TelescopeName: 'Orion Eon 70', FocalLength: 350, Stars: 412, HFR: 2.1,
	Filename: 'x.xisf', Temperature: -5, Gain: 56,
};
const args = {
	entry, subsTonight: 23, nextFrameExpectedAt: '2026-09-02T09:15:15.000Z',
	resolved: { name: 'Veil Nebula', designation: 'NGC 6960' },
	frameUrl: 'https://live.dustin.space/now/sub-20260902T091000Z.jpg', width: 1256, height: 842,
};

test('buildStatus: shape matches spec §7, updatedAt is the frame Date in UTC', () => {
	const s = buildStatus(args);
	assert.equal(s.schemaVersion, 1);
	assert.equal(s.updatedAt, '2026-09-02T09:10:00.000Z');
	assert.equal(s.nextFrameExpectedAt, '2026-09-02T09:15:15.000Z');
	assert.deepEqual(s.target, { raw: 'Veil Nebula', name: 'Veil Nebula', designation: 'NGC 6960' });
	assert.deepEqual(s.frame, {
		url: args.frameUrl, width: 1256, height: 842, filter: 'Ha', exposureSeconds: 300,
		subsTonight: 23, hfr: 2.1, stars: 412,
	});
	assert.deepEqual(s.equipment, { camera: 'QHY268M', telescope: 'Orion Eon 70', focalLengthMm: 350 });
	assert.equal('filename' in s.frame, false, 'NINA filenames stay out of the public document');
});

test('buildStatus: omits nextFrameExpectedAt when null; null designation stays null', () => {
	const s = buildStatus(Object.assign({}, args, { nextFrameExpectedAt: null, resolved: { name: 'Foo', designation: null } }));
	assert.equal('nextFrameExpectedAt' in s, false);
	assert.equal(s.target.designation, null);
});

test('validateStatus: accepts a built status', () => {
	assert.deepEqual(validateStatus(buildStatus(args)), { ok: true });
});

test('validateStatus: rejects any coordinate-like key at any depth (privacy invariant)', () => {
	const s = buildStatus(args);
	s.equipment.siteLatitude = 31.9;          // planted
	const r = validateStatus(s);
	assert.equal(r.ok, false);
	assert.match(r.reason, /siteLatitude/);
	const s2 = buildStatus(args);
	s2.frame.meta = { observerElevation: 1500 };
	assert.equal(validateStatus(s2).ok, false);
});

test('validateStatus: rejects missing required fields and a non-https frame url', () => {
	const s = buildStatus(args);
	delete s.frame.url;
	assert.equal(validateStatus(s).ok, false);
	const s2 = buildStatus(Object.assign({}, args, { frameUrl: 'http://live.dustin.space/x.jpg' }));
	assert.equal(validateStatus(s2).ok, false);
});
