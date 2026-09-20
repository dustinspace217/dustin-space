/**
 * now-imaging-logic.js — PURE logic for the homepage "Currently imaging" card.
 *
 * No DOM, no fetch, no timers: only functions of (status, now). That is what
 * lets tests/now-imaging/logic.test.js pin the liveness window and the fetch
 * schedule under `node --test`, while the browser loads this file as a classic
 * script and reads window.NowImagingLogic (same dual-environment pattern as
 * gallery-filter-logic.js).
 *
 * `status` throughout is the status.json document published by the now-imaging
 * agent (schema in the design spec §7); the shape these functions actually read
 * is `{updatedAt, nextFrameExpectedAt?, frame:{filter, exposureSeconds,
 * subsTonight}}`.
 */
(function (root, factory) {
	// UMD-lite: CommonJS under Node (tests), a global in the browser.
	if (typeof module === 'object' && module.exports) module.exports = factory();
	else root.NowImagingLogic = factory();
}(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	var MIN_LIVE_MS   = 20 * 60000;   // spec §6.2: never shorter than 20 minutes
	var LIVE_EXPOSURES = 3;           // …or three exposures, whichever is longer
	var FRAME_SLACK_MS = 20000;       // after nextFrameExpectedAt (download + publish)
	var POST_EXPOSURE_MS = 30000;     // fallback estimate slack

	// The only image URL the card will ever load: the versioned frame key the
	// agent's keyForFrame produces, on the live bucket's public host. One
	// anchored pattern rather than a URL parser or a startsWith: a prefix check
	// would still admit /now/status.json and /now/../x, and a parser adds
	// normalisation rules nobody needs here. Whoever can write status.json can
	// also replace the JPEG at a legitimate key, so this does not stop a holder of
	// the rig's key from choosing the picture; what it does stop is a corrupted
	// or hostile DOCUMENT pointing the homepage's image at data:, blob:, a
	// same-origin path, or one of the third-party hosts the page's img-src allows.
	var FRAME_URL = /^https:\/\/live\.dustin\.space\/now\/sub-\d{8}T\d{6}Z\.jpg$/;
	// updatedAt may run this far ahead of the visitor's clock and still count.
	// Beyond it the document is refused: a far-future stamp would otherwise read
	// as "live" forever (its age is negative, always inside the live window).
	// The cost, accepted: a VISITOR whose own clock runs more than five minutes
	// slow sees a fresh document as "from the future" and gets no card. That is
	// the fail-closed side of the trade: no card, never a wrong one.
	var MAX_FUTURE_MS = 5 * 60 * 1000;
	// Longest text the card will paint. Catalogue names are short (the longest
	// in the agent's overrides file is 16 characters); the body cap alone would
	// allow about 16,000.
	var MAX_NAME_CHARS = 120;
	var MAX_DESIGNATION_CHARS = 60;
	// Widest and tallest frame shape the card will reserve a box for. The rig's
	// sensor is 3:2; a mosaic or a crop could differ, a 1000:1 sliver could not.
	var MAX_ASPECT = 4;

	/**
	 * isRenderable — is this status document one the card may paint?
	 * Receives the parsed status.json (any value at all) and now (ms epoch).
	 * Returns boolean. Pure, so node:test can exercise every rejection; it lived
	 * inside the DOM script before, where no test could reach it.
	 * Accepts only: schemaVersion 1; target.name a non-empty STRING (an object
	 * here would paint "[object Object]") of at most MAX_NAME_CHARS;
	 * target.designation absent, null or a string of at most
	 * MAX_DESIGNATION_CHARS; frame.url matching FRAME_URL; updatedAt parseable
	 * and not more than MAX_FUTURE_MS ahead of now.
	 */
	function isRenderable(status, nowMs) {
		if (!status || typeof status !== 'object' || status.schemaVersion !== 1) return false;
		var target = status.target, frame = status.frame;
		if (!target || typeof target.name !== 'string' || target.name === '' || target.name.length > MAX_NAME_CHARS) return false;
		if (target.designation !== undefined && target.designation !== null) {
			if (typeof target.designation !== 'string' || target.designation.length > MAX_DESIGNATION_CHARS) return false;
		}
		if (!frame || typeof frame.url !== 'string' || !FRAME_URL.test(frame.url)) return false;
		var t = Date.parse(status.updatedAt);
		if (!isFinite(t) || t - nowMs > MAX_FUTURE_MS) return false;
		return true;
	}

	/**
	 * aspectRatioText — the CSS aspect-ratio value for a frame, or ''.
	 * Receives status.frame (any value). Returns 'W / H' only when both are finite
	 * positive numbers and the shape is within MAX_ASPECT either way; '' tells the
	 * caller to leave the stylesheet's default box alone. The numbers come from a
	 * document this page does not control, and they go into a style property.
	 */
	function aspectRatioText(frame) {
		var w = frame && frame.width, h = frame && frame.height;
		if (typeof w !== 'number' || typeof h !== 'number' || !isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return '';
		if (w / h > MAX_ASPECT || h / w > MAX_ASPECT) return '';
		return w + ' / ' + h;
	}

	/**
	 * readCapped — a fetch Response's body as text, refusing more than maxBytes.
	 * Receives the Response and a byte limit; returns a Promise of the text, or
	 * rejects with 'status too large'. Lives here, not in the DOM script, because
	 * it touches no DOM and node:test has Response and ReadableStream too.
	 * Reads the body stream chunk by chunk and cancels it the moment the running
	 * total passes the limit. Content-Length is not trusted for this: it is
	 * absent on chunked responses and counts compressed bytes when it is present.
	 * Where r.body is missing (no streaming support) the whole text is read and
	 * its length checked afterwards, which still refuses to PARSE an oversized
	 * document but not to buffer it.
	 * Loop bound: the byte cap ends a body that keeps delivering data; a body
	 * that stalls, or trickles empty chunks, is ended by the caller's fetch
	 * timeout, whose abort signal also rejects a pending read(). Each pass goes
	 * through the promise chain, not the call stack.
	 */
	function readCapped(r, maxBytes) {
		if (!r.body || !r.body.getReader || typeof TextDecoder === 'undefined') {
			return r.text().then(function (t) {
				if (t.length > maxBytes) throw new Error('status too large');
				return t;
			});
		}
		var reader = r.body.getReader();
		var decoder = new TextDecoder();
		var total = 0;
		var text = '';
		function pump() {
			return reader.read().then(function (step) {
				if (step.done) return text + decoder.decode();
				total += step.value.byteLength;
				if (total > maxBytes) {
					// cancel() returns a promise that rejects if the stream has already
					// errored. Its outcome is irrelevant (the document is refused either
					// way), so the rejection is swallowed here on purpose rather than
					// left to surface as an unhandled one.
					reader.cancel().catch(function () {});
					throw new Error('status too large');
				}
				// stream:true keeps a multi-byte character that straddles two chunks
				// intact; the final decode() above flushes whatever is held back.
				text += decoder.decode(step.value, { stream: true });
				return pump();
			});
		}
		return pump();
	}

	/** exposureMs — the frame's exposure in ms, or 0 when missing/invalid. */
	function exposureMs(status) {
		var s = status && status.frame && Number(status.frame.exposureSeconds);
		return isFinite(s) && s > 0 ? s * 1000 : 0;
	}

	/**
	 * isLive — is the newest frame recent enough to say "Currently imaging"?
	 * Receives the status document and now (ms). Returns boolean; an
	 * unparseable updatedAt is never live.
	 * Why max(20 min, 3 exposures): a dither, autofocus run, or meridian flip
	 * can sit between two subs; 20 min covers those for short subs, and three
	 * exposures covers them for 20-minute narrowband subs (Dustin's amendment).
	 */
	function isLive(status, nowMs) {
		var t = Date.parse(status && status.updatedAt);
		if (!isFinite(t)) return false;
		// Named liveWindowMs, not `window`: this file ships to the browser, where
		// a local named `window` would shadow the global for the whole function.
		var liveWindowMs = Math.max(MIN_LIVE_MS, LIVE_EXPOSURES * exposureMs(status));
		return nowMs - t < liveWindowMs;
	}

	/**
	 * nextFetchDelayMs — when to fetch status.json again.
	 * Receives status, now (ms), and {minMs, idleMs}. Returns ms from now.
	 * 1. nextFrameExpectedAt in the future → that moment + slack (agent knows
	 *    the camera's actual end time);
	 * 2. else live → updatedAt + exposure + slack (estimate from the last frame);
	 * 3. else idle → idleMs.
	 * Both scheduled branches (1 and 2) are floored at minMs so a clock skew
	 * can't turn into a tight loop; the idle branch needs no floor because
	 * idleMs is already the long wait (5 min by default).
	 */
	function nextFetchDelayMs(status, nowMs, opts) {
		// `||` on purpose, not `!== undefined`: an explicit 0 falls back to the
		// default. A 0 ms floor or a 0 ms idle wait would poll status.json as
		// fast as the network allows, so zero is never an interval we want a
		// caller to be able to request, deliberately or by an arithmetic slip.
		var minMs  = (opts && opts.minMs)  || 60000;
		var idleMs = (opts && opts.idleMs) || 300000;
		var next = Date.parse(status && status.nextFrameExpectedAt);
		if (isFinite(next) && next > nowMs) return Math.max(minMs, next + FRAME_SLACK_MS - nowMs);
		if (isLive(status, nowMs)) {
			var t = Date.parse(status.updatedAt);
			return Math.max(minMs, t + exposureMs(status) + POST_EXPOSURE_MS - nowMs);
		}
		return idleMs;
	}

	/** ordinal — 1 → "1st", 23 → "23rd", 112 → "112th". */
	function ordinal(n) {
		var v = n % 100;
		if (v >= 11 && v <= 13) return n + 'th';
		var d = n % 10;
		return n + (d === 1 ? 'st' : d === 2 ? 'nd' : d === 3 ? 'rd' : 'th');
	}

	/**
	 * filterLabel — NINA filter names as astronomers write them.
	 * "Ha"/"H-alpha"/"HA" → "Hα"; "L"/"Lum"/"Luminance" → "Luminance"; everything
	 * else verbatim (OIII, SII, R, G, B keep their conventional forms).
	 * Matching is case-insensitive, which is what the /i on both regexes buys.
	 */
	function filterLabel(raw) {
		var s = String(raw || '').trim();
		if (/^h-?a(lpha)?$/i.test(s)) return 'Hα';
		if (/^l(um(inance)?)?$/i.test(s)) return 'Luminance';
		return s;
	}

	/**
	 * caption — "Hα · 300 s · 23rd sub tonight". Exposure printed without trailing zeros,
	 * and only when it is above zero: the frame tag in now-imaging.js applies the
	 * same rule, and "0 s" on one line beside no exposure on the other read as a bug.
	 * A missing status or frame yields '' (every part is empty), matching the
	 * `status &&` guard the other exports use — the renderer should be able to
	 * ask for a caption before it has validated the document without throwing.
	 */
	function caption(status) {
		var f = (status && status.frame) || {};
		var exp = Number(f.exposureSeconds);
		var expText = isFinite(exp) && exp > 0 ? String(+exp.toFixed(2)) + ' s' : '';
		var n = Number(f.subsTonight) || 0;
		var parts = [filterLabel(f.filter), expText, n > 0 ? ordinal(n) + ' sub tonight' : ''];
		return parts.filter(Boolean).join(' · ');
	}

	/**
	 * relativeAge — "6 hours ago" style text for the idle label.
	 * Receives an ISO time, now (ms), and an Intl.RelativeTimeFormat instance
	 * (passed in so the caller decides the locale). Picks the largest unit whose
	 * magnitude is ≥ 1 (minutes → hours → days). An unparseable time returns ''.
	 */
	function relativeAge(updatedAtIso, nowMs, rtf) {
		var t = Date.parse(updatedAtIso);
		// Return '' rather than letting NaN reach rtf.format, which throws a
		// RangeError. This is a reachable path, not defensive padding: isLive()
		// already treats an unparseable updatedAt as idle, and per spec §6.2 the
		// idle branch is exactly what renders this label — so a malformed
		// document would land here on every refresh, abort the render, and take
		// the refresh timer with it. Spec §6.2 again: a bad document leaves the
		// section hidden, and is never surfaced as an error.
		if (!isFinite(t)) return '';
		var diffMin = Math.round((t - nowMs) / 60000);   // negative = past
		var abs = Math.abs(diffMin);
		if (abs < 60) return rtf.format(diffMin, 'minute');
		if (abs < 60 * 24) return rtf.format(Math.round(diffMin / 60), 'hour');
		return rtf.format(Math.round(diffMin / (60 * 24)), 'day');
	}

	return { isLive: isLive, nextFetchDelayMs: nextFetchDelayMs, caption: caption, relativeAge: relativeAge, ordinal: ordinal, filterLabel: filterLabel, isRenderable: isRenderable, aspectRatioText: aspectRatioText, readCapped: readCapped };
}));
