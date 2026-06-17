// reconstruct.js — regularized image reconstruction, beyond CLEAN.
//
// CLEAN assumes the sky is a handful of point sources, so on extended structure (a
// ring) it piles flux into a central blob. A more honest method enforces two things the
// data and physics both demand and iterates until both hold:
//   1. the measured visibilities  (data consistency),
//   2. brightness ≥ 0 everywhere   (positivity — a real physical prior).
// This is a POCS scheme (Projection Onto Convex Sets): each pass replaces the sampled
// spatial frequencies with the measured values, transforms to the image, and clips away
// negative flux. The unmeasured frequencies get filled with whatever keeps the image
// non-negative — which, for a ring, reconstructs the ring.
//
// It's a teaching-scale stand-in for the EHT's RML methods (which add smoothness/entropy
// priors and, crucially, fit the data only to WITHIN its noise rather than exactly). The
// capstone shows where this honestly falls short on real, noisy data: hard data
// enforcement fits the noise, so the real M87 reconstruction scatters where a synthetic
// (noise-free) ring through the same coverage comes out clean.

import { fft2d } from './fft.js';

// makePositivitySolver — a RESUMABLE POCS solver over a measured visibility grid, so the
// UI can animate the convergence a few iterations per frame instead of all at once.
//   vr, vi : measured complex visibilities on the grid (0 outside sampled cells).
//   mask   : 1 where measured.  n : grid side.
// Returns { image, step }: `image` is the live reconstruction (Float64Array, in the same
// layout the visibilities imply — the caller shifts/crops for display); `step(k)` advances
// k iterations in place, mutating `image`.
export function makePositivitySolver(vr, vi, mask, n) {
	const n2 = n * n;
	// the measured data — the hard constraint re-imposed every iteration
	const dr = Float64Array.from(vr), di = Float64Array.from(vi);
	// initial guess: the positive part of the dirty image
	const image = new Float64Array(n2);
	const ar = Float64Array.from(dr), ai = Float64Array.from(di);
	fft2d(ar, ai, n, true);
	for (let i = 0; i < n2; i++) image[i] = Math.max(0, ar[i]);

	const step = (k) => {
		for (let it = 0; it < k; it++) {
			const xr = Float64Array.from(image), xi = new Float64Array(n2);
			fft2d(xr, xi, n, false);                         // image → its visibilities
			for (let i = 0; i < n2; i++) if (mask[i]) { xr[i] = dr[i]; xi[i] = di[i]; } // re-impose measured
			fft2d(xr, xi, n, true);                          // back to the image
			for (let i = 0; i < n2; i++) image[i] = Math.max(0, xr[i]); // positivity
		}
	};
	return { image, step };
}

// reconstructPositivity — one-shot: run the solver for `iters` and return the image.
// (The UI uses the stepper for animation; this is the convenient form for tests.)
export function reconstructPositivity(vr, vi, mask, n, iters) {
	const solver = makePositivitySolver(vr, vi, mask, n);
	solver.step(iters);
	return solver.image;
}
