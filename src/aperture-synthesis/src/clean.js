// clean.js — Högbom CLEAN deconvolution.
//
// The dirty image is the true sky convolved with the dirty beam (the array's messy
// point-spread function). CLEAN undoes that convolution under one assumption: the
// sky is a sum of point sources. The loop:
//   1. find the brightest pixel of the residual,
//   2. record a fraction of it (the loop gain) as a "clean component",
//   3. subtract a scaled, shifted copy of the dirty beam at that spot — which removes
//      that source's sidelobes from the WHOLE image at once,
//   4. repeat until the residual is near-flat.
// Finally the clean components are "restored" with an idealized Gaussian clean beam
// (the main lobe without sidelobes) and the leftover residual is added back.
//
// Caveat worth knowing: CLEAN can invent plausible structure if over-iterated on
// sparse data — the reason the EHT ring needed careful regularization, not raw CLEAN.

import { fft2d } from './fft.js';

// measureBeamHwhm — half-width at half-maximum of the dirty beam's central lobe, in
// pixels, averaged over the +x and +y directions from the centre. Sets the size of
// the restoring Gaussian so it matches the array's true resolution.
//   beam : Float64Array(n*n), centred (peak at n/2,n/2). n : grid side.
function measureBeamHwhm(beam, n) {
	const c = n / 2;
	const peak = beam[c * n + c];
	const half = 0.5 * peak;
	// Explicit +x and +y scans out to the first half-max crossing. The c/2 default only
	// survives for a pathological beam with no crossing inside the central half (keeps
	// sigma bounded). Real CLEAN fits an elliptical Gaussian to the lobe; a circular
	// axis-averaged width is the deliberate teaching-scale simplification.
	let hx = c / 2; for (let d = 1; d < c; d++) { if (beam[c * n + (c + d)] < half) { hx = d - 0.5; break; } }
	let hy = c / 2; for (let d = 1; d < c; d++) { if (beam[(c + d) * n + c] < half) { hy = d - 0.5; break; } }
	// Floor the HWHM near 1px. Note the restoring sigma (HWHM/1.1774) can still be
	// sub-pixel for a sharply-peaked beam — that's a near-delta restore, which is fine.
	return Math.max(0.9, (hx + hy) / 2);
}

// gaussianKernelCorner — a unit-peak Gaussian centred at the array CORNER (origin
// 0,0 with wraparound), so it can be used directly as an FFT convolution kernel
// without introducing a half-image shift. sigma in pixels.
function gaussianKernelCorner(n, sigma) {
	const k = new Float64Array(n * n);
	const twoSig2 = 2 * sigma * sigma;
	for (let r = 0; r < n; r++) {
		const dr = Math.min(r, n - r);
		for (let c = 0; c < n; c++) {
			const dc = Math.min(c, n - c);
			k[r * n + c] = Math.exp(-(dr * dr + dc * dc) / twoSig2);
		}
	}
	return k;
}

// convolveFFT — circular convolution of image `a` with a corner-centred kernel via
// the convolution theorem (multiply in the Fourier domain). Returns the real part.
function convolveFFT(a, kernel, n) {
	const ar = Float64Array.from(a), ai = new Float64Array(n * n);
	const kr = Float64Array.from(kernel), ki = new Float64Array(n * n);
	fft2d(ar, ai, n, false);
	fft2d(kr, ki, n, false);
	for (let i = 0; i < n * n; i++) {
		const re = ar[i] * kr[i] - ai[i] * ki[i];
		ai[i] = ar[i] * ki[i] + ai[i] * kr[i];
		ar[i] = re;
	}
	fft2d(ar, ai, n, true);
	return ar;
}

// hogbomClean — deconvolve `dirty` using `beam`.
//   dirty : Float64Array(n*n), the dirty image (centred layout).
//   beam  : Float64Array(n*n), the dirty beam (centred, peak at n/2,n/2).
//   opts  : { gain=0.1, maxIter=300, thresholdFrac=0.03 }
//     - gain         : fraction of the peak removed per iteration (loop gain).
//     - maxIter      : hard iteration cap (Power-of-Ten rule 2 — bound the loop).
//     - thresholdFrac : stop when the residual peak falls below this fraction of the
//                       initial peak (adaptive early-out for simple sources).
// Returns { cleaned, residual, model, iterations }.
export function hogbomClean(dirty, beam, n, opts) {
	const gain = opts?.gain ?? 0.1;
	const maxIter = opts?.maxIter ?? 300;
	const thresholdFrac = opts?.thresholdFrac ?? 0.03;
	const c = n / 2;
	const beamPeak = beam[c * n + c];
	if (!(beamPeak > 0)) throw new Error(`hogbomClean: non-positive beam peak ${beamPeak}`);

	const residual = Float64Array.from(dirty);
	const model = new Float64Array(n * n);
	// CLEAN models POSITIVE point sources, so the stop threshold is a fraction of the
	// brightest positive pixel — consistent with the peak search in the loop below. If
	// the image has no positive pixel, initPeak stays 0, the loop breaks immediately,
	// and we return iterations: 0 (a deliberate no-op, not an error). Unreachable from
	// the UI, where the dirty image of a real sky is always positive-peaked.
	let initPeak = 0;
	for (let i = 0; i < residual.length; i++) if (residual[i] > initPeak) initPeak = residual[i];
	const threshold = thresholdFrac * initPeak;

	let iter = 0;
	for (; iter < maxIter; iter++) {
		// brightest residual pixel
		let pi = 0, pv = -Infinity;
		for (let i = 0; i < residual.length; i++) if (residual[i] > pv) { pv = residual[i]; pi = i; }
		if (pv < threshold) break;
		const pr = (pi / n) | 0, pc = pi % n;
		const comp = gain * pv;
		model[pi] += comp;
		// subtract comp × (dirty beam shifted so its peak sits at the found pixel).
		// `scale` is invariant across the pixel loop — hoisted out of the hot path.
		const scale = comp / beamPeak;
		for (let r = 0; r < n; r++) {
			const br = r - pr + c;
			if (br < 0 || br >= n) continue;
			for (let cc = 0; cc < n; cc++) {
				const bc = cc - pc + c;
				if (bc < 0 || bc >= n) continue;
				residual[r * n + cc] -= scale * beam[br * n + bc];
			}
		}
	}

	// Restore: clean components convolved with an idealized Gaussian beam + residual.
	const sigma = measureBeamHwhm(beam, n) / 1.1774; // HWHM → Gaussian sigma
	const restored = convolveFFT(model, gaussianKernelCorner(n, sigma), n);
	for (let i = 0; i < restored.length; i++) restored[i] += residual[i];
	return { cleaned: restored, residual, model, iterations: iter };
}
