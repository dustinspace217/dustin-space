/**
 * status.js — build and validate the public status document (spec §7).
 *
 * PURE: no I/O. `buildStatus` maps NINA fields to the public schema;
 * `validateStatus` is the last gate before publish and exists mainly to enforce
 * the PRIVACY INVARIANT: the document must never carry the observing site's
 * coordinates. The history rows we consume today carry none (verified against
 * tests/now-imaging/fixtures/history-2026-09-01.json — no lat/long/site field
 * in the schema), so the risk is not today's mapping but tomorrow's: a "just
 * add the mount info" edit pulling from another endpoint could leak ground
 * coordinates by accident. This check makes that a hard failure at the publish
 * gate rather than a silent publish.
 */
'use strict';

// Any key matching this, at any depth, fails validation. Deliberately broad
// (matches "longitude", "sitelat", "elevation", "observer…"): a false positive
// costs a rename; a false negative costs the content policy.
const FORBIDDEN_KEY = /lat|lon|long|site|elev|observer/i;

// Maximum nesting we will walk. The schema is 2 deep; 8 is a generous bound so
// a pathological object can't recurse forever (Power of Ten rule 1).
const MAX_DEPTH = 8;

/**
 * buildStatus — assemble the status document.
 * Receives: entry (NINA history row), subsTonight (int), nextFrameExpectedAt
 * (ISO string or null), resolved ({name, designation|null}), frameUrl (https
 * URL of the uploaded JPEG), width/height (px of that JPEG).
 * Returns a plain object ready for JSON.stringify. Odd FIELD VALUES are
 * absorbed rather than rejected here (empty strings, null numerics) —
 * validateStatus is where rejection happens. The one exception is entry.Date:
 * an unparseable or missing one throws RangeError off toISOString(). That is
 * the caller's contract to keep, and selectLatestLight already keeps it —
 * it skips any row whose Date does not parse, so a row reaching this function
 * through the normal path always has one.
 */
function buildStatus({ entry, subsTonight, nextFrameExpectedAt, resolved, frameUrl, width, height }) {
	const status = {
		schemaVersion: 1,
		// The frame's own timestamp, not publish time: liveness on the page is
		// "how old is the newest frame", and publish lag would lie about that.
		updatedAt: new Date(Date.parse(entry.Date)).toISOString(),
	};
	if (nextFrameExpectedAt) status.nextFrameExpectedAt = nextFrameExpectedAt;
	status.target = {
		raw: String(entry.TargetName || ''),
		name: String(resolved && resolved.name || entry.TargetName || ''),
		designation: resolved && resolved.designation ? String(resolved.designation) : null,
	};
	status.frame = {
		url: frameUrl,
		width, height,
		filter: String(entry.Filter || ''),
		exposureSeconds: Number(entry.ExposureTime),
		subsTonight: Number(subsTonight) || 0,
		// Published but not rendered (Dustin chose the lighter caption); keeps a
		// denser caption a page-only change later.
		hfr: Number.isFinite(Number(entry.HFR)) ? Number(entry.HFR) : null,
		stars: Number.isFinite(Number(entry.Stars)) && Number(entry.Stars) >= 0 ? Number(entry.Stars) : null,
	};
	status.equipment = {
		camera: String(entry.CameraName || ''),
		telescope: String(entry.TelescopeName || ''),
		focalLengthMm: Number.isFinite(Number(entry.FocalLength)) ? Number(entry.FocalLength) : null,
	};
	return status;
}

/**
 * findForbiddenKey — depth-first walk for a key matching FORBIDDEN_KEY.
 * Receives any value and the current depth; returns the offending key path or null.
 */
function findForbiddenKey(value, depth, prefix) {
	if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return null;
	for (const key of Object.keys(value)) {               // bounded: object keys
		const here = prefix ? `${prefix}.${key}` : key;
		if (FORBIDDEN_KEY.test(key)) return here;
		const inner = findForbiddenKey(value[key], depth + 1, here);
		if (inner) return inner;
	}
	return null;
}

/**
 * validateStatus — the publish gate.
 * Receives a status object; returns {ok:true} or {ok:false, reason}.
 * Checks: schemaVersion 1, a Date.parse-able updatedAt (not a strict ISO test),
 * https frame url, numeric exposure, a non-empty target name, and the privacy
 * invariant.
 */
function validateStatus(s) {
	if (!s || typeof s !== 'object') return { ok: false, reason: 'not an object' };
	if (s.schemaVersion !== 1) return { ok: false, reason: 'schemaVersion must be 1' };
	if (!Number.isFinite(Date.parse(s.updatedAt))) return { ok: false, reason: 'updatedAt not parseable' };
	if (!s.target || !s.target.name) return { ok: false, reason: 'target.name missing' };
	if (!s.frame || typeof s.frame.url !== 'string' || !/^https:\/\//.test(s.frame.url)) {
		return { ok: false, reason: 'frame.url missing or not https' };
	}
	if (!Number.isFinite(s.frame.exposureSeconds)) return { ok: false, reason: 'frame.exposureSeconds not numeric' };
	const bad = findForbiddenKey(s, 0, '');
	if (bad) return { ok: false, reason: `forbidden key "${bad}" (privacy invariant, spec §7)` };
	return { ok: true };
}

module.exports = { buildStatus, validateStatus, FORBIDDEN_KEY };
