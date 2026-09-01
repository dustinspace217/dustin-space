/**
 * nina.js — the only code that talks to NINA's Advanced API.
 *
 * Exactly four surfaces (spec Global Constraints): image-history, image/{index},
 * equipment/camera/info, and the /v2/socket event stream. The profile endpoint
 * (which carries the observing site's coordinates) is deliberately absent.
 *
 * fetch and WebSocket are INJECTABLE (defaults are Node 22's built-ins) so the
 * tests drive this module without a network.
 */
'use strict';

const JPEG_MAGIC = [0xff, 0xd8];

/**
 * decodeImageResponse — turn NINA's image/{index} JSON into JPEG bytes.
 * Receives the parsed body ({Response: base64, Success, Error}) and a byte cap.
 * Returns a Buffer. Throws (with NINA's own Error text when present) on an API
 * error, non-JPEG bytes, or a payload over the cap — a cap because a scale
 * misconfiguration could otherwise ship a multi-megabyte frame to R2 every sub.
 */
function decodeImageResponse(body, maxBytes) {
	if (!body || typeof body.Response !== 'string') {
		throw new Error(`NINA image error: ${body && body.Error ? body.Error : 'no image data in response'}`);
	}
	const buf = Buffer.from(body.Response, 'base64');
	if (buf.length > maxBytes) throw new Error(`image ${buf.length} bytes exceeds cap ${maxBytes}`);
	if (buf[0] !== JPEG_MAGIC[0] || buf[1] !== JPEG_MAGIC[1]) throw new Error('image is not a JPEG');
	return buf;
}

/**
 * jpegDimensions — width/height from the first SOF marker (0xFFC0..0xFFC3).
 * Receives a Buffer; returns {width, height} or null if no SOF is found within
 * the buffer. Walks JPEG segments (each: 0xFF, marker, 2-byte length); bounded
 * by the buffer length. Used so status.json can carry the aspect ratio and the
 * page can reserve the box before the image loads (no layout shift).
 */
function jpegDimensions(buf) {
	if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
	let i = 2;
	while (i + 9 < buf.length) {                           // bounded: buffer length
		if (buf[i] !== 0xff) { i++; continue; }
		const marker = buf[i + 1];
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { i += 2; continue; }
		const len = buf.readUInt16BE(i + 2);
		if (marker >= 0xc0 && marker <= 0xc3) {
			return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
		}
		i += 2 + len;
	}
	return null;
}

/**
 * createNina — client factory.
 * Receives baseUrl (e.g. http://localhost:1888), optional fetchImpl /
 * WebSocketImpl (tests), timeoutMs per HTTP call (default 10 s), maxImageBytes
 * (default 3 MB). Returns the client object documented in the plan interfaces.
 */
function createNina({ baseUrl, fetchImpl = fetch, WebSocketImpl = WebSocket, timeoutMs = 10000, maxImageBytes = 3 * 1024 * 1024 }) {
	const base = String(baseUrl).replace(/\/+$/, '');

	/** getJson — one GET with timeout; returns the parsed body or throws with the HTTP status. */
	async function getJson(pathAndQuery) {
		const resp = await fetchImpl(`${base}${pathAndQuery}`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!resp.ok) throw new Error(`NINA ${pathAndQuery} → HTTP ${resp.status}`);
		return resp.json();
	}

	/** history — the full image history array for this NINA process. */
	async function history() {
		const body = await getJson('/v2/api/image-history?all=true');
		if (!body || !Array.isArray(body.Response)) throw new Error('NINA image-history Response is not an array');
		return body.Response;
	}

	/** cameraInfo — camera/info Response object (IsExposing, ExposureEndTime, …). */
	async function cameraInfo() {
		const body = await getJson('/v2/api/equipment/camera/info');
		if (!body || typeof body.Response !== 'object') throw new Error('NINA camera/info Response missing');
		return body.Response;
	}

	/**
	 * imageByIndex — stretched JPEG of history entry `index`.
	 * scale is a 0–1 FRACTION of NINA's prepared image (measured against the rig
	 * 2026-09-01: the same frame came back 1250 px wide at scale 0.2 and 2501 px
	 * at 0.4 — linear, not area); quality is JPEG 1–100.
	 *
	 * Keep scale modest. That same frame is ~6250 px wide at scale 1.0: the
	 * request did not return inside the 10 s default timeout, and extrapolating
	 * from 675 KB at 0.4 puts a full-scale JPEG over the 3 MB maxImageBytes cap.
	 * Both limits are deliberate — they fail loudly rather than shipping a
	 * multi-megabyte frame to R2 on every sub.
	 * Fetching BY INDEX (not prepared-image) is race-free: a snapshot or flat
	 * landing between the history read and this call cannot swap the frame.
	 */
	async function imageByIndex(index, scale, quality) {
		const body = await getJson(`/v2/api/image/${index}?resize=true&scale=${scale}&quality=${quality}`);
		return decodeImageResponse(body, maxImageBytes);
	}

	/**
	 * openSocket — subscribe to IMAGE-SAVE events.
	 * Receives onImageSaved() and onStateChange('open'|'closed'|'error').
	 * Returns {close()}. Reconnection is the CALLER's job (agent.js owns the
	 * backoff so it can log and so the policy is testable in one place).
	 */
	function openSocket(onImageSaved, onStateChange) {
		const wsUrl = base.replace(/^http/, 'ws') + '/v2/socket';
		const ws = new WebSocketImpl(wsUrl);
		ws.addEventListener('open', () => {
			ws.send(JSON.stringify({ action: 'subscribe', eventType: 'IMAGE-SAVE' }));
			onStateChange('open');
		});
		ws.addEventListener('message', (ev) => {
			let msg = null;
			try { msg = JSON.parse(String(ev.data)); } catch { return; }   // unknown frame: ignore, never throw
			if (msg && msg.Response && msg.Response.Event === 'IMAGE-SAVE') onImageSaved();
		});
		ws.addEventListener('error', () => onStateChange('error'));
		ws.addEventListener('close', () => onStateChange('closed'));
		return { close: () => ws.close() };
	}

	return { history, cameraInfo, imageByIndex, openSocket };
}

module.exports = { createNina, decodeImageResponse, jpegDimensions };
