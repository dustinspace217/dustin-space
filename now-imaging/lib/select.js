/**
 * select.js — PURE selection math over NINA's image-history array.
 *
 * Everything here is a plain function of its inputs (no I/O, no clock reads
 * except where `nowMs` is passed in) so it can be pinned with fixtures.
 *
 * NINA history rows (verified 2026-09-01) carry: ImageType, Filter, TargetName,
 * ExposureTime (s), Date (ISO string WITH the rig's UTC offset), Filename, etc.
 */
'use strict';

// Only LIGHT frames are ever published. Flats, darks, bias and snapshots are
// calibration/utility frames and must never appear on the homepage.
const LIGHT = 'light';

/**
 * selectLatestLight — find the newest LIGHT frame.
 * Receives the history array (as returned in NINA's `Response`).
 * Returns { entry, index } where `index` is the entry's POSITION in the array
 * (that index is what /v2/api/image/{index} takes), or null when no LIGHT exists.
 *
 * Why newest-by-Date rather than last-in-array: NINA appends in save order, but
 * we don't rely on that — the Date field is authoritative and the cost is one pass.
 */
function selectLatestLight(history) {
	if (!Array.isArray(history)) return null;
	let best = null;
	for (let i = 0; i < history.length; i++) {           // bounded: array length
		const e = history[i];
		if (!e || String(e.ImageType || '').toLowerCase() !== LIGHT) continue;
		const t = Date.parse(e.Date);
		if (!Number.isFinite(t)) continue;                 // unparseable date: skip, never throw
		if (best === null || t > best.t) best = { entry: e, index: i, t };
	}
	return best ? { entry: best.entry, index: best.index } : null;
}

/**
 * localNoonBefore — the most recent local noon at or before the given time.
 * Receives an ISO string carrying a UTC offset (e.g. "…-07:00"); returns a Date.
 *
 * Why parse the offset out of the string instead of using the host's zone:
 * this code runs on the MeLe (Arizona, no DST) during dev-from-Fedora (Seattle,
 * DST) too. The rig's own offset is embedded in every NINA Date, so "tonight"
 * is defined in the rig's clock regardless of where the agent runs.
 */
function localNoonBefore(isoWithOffset) {
	const m = /([+-])(\d{2}):(\d{2})$/.exec(isoWithOffset) || ['', '+', '00', '00'];
	const offsetMin = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
	const utcMs = Date.parse(isoWithOffset);
	// Shift into "local wall clock as if it were UTC", floor to the day, add 12h.
	const localMs = utcMs + offsetMin * 60000;
	const local = new Date(localMs);
	let noonLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 12);
	if (noonLocal > localMs) noonLocal -= 86400000;      // before noon today → yesterday's noon
	return new Date(noonLocal - offsetMin * 60000);       // back to real UTC
}

/**
 * countSubsTonight — how many LIGHT frames of the same target AND filter were
 * saved since the last local noon before `entry`'s Date (inclusive of entry).
 * Receives the history array and the selected entry; returns an integer.
 *
 * Why target+filter: "23rd Hα sub tonight" is the number an astronomer means;
 * mixing filters would inflate it. Why local noon: a night straddles midnight.
 */
function countSubsTonight(history, entry) {
	if (!Array.isArray(history) || !entry) return 0;
	const since = localNoonBefore(entry.Date).getTime();
	const until = Date.parse(entry.Date);
	let n = 0;
	for (const e of history) {                             // bounded: array length
		if (!e || String(e.ImageType || '').toLowerCase() !== LIGHT) continue;
		if (e.TargetName !== entry.TargetName || e.Filter !== entry.Filter) continue;
		const t = Date.parse(e.Date);
		if (Number.isFinite(t) && t >= since && t <= until) n++;
	}
	return n;
}

/**
 * nextFrameExpectedAt — when the exposure in progress should be on disk.
 * Receives NINA's camera/info Response, the current time in ms, and a slack in
 * ms (download + save + NINA bookkeeping; 15 s default). Returns an ISO UTC
 * string, or null when the camera is not exposing or the end time is missing,
 * unparseable, or already in the past (a stale timestamp from a previous frame).
 *
 * Verified 2026-09-01: camera/info exposes IsExposing + ExposureEndTime but no
 * duration field, which is why we publish an absolute time, not a length.
 */
function nextFrameExpectedAt(cameraInfo, nowMs, slackMs = 15000) {
	if (!cameraInfo || cameraInfo.IsExposing !== true) return null;
	const end = Date.parse(cameraInfo.ExposureEndTime);
	if (!Number.isFinite(end) || end <= nowMs) return null;
	return new Date(end + slackMs).toISOString();
}

module.exports = { selectLatestLight, countSubsTonight, nextFrameExpectedAt, localNoonBefore };
