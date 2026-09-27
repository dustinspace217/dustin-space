'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { createNina, decodeImageResponse, jpegDimensions, jpegMetadataSegments, UNPARSED } = require('../../now-imaging/lib/nina');

// The real 1x1 baseline JPEG these tests decode. Its provenance is on the
// module; it lives there because agent-check.test.js feeds the same bytes
// through the publish path.
const { TINY_JPEG_B64 } = require('./fixtures/tiny-jpeg');

// Segment layout, walked from the actual bytes: DQT (0xFFDB, 67 bytes) at offset 2,
// then SOF0 at offset 71, then two DHT segments (0xFFC4) and SOS. So SOF0 is NOT at
// a fixed offset right after SOI — jpegDimensions has to step past the quantisation
// table to reach it. The Huffman tables sit AFTER SOF0 and the walk never sees them.
// Dimensions live in the SOF0 segment.
const SOF0_OFFSET = 71;

test('decodeImageResponse: base64 Response → Buffer starting with the JPEG magic', () => {
	const buf = decodeImageResponse({ Response: TINY_JPEG_B64, Success: true }, 1024 * 1024);
	assert.equal(buf[0], 0xff); assert.equal(buf[1], 0xd8);
});

test('decodeImageResponse: rejects non-JPEG bytes, oversize payloads, and error responses', () => {
	assert.throws(() => decodeImageResponse({ Response: Buffer.from('not a jpeg').toString('base64') }, 1e6), /not a JPEG/);
	assert.throws(() => decodeImageResponse({ Response: TINY_JPEG_B64 }, 10), /exceeds/);
	assert.throws(() => decodeImageResponse({ Success: false, Error: 'no image' }, 1e6), /no image/);
	// An error body whose Response is present but an EMPTY STRING, alongside
	// Success:false. Checking the Response shape first passes this through to the
	// JPEG-magic branch and reports "image is not a JPEG", throwing away the only
	// text that says what went wrong. (Shape not observed live — the rig had no
	// bad-index case to provoke during the Task 4 probe — so this pins the decoder
	// against it rather than documenting NINA.)
	assert.throws(
		() => decodeImageResponse({ Response: '', Success: false, Error: 'Index out of range' }, 1e6),
		/Index out of range/
	);
});

test('decodeImageResponse: a missing or nonsensical maxBytes is a TypeError, not a disabled cap', () => {
	// Without this guard `buf.length > undefined` is false, so a caller who forgot
	// the argument would silently get NO cap at all.
	assert.throws(() => decodeImageResponse({ Response: TINY_JPEG_B64 }), TypeError);
	assert.throws(() => decodeImageResponse({ Response: TINY_JPEG_B64 }, 0), TypeError);
	assert.throws(() => decodeImageResponse({ Response: TINY_JPEG_B64 }, Infinity), TypeError);
});

test('jpegDimensions: reads width/height from SOF0', () => {
	const buf = Buffer.from(TINY_JPEG_B64, 'base64');
	assert.deepEqual(jpegDimensions(buf), { width: 1, height: 1 });
	assert.equal(jpegDimensions(Buffer.from('zz')), null);
});

test('jpegDimensions: a 0xFF fill byte before SOF0 does not hide the marker', () => {
	// JPEG permits any number of 0xFF padding bytes before a marker. Splice one in
	// immediately ahead of SOF0: the walk must treat it as padding and re-read the
	// next byte as the marker prefix, not swallow the genuine 0xFF with it.
	const buf = Buffer.from(TINY_JPEG_B64, 'base64');
	const filled = Buffer.concat([buf.subarray(0, SOF0_OFFSET), Buffer.from([0xff]), buf.subarray(SOF0_OFFSET)]);
	assert.deepEqual(jpegDimensions(filled), { width: 1, height: 1 });
});

test('jpegDimensions: returns null when the walk runs off a header truncated before SOF0', () => {
	// 60 bytes: past the 4-byte entry guard and into the DQT segment, whose length
	// word points past the end. This exercises the WALK's null exit rather than the
	// cheap "too short / no SOI" rejection the 'zz' case above covers.
	const truncated = Buffer.from(TINY_JPEG_B64, 'base64').subarray(0, 60);
	assert.ok(truncated.length > 4 && truncated.length < SOF0_OFFSET);
	assert.equal(jpegDimensions(truncated), null);
});

test('history/cameraInfo/imageByIndex hit the documented URLs with a timeout signal', async () => {
	const seen = [];
	const fetchImpl = async (url, opts) => {
		seen.push({ url: String(url), hasSignal: !!(opts && opts.signal) });
		if (/image-history/.test(url)) return { ok: true, json: async () => ({ Response: [{ ImageType: 'LIGHT' }] }) };
		if (/camera\/info/.test(url))   return { ok: true, json: async () => ({ Response: { IsExposing: false } }) };
		if (/\/image\/7\?/.test(url))   return { ok: true, json: async () => ({ Response: TINY_JPEG_B64, Success: true }) };
		return { ok: false, status: 404 };
	};
	const nina = createNina({ baseUrl: 'http://localhost:1888', fetchImpl });
	assert.deepEqual(await nina.history(), [{ ImageType: 'LIGHT' }]);
	assert.deepEqual(await nina.cameraInfo(), { IsExposing: false });
	const buf = await nina.imageByIndex(7, 0.4, 80);
	assert.equal(buf[0], 0xff);
	assert.equal(seen[0].url, 'http://localhost:1888/v2/api/image-history?all=true');
	assert.equal(seen[1].url, 'http://localhost:1888/v2/api/equipment/camera/info');
	assert.equal(seen[2].url, 'http://localhost:1888/v2/api/image/7?resize=true&scale=0.4&quality=80');
	assert.ok(seen.every(s => s.hasSignal), 'every request carries an abort signal (timeout)');
});

test('history: non-200 or non-array Response → throws with the status in the message', async () => {
	const nina = createNina({ baseUrl: 'http://x', fetchImpl: async () => ({ ok: false, status: 503 }) });
	await assert.rejects(nina.history(), /503/);
	const nina2 = createNina({ baseUrl: 'http://x', fetchImpl: async () => ({ ok: true, json: async () => ({ Response: 'nope' }) }) });
	await assert.rejects(nina2.history(), /not an array/);
});

test('imageByIndex: out-of-contract arguments throw TypeError before any request is made', async () => {
	// The guards exist so a bad argument is reported as a bug here rather than as a
	// confusing NINA response later. Asserting the fetch was never called is the
	// part that proves the check runs FIRST.
	let calls = 0;
	const nina = createNina({ baseUrl: 'http://x', fetchImpl: async () => { calls++; return { ok: false, status: 404 }; } });
	await assert.rejects(nina.imageByIndex(-1, 0.4, 80), TypeError);
	await assert.rejects(nina.imageByIndex(0, 1.5, 80), TypeError);
	await assert.rejects(nina.imageByIndex(0, 0.4, 0), TypeError);
	assert.equal(calls, 0, 'no request is issued for an out-of-contract argument');
});

test('imageByIndex: a NINA error body surfaces NINA\'s own Error text', async () => {
	// End-to-end path for the empty-Response error shape: through getJson (HTTP 200,
	// so the status branch does not fire) and into decodeImageResponse.
	const nina = createNina({
		baseUrl: 'http://x',
		fetchImpl: async () => ({ ok: true, json: async () => ({ Response: '', Success: false, Error: 'Index out of range' }) })
	});
	await assert.rejects(nina.imageByIndex(99, 0.4, 80), /Index out of range/);
});

test('getJson: a transport failure and unparseable JSON both name the endpoint', async () => {
	// The fake reproduces what a fired AbortSignal.timeout actually rejects with on
	// Node 22, measured 2026-09-01 against a server that accepts and never replies:
	// name "TimeoutError", message "The operation was aborted due to timeout". That
	// message names no endpoint, so without the prefix the agent's log cannot say
	// WHICH of the three NINA calls timed out.
	const boom = createNina({
		baseUrl: 'http://x',
		fetchImpl: async () => {
			const e = new Error('The operation was aborted due to timeout');
			e.name = 'TimeoutError';
			throw e;
		}
	});
	await assert.rejects(boom.history(), /image-history.*TimeoutError/);
	const badJson = createNina({
		baseUrl: 'http://x',
		fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } })
	});
	await assert.rejects(badJson.cameraInfo(), /camera\/info.*SyntaxError/);
});

test('getJson: a transport failure carries err.cause, which is where the real reason lives', async () => {
	// Shape measured on Node 22: a refused connection rejects with "TypeError: fetch
	// failed", and the syscall detail is only on .cause. Without it the log says
	// "fetch failed" for NINA being closed, a wrong port, and a dead NIC alike.
	const refused = createNina({
		baseUrl: 'http://x',
		fetchImpl: async () => {
			const e = new TypeError('fetch failed');
			e.cause = new Error('connect ECONNREFUSED 127.0.0.1:1888');
			throw e;
		}
	});
	await assert.rejects(refused.history(), /fetch failed: connect ECONNREFUSED 127\.0\.0\.1:1888/);
});

test('openSocket: subscribes to IMAGE-SAVE on open and forwards only IMAGE-SAVE events', () => {
	const sent = [];
	class FakeWS {
		constructor(url) { this.url = url; this.listeners = {}; FakeWS.last = this; }
		addEventListener(type, fn) { this.listeners[type] = fn; }
		send(msg) { sent.push(msg); }
		close() { this.closed = true; }
		emit(type, ev) { this.listeners[type] && this.listeners[type](ev); }
	}
	const saved = []; const states = [];
	const nina = createNina({ baseUrl: 'http://host:1888', WebSocketImpl: FakeWS });
	const sock = nina.openSocket(() => saved.push(1), s => states.push(s));
	assert.equal(FakeWS.last.url, 'ws://host:1888/v2/socket');
	FakeWS.last.emit('open', {});
	assert.deepEqual(JSON.parse(sent[0]), { action: 'subscribe', eventType: 'IMAGE-SAVE' });
	FakeWS.last.emit('message', { data: JSON.stringify({ Response: { Event: 'IMAGE-PREPARED' } }) });
	FakeWS.last.emit('message', { data: JSON.stringify({ Response: { Event: 'IMAGE-SAVE' } }) });
	FakeWS.last.emit('message', { data: 'garbage{' });        // must not throw
	assert.equal(saved.length, 1);
	// A failing socket emits 'error' and then 'close' — both must reach the caller,
	// because agent.js decides whether to reconnect from these state changes alone.
	FakeWS.last.emit('error', { message: 'boom' });
	FakeWS.last.emit('close', { code: 1006 });
	assert.deepEqual(states, ['open', 'error', 'closed']);
	sock.close();
	assert.equal(FakeWS.last.closed, true);
});

/**
 * segment — one JPEG segment as bytes: FF, marker, a 2-byte big-endian length
 * that counts itself, then the payload. Receives the marker byte (0xE1 = APP1,
 * 0xFE = COM, …) and the payload Buffer; returns a Buffer.
 */
function segment(marker, payload) {
	return Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
}

/** spliceAt — the tiny JPEG with `bytes` inserted at `offset`. Returns a new Buffer. */
function spliceAt(offset, bytes) {
	const base = Buffer.from(TINY_JPEG_B64, 'base64');
	return Buffer.concat([base.subarray(0, offset), bytes, base.subarray(offset)]);
}

/** withSegment — the tiny JPEG with one extra segment right after SOI (offset 2). */
function withSegment(marker, payload) {
	return spliceAt(2, segment(marker, payload));
}

// The plain JFIF header exactly as a real published frame carries it: length
// word 16, "JFIF\0", version 1.1, no units, 1x1 density, a 0x0 thumbnail.
const JFIF_APP0 = segment(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]));

test('jpegMetadataSegments: a clean frame reports nothing; EXIF, IPTC, a comment, a colour profile and APP15 are each named', () => {
	assert.deepEqual(jpegMetadataSegments(Buffer.from(TINY_JPEG_B64, 'base64')), [], 'coding segments only');
	assert.deepEqual(jpegMetadataSegments(spliceAt(2, JFIF_APP0)), [], 'the shape NINA publishes today: one plain JFIF header');
	assert.deepEqual(jpegMetadataSegments(withSegment(0xe1, Buffer.from('Exif\0\0GPS…'))), ['APP1']);
	assert.deepEqual(jpegMetadataSegments(withSegment(0xed, Buffer.from('Photoshop 3.0\0'))), ['APP13']);
	assert.deepEqual(jpegMetadataSegments(withSegment(0xfe, Buffer.from('observer: someone'))), ['COM']);
	assert.deepEqual(jpegMetadataSegments(withSegment(0xe2, Buffer.from('ICC_PROFILE\0'))), ['APP2']);
	// The top of the APPn range, so narrowing it (<= 0xEF to anything lower) fails.
	assert.deepEqual(jpegMetadataSegments(withSegment(0xef, Buffer.from('x'))), ['APP15']);
	// The spliced file is still a readable JPEG: the dimension walk is undisturbed.
	assert.deepEqual(jpegDimensions(withSegment(0xe1, Buffer.from('Exif\0\0'))), jpegDimensions(Buffer.from(TINY_JPEG_B64, 'base64')));
});

test('jpegMetadataSegments: finds a segment that is not the first one', () => {
	// The real-world layout is JFIF APP0 first, THEN EXIF. Every case above puts
	// the segment right after SOI, so a walker that looked only at the first
	// segment, or advanced by the wrong amount, would pass them all.
	const exif = segment(0xe1, Buffer.from('Exif\0\0'));
	assert.deepEqual(jpegMetadataSegments(spliceAt(2, Buffer.concat([JFIF_APP0, exif]))), ['APP1'], 'APP0 then APP1');
	assert.deepEqual(jpegMetadataSegments(spliceAt(SOF0_OFFSET, exif)), ['APP1'], 'after the quantisation table');
	// JPEG allows 0xFF padding before any marker. Reading the pad as the marker
	// would take E1 for a length byte and jump far past the segment.
	assert.deepEqual(jpegMetadataSegments(spliceAt(2, Buffer.concat([Buffer.from([0xff]), exif]))), ['APP1'], 'fill byte before APP1');
});

test('jpegMetadataSegments: only one plain JFIF APP0 is allowed', () => {
	// JFXX is the APP0 extension that can embed a thumbnail IMAGE; a JFIF header
	// longer than 16 carries an inline one. Neither is published by NINA today.
	assert.deepEqual(jpegMetadataSegments(withSegment(0xe0, Buffer.from('JFXX\0'))), ['APP0']);
	assert.deepEqual(jpegMetadataSegments(spliceAt(2, Buffer.concat([JFIF_APP0, JFIF_APP0]))), ['APP0'], 'a second APP0');
});

test('jpegMetadataSegments: fails closed on anything it cannot read to the end', () => {
	const base = Buffer.from(TINY_JPEG_B64, 'base64');
	assert.deepEqual(jpegMetadataSegments(Buffer.from('zz')), [UNPARSED], 'not a JPEG');
	assert.deepEqual(jpegMetadataSegments(null), [UNPARSED]);
	// Cut inside the header, before SOS: the first version returned [] here.
	assert.deepEqual(jpegMetadataSegments(base.subarray(0, SOF0_OFFSET - 10)), [UNPARSED], 'truncated header');
	// A length word that points past the end of the file.
	assert.deepEqual(jpegMetadataSegments(spliceAt(2, Buffer.from([0xff, 0xe1, 0xff, 0xff]))), [UNPARSED], 'overrunning length');
	// A length word below 2 cannot be right (it counts its own two bytes). There is
	// no dedicated check: the walk lands inside the length word, which is never
	// 0xFF, and ends there. Both malformed values are pinned.
	assert.deepEqual(jpegMetadataSegments(spliceAt(2, Buffer.from([0xff, 0xdb, 0x00, 0x01]))), [UNPARSED], 'length 1');
	assert.deepEqual(jpegMetadataSegments(spliceAt(2, Buffer.from([0xff, 0xdb, 0x00, 0x00]))), [UNPARSED], 'length 0');
	// A byte that is not 0xFF where the next marker must start.
	assert.deepEqual(jpegMetadataSegments(spliceAt(SOF0_OFFSET, Buffer.from([0x41]))), [UNPARSED], 'stray byte between segments');
	// No EOI: the image data never ends.
	assert.deepEqual(jpegMetadataSegments(base.subarray(0, base.length - 2)), [UNPARSED], 'missing EOI');
	// What was found before the walk failed is still named.
	const exifThenCut = spliceAt(2, segment(0xe1, Buffer.from('Exif\0\0'))).subarray(0, 40);
	assert.deepEqual(jpegMetadataSegments(exifThenCut), ['APP1', UNPARSED]);
});

test('jpegMetadataSegments: looks past the image data, and is not fooled by bytes inside it', () => {
	const base = Buffer.from(TINY_JPEG_B64, 'base64');
	const eoi = base.length - 2;
	assert.deepEqual([base[eoi], base[eoi + 1]], [0xff, 0xd9], 'the fixture ends with EOI');
	// A progressive file has several scans, and a segment may sit between them;
	// so may one just before EOI. Both are after the first SOS.
	assert.deepEqual(jpegMetadataSegments(spliceAt(eoi, segment(0xfe, Buffer.from('site: somewhere')))), ['COM'], 'a comment after the scan');
	// Bytes appended after EOI are invisible to an image decoder and a common
	// place for tools to park data.
	assert.deepEqual(jpegMetadataSegments(Buffer.concat([base, Buffer.from('lat=1.0')])), ['TRAILING']);
	// Inside scan data the encoder writes a literal 0xFF as FF 00, and FF D0..D7
	// are restart markers. Neither ends the scan, and neither is reported. The
	// bytes after the stuffed pair spell FF E1 only if the 00 is skipped wrongly.
	assert.deepEqual(jpegMetadataSegments(spliceAt(eoi, Buffer.from([0xff, 0x00, 0xe1, 0x41, 0xff, 0xd3, 0x42]))), [], 'stuffed byte and restart marker');
});
