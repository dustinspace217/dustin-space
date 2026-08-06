/**
 * tests/wcs-cross-consistency.test.js — issue #135.2.
 *
 * The site has TWO independent implementations of the same tangent-plane
 * projection math: ingest/lib/platesolve.js (`skyToPixelFrac`, server-side,
 * used at ingest time to place annotation overlays) and src/assets/js/wcs.js
 * (`DSWcs.skyToPixelFrac`, browser-side, used live on detail pages). Each was
 * individually tested, but nothing asserted they AGREE — a fix applied to one
 * (a sign flip, a wrap change, an epsilon tweak) could silently diverge the
 * other, and annotations would land in different places at ingest vs render.
 *
 * This table drives both implementations over the same inputs and requires
 * agreement. Field-name mapping is part of the test's job: the browser WCS is
 * camelCase with imgW/imgH inside the object; the server WCS is snake_case
 * for the reference coords with dims as separate arguments.
 *
 * Coverage honesty (QA 2026-08-06, CR-2/TA-4): the well-conditioned fixtures
 * catch sign flips, wrap changes, and cosDec sourcing changes — but NOT a
 * drift in the degeneracy epsilon, which is a DUPLICATED constant (1e-20
 * hardcoded in wcs.js's precompute; DET_EPSILON in platesolve.js) with
 * nothing else coupling the two. The near-boundary tests at the bottom exist
 * for exactly that: dets just above and just below 1e-20, asserting the two
 * sides AGREE on null-vs-non-null (coordinate agreement is deliberately not
 * asserted near the boundary, where the two inverse formulations' rounding
 * differences explode past any absolute tolerance — except at the reference
 * point, where both sides compute a zero offset bit-exactly).
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const DSWcs  = require('../src/assets/js/wcs.js');
const server = require('../ingest/lib/platesolve.js');

// Both are pure double-precision evaluations of the same closed-form math, so
// agreement should be near machine epsilon; 1e-9 in fractional units leaves
// headroom for the different inverse-matrix formulations (server divides by
// det per call, browser precomputes the inverse entries once).
const TOL = 1e-9;

/**
 * One fixture per row: a WCS in BROWSER shape (the richer one — imgW/imgH
 * included) plus sky points to probe. toServerArgs() derives the server-side
 * calling convention from it so the two implementations always receive the
 * same numbers.
 */
const CASES = [
	{
		name: 'typical astro field (arcsec-scale CD, slight rotation)',
		wcs: {
			raDeg: 84.05, decDeg: -1.20,          // near Orion's belt
			crpix1: 1200.5, crpix2: 800.5,
			// ~1.6 arcsec/px with a few degrees of rotation — realistic for
			// the Eon 70 + QHY 268M plate solves the ingest tool handles.
			cd11: -4.4e-4, cd12:  1.2e-5,
			cd21:  1.1e-5, cd22:  4.4e-4,
			imgW: 2400, imgH: 1600,
		},
		points: [
			{ ra: 84.05,  dec: -1.20 },           // reference point exactly
			{ ra: 84.30,  dec: -1.05 },           // off-center
			{ ra: 83.80,  dec: -1.45 },           // opposite quadrant
		],
	},
	{
		name: 'RA wrap-around (field straddling 0h)',
		wcs: {
			raDeg: 0.3, decDeg: 41.2,             // Andromeda-ish, near RA 0
			crpix1: 512, crpix2: 512,
			cd11: -5.0e-4, cd12: 0,
			cd21: 0,       cd22: 5.0e-4,
			imgW: 1024, imgH: 1024,
		},
		// One point on each side of the 0/360 seam — the wrap branch must fire
		// identically in both implementations.
		points: [
			{ ra: 359.9, dec: 41.1 },
			{ ra: 0.7,   dec: 41.3 },
		],
	},
	{
		name: 'high declination (strong cos(dec) foreshortening)',
		wcs: {
			raDeg: 37.95, decDeg: 89.26,          // Polaris neighborhood
			crpix1: 300, crpix2: 200,
			cd11: -8.0e-4, cd12: 2.0e-5,
			cd21:  2.0e-5, cd22: 8.0e-4,
			imgW: 600, imgH: 400,
		},
		points: [
			{ ra: 40.0, dec: 89.20 },
			{ ra: 30.0, dec: 89.30 },
		],
	},
];

/** Server-side WCS shape + args derived from the browser-shape fixture. */
function toServerArgs(browserWcs, point) {
	const serverWcs = {
		ra_deg:  browserWcs.raDeg,
		dec_deg: browserWcs.decDeg,
		crpix1:  browserWcs.crpix1,
		crpix2:  browserWcs.crpix2,
		cd11: browserWcs.cd11, cd12: browserWcs.cd12,
		cd21: browserWcs.cd21, cd22: browserWcs.cd22,
	};
	return [point.ra, point.dec, serverWcs, browserWcs.imgW, browserWcs.imgH];
}

for (const c of CASES) {
	test(`wcs cross-consistency: ${c.name}`, () => {
		for (const p of c.points) {
			// Fresh object per point: DSWcs.precomputeWcs caches non-enumerable
			// fields on the wcs object, and this test must not let one point's
			// cache mask a hypothetical per-call bug for the next.
			const browser = DSWcs.skyToPixelFrac(p.ra, p.dec, { ...c.wcs });
			const srv     = server.skyToPixelFrac(...toServerArgs(c.wcs, p));

			assert.ok(browser !== null && srv !== null,
				`(${p.ra}, ${p.dec}): one side returned null on a well-conditioned WCS ` +
				`(browser=${browser}, server=${JSON.stringify(srv)})`);
			assert.ok(Math.abs(browser.x - srv.x) < TOL,
				`(${p.ra}, ${p.dec}): x diverged — browser ${browser.x} vs server ${srv.x}`);
			assert.ok(Math.abs(browser.y - srv.y) < TOL,
				`(${p.ra}, ${p.dec}): y diverged — browser ${browser.y} vs server ${srv.y}`);
		}
	});
}

/**
 * Near-boundary epsilon-coupling tests (CR-2/TA-4). Both implementations
 * declare a WCS degenerate when |det(CD)| < 1e-20 — but each carries its own
 * copy of that constant, so one side's epsilon can drift silently. Two dets
 * bracketing the boundary pin the coupling in BOTH drift directions: a
 * tightened epsilon on either side breaks the just-above case (that side
 * starts returning null); a loosened epsilon breaks the just-below case
 * (that side starts returning coordinates).
 *
 * Fixture-precondition self-checks (TA-4 cross-exam): the dets are engineered
 * as single products of exact powers of ten with zero off-diagonal terms —
 * det = cd11*cd22 exactly, no cancellation — but each test still computes the
 * det and asserts it landed in the intended band, so float representation
 * can never silently strand both fixtures on the same side of the boundary
 * (which would turn these assertions vacuous).
 */
function boundaryWcs(cd11, cd22) {
	return {
		raDeg: 10, decDeg: 10, crpix1: 101, crpix2: 51,
		cd11: cd11, cd12: 0, cd21: 0, cd22: cd22,
		imgW: 200, imgH: 100,
	};
}

test('wcs epsilon boundary: det just ABOVE 1e-20 → both sides non-null, exact at reference', () => {
	const wcs = boundaryWcs(1e-10, 5e-10);          // det = 5e-20
	const det = wcs.cd11 * wcs.cd22 - wcs.cd12 * wcs.cd21;
	assert.ok(det > 1e-20 && det < 1e-19,
		`fixture precondition broken: det ${det} not in (1e-20, 1e-19)`);

	// Probe the REFERENCE POINT: dRA = dDec = 0, so both sides compute
	// (crpix-1)/img with a zero offset — bit-exact agreement regardless of how
	// ill-conditioned the inverse is. Off-reference points are deliberately
	// not probed here (rounding divergence swamps any absolute tolerance).
	const browser = DSWcs.skyToPixelFrac(10, 10, { ...wcs });
	const srv     = server.skyToPixelFrac(...toServerArgs(wcs, { ra: 10, dec: 10 }));
	assert.ok(browser !== null, 'browser side went null above its own epsilon');
	assert.ok(srv !== null,     'server side went null above its own epsilon');
	assert.equal(browser.x, srv.x, 'reference-point x must agree bit-exactly');
	assert.equal(browser.y, srv.y, 'reference-point y must agree bit-exactly');
});

test('wcs epsilon boundary: det just BELOW 1e-20 → both sides null', () => {
	const wcs = boundaryWcs(1e-10, 5e-11);          // det = 5e-21
	const det = wcs.cd11 * wcs.cd22 - wcs.cd12 * wcs.cd21;
	assert.ok(det > 0 && det < 1e-20,
		`fixture precondition broken: det ${det} not in (0, 1e-20)`);

	assert.equal(DSWcs.skyToPixelFrac(10, 10, { ...wcs }), null,
		'browser side returned coordinates below its own epsilon');
	assert.equal(server.skyToPixelFrac(...toServerArgs(wcs, { ra: 10, dec: 10 })), null,
		'server side returned coordinates below its own epsilon');
});

test('wcs cross-consistency: degenerate CD matrix → both sides return null', () => {
	// det(CD) = 0 (second row is a multiple of the first). The null contract
	// is part of the shared projection semantics — detail.js and the ingest
	// overlay code both branch on it — so the two sides must agree here too.
	const wcs = {
		raDeg: 10, decDeg: 10,
		crpix1: 100, crpix2: 100,
		cd11: 1e-4, cd12: 2e-4,
		cd21: 2e-4, cd22: 4e-4,
		imgW: 200, imgH: 200,
	};
	assert.equal(DSWcs.skyToPixelFrac(10.1, 10.1, { ...wcs }), null);
	assert.equal(server.skyToPixelFrac(...toServerArgs(wcs, { ra: 10.1, dec: 10.1 })), null);
});
