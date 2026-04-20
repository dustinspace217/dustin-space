/**
 * coordinates.js — RA/Dec formatting for the ingest pipeline
 *
 * Converts decimal degree values (from ASTAP plate solutions) into
 * human-readable sexagesimal strings stored in images.json.
 *
 * Exports:
 *   raToStr(raDeg)   — convert RA degrees → "XXh XXm XXs"
 *   decToStr(decDeg) — convert Dec degrees → "+XX° XX' XX\""
 */

'use strict';

/**
 * raToStr — convert right ascension from decimal degrees to sexagesimal string.
 *
 * @param {number} raDeg — right ascension in decimal degrees (0–360),
 *                          from the ASTAP WCS solution
 * @returns {string} zero-padded string like "05h 40m 59s"
 *
 * Note: Math.round can produce 60 seconds, which is invalid in sexagesimal.
 * The carry logic below handles this edge case.
 */
function raToStr(raDeg) {
	let h  = Math.floor(raDeg / 15);
	let mf = (raDeg / 15 - h) * 60;
	let m  = Math.floor(mf);
	let s  = Math.round((mf - m) * 60);
	// Carry: if rounding pushed seconds to 60, bump minutes (and hours if needed).
	if (s === 60) { s = 0; m += 1; }
	if (m === 60) { m = 0; h += 1; }
	return `${String(h).padStart(2,'0')}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;
}

/**
 * decToStr — convert declination from decimal degrees to sexagesimal string.
 *
 * @param {number} decDeg — declination in decimal degrees (-90 to +90),
 *                           from the ASTAP WCS solution
 * @returns {string} zero-padded string like "+31° 07' 05\"" or "-02° 27' 30\""
 *
 * Same carry logic as raToStr for the 60-second edge case.
 */
function decToStr(decDeg) {
	const sign = decDeg >= 0 ? '+' : '-';
	const abs  = Math.abs(decDeg);
	let d    = Math.floor(abs);
	let mf   = (abs - d) * 60;
	let m    = Math.floor(mf);
	let s    = Math.round((mf - m) * 60);
	if (s === 60) { s = 0; m += 1; }
	if (m === 60) { m = 0; d += 1; }
	return `${sign}${String(d).padStart(2,'0')}° ${String(m).padStart(2,'0')}' ${String(s).padStart(2,'0')}"`;
}

module.exports = { raToStr, decToStr };
