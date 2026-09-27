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
	// A zero exposure prints no exposure at all, the same rule the frame tag in
	// now-imaging.js applies; "0 s" on one line only read as a bug.
	assert.equal(L.caption(status({ frame: Object.assign(status().frame, { exposureSeconds: 0 }) })), 'Hα · 23rd sub tonight');
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

// ---- isRenderable: the page's whole trust decision about status.json ----

const FRAME_OK = 'https://live.dustin.space/now/sub-20260902T091000Z.jpg';
const renderable = (over) => status(Object.assign({ frame: Object.assign({}, status().frame, { url: FRAME_OK }) }, over));

test('isRenderable: accepts the document the agent really publishes, and the URL the agent really builds', () => {
	assert.equal(L.isRenderable(renderable(), T0), true);
	assert.equal(L.isRenderable(renderable({ target: { raw: 'x', name: 'Veil Nebula', designation: null } }), T0), true);
	// designation ABSENT, which the function's comment promises to accept and no
	// row exercised: without it the `!== undefined` half could be deleted unseen.
	assert.equal(L.isRenderable(renderable({ target: { name: 'Veil Nebula' } }), T0), true);
	// Contract pin across the two halves of the feature: the site's URL pattern
	// must accept exactly what lib/publish.js keyForFrame produces, or tightening
	// either side silently hides the card.
	const { keyForFrame } = require('../../now-imaging/lib/publish');
	const built = 'https://live.dustin.space/' + keyForFrame('2026-09-20T11:46:41.123Z');
	assert.equal(built, 'https://live.dustin.space/now/sub-20260920T114641Z.jpg');
	assert.equal(L.isRenderable(renderable({ frame: { url: built } }), T0), true);
});

test('isRenderable: refuses every other image URL', () => {
	const bad = [
		'http://live.dustin.space/now/sub-20260902T091000Z.jpg',          // not https
		'https://live.dustin.space.evil.example/now/sub-20260902T091000Z.jpg', // look-alike host
		'https://evil.example/now/sub-20260902T091000Z.jpg',
		// A valid frame URL as the TAIL of another one: only the leading ^ refuses it.
		'https://evil.example/?https://live.dustin.space/now/sub-20260902T091000Z.jpg',
		// …and as the HEAD of another one: only the trailing $ refuses it.
		'https://live.dustin.space/now/sub-20260902T091000Z.jpg.evil.example/x',
		'https://live.dustin.space/now/status.json',
		'https://live.dustin.space/now/../sub-20260902T091000Z.jpg',
		'https://live.dustin.space/now/sub-20260902T091000Z.jpg?x=1',
		'https://live.dustin.space/now/sub-20260902T091000Z.jpg#x',
		'https://live.dustin.space/now/sub-20260902T091000Z.svg',
		'https://cdn.jsdelivr.net/npm/x/y.jpg',
		'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
		'blob:https://dustin.space/abc',
		'/assets/img/gallery/x.webp',
		'', 42, null, {}, undefined,
	];
	for (const url of bad) {
		assert.equal(L.isRenderable(renderable({ frame: { url } }), T0), false, `must refuse ${JSON.stringify(url)}`);
	}
});

test('isRenderable: refuses wrong shapes — version, name types, designation types, missing parts, non-objects', () => {
	assert.equal(L.isRenderable(renderable({ schemaVersion: 2 }), T0), false);
	assert.equal(L.isRenderable(renderable({ schemaVersion: '1' }), T0), false, 'the string "1" is not version 1');
	for (const name of ['', {}, 42, null, undefined, ['x']]) {
		assert.equal(L.isRenderable(renderable({ target: { name } }), T0), false, `name ${JSON.stringify(name)}`);
	}
	assert.equal(L.isRenderable(renderable({ target: { name: 'x', designation: {} } }), T0), false);
	assert.equal(L.isRenderable(renderable({ target: { name: 'x', designation: 7 } }), T0), false);
	// Length bounds, each pinned on both sides.
	assert.equal(L.isRenderable(renderable({ target: { name: 'n'.repeat(120) } }), T0), true);
	assert.equal(L.isRenderable(renderable({ target: { name: 'n'.repeat(121) } }), T0), false);
	assert.equal(L.isRenderable(renderable({ target: { name: 'x', designation: 'd'.repeat(60) } }), T0), true);
	assert.equal(L.isRenderable(renderable({ target: { name: 'x', designation: 'd'.repeat(61) } }), T0), false);
	assert.equal(L.isRenderable(renderable({ target: undefined }), T0), false);
	assert.equal(L.isRenderable(renderable({ frame: undefined }), T0), false);
	for (const doc of [null, undefined, 'a string', 42, []]) assert.equal(L.isRenderable(doc, T0), false);
});

test('isRenderable: a future-dated updatedAt is refused past five minutes; an unparseable one always', () => {
	// Without this a far-future stamp reads as "live" forever: its age is
	// negative, which is always inside the live window.
	const at = (ms) => renderable({ updatedAt: new Date(T0 + ms).toISOString() });
	assert.equal(L.isRenderable(at(4 * 60000), T0), true, 'a rig clock four minutes fast is fine');
	assert.equal(L.isRenderable(at(6 * 60000), T0), false);
	assert.equal(L.isRenderable(at(3 * 86400000), T0), false);
	assert.equal(L.isRenderable(at(-30 * 86400000), T0), true, 'an old document is still renderable: it paints as idle');
	assert.equal(L.isRenderable(renderable({ updatedAt: 'garbage' }), T0), false);
	assert.equal(L.isRenderable(renderable({ updatedAt: undefined }), T0), false);
});

test('aspectRatioText: a sane frame shape becomes a CSS value; anything else leaves the default box', () => {
	assert.equal(L.aspectRatioText({ width: 1876, height: 1253 }), '1876 / 1253');
	assert.equal(L.aspectRatioText({ width: 400, height: 100 }), '400 / 100', 'exactly 4:1 is allowed');
	assert.equal(L.aspectRatioText({ width: 100, height: 400 }), '100 / 400');
	assert.equal(L.aspectRatioText({ width: 401, height: 100 }), '', 'wider than 4:1');
	assert.equal(L.aspectRatioText({ width: 100, height: 401 }), '', 'taller than 1:4');
	// The values end up in a style property, so strings never pass, even numeric ones.
	for (const bad of [{ width: '3', height: 2 }, { width: 3, height: '2; color: red' }, { width: 0, height: 2 }, { width: -3, height: 2 },
		{ width: Infinity, height: 2 }, { width: NaN, height: 2 }, { width: 3 }, {}, null, undefined]) {
		assert.equal(L.aspectRatioText(bad), '', JSON.stringify(bad));
	}
});

// ---- readCapped: run against real Response and ReadableStream objects ----

/** streamOf — a Response whose body arrives as the given chunks, one per read. */
function streamOf(chunks, onCancel) {
	let i = 0;
	const body = new ReadableStream({
		pull(controller) { if (i < chunks.length) controller.enqueue(chunks[i++]); else controller.close(); },
		cancel() { if (onCancel) onCancel(); },
	});
	return new Response(body);
}

test('readCapped: counts bytes ACROSS chunks, refuses past the cap, and cancels the rest of the body', async () => {
	// Three 6000-byte chunks against a 16384 cap: no single chunk is over, the
	// running total is. A reader that compared each chunk alone would accept this.
	const chunk = new Uint8Array(6000).fill(0x20);
	let cancelled = 0;
	await assert.rejects(L.readCapped(streamOf([chunk, chunk, chunk], () => { cancelled++; }), 16384), /status too large/);
	assert.equal(cancelled, 1, 'the unread remainder is abandoned, not drained');
	// Under the cap: the text comes back whole.
	assert.equal(await L.readCapped(streamOf([chunk, chunk]), 16384), ' '.repeat(12000));
	// Exactly at the cap is allowed; one byte more is not.
	assert.equal((await L.readCapped(streamOf([new Uint8Array(16384).fill(0x20)]), 16384)).length, 16384);
	await assert.rejects(L.readCapped(streamOf([new Uint8Array(16385).fill(0x20)]), 16384), /status too large/);
});

test('readCapped: a multi-byte character split across two chunks survives', async () => {
	// "α" is CE B1 in UTF-8. Decoding each chunk on its own gives two U+FFFD.
	const text = await L.readCapped(streamOf([new Uint8Array([0x48, 0xce]), new Uint8Array([0xb1])]), 100);
	assert.equal(text, 'Hα');
});

test('readCapped: without a streaming body it falls back to text() and still refuses an oversized document', async () => {
	const noStream = (t) => ({ body: null, text: async () => t });
	assert.equal(await L.readCapped(noStream('{"ok":1}'), 100), '{"ok":1}');
	await assert.rejects(L.readCapped(noStream('x'.repeat(101)), 100), /status too large/);
});
