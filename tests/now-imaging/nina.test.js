'use strict';
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { createNina, decodeImageResponse, jpegDimensions } = require('../../now-imaging/lib/nina');

// A real 1x1 BASELINE JPEG (SOF0 = 0xFFC0), 315 bytes, as base64. Generated with
// `vips black /tmp/claude/one.jpg 1 1` then `vips copy ... [strip]` to drop the Exif
// block, and verified with `file` (reports "baseline, precision 8, 1x1"). It is not
// the smallest encodable JPEG — it carries libjpeg's standard quantisation and
// Huffman tables — which is exactly why it is useful here: jpegDimensions has to
// WALK past those segments to reach SOF0 rather than finding it at a fixed offset.
// Dimensions live in the SOF0 segment.
const TINY_JPEG_B64 = '/9j/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+v//Z';

test('decodeImageResponse: base64 Response → Buffer starting with the JPEG magic', () => {
	const buf = decodeImageResponse({ Response: TINY_JPEG_B64, Success: true }, 1024 * 1024);
	assert.equal(buf[0], 0xff); assert.equal(buf[1], 0xd8);
});

test('decodeImageResponse: rejects non-JPEG bytes, oversize payloads, and error responses', () => {
	assert.throws(() => decodeImageResponse({ Response: Buffer.from('not a jpeg').toString('base64') }, 1e6), /not a JPEG/);
	assert.throws(() => decodeImageResponse({ Response: TINY_JPEG_B64 }, 10), /exceeds/);
	assert.throws(() => decodeImageResponse({ Success: false, Error: 'no image' }, 1e6), /no image/);
});

test('jpegDimensions: reads width/height from SOF0', () => {
	const buf = Buffer.from(TINY_JPEG_B64, 'base64');
	assert.deepEqual(jpegDimensions(buf), { width: 1, height: 1 });
	assert.equal(jpegDimensions(Buffer.from('zz')), null);
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
	FakeWS.last.emit('close', { code: 1006 });
	assert.deepEqual(states, ['open', 'closed']);
	sock.close();
	assert.equal(FakeWS.last.closed, true);
});
