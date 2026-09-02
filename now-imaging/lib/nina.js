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
 * Throws TypeError if maxBytes is not a positive finite number: a caller passing
 * undefined would otherwise disable the cap silently, because a relational
 * comparison against NaN is always false. Silently uncapped is the one failure
 * this guard exists to prevent.
 */
function decodeImageResponse(body, maxBytes) {
	if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes <= 0) {
		throw new TypeError('maxBytes must be a positive number');
	}
	// Success === false is checked BEFORE the Response shape, because an error body
	// can carry Response as an EMPTY STRING rather than omitting it. Checking the
	// shape first passes that case through to the JPEG-magic branch, which reports
	// "image is not a JPEG" and discards the Error text that says what actually
	// went wrong. Checking Success first covers both shapes — Response absent, and
	// Response present but empty.
	if (body && body.Success === false) {
		throw new Error(`NINA image error: ${body.Error || 'unknown'}`);
	}
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
		// Standalone markers (SOI, RST0-7, TEM) carry no length word, so skip both
		// bytes. A 0xFF here is a FILL byte, not a marker: JPEG allows any number of
		// 0xFF padding bytes before a marker, and the byte after it may itself be the
		// real marker prefix. Advance by ONE so the next iteration re-reads it as the
		// prefix — advancing by two would consume the genuine 0xFF and hide the SOF.
		if (marker === 0xff) { i += 1; continue; }
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
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

	/**
	 * getJson — one GET with timeout; returns the parsed body or throws.
	 * Receives the path+query to append to `base`. Three failure shapes, each
	 * naming the endpoint: a transport failure, a non-2xx status, and a body that
	 * is not JSON. The bare errors are useless in the agent's log because none of
	 * them mentions the request — measured on Node 22 (2026-09-01), a fired
	 * AbortSignal.timeout rejects with "TimeoutError: The operation was aborted due
	 * to timeout" and a refused connection with "TypeError: fetch failed", neither
	 * of which says WHICH of the three NINA calls broke. So the path is prefixed
	 * onto the transport and parse cases; the status branch already carries it.
	 */
	async function getJson(pathAndQuery) {
		let resp;
		try {
			resp = await fetchImpl(`${base}${pathAndQuery}`, { signal: AbortSignal.timeout(timeoutMs) });
		} catch (err) {
			// Undici hides the actual syscall failure one level down: a refused
			// connection surfaces as "TypeError: fetch failed" with the useful part
			// ("connect ECONNREFUSED 127.0.0.1:1888" — NINA is not running) only on
			// err.cause. Append it when present, so the log says why rather than that.
			const because = err.cause && err.cause.message ? `: ${err.cause.message}` : '';
			throw new Error(`NINA ${pathAndQuery}: ${err.name}: ${err.message}${because}`);
		}
		if (!resp.ok) throw new Error(`NINA ${pathAndQuery} → HTTP ${resp.status}`);
		try {
			return await resp.json();
		} catch (err) {
			throw new Error(`NINA ${pathAndQuery}: ${err.name}: ${err.message}`);
		}
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
	 * Keep scale modest. Extrapolating that same linear relation, the frame is
	 * ~6250 px wide at scale 1.0; the scale-1.0 request did not return inside the
	 * 10 s default timeout, and extrapolating from 675 KB at 0.4 puts a full-scale
	 * JPEG over the 3 MB maxImageBytes cap. Both limits are deliberate — they fail
	 * loudly rather than shipping a multi-megabyte frame to R2 on every sub.
	 *
	 * Fetching BY INDEX (not prepared-image) avoids the prepared-image race as
	 * long as NINA's history is append-only within a process (observed, not
	 * documented); a snapshot or flat landing between the history read and this
	 * call therefore cannot swap the frame. If NINA ever rotated or capped that
	 * list, indices would shift and this would publish the wrong frame silently.
	 *
	 * Throws TypeError on an out-of-contract argument rather than interpolating it
	 * into the URL. Whatever NINA then does with `scale=NaN` — refuse it, or return
	 * an unexpected image — the failure would be reported against the endpoint, so
	 * the caller's bug would be diagnosed as a rig problem. Rejecting here keeps
	 * the blame where it belongs, and no request is issued at all.
	 */
	async function imageByIndex(index, scale, quality) {
		if (!Number.isInteger(index) || index < 0) throw new TypeError('index must be a non-negative integer');
		if (typeof scale !== 'number' || !(scale > 0) || scale > 1) throw new TypeError('scale must be in (0, 1]');
		if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new TypeError('quality must be an integer 1-100');
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
