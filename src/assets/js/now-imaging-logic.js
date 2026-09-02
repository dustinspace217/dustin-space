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
	 * caption — "Hα · 300 s · 23rd sub tonight". Exposure printed without trailing zeros.
	 * A missing status or frame yields '' (every part is empty), matching the
	 * `status &&` guard the other exports use — the renderer should be able to
	 * ask for a caption before it has validated the document without throwing.
	 */
	function caption(status) {
		var f = (status && status.frame) || {};
		var exp = Number(f.exposureSeconds);
		var expText = isFinite(exp) ? String(+exp.toFixed(2)) + ' s' : '';
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

	return { isLive: isLive, nextFetchDelayMs: nextFetchDelayMs, caption: caption, relativeAge: relativeAge, ordinal: ordinal, filterLabel: filterLabel };
}));
