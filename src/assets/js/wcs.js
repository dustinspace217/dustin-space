/**
 * wcs.js — pure WCS projection + sexagesimal formatting math.
 *
 * Extracted from detail.js (council 2026-07-13, W7) so the coordinate math
 * can be unit-tested in isolation with node:test — none of it touches the
 * DOM or OpenSeadragon, so it is fully deterministic given a `wcs` object
 * and plain numbers. detail.js keeps ALL the DOM/OSD glue and calls into
 * this module through the global `DSWcs`.
 *
 * UMD wrapper: when a CommonJS `module` exists (Node, the test runner) the
 * functions are exported via `module.exports`; in the browser (a plain
 * <script>, loaded before detail.js) they attach to `window.DSWcs`. This
 * avoids a bundler while letting the same source serve both environments —
 * the site has no build step for JS, so a classic script + global is the
 * lowest-friction way to share code between the page and the tests.
 *
 * A `wcs` object (from images.json, camelCased by the ingest tool) carries:
 *   raDeg, decDeg   — sky coords of the reference pixel (degrees)
 *   crpix1, crpix2  — reference pixel (FITS 1-indexed)
 *   cd11..cd22      — the 2x2 CD matrix (degrees per pixel)
 *   imgW, imgH      — dimensions of the image the solve was done on
 * precomputeWcs() lazily caches derived invariants on the object as
 * non-enumerable fields so JSON.stringify never sees the `_*` cruft.
 */
(function (root, factory) {
	'use strict';
	// CommonJS (Node / node --test) takes the module.exports branch; a browser
	// classic script has no `module`, so it falls through to the global.
	if (typeof module === 'object' && module.exports) {
		module.exports = factory();
	} else {
		root.DSWcs = factory();
	}
}(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	/**
	 * precomputeWcs — lazily attach cached projection invariants to a wcs.
	 *
	 * For a given variant, `cos(decDeg)` and the inverse of the CD matrix are
	 * constants, but skyToPixelFrac would otherwise recompute them on every
	 * call (~360 times per grid frame at 60fps during a pan). Cache them once,
	 * keyed by the wcs object itself.
	 *
	 * Uses `Object.defineProperty` with `enumerable: false` so the cached `_*`
	 * fields don't leak into `JSON.stringify(wcs)` if a future logging or
	 * persistence path serializes it (issue #82).
	 *
	 * Degenerate-CD-matrix handling: instead of letting `_invDet` become
	 * Infinity and silently poison every projection, set `_degenerate = true`.
	 * skyToPixelFrac checks that flag first and short-circuits to null.
	 *
	 * Idempotent — bails immediately on a wcs already cached.
	 */
	function precomputeWcs(wcs) {
		if (!wcs || wcs._cached) return;
		var det = wcs.cd11 * wcs.cd22 - wcs.cd12 * wcs.cd21;
		var degenerate = !(Math.abs(det) >= 1e-20);
		Object.defineProperty(wcs, '_cached',     { value: true,       enumerable: false });
		Object.defineProperty(wcs, '_degenerate', { value: degenerate, enumerable: false });
		if (degenerate) return;
		Object.defineProperty(wcs, '_cosDec', { value: Math.cos(wcs.decDeg * Math.PI / 180), enumerable: false });
		// Pre-divided CD-inverse entries so skyToPixelFrac drops to a
		// pair of multiplies + adds per coordinate.
		Object.defineProperty(wcs, '_inv00', { value:  wcs.cd22 / det, enumerable: false });
		Object.defineProperty(wcs, '_inv01', { value: -wcs.cd12 / det, enumerable: false });
		Object.defineProperty(wcs, '_inv10', { value: -wcs.cd21 / det, enumerable: false });
		Object.defineProperty(wcs, '_inv11', { value:  wcs.cd11 / det, enumerable: false });
	}

	/**
	 * skyToPixelFrac — sky (RA, Dec in degrees) → image fraction (0..1).
	 *
	 * Inverts the 2x2 CD matrix to convert sky offsets into pixel offsets from
	 * the reference pixel (crpix1, crpix2, FITS 1-indexed). The cos(dec) factor
	 * on dRA accounts for RA-line foreshortening toward the poles. Returns null
	 * if the matrix is degenerate (det ~ 0).
	 *
	 * @param {number} raDeg
	 * @param {number} decDeg
	 * @param {Object} wcs
	 * @returns {{x:number, y:number} | null}
	 */
	function skyToPixelFrac(raDeg, decDeg, wcs) {
		precomputeWcs(wcs);
		if (wcs._degenerate) return null;

		var dRA = raDeg - wcs.raDeg;
		// Wrap to [-180, 180] so RA crossings near 0/360 don't blow up
		if (dRA > 180)  dRA -= 360;
		if (dRA < -180) dRA += 360;
		dRA *= wcs._cosDec;
		var dDec = decDeg - wcs.decDeg;

		// Use precomputed inverse-CD entries (issue #82).
		var dx = wcs._inv00 * dRA + wcs._inv01 * dDec;
		var dy = wcs._inv10 * dRA + wcs._inv11 * dDec;

		// FITS reference pixels are 1-indexed; subtract 1 for 0-based array math
		var xPx = (wcs.crpix1 - 1) + dx;
		var yPx = (wcs.crpix2 - 1) + dy;
		return { x: xPx / wcs.imgW, y: yPx / wcs.imgH };
	}

	/**
	 * pixelFracToSky — image fraction (0..1) → sky (RA, Dec in degrees).
	 *
	 * Forward CD matrix application. Inverse of skyToPixelFrac.
	 *
	 * @param {number} fx — fractional x position (0=left, 1=right)
	 * @param {number} fy — fractional y position (0=top, 1=bottom)
	 * @param {Object} wcs
	 * @returns {{ra:number, dec:number}}
	 */
	function pixelFracToSky(fx, fy, wcs) {
		precomputeWcs(wcs);
		var dx = fx * wcs.imgW - (wcs.crpix1 - 1);
		var dy = fy * wcs.imgH - (wcs.crpix2 - 1);
		var dRA  = wcs.cd11 * dx + wcs.cd12 * dy;
		var dDec = wcs.cd21 * dx + wcs.cd22 * dy;
		// Reuse precomputed cos(decDeg) when available; fall back to a fresh
		// compute when the WCS is degenerate (no harm; the caller discards the
		// result via its NaN check anyway).
		var cosDec = wcs._cosDec != null ? wcs._cosDec : Math.cos(wcs.decDeg * Math.PI / 180);
		return {
			ra:  wcs.raDeg + dRA / cosDec,
			dec: wcs.decDeg + dDec,
		};
	}

	/**
	 * pickGridSpacing — choose a "nice" round grid spacing in degrees so that
	 * ~10 lines are visible across the given range. Steps are 0.5', 1', 2', 5',
	 * 10', 15', 20', 30', 1°, 1.5°, 2°, 3°, 5°, 10° — the intervals AstroBin and
	 * Stellarium use, so the result feels familiar.
	 *
	 * @param {number} rangeDeg — visible range in degrees (RA or Dec)
	 * @returns {number} spacing in degrees
	 */
	function pickGridSpacing(rangeDeg) {
		var rangeMin = rangeDeg * 60;
		var ideal = rangeMin / 10;
		var nice = [0.5, 1, 2, 5, 10, 15, 20, 30, 60, 90, 120, 180, 300, 600];
		for (var i = 0; i < nice.length; i++) {
			if (nice[i] >= ideal) return nice[i] / 60;
		}
		return nice[nice.length - 1] / 60;
	}

	// ── Sexagesimal formatters ───────────────────────────────────────────────
	// All four carry the same 60.0-rollover fix (W7): toFixed() can round a
	// value like 59.97 up to the string "60.0"/"60", which without a carry
	// renders nonsense such as "5h 59m 60.0s". We format the smallest unit
	// first, and when its rendered string lands on the 60 boundary we zero it
	// and carry into the next unit up (seconds→minutes→hours/degrees). We test
	// the *string* toFixed produces rather than a numeric threshold because
	// float representation makes a numeric cutoff (e.g. `s >= 59.95`) unreliable
	// — the string is exactly what would have been shown.

	/**
	 * formatRA — full-precision RA readout: "RA 5h 30m 12.3s".
	 * @param {number} raDeg — Right Ascension in decimal degrees
	 * @returns {string}
	 */
	function formatRA(raDeg) {
		var ra = ((raDeg % 360) + 360) % 360; // wrap into 0–360 (handles negatives)
		var totalHours = ra / 15;
		var h = Math.floor(totalHours);
		var m = Math.floor((totalHours - h) * 60);
		var s = ((totalHours - h) * 60 - m) * 60;
		var sStr = s.toFixed(1);
		if (sStr === '60.0') { sStr = '0.0'; m += 1; }
		if (m === 60) { m = 0; h += 1; }
		if (h === 24) { h = 0; } // RA wraps at 24h back to 0h
		var sPad = (parseFloat(sStr) < 10 ? '0' : '') + sStr;
		return 'RA ' + h + 'h ' + (m < 10 ? '0' : '') + m + 'm ' + sPad + 's';
	}

	/**
	 * formatDec — full-precision Dec readout: "Dec +41° 16′ 09″".
	 * Uses the proper Unicode minus (U+2212) and prime/double-prime marks.
	 * @param {number} decDeg — Declination in decimal degrees
	 * @returns {string}
	 */
	function formatDec(decDeg) {
		var sign = decDeg < 0 ? '−' : '+';
		var abs = Math.abs(decDeg);
		var d = Math.floor(abs);
		var m = Math.floor((abs - d) * 60);
		var s = ((abs - d) * 60 - m) * 60;
		var sStr = s.toFixed(0);
		if (sStr === '60') { sStr = '0'; m += 1; }
		if (m === 60) { m = 0; d += 1; } // Dec does not wrap (bounded ±90)
		var sPad = (parseFloat(sStr) < 10 ? '0' : '') + sStr;
		return 'Dec ' + sign + d + '° ' + (m < 10 ? '0' : '') + m + '′ ' + sPad + '″';
	}

	/**
	 * formatRaShort — compact axis label for grid lines: "5h30.0m".
	 * Drops seconds so the string doesn't crowd the canvas.
	 * @param {number} raDeg
	 * @returns {string}
	 */
	function formatRaShort(raDeg) {
		var ra = ((raDeg % 360) + 360) % 360;
		var totalH = ra / 15;
		var h = Math.floor(totalH);
		var m = (totalH - h) * 60;
		var mStr = m.toFixed(1);
		if (mStr === '60.0') { mStr = '0.0'; h += 1; }
		if (h === 24) { h = 0; }
		var mPad = (parseFloat(mStr) < 10 ? '0' : '') + mStr;
		return h + 'h' + mPad + 'm';
	}

	/**
	 * formatDecShort — compact axis label for grid lines: "+41°16.3′".
	 * @param {number} decDeg
	 * @returns {string}
	 */
	function formatDecShort(decDeg) {
		var sign = decDeg < 0 ? '−' : '+';
		var abs = Math.abs(decDeg);
		var d = Math.floor(abs);
		var m = (abs - d) * 60;
		var mStr = m.toFixed(1);
		if (mStr === '60.0') { mStr = '0.0'; d += 1; }
		var mPad = (parseFloat(mStr) < 10 ? '0' : '') + mStr;
		return sign + d + '°' + mPad + '′';
	}

	return {
		precomputeWcs:  precomputeWcs,
		skyToPixelFrac: skyToPixelFrac,
		pixelFracToSky: pixelFracToSky,
		pickGridSpacing: pickGridSpacing,
		formatRA:       formatRA,
		formatDec:      formatDec,
		formatRaShort:  formatRaShort,
		formatDecShort: formatDecShort,
	};
}));
