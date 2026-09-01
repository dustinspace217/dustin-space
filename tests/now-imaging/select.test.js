/**
 * tests/now-imaging/select.test.js — pins for the PURE selection math in
 * now-imaging/lib/select.js. Fixture = a real NINA image-history capture from
 * 2026-09-01 (69 entries, all SNAPSHOT bias/snapshot frames — no lights), plus
 * synthetic LIGHT entries appended per test so each pin controls its own data.
 */
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const { selectLatestLight, countSubsTonight, nextFrameExpectedAt, localNoonBefore }
	= require('../../now-imaging/lib/select');

const FIX = path.join(__dirname, 'fixtures');
const history = JSON.parse(fs.readFileSync(path.join(FIX, 'history-2026-09-01.json'), 'utf8')).Response;
const cameraInfo = JSON.parse(fs.readFileSync(path.join(FIX, 'camera-info-2026-09-01.json'), 'utf8')).Response;

// Build a LIGHT entry shaped exactly like NINA's history rows.
function light(overrides) {
	return Object.assign({
		ExposureTime: 300, ImageType: 'LIGHT', Filter: 'Ha', RmsText: 'Tot: 0.40 (0.60")',
		Temperature: -5, CameraName: 'QHY268M', TargetName: 'Veil Nebula', Gain: 56, Offset: 11,
		Date: '2026-09-02T02:10:00.0000000-07:00', TelescopeName: 'Orion Eon 70', FocalLength: 350,
		StDev: 12.1, Mean: 410.2, Median: 402, Min: 12, Max: 65535, Stars: 412, HFR: 2.1,
		HFRStDev: '0.3', IsBayered: false,
		Filename: 'Orion Eon 70_Veil Nebula_2026-09-02_02-10-00_Ha_-5.00_300.00s_0023.xisf',
	}, overrides);
}

test('selectLatestLight: no LIGHT frames → null (real fixture is all SNAPSHOT)', () => {
	assert.equal(selectLatestLight(history), null);
});

test('selectLatestLight: picks the newest LIGHT by Date, not by array position', () => {
	const older  = light({ Date: '2026-09-02T02:10:00.0000000-07:00', Filename: 'a.xisf' });
	const newest = light({ Date: '2026-09-02T02:15:30.0000000-07:00', Filename: 'b.xisf' });
	const h = [...history, newest, older]; // newest deliberately BEFORE older in the array
	const picked = selectLatestLight(h);
	assert.equal(picked.entry.Filename, 'b.xisf');
	assert.equal(picked.index, history.length); // index = position in the array, for image/{index}
});

test('selectLatestLight: ImageType comparison is case-insensitive and ignores FLAT/DARK/BIAS', () => {
	const h = [...history, light({ ImageType: 'light', Filename: 'lc.xisf' }),
		light({ ImageType: 'FLAT', Date: '2026-09-02T03:00:00.0000000-07:00', Filename: 'flat.xisf' })];
	assert.equal(selectLatestLight(h).entry.Filename, 'lc.xisf');
});

test('countSubsTonight: counts same target+filter LIGHTs since the last local noon', () => {
	const h = [...history,
		light({ Date: '2026-09-01T23:50:00.0000000-07:00', Filename: '1.xisf' }), // same night, before midnight
		light({ Date: '2026-09-02T00:20:00.0000000-07:00', Filename: '2.xisf' }),
		light({ Date: '2026-09-02T02:10:00.0000000-07:00', Filename: '3.xisf' }),
		light({ Date: '2026-09-02T02:12:00.0000000-07:00', Filter: 'OIII', Filename: 'o.xisf' }), // other filter
		light({ Date: '2026-09-01T03:00:00.0000000-07:00', Filename: 'prev.xisf' }),            // previous night
	];
	const entry = h.find(e => e.Filename === '3.xisf');
	assert.equal(countSubsTonight(h, entry), 3);
});

test('localNoonBefore: uses the offset embedded in NINA\'s Date string, not the host zone', () => {
	// 00:20 local (-07:00) → previous local noon is 2026-09-01 12:00 -07:00 = 19:00Z
	assert.equal(localNoonBefore('2026-09-02T00:20:00.0000000-07:00').toISOString(), '2026-09-01T19:00:00.000Z');
	// 13:00 local → noon of the SAME day
	assert.equal(localNoonBefore('2026-09-02T13:00:00.0000000-07:00').toISOString(), '2026-09-02T19:00:00.000Z');
});

test('nextFrameExpectedAt: only when exposing; ExposureEndTime + slack, as UTC ISO', () => {
	// Real fixture: IsExposing=false → null
	assert.equal(nextFrameExpectedAt(cameraInfo, Date.now()), null);
	const exposing = Object.assign({}, cameraInfo, { IsExposing: true, ExposureEndTime: '2026-09-02T02:15:00.0000000-07:00' });
	assert.equal(nextFrameExpectedAt(exposing, Date.parse('2026-09-02T09:10:00Z')), '2026-09-02T09:15:15.000Z');
	// End time in the past (stale) → null, never a "next frame" in the past
	assert.equal(nextFrameExpectedAt(exposing, Date.parse('2026-09-02T09:20:00Z')), null);
});
