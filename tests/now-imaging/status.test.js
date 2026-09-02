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
	const r2 = validateStatus(s2);
	assert.equal(r2.ok, false);
	// The reason names the full dotted path, not just the key. Without this the
	// pin would pass on ANY rejection — a schemaVersion complaint, say — and stop
	// proving that the nested key is what the walk found.
	assert.match(r2.reason, /frame\.meta\.observerElevation/);
});

/**
 * nest — wrap a value in `levels` plain objects, one key per level.
 * Receives: levels (how many wrappers to add), leaf (the innermost value).
 * Returns the outermost wrapper. Only used by the fail-closed pin below, to
 * plant a key deeper than the privacy walk is willing to descend.
 */
function nest(levels, leaf) {
	let node = leaf;
	// Bounded by the literal the caller passes (Power of Ten rule 2).
	for (let i = 0; i < levels; i += 1) node = { inner: node };
	return node;
}

test('validateStatus: fails closed past the walk bound instead of reporting clean', () => {
	const s = buildStatus(args);
	// 12 wrappers puts `siteLatitude` well past MAX_DEPTH (8), so the walk can
	// never reach it. The gate must still refuse: a subtree nobody inspected is
	// not a subtree known to be clean. Before the fail-closed guard this
	// document validated {ok:true} with a planted coordinate key inside it.
	s.frame.meta = nest(12, { siteLatitude: 31.9 });
	const r = validateStatus(s);
	assert.equal(r.ok, false);
	assert.match(r.reason, /depth 8 exceeded/);
});

test('validateStatus: rejects missing required fields and a non-https frame url', () => {
	const s = buildStatus(args);
	delete s.frame.url;
	const r = validateStatus(s);
	assert.equal(r.ok, false);
	assert.match(r.reason, /frame\.url/);
	const s2 = buildStatus(Object.assign({}, args, { frameUrl: 'http://live.dustin.space/x.jpg' }));
	const r2 = validateStatus(s2);
	assert.equal(r2.ok, false);
	assert.match(r2.reason, /frame\.url/);
});

// The four pins below cover the remaining rejection branches one apiece. Each
// asserts the REASON names the offending field, not just that ok is false.
// `reason` is the only information validateStatus returns beyond the boolean,
// so pinning just `ok === false` would let any two branches swap their messages
// without a test noticing.

test('validateStatus: rejects a schemaVersion other than 1', () => {
	const s = buildStatus(args);
	s.schemaVersion = 2;
	const r = validateStatus(s);
	assert.equal(r.ok, false);
	assert.match(r.reason, /schemaVersion/);
});

test('validateStatus: rejects an unparseable updatedAt', () => {
	const s = buildStatus(args);
	s.updatedAt = 'not-a-date';
	const r = validateStatus(s);
	assert.equal(r.ok, false);
	assert.match(r.reason, /updatedAt/);
});

test('validateStatus: rejects a missing target.name', () => {
	const s = buildStatus(args);
	// buildStatus produces '' here when neither the resolver nor the NINA row
	// supplies a name, so the empty string is the realistic failure value.
	s.target.name = '';
	const r = validateStatus(s);
	assert.equal(r.ok, false);
	assert.match(r.reason, /target\.name/);
});

test('validateStatus: rejects a non-numeric frame.exposureSeconds', () => {
	const s = buildStatus(args);
	// NaN is exactly what buildStatus yields from a row missing ExposureTime:
	// Number(undefined). The gate, not the builder, is where that is caught.
	s.frame.exposureSeconds = Number(undefined);
	const r = validateStatus(s);
	assert.equal(r.ok, false);
	assert.match(r.reason, /exposureSeconds/);
});
