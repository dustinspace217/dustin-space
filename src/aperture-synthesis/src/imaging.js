// imaging.js — turn uv-samples into a reconstructed ("dirty") image.
//
// Pipeline (the convolution theorem made literal):
//   1. The true sky's FFT is the full visibility function V(u,v).
//   2. The array only measures V where it has samples → multiply V by a sampling
//      mask S (1 where sampled, 0 elsewhere).
//   3. Inverse-FFT the masked visibilities → the DIRTY IMAGE.
//   4. Inverse-FFT the mask alone → the DIRTY BEAM (the array's point-spread
//      function): what a single point of light would look like through this array.
//
// Because masking in the Fourier plane is multiplication, the dirty image equals
// the true sky CONVOLVED with the dirty beam. So a sparse, ugly sampling pattern →
// an ugly beam → a smeared, artifact-ridden image. That single fact is the lesson.

import { fft2d, fftshift2d } from './fft.js';

// setFreqCell — mark one integer spatial-frequency cell (ku,kv) in the mask.
//   ku,kv : signed frequency indices in cells, where 0 = DC (zero spatial freq).
//   n,half: grid side and n/2. Cells outside [−half, half) fall off the grid.
// FFT layout puts DC at the corner, so a negative frequency k maps to index k+n.
// Returns 1 ONLY when this call newly fills a cell, so the caller can count the
// number of DISTINCT spatial frequencies measured — not raw placements. (Many
// baselines, and many time-samples of one baseline, round to the same cell; an
// evenly-spaced array makes this redundancy extreme. Counting placements would
// overstate coverage, which is exactly what the user is trying to judge.) Off-grid
// or already-filled cells return 0.
function setFreqCell(mask, ku, kv, n, half) {
	if (ku < -half || ku >= half || kv < -half || kv >= half) return 0;
	const iu = ((ku % n) + n) % n;
	const iv = ((kv % n) + n) % n;
	const idx = iv * n + iu; // row index = v, column index = u
	if (mask[idx]) return 0; // already measured this spatial frequency
	mask[idx] = 1;
	return 1;
}

// gridSampling — rasterize a list of physical (u,v) samples onto an N×N mask.
//   points: array of {u, v} in wavelengths (from physics.sampleUv).
//   n     : grid side (power of two).
//   uvMax : the spatial frequency (wavelengths) that maps to the grid EDGE. This
//           is a FIXED scale on purpose — see the module header in imaging.js's
//           caller — so longer baselines visibly reach farther out and sharpen the
//           image, rather than being auto-fit and hiding that relationship.
// Adds each sample AND its Hermitian conjugate (−u,−v): the sky is real, so its
// transform obeys V(−u,−v)=V*(u,v) and every baseline gives its mirror for free.
// Returns { mask, filled } where `filled` is the number of DISTINCT grid cells
// measured (conjugate mirrors counted, redundant placements not) — the honest
// "how much of the uv-plane have you actually covered" number shown to the user.
export function gridSampling(points, n, uvMax) {
	if (!(uvMax > 0)) throw new Error(`gridSampling: uvMax must be >0, got ${uvMax}`);
	const mask = new Float64Array(n * n);
	const half = n >> 1;
	const scale = half / uvMax; // wavelengths → cells
	let filled = 0;
	for (let p = 0; p < points.length; p++) {
		const ku = Math.round(points[p].u * scale);
		const kv = Math.round(points[p].v * scale);
		filled += setFreqCell(mask, ku, kv, n, half);   // measured sample
		filled += setFreqCell(mask, -ku, -kv, n, half);  // Hermitian conjugate
	}
	return { mask, filled };
}

// thermalNoiseSigma — per-component noise standard deviation for a given level, scaled
// to the RMS of the sampled visibilities times √(sample count). The √ factor is the
// load-bearing part: a source adds coherently across baselines (∝ samples) while noise
// adds incoherently (∝ √samples), so without it the image barely degrades at dense
// coverage and whites out at sparse coverage. The √ cancels that, making the slider an
// image-noise axis approximately DECOUPLED from the coverage (rotation) axis — a
// deliberate teaching simplification over true per-visibility SNR. Pure + exported so
// this scaling can be unit-tested directly. Returns 0 when nothing was sampled.
//   0.3 ⇒ level 1.0 leaves the source peak ~2.5× the noise floor: clearly degraded,
//   still findable, and about where over-CLEANing starts inventing spurious sources.
export function thermalNoiseSigma(vr, vi, mask, level) {
	let sumSq = 0, cnt = 0;
	for (let i = 0; i < mask.length; i++) {
		if (mask[i] > 0) { sumSq += vr[i] * vr[i] + vi[i] * vi[i]; cnt++; }
	}
	if (cnt === 0) return 0;
	const rms = Math.sqrt(sumSq / cnt);
	return level * rms * Math.sqrt(cnt) * 0.3;
}

// dirtyFromVisibilities — reconstruct a dirty image + beam from MEASURED complex
// visibilities (real interferometer data), instead of the simulation's FFT-of-a-known-
// sky. Each cell is [gridIndex, re, im] in FFT layout (the measured half); we place it
// and its Hermitian conjugate V*(u,v), inverse-FFT to the dirty image, and fftshift so
// the phase centre (where the source sits) moves to the panel centre — real visibilities
// are referenced to the phase centre, so unlike the centred-sky simulation the source
// lands at the FFT origin and needs the shift. The beam comes from the sampling pattern
// alone, exactly as in the simulation.
//   cells : array of [idx, re, im].  n : grid side.
// Returns { dirty, beam, filled } where filled = distinct sampled cells.
export function dirtyFromVisibilities(cells, n) {
	if (!Array.isArray(cells) || !Number.isInteger(n) || n <= 0 || (n & (n - 1)) !== 0) {
		throw new Error(`dirtyFromVisibilities: bad input (cells array? n power-of-two? got n=${n})`);
	}
	const vr = new Float64Array(n * n), vi = new Float64Array(n * n);
	const mask = new Float64Array(n * n);
	for (let k = 0; k < cells.length; k++) {
		const idx = cells[k][0], re = cells[k][1], im = cells[k][2];
		const r = (idx / n) | 0, c = idx % n;
		const j = ((n - r) % n) * n + ((n - c) % n); // conjugate cell (−u,−v)
		if (j === idx) { vr[idx] += re; mask[idx] = 1; continue; } // self-conjugate (DC/Nyquist) ⇒ real, once
		vr[idx] += re; vi[idx] += im; mask[idx] = 1;
		vr[j] += re; vi[j] -= im; mask[j] = 1;        // V*(u,v) keeps the image real
	}
	fft2d(vr, vi, n, true);
	const dirty = fftshift2d(vr, n);
	const br = Float64Array.from(mask), bi = new Float64Array(n * n);
	fft2d(br, bi, n, true);
	const beam = fftshift2d(br, n);
	let filled = 0; for (let i = 0; i < mask.length; i++) if (mask[i]) filled++;
	return { dirty, beam, filled };
}

// addThermalNoise — add HERMITIAN-symmetric Gaussian noise to the sampled visibilities,
// in place. A real sky's conjugate visibility V(−u,−v)=V*(u,v) is the SAME measurement,
// not an independent one — so we draw noise once per conjugate pair and write the
// conjugate, which keeps the dirty image exactly real (no imaginary residue to discard)
// and injects the physically right noise power. Noise lands only on sampled cells, and
// since gridSampling's mask is itself Hermitian, each sampled cell's conjugate is also
// sampled. The beam is never touched (it's the PSF, not a measurement). The fields are a
// fixed pattern passed in, so the noise doesn't reshuffle frame to frame.
//   noise : { level, fieldRe, fieldIm } — unit-variance noise fields (length n*n).
// Exported so the Hermitian/gating behavior can be unit-tested in isolation.
export function addThermalNoise(vr, vi, mask, n, noise) {
	const sigma = thermalNoiseSigma(vr, vi, mask, noise.level);
	if (sigma === 0) return;
	for (let r = 0; r < n; r++) {
		for (let c = 0; c < n; c++) {
			const i = r * n + c;
			if (!(mask[i] > 0)) continue;
			const j = ((n - r) % n) * n + ((n - c) % n); // conjugate cell (−u,−v)
			if (j < i) continue;                          // visit each conjugate pair once
			const re = sigma * noise.fieldRe[i];
			if (j === i) { vr[i] += re; continue; }       // self-conjugate (DC/Nyquist) ⇒ real
			const im = sigma * noise.fieldIm[i];
			vr[i] += re; vi[i] += im;
			vr[j] += re; vi[j] -= im;                     // the conjugate visibility V*(u,v)
		}
	}
}

// dirtyImageAndBeam — reconstruct the dirty image and beam from a sampling mask.
//   skyRe : Float64Array length n*n, the true sky brightness (real, image-centered).
//   mask  : Float64Array length n*n, the sampling mask from gridSampling (FFT layout).
//   n     : grid side.
//   noise : optional { level, fieldRe, fieldIm } thermal-noise spec (see addThermalNoise);
//           omitted/level 0 ⇒ a noiseless ideal measurement.
// Returns { dirty, beam } as Float64Arrays in display layout (object/peak centered).
// The dirty image keeps the sky's centered layout; the beam is fftshift-ed so its
// peak sits at the panel centre (conventional PSF display). Values are raw — the
// renderer scales each panel to its own min/max for contrast.
export function dirtyImageAndBeam(skyRe, mask, n, noise) {
	if (skyRe.length !== n * n || mask.length !== n * n) {
		throw new Error(`dirtyImageAndBeam: array length mismatch for n=${n}`);
	}
	// Sky → visibilities (forward FFT). Sky is real, so the imaginary part starts 0.
	const vr = Float64Array.from(skyRe);
	const vi = new Float64Array(n * n);
	fft2d(vr, vi, n, false);

	// Keep only the spatial frequencies the array actually sampled.
	for (let i = 0; i < vr.length; i++) { vr[i] *= mask[i]; vi[i] *= mask[i]; }

	// Optional thermal noise on the measured visibilities (the beam stays noiseless —
	// it's the array's PSF, not a measurement).
	if (noise && noise.level > 0) addThermalNoise(vr, vi, mask, n, noise);

	// Masked visibilities → dirty image (inverse FFT). The mask is (almost) point-
	// symmetric because gridSampling adds every conjugate, and thermal noise is added
	// Hermitian-symmetrically too, so the imaginary part is ~0 — up to a tiny residue at
	// the Nyquist edge, where a sample at −half has no matching +half cell. We take the
	// real part, which is correct regardless.
	fft2d(vr, vi, n, true);
	const dirty = Float64Array.from(vr);

	// The mask alone → dirty beam (the array's PSF). Same story: bi is ~0 and discarded;
	// we keep the real part and fftshift it so the peak sits at the panel centre.
	const br = Float64Array.from(mask);
	const bi = new Float64Array(n * n);
	fft2d(br, bi, n, true);
	const beam = fftshift2d(br, n);

	return { dirty, beam };
}
